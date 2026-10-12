// Discover (/discover, /new): Trending on Rhea, top Gainers, New launches and your Watchlist.

import { useMemo } from 'react';
import { useAsync } from '../hooks.js';
import { Link, navigate, useLocation } from '../router.jsx';
import { EmptyState, ErrorNotice, Skeleton, Tabs, TokenIcon } from '../components/ui.jsx';
import WatchStar from '../components/WatchStar.jsx';
import { enrichTokens, getTrending } from '../lib/trending.js';
import { useWatchlist } from '../lib/watchlist.js';
import { formatPrice, formatUsd } from '../lib/format.js';
import { NATIVE_NEAR } from '../config.js';
import { NewLaunches } from './NewOnRhea.jsx';

const TABS = [
  { key: 'trending', label: 'Trending' },
  { key: 'gainers', label: 'Gainers' },
  { key: 'new', label: 'New launches' },
  { key: 'watchlist', label: 'Watchlist' }
];

const MIN_GAINER_LIQUIDITY = 10_000;

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

export default function Discover({ defaultTab = 'trending' }) {
  const { search } = useLocation();
  const tab = TABS.some((t) => t.key === search.get('tab')) ? search.get('tab') : defaultTab;
  const { list } = useWatchlist();

  return (
    <div className="page new-page">
      <header className="page-head">
        <span className="eyebrow">Discover</span>
        <h1>{tab === 'new' ? 'New on Rhea' : tab === 'watchlist' ? 'Your watchlist' : tab === 'gainers' ? 'Top gainers on Rhea' : 'Trending on Rhea'}</h1>
        <p>
          {tab === 'new'
            ? 'The newest tokens with a Rhea pool, launched on Nearly. Live every minute, with the facts that matter before you buy.'
            : tab === 'watchlist'
              ? 'Tokens you starred, with live prices.'
              : tab === 'gainers'
                ? 'Biggest 24h moves among actively traded Rhea tokens with at least $10K liquidity.'
                : 'Tokens with the most trading volume across Rhea pools in the last 24 hours. NEAR and stablecoins are left out.'}
        </p>
      </header>
      <Tabs
        tabs={TABS.map((t) => (t.key === 'watchlist' ? { ...t, count: list.length || undefined } : t))}
        value={tab}
        onChange={(key) => navigate(`/discover?tab=${key}`, { replace: true })}
      />
      <div className="disc-body">
        {tab === 'new' ? <NewLaunches /> : tab === 'watchlist' ? <Watchlist /> : <Trending gainers={tab === 'gainers'} />}
      </div>
      {tab !== 'new' && <p className="muted small">Data: Rhea pools and Intear. Not a recommendation — always check the contract before you buy.</p>}
    </div>
  );
}
