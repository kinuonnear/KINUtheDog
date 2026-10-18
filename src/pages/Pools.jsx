import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced, useLocalStorage } from '../hooks.js';
import { Link, navigate, poolPath, rememberPoolsPath, useLocation } from '../router.jsx';
import { fillClassicVolumes, getClassicPositions, getDclPositions, POOL_TYPES, searchPools } from '../lib/rhea.js';
import { asPoolToken, getCachedToken, getTokens, priceOf } from '../lib/tokens.js';
import { getTokenInfoCached, isQuoteToken } from '../lib/intear.js';
import { ESTIMATED_WINDOWS, fetchWindowVolumes, WINDOWS } from '../lib/gecko.js';
import { swingLevel } from '../lib/poolRadar.js';
import AprValue from '../components/AprValue.jsx';
import { formatChartPrice, formatPercent, formatUsd, shortAccount } from '../lib/format.js';
import { ErrorNotice, PairIcons, Skeleton, TokenIcon } from '../components/ui.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import PageIcon from '../components/PageIcon.jsx';
import PoolSourceTabs from '../components/PoolSourceTabs.jsx';
import '../pools.css';

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

/** One pool in a table. `usdOpts` (optional) is passed to formatUsd for TVL and volume. */
export function PoolRow({ pool, tokensOf, usdOpts }) {
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
        {formatUsd(pool.tvl, usdOpts)}
      </span>
      <span className="pool-row__num" data-label="Volume 24h">
        {formatUsd(pool.volume24h, usdOpts)}
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
  { key: 'top', label: 'Top Performers' },
  { key: 'trending', label: 'Trending' }
];

/** Views that rank their own candidates (the most traded pools) instead of paging the API. */
const RANKED_VIEWS = new Set(['top', 'trending']);
const TOP_MIN_TVL = 5_000; // ignore dust pools in Top Performers
const TRENDING_MIN_TVL = 1_000; // Trending: small pools count, dust doesn't
const TOP_CANDIDATES = 60; // most active pools (24h volume) considered for Top Performers
const TOP_WINDOWS = new Set(['h6', 'h12', 'h24']); // Top Performers rank by fees over 6–24h

/**
 * The pools where the account provides liquidity (CLMM positions, AMM / stable shares incl. farmed),
 * and for CLMM pools whether its positions earn: { ids, range: { [poolId]: 'in' | 'out' | 'partial' } }.
 */
async function getMyPools(accountId) {
  const [dcl, classic] = await Promise.all([getDclPositions(accountId), getClassicPositions(accountId).catch(() => [])]);
  const range = {};
  const byPool = new Map();
  dcl.forEach((p) => byPool.set(p.poolId, [...(byPool.get(p.poolId) || []), p]));
  byPool.forEach((list, id) => {
    const earning = list.filter((p) => p.inRange).length;
    range[id] = earning === list.length ? 'in' : earning === 0 ? 'out' : 'partial';
  });
  return { ids: [...new Set([...byPool.keys(), ...classic.map((c) => String(c.pool.id))])], range };
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
export function useBaseTokenInfo(ids) {
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

/** How long ago the pool's main token was created: 45m, 18h, 12d, 7mo, 3y. Under a week reads as new. */
function TokenAge({ createdAt, pending }) {
  if (pending) return <Skeleton width={34} />;
  const ms = createdAt ? Date.now() - createdAt : NaN;
  if (!(ms >= 0)) return <span className="muted">—</span>;
  const h = ms / 3_600_000;
  const d = h / 24;
  const text = h < 1 ? `${Math.max(1, Math.round(ms / 60_000))}m` : h < 48 ? `${Math.floor(h)}h` : d < 60 ? `${Math.floor(d)}d` : d < 730 ? `${Math.floor(d / 30.4)}mo` : `${Math.floor(d / 365)}y`;
  return <span className={d < 7 ? 'dt-age--new' : ''}>{text}</span>;
}

// "Your LP" badge: whether your CLMM positions in the pool are earning fees right now.
const MINE_LABEL = { in: 'In range', out: 'Out of range', partial: 'Partly in range' };
const MINE_HINT = {
  yes: 'You provide liquidity in this pool',
  in: 'Your positions here are in range: earning fees',
  out: 'Your positions here are out of range: not earning fees — consider a rebalance',
  partial: 'Some of your positions here are out of range'
};

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
              <span
                className={`kind kind--mine ${mine === 'out' ? 'kind--mine-out' : mine === 'partial' ? 'kind--mine-partial' : ''}`}
                title={MINE_HINT[mine]}
              >
                Your LP{MINE_LABEL[mine] ? ` · ${MINE_LABEL[mine]}` : ''}
              </span>
            )}
          </small>
        </span>
      </span>
      <span className="dt-num dt-age" data-label="Token age" title={info?.createdAt ? `${base?.symbol} created ${new Date(info.createdAt).toLocaleDateString()}` : undefined}>
        <TokenAge createdAt={info?.createdAt} pending={info === undefined} />
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
        {formatUsd(pool.tvl, USD_K)}
      </span>
      <span className="dt-num" data-label="Volume">
        {pending ? <Skeleton width={60} /> : stat ? `${estimated ? '≈' : ''}${formatUsd(stat.volume, USD_K)}` : '—'}
        <small className="muted">{volTvl > 0 ? `${formatPercent(volTvl, 0)} of TVL` : ''}</small>
      </span>
      <span className="dt-num dt-fees" data-label="Fees">
        {pending ? <Skeleton width={56} /> : stat ? `${estimated ? '≈' : ''}${formatUsd(stat.fees, USD_K)}` : '—'}
      </span>
      <span className="dt-num dt-apr" data-label="APR">
        <AprValue apr={pool.apy + pool.farmApy} move={info?.change24h} estimated={pool.apyEstimated} />
        <AprMeter apr={pool.apy + pool.farmApy} />
      </span>
      {/* The row is a link, so the quick action is a button (no link inside a link). */}
      <span className="dt-action">
        <button
          type="button"
          className="dt-add"
          title="Open the pool at its add-liquidity form"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            navigate(`${poolPath(pool.id)}?tab=add`);
          }}
        >
          + Add LP
        </button>
      </span>
    </Link>
  );
}

// Dollar amounts in the table and the header read compact from $1K, so the columns line up.
const USD_K = { compactAbove: 1e3 };

/** Pool types in the TVL split of the header card (labels from rhea.poolKindLabel). */
const GLANCE_TYPES = [
  { key: 'clmm', label: 'CLMM' },
  { key: 'amm', label: 'AMM' },
  { key: 'stable', label: 'Stable' },
  { key: 'almm', label: 'ALMM' }
];

/** Header monitor: Rhea-wide numbers (24h), TVL by pool type and today's top fee earner. */
function PoolsMonitor({ ready, totals }) {
  const skeleton = <Skeleton width={80} height={22} />;
  const top = totals.topFees;
  const metrics = [
    { key: 'tvl', label: 'Total value locked', value: formatUsd(totals.tvl) },
    { key: 'vol', label: 'Volume 24h', value: formatUsd(totals.volume), hint: totals.tvl > 0 && `${((totals.volume / totals.tvl) * 100).toFixed(0)}% of TVL traded` },
    { key: 'fees', label: 'Fees to LPs 24h', value: formatUsd(totals.fees, USD_K), accent: true },
    { key: 'yield', label: 'Avg. daily yield', value: totals.tvl > 0 ? formatPercent((totals.fees / totals.tvl) * 100, 3) : '—', hint: `${totals.pools.toLocaleString()} active pools` }
  ];
  return (
    <section className="pt-monitor" aria-label="NEAR liquidity at a glance, last 24 hours">
      {metrics.map((m) => (
        <div className="pt-tile" key={m.key}>
          <span>{m.label}</span>
          <strong className={m.accent ? 'up' : ''}>{ready ? m.value : skeleton}</strong>
          <small>{ready && m.hint ? m.hint : ' '}</small>
        </div>
      ))}
      <div className="pt-tile pt-tile--split">
        <span>TVL by pool type</span>
        <div className="pt-split" aria-hidden="true">
          {ready &&
            totals.byType.map((t) => (
              <i key={t.key} className={`pt-seg pt-seg--${t.key}`} style={{ width: `${totals.tvl > 0 ? (t.tvl / totals.tvl) * 100 : 0}%` }} />
            ))}
        </div>
        <div className="pt-legend">
          {totals.byType.map((t) => (
            <span key={t.key}>
              <i className={`pt-seg pt-seg--${t.key}`} />
              {t.label} <b>{ready && totals.tvl > 0 ? `${((t.tvl / totals.tvl) * 100).toFixed(0)}%` : '—'}</b>
            </span>
          ))}
        </div>
        {ready && top && (
          <Link to={poolPath(top.id)} className="pt-top">
            <span>Top fees today</span>
            <strong>{top.symbols.join(' / ')}</strong>
            <b className="up">{formatUsd(top.feeVolume24h, USD_K)}</b>
            <em aria-hidden="true">→</em>
          </Link>
        )}
      </div>
    </section>
  );
}

/** APR as a meter: log scale, full at 100% so ordinary yields still show. */
function AprMeter({ apr }) {
  const width = Number.isFinite(apr) && apr > 0 ? Math.min(1, Math.log10(1 + apr) / 2) * 100 : 0;
  return (
    <i className={`apr-meter ${apr >= 100 ? 'apr-meter--hot' : ''}`} aria-hidden="true">
      <b style={{ width: `${width}%` }} />
    </i>
  );
}

/** A sidebar section with a terminal-style heading. */
function SideSection({ title, children }) {
  return (
    <section className="pt-side__section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Every Rhea pool a token trades in, as pair chips (largest first), above the table. */
function TokenPairs({ tokenId, pools, tokensOf }) {
  const token = getCachedToken(tokenId);
  const list = (pools || []).filter((p) => p.tokenIds.includes(tokenId)).sort((a, b) => b.tvl - a.tvl);
  const tvl = list.reduce((s, p) => s + p.tvl, 0);
  return (
    <section className="pt-pairs" aria-label="Pairs for this token">
      <div className="pt-pairs__head">
        <TokenIcon token={token || { id: tokenId, symbol: '?' }} size={34} />
        <span className="pt-pairs__name">
          <strong>{token?.symbol || shortAccount(tokenId, 12, 8)}</strong>
          <small>{shortAccount(tokenId, 22, 12)}</small>
        </span>
        <span className="pt-pairs__sum">
          {pools === null ? (
            'Finding pairs…'
          ) : list.length ? (
            <>
              <b>{list.length}</b> pair{list.length === 1 ? '' : 's'} on Rhea · <b>{formatUsd(tvl)}</b> TVL
            </>
          ) : (
            <>
              No Rhea pools for this token yet · <Link to="/create">Create one →</Link>
            </>
          )}
        </span>
      </div>
      {list.length > 0 && (
        <div className="pt-pairs__list">
          {list.map((p) => {
            const toks = tokensOf(p);
            return (
              <Link key={p.id} to={poolPath(p.id)} className="pt-pair">
                <PairIcons tokens={toks} size={20} />
                <b>{toks.map((x) => x.symbol).join(' / ')}</b>
                <span className={`kind kind--${String(p.label).toLowerCase()}`}>{p.label}</span>
                {p.feePercent > 0 && <small>{formatPercent(p.feePercent, p.feePercent < 0.1 ? 3 : 2)}</small>}
                <em>{p.tvl < 1 ? '<$1' : formatUsd(p.tvl)}</em>
              </Link>
            );
          })}
        </div>
      )}
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
  const mine = useAsync(() => getMyPools(accountId), [accountId], { enabled: Boolean(accountId), refreshMs: 120_000 });
  const mineIds = mine.data?.ids || [];
  const mineRange = mine.data?.range || {};
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
  const [filtersOpen, setFiltersOpen] = useState(false); // phones: the sidebar folds into a "Filters" button
  // The sidebar sticks just below the sticky stats band, whose height changes with the layout.
  const bandRef = useRef(null);
  const measureBand = () => {
    const band = bandRef.current;
    if (band) band.parentElement?.style.setProperty('--pt-band-h', `${band.offsetHeight}px`);
  };
  useEffect(() => {
    const band = bandRef.current;
    if (!band) return undefined;
    // ResizeObserver where it runs; window resizes (and the data load below) as a fallback.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measureBand) : null;
    observer?.observe(band);
    window.addEventListener('resize', measureBand);
    measureBand();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureBand);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [favorites, setFavorites] = useLocalStorage('kinu.pool.favorites', []);
  const q = useDebounced(query.trim().toLowerCase(), 300);
  const windowLabel = WINDOWS.find((w) => w.key === windowKey)?.label || '24H';
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (q) params.set('q', q);
    else params.delete('q');
    const path = `/pools${params.toString() ? `?${params}` : ''}`;
    if (path !== window.location.pathname + window.location.search) navigate(path, { replace: true });
    rememberPoolsPath(path);
  }, [q]);

  // Top Performers only rank by 6H–24H fees; switching to it moves 1H / 4H up to 6H.
  useEffect(() => {
    if (view === 'top' && !TOP_WINDOWS.has(windowKey)) setWindowKey('h6');
  }, [view, windowKey, setWindowKey]);

  const toggleFavorite = (id) => setFavorites((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  // Overall stats for the header (top pools by TVL).
  const overview = useAsync(() => searchPools({ limit: 300, hideLow: true }), [], { refreshMs: 120_000 });
  // The stats band changes height once its numbers arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(measureBand, [Boolean(overview.data)]);
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

  // Top Performers / Trending show their own ranking ('rank') until a column header is clicked.
  const ranked = RANKED_VIEWS.has(view);
  useEffect(() => {
    if (ranked) setSort('rank');
    else setSort((s) => (s === 'rank' ? 'tvl' : s));
  }, [ranked]);

  // TVL / APR (and 24H volume) sort through the Rhea API; window volume / fees, the 24h move and
  // token age sort client-side.
  const apiSortable = sort === 'tvl' || sort === 'apy' || (sort === 'volume' && windowKey === 'h24');
  const apiSort = sort === 'volume' ? 'volume_24h' : apiSortable ? sort : 'tvl';
  const limit = q ? 300 : ranked ? TOP_CANDIDATES : apiSortable ? PAGE_SIZE * pages : 100;
  // NEAR account ids contain a dot; bridged tokens are 64-hex implicit accounts.
  const tokenQuery = q && (q.includes('.') || /^[0-9a-f]{64}$/.test(q)) ? q : '';
  const favKey = favorites.slice().sort().join(',');
  const result = useAsync(
    () => loadList().then(async (res) => ({ ...res, list: await fillClassicVolumes(res.list || []) })),
    [view, category, apiSort, order, limit, hideLow, Boolean(q), tokenQuery, view === 'favorites' ? favKey : view === 'mine' ? mineKey : ''],
    { refreshMs: 60_000 }
  );
  // New classic pools Rhea hasn't indexed yet get their volume from DexScreener (fillClassicVolumes).
  function loadList() {
    if (view === 'favorites') {
      if (!favorites.length) return Promise.resolve({ list: [], total: 0 });
      return searchPools({ poolIds: favorites.join(','), hideLow: false, limit: favorites.length });
    }
    if (view === 'mine') {
      if (!mineIds.length) return Promise.resolve({ list: [], total: 0 });
      return searchPools({ poolIds: mineKey, hideLow: false, limit: mineIds.length });
    }
    if (ranked) {
      // The most actively traded pools: Top Performers ranks them by window fees, Trending by
      // window volume against their size (below).
      return searchPools({ type: tab.type, labels: tab.labels || '', sort: 'volume_24h', order: 'desc', limit, hideLow: true });
    }
    // A token address (from a "Add LP" link) asks Rhea for that token's pools, small ones included;
    // anything else filters the largest pools below.
    return searchPools({
      type: tab.type,
      labels: tab.labels || '',
      sort: apiSort,
      order,
      limit,
      offset: 0,
      hideLow: q ? false : hideLow,
      ...(tokenQuery ? { tokenList: tokenQuery } : {})
    });
  }

  useEffect(() => setPages(1), [view, category, sort, order, hideLow, windowKey]);

  // Rows before window stats: search / category / Top Performers candidate filtering.
  const baseRows = useMemo(() => {
    let list = result.data?.list || [];
    // My positions lists every pool you are in, whatever its type.
    if (view === 'favorites') list = list.filter((p) => matchesCategory(p, category));
    if (view === 'top') list = list.filter((p) => p.tvl >= TOP_MIN_TVL);
    if (view === 'trending') list = list.filter((p) => p.tvl >= TRENDING_MIN_TVL);
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
    if (ranked) {
      // Trending: the most trading for the pool's size (volume ÷ TVL) in the window.
      const rank = (p) => (view === 'trending' ? (p.tvl > 0 ? statValue(p, 'volume') / p.tvl : -1) : statValue(p, 'fees'));
      list = [...list].sort((a, b) => rank(b) - rank(a)).slice(0, PAGE_SIZE * pages);
    }
    if (sort !== 'rank' && sort !== 'move' && sort !== 'age' && (ranked || !apiSortable || view === 'favorites' || view === 'mine')) {
      const value = (p) =>
        sort === 'fees' ? statValue(p, 'fees') : sort === 'volume' ? statValue(p, 'volume') : sort === 'apy' ? p.apy + p.farmApy : p.tvl;
      list = [...list].sort((a, b) => (order === 'desc' ? value(b) - value(a) : value(a) - value(b)));
    }
    return list;
  }, [baseRows, stats, view, ranked, sort, order, pages, apiSortable]);

  const tokensOf = usePoolTokens(pools);
  const baseIdOf = (tokens) => (baseQuote(tokens)[0]?.id || '').replace(/^near$/, 'wrap.near');
  const infos = useBaseTokenInfo([...new Set(pools.map((p) => baseIdOf(tokensOf(p))).filter(Boolean))]);
  // The 24h move and token age come from each row's market data: sorted once it is in
  // (rows still loading go last).
  const rows = useMemo(() => {
    if (sort !== 'move' && sort !== 'age') return pools;
    const value = (p) => {
      const info = infos[baseIdOf(tokensOf(p))];
      const v = sort === 'move' ? info?.change24h : info?.createdAt ? Date.now() - info.createdAt : null;
      return Number.isFinite(v) ? v : null;
    };
    return [...pools].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null || vb === null) return va === null ? (vb === null ? 0 : 1) : -1;
      return order === 'desc' ? vb - va : va - vb;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pools, infos, sort, order]);
  const rowTokens = rows.map((p) => tokensOf(p));
  const total = result.data?.total ?? 0;
  const loadingWindow = windowKey !== 'h24' && baseRows.some((p) => stats[p.id] === undefined);

  const toggleSort = (key) => {
    if (sort === key) setOrder(order === 'desc' ? 'asc' : 'desc');
    else {
      setSort(key);
      // Token age: newest first on the first click.
      setOrder(key === 'age' ? 'asc' : 'desc');
    }
  };
  const sortHeader = (key, label, title) => (
    <button
      type="button"
      className={`th-sort ${sort === key ? 'th-sort--active' : ''}`}
      onClick={() => toggleSort(key)}
      title={title || `Sort by ${label}`}
      aria-sort={sort === key ? (order === 'desc' ? 'descending' : 'ascending') : undefined}
    >
      {label}
      <span aria-hidden className="th-sort__arrow">
        {sort === key ? (order === 'desc' ? '↓' : '↑') : '↕'}
      </span>
    </button>
  );

  // Counted before the inactive filter: the API pages through every pool.
  const fetched = result.data?.list?.length ?? 0;
  const canLoadMore = view === 'all' && !q && apiSortable && fetched < total && fetched >= PAGE_SIZE * pages;
  const canLoadMoreTop = ranked && baseRows.length > pools.length;

  const typeShare = (key) => {
    const t = totals.byType.find((x) => x.key === key);
    return t && totals.tvl > 0 ? (t.tvl / totals.tvl) * 100 : null;
  };
  const sideViews = [
    ...VIEWS.map((v) => ({ ...v, icon: v.key === 'favorites' ? '☆' : v.key === 'top' ? '↗' : v.key === 'trending' ? '⚡︎' : '◇', count: v.key === 'favorites' ? favorites.length : null })),
    { key: 'mine', label: 'My positions', icon: '◎', count: accountId && mine.data ? mineIds.length : null }
  ];
  const pickView = (key) => {
    if (key === 'mine') {
      if (!accountId) return connect();
      setCategory('all');
    }
    setView(key);
  };

  return (
    <div className="page page--discover page--pools">
      <header className="pt-hero">
        <FlowLines />
        <h1 className="pt-title">
          <PageIcon name="pools" />
          Pools
        </h1>
        <p>Every pool on NEAR, sorted by what it pays LPs.</p>
        <PoolSourceTabs active="rhea" rhea={overview.data ? { pools: totals.pools, tvl: totals.tvl } : undefined} />
        <Link to="/start-lp" className="pt-start">
          New to LP? Start here
          <span className="pt-start__arrow" aria-hidden>
            →
          </span>
        </Link>
      </header>
      {/* The title scrolls away; the stats band stays under the top bar and the list passes under it. */}
      <div className="pt-band" ref={bandRef}>
        <PoolsMonitor ready={Boolean(overview.data)} totals={totals} />
      </div>

      <div className="pt-layout">
        <aside className={`pt-side ${filtersOpen ? 'pt-side--open' : ''}`}>
          <button type="button" className="pt-side__toggle" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen}>
            <span>⚙ Filters</span>
            <small>
              {sideViews.find((v) => v.key === view)?.label} · {windowLabel}
            </small>
            <em aria-hidden>{filtersOpen ? '▴' : '▾'}</em>
          </button>
          <div className="pt-side__body">
            <SideSection title="VIEW">
              <div className="pt-list" role="radiogroup" aria-label="Pool views">
                {sideViews.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    role="radio"
                    aria-checked={view === v.key}
                    className={`pt-item ${view === v.key ? 'pt-item--on' : ''}`}
                    onClick={() => pickView(v.key)}
                    title={v.key === 'mine' && !accountId ? 'Connect your wallet to see your positions' : undefined}
                  >
                    <span aria-hidden className="pt-item__icon">
                      {v.icon}
                    </span>
                    {v.label}
                    {v.count > 0 && <em>{v.count}</em>}
                  </button>
                ))}
              </div>
            </SideSection>

            <SideSection title="TIME WINDOW">
              <div className="segmented window-picker pt-window" role="radiogroup" aria-label="Time window">
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
            </SideSection>

            <SideSection title="FILTERS">
              <label className={`pt-switch ${view !== 'all' || q ? 'pt-switch--off' : ''}`}>
                <input type="checkbox" checked={hideLow} onChange={(e) => setHideLow(e.target.checked)} disabled={view !== 'all' || Boolean(q)} />
                <i aria-hidden />
                Hide low TVL
              </label>
              <label
                className={`pt-switch ${view !== 'all' || q ? 'pt-switch--off' : ''}`}
                title="Hide pools with no trades in the last 24h: they earn their LPs nothing"
              >
                <input type="checkbox" checked={hideInactive} onChange={(e) => setHideInactive(e.target.checked)} disabled={view !== 'all' || Boolean(q)} />
                <i aria-hidden />
                Hide inactive
              </label>
              {view !== 'all' && <small className="muted">Filters apply to the All pools view.</small>}
            </SideSection>
          </div>
        </aside>

        <div className="pt-main">
          {/* Pool type as buttons above the table, always in view (also on phones). */}
          <div className="pt-types" role="radiogroup" aria-label="Pool type">
            {POOL_TYPES.map((t) => {
              const share = typeShare(t.key);
              const on = category === t.key && view !== 'mine';
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`pt-type ${on ? 'pt-type--on' : ''}`}
                  onClick={() => {
                    setCategory(t.key);
                    // A pool type applies to the full list: leave My positions.
                    if (view === 'mine') setView('all');
                  }}
                  title={t.hint}
                >
                  {t.key !== 'all' && <span className={`pt-dot pt-seg--${t.key}`} aria-hidden />}
                  {t.key === 'all' ? 'All types' : t.label}
                  {share !== null && <small>{share.toFixed(0)}%</small>}
                </button>
              );
            })}
          </div>
      <div className="pt-hint-row">
        <p className="type-hint">
          {view === 'top'
            ? `Pools that earned the most fees in the last ${windowLabel} (TVL ≥ ${formatUsd(TOP_MIN_TVL)}).`
            : view === 'trending'
              ? `Pools trading the most for their size in the last ${windowLabel} (volume ÷ TVL, TVL ≥ ${formatUsd(TRENDING_MIN_TVL)}).`
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
            {/* Search: a token contract lists every Rhea pair it trades in; a symbol or pool id filters the table. */}
            <div className="pt-search">
              <span aria-hidden>⌕</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Paste token contract → all its pairs"
                spellCheck={false}
                aria-label="Search pools by token contract, symbol or pool id"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
                  ✕
                </button>
              )}
            </div>
      </div>

          {tokenQuery && (
            <TokenPairs tokenId={tokenQuery} pools={result.loading && !result.data ? null : baseRows} tokensOf={tokensOf} />
          )}

      <ErrorNotice error={result.error} onRetry={result.reload} />

      <div className="card discover-table">
        <div className="dt-scroll">
          <div className="dt-row dt-row--head">
            <span>#</span>
            <span>Pool</span>
            <span className="dt-num">{sortHeader('age', 'Token age', 'Sort by the age of the pool’s main token')}</span>
            <span className="dt-num">Pool price</span>
            <span className="dt-num">{sortHeader('move', '24h move', '24h price move: the impermanent-loss risk for LPs')}</span>
            <span className="dt-num">{sortHeader('tvl', 'TVL')}</span>
            <span className="dt-num">{sortHeader('volume', `Volume ${windowLabel}`)}</span>
            <span className="dt-num">{sortHeader('fees', `Fees ${windowLabel}`)}</span>
            <span className="dt-num">{sortHeader('apy', 'APR')}</span>
            <span aria-hidden />
          </div>
          {result.loading && !result.data ? (
            Array.from({ length: 8 }, (_, i) => (
              <div className="dt-row" key={i}>
                <Skeleton width={28} />
                <Skeleton width="60%" height={18} />
                {Array.from({ length: 7 }, (__, j) => (
                  <Skeleton key={j} width={56} />
                ))}
              </div>
            ))
          ) : rows.length ? (
            rows.map((pool, i) => (
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
                mine={mineIds.includes(pool.id) ? mineRange[pool.id] || 'yes' : null}
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
      <p className="muted small center">Data: Rhea Finance classic and CLMM pools, live.</p>
        </div>
      </div>
    </div>
  );
}
