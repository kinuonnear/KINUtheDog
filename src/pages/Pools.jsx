import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced, useLocalStorage } from '../hooks.js';
import { Link, navigate, poolPath, rememberPoolsPath, useLocation } from '../router.jsx';
import { getClassicPositions, getDclPositions, POOL_TYPES, searchPools } from '../lib/rhea.js';
import { asPoolToken, getCachedToken, getTokens, priceOf } from '../lib/tokens.js';
import { getTokenInfoCached, isQuoteToken } from '../lib/intear.js';
import { ESTIMATED_WINDOWS, fetchWindowVolumes, WINDOWS } from '../lib/gecko.js';
import { swingLevel } from '../lib/poolRadar.js';
import AprValue from '../components/AprValue.jsx';
import { formatChartPrice, formatPercent, formatUsd } from '../lib/format.js';
import { ErrorNotice, PairIcons, Skeleton } from '../components/ui.jsx';

const PAGE_SIZE = 25;

/** Lazily resolve token metadata (icons) for the visible pools. */
export function usePoolTokens(pools) {
  // Keyed by the joined ids: a re-created pools array with the same tokens must not refetch
  // (that would re-render forever).
  const key = [...new Set((pools || []).flatMap((p) => p.tokenIds))].join(',');
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    getTokens(key.split(',')).then(() => alive && setVersion((v) => v + 1));
    return () => {
      alive = false;
    };
  }, [key]);
  return (pool) =>
    pool.tokenIds.map((id, i) => asPoolToken(getCachedToken(id) || { id, symbol: pool.symbols?.[i] || id.slice(0, 4) }));
}

export function PoolRow({ pool, tokensOf }) {
  const tokens = tokensOf(pool);
  const totalApr = pool.apy + pool.farmApy;
  return (
    <Link to={poolPath(pool.id)} className="pool-row">
      <span className="pool-row__pair">
        <PairIcons tokens={tokens} size={30} />
        <span>
          <strong>{tokens.map((t) => t.symbol).join(' / ')}</strong>
          <small>
            <span className={`kind kind--${pool.label.toLowerCase()}`}>{pool.label}</span>
            {pool.feePercent > 0 && <span>{formatPercent(pool.feePercent, pool.feePercent < 0.1 ? 3 : 2)} fee</span>}
            {pool.isFarm && <span className="kind kind--farm">Farm</span>}
          </small>
        </span>
      </span>
      <span className="pool-row__num" data-label="TVL">
        {formatUsd(pool.tvl)}
      </span>
      <span className="pool-row__num" data-label="Volume 24h">
        {formatUsd(pool.volume24h)}
      </span>
      <span className="pool-row__num pool-row__apr" data-label="APR">
        {formatPercent(totalApr)}
      </span>
    </Link>
  );
}

export function PoolRowsSkeleton({ rows = 8 }) {
  return Array.from({ length: rows }, (_, i) => (
    <div className="pool-row pool-row--skeleton" key={i}>
      <Skeleton width="45%" height={18} />
      <Skeleton width={70} />
      <Skeleton width={70} />
      <Skeleton width={50} />
    </div>
  ));
}

/* ------------------------------------------------------------------ */
/* Pools page (Meteora-style discover table)                           */
/* ------------------------------------------------------------------ */

const VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'top', label: 'Top Performers' }
];

const TOP_MIN_TVL = 5_000; // ignore dust pools in Top Performers
const TOP_CANDIDATES = 60; // most active pools (24h volume) considered for Top Performers
const TOP_WINDOWS = new Set(['h6', 'h12', 'h24']); // Top Performers rank by fees over 6–24h

/** Ids of the pools where the account provides liquidity (CLMM positions, AMM / stable shares incl. farmed). */
async function getMyPoolIds(accountId) {
  const [dcl, classic] = await Promise.all([getDclPositions(accountId).catch(() => []), getClassicPositions(accountId).catch(() => [])]);
  return [...new Set([...dcl.map((p) => p.poolId), ...classic.map((c) => String(c.pool.id))])];
}

function matchesCategory(pool, category) {
  switch (category) {
    case 'amm':
      return pool.kind === 'SIMPLE_POOL';
    case 'clmm':
      return pool.kind === 'DCL';
    case 'almm':
      return pool.kind === 'DEGEN_SWAP';
    case 'stable':
      return pool.kind === 'STABLE_SWAP' || pool.kind === 'RATED_SWAP';
    case 'farm':
      return pool.isFarm;
    default:
      return true;
  }
}

/** Base / quote order for display: quote is NEAR or a stablecoin when present. */
function baseQuote(tokens) {
  const [a, b] = tokens;
  if (!b) return [a, null];
  if (isQuoteToken(b.id)) return [a, b];
  if (isQuoteToken(a.id)) return [b, a];
  return [a, b];
}

/** Lazily loaded market data (USD price, 24h change, market cap) for base tokens. */
function useBaseTokenInfo(ids) {
  const [infos, setInfos] = useState({});
  const key = ids.join(',');
  useEffect(() => {
    let alive = true;
    const missing = ids.filter((id) => !(id in infos));
    if (!missing.length) return undefined;
    (async () => {
      for (let i = 0; i < missing.length; i += 6) {
        const chunk = missing.slice(i, i + 6);
        const results = await Promise.all(chunk.map((id) => getTokenInfoCached(id)));
        if (!alive) return;
        setInfos((prev) => ({ ...prev, ...Object.fromEntries(chunk.map((id, j) => [id, results[j]])) }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return infos;
}

/**
 * Volume and fees per pool for the chosen window:
 *   24H             -> Rhea pool API (same numbers as app.rhea.finance)
 *   1H / 6H         -> GeckoTerminal (exact)
 *   4H / 12H        -> estimated between the nearest exact windows (marked ≈)
 * Fees = volume × the pool's effective fee rate. Returns { [poolId]: { volume, fees } | null }.
 */
function useWindowStats(pools, windowKey) {
  const [stats, setStats] = useState({});
  const ids = pools.map((p) => p.id).join(',');

  useEffect(() => {
    if (windowKey === 'h24') return undefined;
    let alive = true;
    setStats({});
    // Rhea's effective LP fee rate (24h fees / 24h volume) keeps every window consistent
    // with Rhea's own fee accounting; fall back to the nominal fee tier.
    const feeRate = (p) => (p.volume24h > 0 && p.feeVolume24h > 0 ? p.feeVolume24h / p.volume24h : (p.feePercent || 0) / 100);
    fetchWindowVolumes(pools)
      .then((map) => {
        if (!alive) return;
        setStats(
          Object.fromEntries(
            pools.map((p) => {
              const volume = map[p.id] ? map[p.id][windowKey] : null;
              return [p.id, volume === null ? null : { volume, fees: volume * feeRate(p) }];
            })
          )
        );
      })
      .catch(() => alive && setStats(Object.fromEntries(pools.map((p) => [p.id, null]))));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, windowKey]);

  const stats24 = useMemo(
    () => Object.fromEntries(pools.map((p) => [p.id, { volume: p.volume24h, fees: p.feeVolume24h }])),
    [pools]
  );
  return windowKey === 'h24' ? stats24 : stats;
}

function Change({ value }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return (
    <small className={value >= 0 ? 'up' : 'down'}>
      {value >= 0 ? '+' : ''}
      {value.toFixed(2)}%
    </small>
  );
}

/** How far the price moved in 24h, with the swing level (the impermanent-loss risk for LPs). */
export function SwingValue({ change }) {
  const move = Number.isFinite(change) ? Math.abs(change) : null;
  const swing = swingLevel(move, 24);
  if (move === null) return <span className="muted">—</span>;
  return (
    <span className="disc-swing" title="24h price move of the pool's main token: bigger moves mean more impermanent loss for LPs">
      <Change value={change} />
      {swing && <em className={`swing swing--${swing.key}`}>{swing.label}</em>}
    </span>
  );
}

function DiscoverRow({ rank, pool, tokens, prices, info, stat, estimated, favorite, onFavorite, mine }) {
  const [base, quote] = baseQuote(tokens);
  const pBase = priceOf(prices, base?.id);
  const pQuote = quote ? priceOf(prices, quote.id) : 0;
  const poolPrice = pBase > 0 && pQuote > 0 ? pBase / pQuote : null;
  const volTvl = stat && pool.tvl > 0 ? (stat.volume / pool.tvl) * 100 : 0;
  const pending = stat === undefined;
  // Classic pools can be created with a 0% fee: swaps then pay LPs nothing.
  const noFee = !pool.isDcl && !(pool.feePercent > 0);

  return (
    <Link to={poolPath(pool.id)} className="dt-row">
      <span className="dt-rank">
        <b>#{rank}</b>
        <button
          type="button"
          className={`star ${favorite ? 'star--on' : ''}`}
          aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
          title={favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onFavorite(pool.id);
          }}
        >
          {favorite ? '★' : '☆'}
        </button>
      </span>
      <span className="dt-pool">
        <PairIcons tokens={tokens} size={30} />
        <span>
          <strong>{tokens.map((t) => t.symbol).join(' / ')}</strong>
          <small>
            <span className={`kind kind--${pool.label.toLowerCase()}`}>{pool.label}</span>
            {pool.feePercent > 0 && `Fee ${formatPercent(pool.feePercent, pool.feePercent < 0.1 ? 3 : 2)}`}
            {noFee && (
              <span className="kind kind--nofee" title="This pool charges a 0% trading fee: its LPs earn nothing from swaps.">
                No fee
              </span>
            )}
            {pool.isFarm && <span className="kind kind--farm">Farm</span>}
            {mine && (
              <span className="kind kind--mine" title="You provide liquidity in this pool">
                Your LP
              </span>
            )}
          </small>
        </span>
      </span>
      <span className="dt-num" data-label="Pool price">
        {poolPrice !== null ? (
          <>
            {formatChartPrice(poolPrice)} <i>{quote.symbol}</i>
          </>
        ) : (
          '—'
        )}
      </span>
      <span className="dt-num" data-label="24h move">
        <SwingValue change={info?.change24h} />
      </span>
      <span className="dt-num" data-label="TVL">
        {formatUsd(pool.tvl)}
      </span>
      <span className="dt-num" data-label="Volume">
        {pending ? <Skeleton width={60} /> : stat ? `${estimated ? '≈' : ''}${formatUsd(stat.volume)}` : '—'}
        <small className="muted">{volTvl > 0 ? `${formatPercent(volTvl, 0)} of TVL` : ''}</small>
      </span>
      <span className="dt-num dt-fees" data-label="Fees">
        {pending ? <Skeleton width={56} /> : stat ? `${estimated ? '≈' : ''}${formatUsd(stat.fees)}` : '—'}
      </span>
      <span className="dt-num dt-apr" data-label="APR">
        <AprValue apr={pool.apy + pool.farmApy} move={info?.change24h} />
      </span>
    </Link>
  );
}

/** Pool types in the TVL split of the header card (labels from rhea.poolKindLabel). */
const GLANCE_TYPES = [
  { key: 'clmm', label: 'CLMM' },
  { key: 'amm', label: 'AMM' },
  { key: 'stable', label: 'Stable' },
  { key: 'almm', label: 'ALMM' }
];

/** Header card: Rhea-wide numbers, TVL by pool type and today's top fee earner. */
function RheaGlance({ ready, totals }) {
  const skeleton = <Skeleton width={80} height={20} />;
  const top = totals.topFees;
  const metrics = [
    { label: 'Total value locked', value: formatUsd(totals.tvl) },
    { label: '24h volume', value: formatUsd(totals.volume), hint: totals.tvl > 0 && `${((totals.volume / totals.tvl) * 100).toFixed(0)}% of TVL traded` },
    { label: '24h fees to LPs', value: formatUsd(totals.fees), accent: true },
    { label: 'Avg. daily yield', value: totals.tvl > 0 ? formatPercent((totals.fees / totals.tvl) * 100, 3) : '—', hint: `${totals.pools.toLocaleString()} active pools` }
  ];
  return (
    <section className="glance card" aria-label="Rhea at a glance, last 24 hours">
      {metrics.map((m) => (
        <div className="glance__metric" key={m.label}>
          <span>{m.label}</span>
          <strong className={m.accent ? 'up' : ''}>{ready ? m.value : skeleton}</strong>
          {ready && m.hint && <small>{m.hint}</small>}
        </div>
      ))}
      <div className="glance__split">
        <span className="glance__label">
          TVL by pool type
          <span className="glance__live">
            <i /> Live · 24h
          </span>
        </span>
        <div className="glance__bar" aria-hidden="true">
          {ready &&
            totals.byType.map((t) => (
              <i key={t.key} className={`glance__seg glance__seg--${t.key}`} style={{ width: `${totals.tvl > 0 ? (t.tvl / totals.tvl) * 100 : 0}%` }} />
            ))}
        </div>
        <div className="glance__legend">
          {totals.byType.map((t) => (
            <span key={t.key}>
              <i className={`glance__dot glance__seg--${t.key}`} />
              {t.label} <b>{ready && totals.tvl > 0 ? `${((t.tvl / totals.tvl) * 100).toFixed(0)}%` : '—'}</b>
            </span>
          ))}
        </div>
        {ready && top && (
          <Link to={poolPath(top.id)} className="glance__top">
            <span>Most fees today</span>
            <strong>{top.symbols.join(' / ')}</strong>
            <b className="up">{formatUsd(top.feeVolume24h)}</b>
            <em aria-hidden="true">→</em>
          </Link>
        )}
      </div>
    </section>
  );
}

export default function Pools() {
  const { prices, accountId, connect } = useApp();
  const { search } = useLocation();
  const [view, setView] = useState(() => {
    const v = search.get('view');
    return v === 'mine' || VIEWS.some((x) => x.key === v) ? v : 'all';
  });
  // The view lives in the URL (?view=mine …): back from a pool page — browser or ← — returns here.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (view === 'all') params.delete('view');
    else params.set('view', view);
    const path = `/pools${params.toString() ? `?${params}` : ''}`;
    navigate(path, { replace: true });
    rememberPoolsPath(path);
  }, [view]);
  // "My positions": pools where the connected wallet has liquidity.
  const mine = useAsync(() => getMyPoolIds(accountId), [accountId], { enabled: Boolean(accountId), refreshMs: 120_000 });
  const mineIds = mine.data || [];
  const mineKey = mineIds.join(',');
  const [category, setCategory] = useState('all');
  const tab = POOL_TYPES.find((t) => t.key === category) || POOL_TYPES[0];
  const [windowKey, setWindowKey] = useLocalStorage('kinu.pools.window', 'h24');
  const [sort, setSort] = useState('tvl');
  const [order, setOrder] = useState('desc');
  const [hideLow, setHideLow] = useState(true);
  // Pools with liquidity but no trades in 24h earn their LPs nothing.
  const [hideInactive, setHideInactive] = useLocalStorage('kinu.pools.hideInactive', true);
  const [query, setQuery] = useState(() => search.get('q') || '');
  const [pages, setPages] = useState(1);
  const [favorites, setFavorites] = useLocalStorage('kinu.pool.favorites', []);
  const q = useDebounced(query.trim().toLowerCase(), 300);
  const windowLabel = WINDOWS.find((w) => w.key === windowKey)?.label || '24H';

  // Top Performers only rank by 6H–24H fees; switching to it moves 1H / 4H up to 6H.
  useEffect(() => {
    if (view === 'top' && !TOP_WINDOWS.has(windowKey)) setWindowKey('h6');
  }, [view, windowKey, setWindowKey]);

  const toggleFavorite = (id) => setFavorites((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  // Overall stats for the header (top pools by TVL).
  const overview = useAsync(() => searchPools({ limit: 300, hideLow: true }), [], { refreshMs: 120_000 });
  const totals = useMemo(() => {
    const list = overview.data?.list || [];
    const byType = GLANCE_TYPES.map((t) => ({ ...t, tvl: list.filter((p) => p.label === t.label).reduce((s, p) => s + p.tvl, 0) }));
    return {
      tvl: list.reduce((s, p) => s + p.tvl, 0),
      volume: list.reduce((s, p) => s + p.volume24h, 0),
      fees: list.reduce((s, p) => s + p.feeVolume24h, 0),
      pools: overview.data?.total || list.length,
      byType,
      topFees: list.reduce((best, p) => (!best || p.feeVolume24h > best.feeVolume24h ? p : best), null)
    };
  }, [overview.data]);

  // TVL / APR (and 24H volume) sort through the Rhea API; window volume / fees sort client-side.
  const apiSortable = sort === 'tvl' || sort === 'apy' || (sort === 'volume' && windowKey === 'h24');
  const apiSort = sort === 'volume' ? 'volume_24h' : apiSortable ? sort : 'tvl';
  const limit = q ? 300 : view === 'top' ? TOP_CANDIDATES : apiSortable ? PAGE_SIZE * pages : 100;
  const favKey = favorites.slice().sort().join(',');
  const result = useAsync(
    () => {
      if (view === 'favorites') {
        if (!favorites.length) return Promise.resolve({ list: [], total: 0 });
        return searchPools({ poolIds: favorites.join(','), hideLow: false, limit: favorites.length });
      }
      if (view === 'mine') {
        if (!mineIds.length) return Promise.resolve({ list: [], total: 0 });
        return searchPools({ poolIds: mineKey, hideLow: false, limit: mineIds.length });
      }
      if (view === 'top') {
        // The most actively traded pools are the fee leaders; rank them by window fees below.
        return searchPools({ type: tab.type, labels: tab.labels || '', sort: 'volume_24h', order: 'desc', limit, hideLow: true });
      }
      return searchPools({ type: tab.type, labels: tab.labels || '', sort: apiSort, order, limit, offset: 0, hideLow: q ? false : hideLow });
    },
    [view, category, apiSort, order, limit, hideLow, Boolean(q), view === 'favorites' ? favKey : view === 'mine' ? mineKey : ''],
    { refreshMs: 60_000 }
  );

  useEffect(() => setPages(1), [view, category, sort, order, hideLow, windowKey]);

  // Rows before window stats: search / category / Top Performers candidate filtering.
  const baseRows = useMemo(() => {
    let list = result.data?.list || [];
    if (view === 'favorites' || view === 'mine') list = list.filter((p) => matchesCategory(p, category));
    if (view === 'top') list = list.filter((p) => p.tvl >= TOP_MIN_TVL);
    if (view === 'all' && hideInactive && !q) list = list.filter((p) => p.volume24h > 0);
    if (q) {
      list = list
        .filter((p) => p.id === q || p.symbols.some((s) => s.toLowerCase().includes(q)) || p.tokenIds.some((id) => id.toLowerCase().includes(q)))
        .slice(0, 100);
    }
    return list;
  }, [result.data, view, category, q, hideInactive]);

  const stats = useWindowStats(baseRows, windowKey);

  const pools = useMemo(() => {
    let list = baseRows;
    const statValue = (p, field) => stats[p.id]?.[field] ?? -1;
    if (view === 'top') {
      list = [...list].sort((a, b) => statValue(b, 'fees') - statValue(a, 'fees')).slice(0, PAGE_SIZE * pages);
    } else if (!apiSortable || view === 'favorites' || view === 'mine') {
      const value = (p) =>
        sort === 'fees' ? statValue(p, 'fees') : sort === 'volume' ? statValue(p, 'volume') : sort === 'apy' ? p.apy + p.farmApy : p.tvl;
      list = [...list].sort((a, b) => (order === 'desc' ? value(b) - value(a) : value(a) - value(b)));
    }
    return list;
  }, [baseRows, stats, view, sort, order, pages, apiSortable]);

  const tokensOf = usePoolTokens(pools);
  const rowTokens = pools.map((p) => tokensOf(p));
  const baseIdOf = (tokens) => (baseQuote(tokens)[0]?.id || '').replace(/^near$/, 'wrap.near');
  const infos = useBaseTokenInfo([...new Set(rowTokens.map(baseIdOf).filter(Boolean))]);
  const total = result.data?.total ?? 0;
  const loadingWindow = windowKey !== 'h24' && baseRows.some((p) => stats[p.id] === undefined);

  const toggleSort = (key) => {
    if (sort === key) setOrder(order === 'desc' ? 'asc' : 'desc');
    else {
      setSort(key);
      setOrder('desc');
    }
  };
  const sortHeader = (key, label) => (
    <button type="button" className={`th-sort ${sort === key && view !== 'top' ? 'th-sort--active' : ''}`} onClick={() => toggleSort(key)} disabled={view === 'top'}>
      {label}
      {sort === key && view !== 'top' && <span aria-hidden>{order === 'desc' ? ' ↓' : ' ↑'}</span>}
    </button>
  );

  // Counted before the inactive filter: the API pages through every pool.
  const fetched = result.data?.list?.length ?? 0;
  const canLoadMore = view === 'all' && !q && apiSortable && fetched < total && fetched >= PAGE_SIZE * pages;
  const canLoadMoreTop = view === 'top' && baseRows.length > pools.length;

  return (
    <div className="page page--discover">
      <header className="discover-head">
        <div>
          <span className="eyebrow">Rhea Finance · NEAR</span>
          <h1>Liquidity pools</h1>
          <p>Live TVL, volume, fees and APR for every Rhea pool. Provide liquidity to earn trading fees.</p>
        </div>
        <RheaGlance ready={Boolean(overview.data)} totals={totals} />
      </header>

      <nav className="view-tabs" aria-label="Pool views">
        {VIEWS.map((v) => (
          <button key={v.key} type="button" className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>
            {v.key === 'favorites' && <span aria-hidden>★ </span>}
            {v.key === 'top' && <span aria-hidden>🔥 </span>}
            {v.label}
            {v.key === 'favorites' && favorites.length > 0 && <em>{favorites.length}</em>}
          </button>
        ))}
      </nav>

      <div className="toolbar toolbar--discover">
        <div className="category-chips" role="tablist" aria-label="Pool type">
          {POOL_TYPES.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={category === t.key} className={category === t.key ? 'active' : ''} onClick={() => setCategory(t.key)}>
              {t.key === 'all' ? 'All types' : t.label}
            </button>
          ))}
          <button
            type="button"
            className={`my-positions-chip ${view === 'mine' ? 'active' : ''}`}
            onClick={() => (accountId ? setView((v) => (v === 'mine' ? 'all' : 'mine')) : connect())}
            title={accountId ? 'Pools where you provide liquidity' : 'Connect your wallet to see your positions'}
          >
            <span aria-hidden>◎</span> My positions
            {accountId && mine.data && <em>{mineIds.length}</em>}
          </button>
        </div>
        <div className="toolbar__right">
          <div className="segmented window-picker" role="radiogroup" aria-label="Time window">
            {WINDOWS.map((w) => {
              const disabled = view === 'top' && !TOP_WINDOWS.has(w.key);
              return (
                <button
                  key={w.key}
                  type="button"
                  role="radio"
                  aria-checked={windowKey === w.key}
                  className={windowKey === w.key ? 'active' : ''}
                  disabled={disabled}
                  title={disabled ? 'Top Performers rank by 6H–24H fees' : `Volume and fees over the last ${w.hours}h`}
                  onClick={() => setWindowKey(w.key)}
                >
                  {w.label}
                </button>
              );
            })}
          </div>
          <div className="search-field">
            <span aria-hidden>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter token, symbol or pool id" spellCheck={false} />
          </div>
          {view === 'all' && (
            <label className="checkbox">
              <input type="checkbox" checked={hideLow} onChange={(e) => setHideLow(e.target.checked)} disabled={Boolean(q)} />
              Hide low TVL
            </label>
          )}
          {view === 'all' && (
            <label className="checkbox" title="Hide pools with no trades in the last 24h: they earn their LPs nothing">
              <input type="checkbox" checked={hideInactive} onChange={(e) => setHideInactive(e.target.checked)} disabled={Boolean(q)} />
              Hide inactive
            </label>
          )}
        </div>
      </div>

      <p className="type-hint">
        <span className={`kind kind--${tab.key}`}>{tab.key === 'all' ? 'All types' : tab.label}</span>
        {view === 'top'
          ? `Pools that earned the most fees in the last ${windowLabel} (TVL ≥ ${formatUsd(TOP_MIN_TVL)}).`
          : view === 'favorites'
            ? 'Pools you starred. Tap ☆ on any row to add it here.'
            : view === 'mine'
              ? 'Pools where you provide liquidity. Open one to see and manage your positions.'
              : tab.hint}
        {ESTIMATED_WINDOWS.has(windowKey) && (
          <span className="muted small"> · ≈ {windowLabel} values are estimated from the exact 1H / 6H / 24H data.</span>
        )}
        {loadingWindow && (
          <span className="muted small">
            {' '}
            · loading {windowLabel} data…
          </span>
        )}
      </p>

      <ErrorNotice error={result.error} onRetry={result.reload} />

      <div className="card discover-table">
        <div className="dt-scroll">
          <div className="dt-row dt-row--head">
            <span>#</span>
            <span>Pool</span>
            <span className="dt-num">Pool price</span>
            <span className="dt-num" title="24h price move: the impermanent-loss risk for LPs">
              24h move
            </span>
            <span className="dt-num">{sortHeader('tvl', 'TVL')}</span>
            <span className="dt-num">{sortHeader('volume', `Volume ${windowLabel}`)}</span>
            <span className="dt-num">{view === 'top' ? `Fees ${windowLabel} ↓` : sortHeader('fees', `Fees ${windowLabel}`)}</span>
            <span className="dt-num">{sortHeader('apy', 'APR')}</span>
          </div>
          {result.loading && !result.data ? (
            Array.from({ length: 8 }, (_, i) => (
              <div className="dt-row" key={i}>
                <Skeleton width={28} />
                <Skeleton width="60%" height={18} />
                {Array.from({ length: 6 }, (__, j) => (
                  <Skeleton key={j} width={64} />
                ))}
              </div>
            ))
          ) : pools.length ? (
            pools.map((pool, i) => (
              <DiscoverRow
                key={pool.id}
                rank={i + 1}
                pool={pool}
                tokens={rowTokens[i]}
                prices={prices}
                info={infos[baseIdOf(rowTokens[i])]}
                stat={stats[pool.id]}
                estimated={ESTIMATED_WINDOWS.has(windowKey)}
                favorite={favorites.includes(pool.id)}
                onFavorite={toggleFavorite}
                mine={mineIds.includes(pool.id)}
              />
            ))
          ) : (
            <div className="pool-table__empty">
              {view === 'favorites' && !favorites.length ? (
                'No favorites yet — star a pool with ☆ to pin it here.'
              ) : view === 'mine' && (mine.loading || !mine.data) && accountId ? (
                'Loading your positions…'
              ) : view === 'mine' && !q ? (
                'No liquidity positions yet — pick a pool and add liquidity to see it here.'
              ) : q ? (
                <>
                  No pools match “{query}”.{' '}
                  {/^\d+$/.test(q) && (
                    <button type="button" className="link-button" onClick={() => navigate(poolPath(q))}>
                      Open pool #{q}
                    </button>
                  )}
                </>
              ) : (
                'No pools found.'
              )}
            </div>
          )}
        </div>
      </div>

      {(canLoadMore || canLoadMoreTop) && (
        <div className="center">
          <button type="button" className="button button--ghost" onClick={() => setPages((p) => p + 1)} disabled={result.loading}>
            {result.loading ? 'Loading…' : canLoadMore ? `Load more (${fetched} of ${total.toLocaleString()})` : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
