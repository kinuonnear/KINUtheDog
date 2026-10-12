// Discover (/discover, /new): Trending on Rhea, Hot pairs, top Gainers, Best to LP,
// New launches and your Watchlist.

import { useMemo, useState } from 'react';
import { useAsync, useLocalStorage } from '../hooks.js';
import { Link, navigate, poolPath, useLocation } from '../router.jsx';
import { EmptyState, ErrorNotice, PairIcons, Skeleton, Tabs, TokenIcon } from '../components/ui.jsx';
import WatchStar from '../components/WatchStar.jsx';
import { enrichTokens, getTrending } from '../lib/trending.js';
import { useWatchlist } from '../lib/watchlist.js';
import { formatPercent, formatPrice, formatUsd } from '../lib/format.js';
import { bestToLp, filterRadar, getPoolRadar, hotPairs, LP_MIN_TVL, RADAR_TYPES, RADAR_WINDOWS } from '../lib/poolRadar.js';
import { NATIVE_NEAR } from '../config.js';
import { NewLaunches } from './NewOnRhea.jsx';
import { usePoolTokens } from './Pools.jsx';
import LiveFeed from '../components/LiveFeed.jsx';

const TABS = [
  { key: 'trending', label: 'Trending' },
  { key: 'feed', label: 'Live feed' },
  { key: 'hot', label: 'Hot pairs' },
  { key: 'gainers', label: 'Gainers' },
  { key: 'lp', label: 'Best to LP' },
  { key: 'new', label: 'New launches' },
  { key: 'watchlist', label: 'Watchlist' }
];

const MIN_GAINER_LIQUIDITY = 10_000;

// [before, highlighted word, after]
const TITLES = {
  trending: ['Trending on ', 'Rhea', ''],
  feed: ['Live ', 'feed', ''],
  hot: ['Hot pairs on ', 'Rhea', ''],
  gainers: ['Top gainers on ', 'Rhea', ''],
  lp: ['Best pools ', 'to', ' LP'],
  new: ['New on ', 'Rhea', ''],
  watchlist: ['Your ', 'watchlist', '']
};

const INTROS = {
  trending: 'Tokens with the most trading volume across Rhea pools in the last 24 hours. NEAR and stablecoins are left out.',
  feed: 'Every swap on Rhea as it happens. Follow traders to see their moves first.',
  hot: 'The pairs traded most right now, over the last hour, 6 hours or day.',
  gainers: 'Biggest 24h moves among actively traded Rhea tokens with at least $10K liquidity.',
  lp: `Pools that paid their liquidity providers the most fees per dollar (TVL ≥ $${LP_MIN_TVL / 1000}K), with how much the price moved.`,
  new: 'The newest tokens with a Rhea pool, launched on Nearly. Live every minute, with the facts that matter before you buy.',
  watchlist: 'Tokens you starred, with live prices.'
};

function Change({ value }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="muted">—</span>;
  return (
    <span className={value > 0 ? 'up' : value < 0 ? 'down' : 'muted'}>
      {value > 0 ? '+' : ''}
      {value.toFixed(1)}%
    </span>
  );
}

/** Ranked token table for Trending / Gainers / Watchlist. */
function TokenTable({ rows, loading, error, onRetry, volumeLabel = 'Volume 24h', empty }) {
  if (error && !rows) return <ErrorNotice error={error} onRetry={onRetry} />;
  return (
    <section className="card new-table disc-table">
      <div className="new-row disc-row new-row--head">
        <span>#</span>
        <span>Token</span>
        <span>Price</span>
        <span>24h</span>
        <span>{volumeLabel}</span>
        <span>Liquidity</span>
        <span>Holders</span>
        <span />
      </div>
      {loading && !rows
        ? Array.from({ length: 8 }, (_, i) => (
            <div className="new-row disc-row" key={i}>
              <Skeleton width={16} />
              <Skeleton width={140} />
              {Array.from({ length: 5 }, (__, j) => (
                <Skeleton key={j} width={60} />
              ))}
              <span />
            </div>
          ))
        : rows?.map((r, i) => (
            <div className="new-row disc-row" key={r.id} onClick={() => navigate(`/token/${encodeURIComponent(r.id)}`)} role="link" tabIndex={0}>
              <span className="disc-row__rank">{i + 1}</span>
              <span className="new-row__token">
                <WatchStar id={r.id} />
                <TokenIcon token={r.token} size={30} />
                <span>
                  <strong>{r.token.symbol}</strong>
                  <small>{r.official ? 'Official $KINU' : r.token.name || r.id}</small>
                </span>
              </span>
              <span data-label="Price">{r.price ? formatPrice(r.price) : '—'}</span>
              <span data-label="24h">
                <Change value={r.change24h} />
              </span>
              <span data-label={volumeLabel}>{formatUsd(r.rheaVolume ?? r.volume24hUsd ?? 0)}</span>
              <span data-label="Liquidity">{r.liquidityUsd ? formatUsd(r.liquidityUsd) : '—'}</span>
              <span data-label="Holders">{r.holders ? r.holders.toLocaleString() : '—'}</span>
              <span className="new-row__buy">
                <Link className="button button--outline button--sm" to={`/swap?from=${NATIVE_NEAR.id}&to=${encodeURIComponent(r.id)}`} onClick={(e) => e.stopPropagation()}>
                  Buy
                </Link>
              </span>
            </div>
          ))}
      {rows && !rows.length && empty}
    </section>
  );
}

function Trending({ gainers }) {
  const data = useAsync(() => getTrending({ limit: 30 }), [], { refreshMs: 120_000 });
  const rows = useMemo(() => {
    if (!data.data) return null;
    if (!gainers) return data.data.slice(0, 20);
    return data.data
      .filter((r) => Number.isFinite(r.change24h) && (r.liquidityUsd || 0) >= MIN_GAINER_LIQUIDITY)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 20);
  }, [data.data, gainers]);
  return (
    <TokenTable
      rows={rows}
      loading={data.loading}
      error={data.error}
      onRetry={data.reload}
      volumeLabel="Rhea volume 24h"
      empty={<p className="muted small new-table__empty">No tokens to show right now.</p>}
    />
  );
}

/** ☆ / ★ for a pool, shared with the favourites on the Pools page. */
function PoolStar({ id, favorites, onToggle }) {
  const on = favorites.includes(id);
  return (
    <button
      type="button"
      className={`watch-star disc-star ${on ? 'watch-star--on' : ''}`}
      onClick={() => onToggle(id)}
      aria-pressed={on}
      title={on ? 'Remove from favourite pools' : 'Add to favourite pools'}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

/** Pool table shared by Hot pairs and Best to LP: rank, pair, five numbers, star + one action. */
function PoolTable({ rows, loading, error, onRetry, heads, cells, action, empty }) {
  const tokensOf = usePoolTokens(rows || []);
  const [favorites, setFavorites] = useLocalStorage('kinu.pool.favorites', []);
  const toggle = (id) => setFavorites((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  if (error && !rows) return <ErrorNotice error={error} onRetry={onRetry} />;
  return (
    <section className="card new-table disc-table">
      <div className="new-row disc-row disc-row--pools new-row--head">
        <span>#</span>
        <span>Pair</span>
        {heads.map((h) => (
          <span key={h}>{h}</span>
        ))}
        <span className="disc-row__actions-head">Actions</span>
      </div>
      {loading && !rows
        ? Array.from({ length: 8 }, (_, i) => (
            <div className="new-row disc-row disc-row--pools" key={i}>
              <Skeleton width={16} />
              <Skeleton width={140} />
              {heads.map((h) => (
                <Skeleton key={h} width={60} />
              ))}
              <span />
            </div>
          ))
        : rows?.map((r, i) => {
            const tokens = tokensOf(r);
            return (
              <div
                className="new-row disc-row disc-row--pools disc-row--in"
                style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}
                key={r.id}
                onClick={() => navigate(poolPath(r.id))}
                role="link"
                tabIndex={0}
              >
                <span className="disc-row__rank">{i + 1}</span>
                <span className="new-row__token">
                  <PairIcons tokens={tokens} size={28} />
                  <span>
                    <strong>{tokens.map((t) => t.symbol).join(' / ')}</strong>
                    <small>
                      <span className={`kind kind--${r.label.toLowerCase()}`}>{r.label}</span>{' '}
                      {r.feePercent > 0 && `${formatPercent(r.feePercent, r.feePercent < 0.1 ? 3 : 2)} fee`}
                    </small>
                  </span>
                </span>
                {cells(r).map((c, j) => (
                  <span key={heads[j]} data-label={heads[j]}>
                    {c}
                  </span>
                ))}
                <span className="new-row__buy disc-row__actions" onClick={(e) => e.stopPropagation()}>
                  <PoolStar id={r.id} favorites={favorites} onToggle={toggle} />
                  {action(r)}
                </span>
              </div>
            );
          })}
      {rows && !rows.length && empty}
    </section>
  );
}

function Segmented({ value, onChange, options, className = '' }) {
  return (
    <div className={`segmented disc-seg ${className}`}>
      {options.map((o) => (
        <button key={o.key} type="button" className={value === o.key ? 'active' : ''} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const windowLabel = (key) => RADAR_WINDOWS.find((w) => w.key === key)?.label || '24H';

/** Sort toggle on the left; time window and pool search on the right. */
function PoolToolbar({ sort, sorts, onSort, filters, onFilters }) {
  return (
    <div className="disc-toolbar">
      <Segmented value={sort} onChange={onSort} options={sorts} />
      <div className="disc-toolbar__right">
        <Segmented
          className="disc-seg--window"
          value={filters.window}
          onChange={(window) => onFilters({ ...filters, window })}
          options={RADAR_WINDOWS.map((w) => ({ key: w.key, label: w.label }))}
        />
        <label className="disc-search">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input value={filters.query} onChange={(e) => onFilters({ ...filters, query: e.target.value })} placeholder="Search pools…" aria-label="Search pools" />
        </label>
      </div>
    </div>
  );
}

function HotPairs({ filters, onFilters }) {
  const data = useAsync(getPoolRadar, [], { refreshMs: 90_000 });
  const [by, setBy] = useState('volume');
  const { window } = filters;
  const rows = useMemo(
    () => (data.data ? hotPairs(filterRadar(data.data, filters), { by, window }) : null),
    [data.data, by, window, filters]
  );
  const w = windowLabel(window);
  return (
    <>
      <PoolToolbar
        sort={by}
        onSort={setBy}
        sorts={[
          { key: 'volume', label: 'By volume' },
          { key: 'trades', label: 'By trades' }
        ]}
        filters={filters}
        onFilters={onFilters}
      />
      <PoolTable
        rows={rows}
        loading={data.loading}
        error={data.error}
        onRetry={data.reload}
        heads={[`Volume ${w}`, `Trades ${w}`, `Price ${w}`, 'Volume 24H', 'TVL']}
        cells={(r) => [
          formatUsd(r.activity.volume[window]),
          (r.activity.trades[window] || 0).toLocaleString(),
          <Change key="c" value={r.activity.change[window]} />,
          formatUsd(r.activity.volume.h24 || r.volume24h),
          formatUsd(r.tvl)
        ]}
        action={(r) => (
          <Link
            className="button button--outline button--sm"
            to={`/swap?from=${encodeURIComponent(r.tokenIds[0])}&to=${encodeURIComponent(r.tokenIds[1])}`}
          >
            Swap
          </Link>
        )}
        empty={<p className="muted small new-table__empty">No pairs match. Try another filter or window.</p>}
      />
    </>
  );
}

function BestToLp({ filters, onFilters }) {
  const data = useAsync(getPoolRadar, [], { refreshMs: 90_000 });
  const [mode, setMode] = useState('yield');
  const { window } = filters;
  const rows = useMemo(
    () => (data.data ? bestToLp(filterRadar(data.data, filters), { mode, window }) : null),
    [data.data, mode, window, filters]
  );
  const w = windowLabel(window);
  return (
    <>
      <PoolToolbar
        sort={mode}
        onSort={setMode}
        sorts={[
          { key: 'yield', label: 'Highest yield' },
          { key: 'balanced', label: 'Yield vs. price swings' }
        ]}
        filters={filters}
        onFilters={onFilters}
      />
      <PoolTable
        rows={rows}
        loading={data.loading}
        error={data.error}
        onRetry={data.reload}
        heads={[`Fees ${w}`, `Yield ${w}`, 'Rhea APR', `Price ${w}`, 'TVL']}
        cells={(r) => [
          formatUsd(r.fees),
          <b key="y" className="up" title={`Fees over ${w} ÷ TVL: what $100 of liquidity earned`}>
            {formatPercent(r.yieldPct, 2)}
          </b>,
          formatPercent(r.apy + r.farmApy),
          <span key="m" className="disc-swing">
            <Change value={r.change} />
            {r.swing && <em className={`swing swing--${r.swing.key}`}>{r.swing.label}</em>}
          </span>,
          formatUsd(r.tvl)
        ]}
        action={(r) => (
          <Link className="button button--outline button--sm" to={`${poolPath(r.id)}?tab=add`}>
            Add LP
          </Link>
        )}
        empty={<p className="muted small new-table__empty">No pools match. Try another filter or window.</p>}
      />
    </>
  );
}

function Watchlist() {
  const { list } = useWatchlist();
  const key = list.join(',');
  const data = useAsync(() => (list.length ? enrichTokens(list) : Promise.resolve([])), [key], { refreshMs: 60_000 });
  if (!list.length) {
    return (
      <EmptyState icon="☆" title="Your watchlist is empty">
        Tap ☆ next to any token — in Trending, New launches or on a token page — to follow it here. The list is kept in this
        browser.
      </EmptyState>
    );
  }
  return <TokenTable rows={data.data} loading={data.loading} error={data.error} onRetry={data.reload} />;
}

const POOL_TABS = new Set(['hot', 'lp']);
const DEFAULT_WINDOW = { hot: 'h1', lp: 'h24' };

export default function Discover({ defaultTab = 'trending' }) {
  const { search } = useLocation();
  const tab = TABS.some((t) => t.key === search.get('tab')) ? search.get('tab') : defaultTab;
  const { list } = useWatchlist();
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [windows, setWindows] = useState(DEFAULT_WINDOW);
  const filters = { type, query, window: windows[tab] || 'h24' };
  const setFilters = (next) => {
    setType(next.type);
    setQuery(next.query);
    setWindows((w) => ({ ...w, [tab]: next.window }));
  };
  const [pre, accent, post] = TITLES[tab];

  return (
    <div className="page new-page disc-page">
      <section className="disc-banner">
        <div className="disc-banner__img" aria-hidden="true" />
        <div className="disc-banner__shade" aria-hidden="true" />
        <header className="page-head disc-banner__head" key={tab}>
          <span className="eyebrow">Discover</span>
          <h1>
            {pre}
            <span className="disc-accent">{accent}</span>
            {post}
          </h1>
          <p>{INTROS[tab]}</p>
        </header>
      </section>


      <div className="disc-nav">
        <Tabs
          tabs={TABS.map((t) => (t.key === 'watchlist' ? { ...t, count: list.length || undefined } : t))}
          value={tab}
          onChange={(key) => navigate(`/discover?tab=${key}`, { replace: true })}
        />
        {POOL_TABS.has(tab) && (
          <Segmented className="disc-seg--types" value={type} onChange={setType} options={RADAR_TYPES.map((t) => ({ key: t.key, label: t.label }))} />
        )}
      </div>

      <div className="disc-body">
        {tab === 'feed' ? (
          <LiveFeed />
        ) : tab === 'new' ? (
          <NewLaunches />
        ) : tab === 'watchlist' ? (
          <Watchlist />
        ) : tab === 'hot' ? (
          <HotPairs filters={filters} onFilters={setFilters} />
        ) : tab === 'lp' ? (
          <BestToLp filters={filters} onFilters={setFilters} />
        ) : (
          <Trending gainers={tab === 'gainers'} />
        )}
      </div>
      {tab !== 'new' && (
        <p className="muted small">
          {tab === 'feed'
            ? 'Data: Intear trade feed of Rhea pools. Market cap at the trade is estimated from its price and the circulating supply. Not a recommendation.'
            : POOL_TABS.has(tab)
            ?`Data: Rhea pools and GeckoTerminal, among the most active pools on Rhea. 1H and 6H fees are estimated from window volume at each pool's fee rate. Past fees do not promise future fees, and a concentrated range stops earning when the price leaves it. Not a recommendation.`
            : 'Data: Rhea pools and Intear. Not a recommendation — always check the contract before you buy.'}
        </p>
      )}
    </div>
  );
}
