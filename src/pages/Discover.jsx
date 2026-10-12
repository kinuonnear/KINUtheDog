// Discover (/discover, /new): Trending on Rhea, Hot pairs, top Gainers, Best to LP,
// New launches and your Watchlist.

import { useMemo, useState } from 'react';
import { useAsync } from '../hooks.js';
import { Link, navigate, poolPath, useLocation } from '../router.jsx';
import { EmptyState, ErrorNotice, PairIcons, Skeleton, Tabs, TokenIcon } from '../components/ui.jsx';
import WatchStar from '../components/WatchStar.jsx';
import { enrichTokens, getTrending } from '../lib/trending.js';
import { useWatchlist } from '../lib/watchlist.js';
import { formatPercent, formatPrice, formatUsd } from '../lib/format.js';
import { bestToLp, getPoolRadar, hotPairs, LP_MIN_TVL } from '../lib/poolRadar.js';
import { NATIVE_NEAR } from '../config.js';
import { NewLaunches } from './NewOnRhea.jsx';
import { usePoolTokens } from './Pools.jsx';

const TABS = [
  { key: 'trending', label: 'Trending' },
  { key: 'hot', label: 'Hot pairs' },
  { key: 'gainers', label: 'Gainers' },
  { key: 'lp', label: 'Best to LP' },
  { key: 'new', label: 'New launches' },
  { key: 'watchlist', label: 'Watchlist' }
];

const MIN_GAINER_LIQUIDITY = 10_000;

const TITLES = {
  trending: 'Trending on Rhea',
  hot: 'Hot pairs on Rhea',
  gainers: 'Top gainers on Rhea',
  lp: 'Best pools to LP',
  new: 'New on Rhea',
  watchlist: 'Your watchlist'
};

const INTROS = {
  trending: 'Tokens with the most trading volume across Rhea pools in the last 24 hours. NEAR and stablecoins are left out.',
  hot: 'The pairs traded most in the last hour: where the action is right now.',
  gainers: 'Biggest 24h moves among actively traded Rhea tokens with at least $10K liquidity.',
  lp: `Pools that paid their liquidity providers the most fees per dollar in the last 24 hours (TVL ≥ $${LP_MIN_TVL / 1000}K), with how much the price moved.`,
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

/** Pool table shared by Hot pairs and Best to LP: rank, pair, five numbers, one action. */
function PoolTable({ rows, loading, error, onRetry, heads, cells, action, empty }) {
  const tokensOf = usePoolTokens(rows || []);
  if (error && !rows) return <ErrorNotice error={error} onRetry={onRetry} />;
  return (
    <section className="card new-table disc-table">
      <div className="new-row disc-row new-row--head">
        <span>#</span>
        <span>Pair</span>
        {heads.map((h) => (
          <span key={h}>{h}</span>
        ))}
        <span />
      </div>
      {loading && !rows
        ? Array.from({ length: 8 }, (_, i) => (
            <div className="new-row disc-row" key={i}>
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
              <div className="new-row disc-row" key={r.id} onClick={() => navigate(poolPath(r.id))} role="link" tabIndex={0}>
                <span className="disc-row__rank">{i + 1}</span>
                <span className="new-row__token">
                  <PairIcons tokens={tokens} size={26} />
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
                <span className="new-row__buy" onClick={(e) => e.stopPropagation()}>
                  {action(r)}
                </span>
              </div>
            );
          })}
      {rows && !rows.length && empty}
    </section>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented disc-sort">
      {options.map((o) => (
        <button key={o.key} type="button" className={value === o.key ? 'active' : ''} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function HotPairs() {
  const data = useAsync(getPoolRadar, [], { refreshMs: 90_000 });
  const [by, setBy] = useState('volume');
  const rows = useMemo(() => (data.data ? hotPairs(data.data, by) : null), [data.data, by]);
  return (
    <>
      <Segmented
        value={by}
        onChange={setBy}
        options={[
          { key: 'volume', label: 'By volume' },
          { key: 'trades', label: 'By trades' }
        ]}
      />
      <PoolTable
        rows={rows}
        loading={data.loading}
        error={data.error}
        onRetry={data.reload}
        heads={['Volume 1H', 'Trades 1H', 'Price 1H', 'Volume 24H', 'TVL']}
        cells={(r) => [
          formatUsd(r.activity.volume.h1),
          r.activity.trades.h1.toLocaleString(),
          <Change key="c" value={r.activity.change.h1} />,
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
        empty={<p className="muted small new-table__empty">No trading activity in the last hour.</p>}
      />
    </>
  );
}

function BestToLp() {
  const data = useAsync(getPoolRadar, [], { refreshMs: 90_000 });
  const [mode, setMode] = useState('yield');
  const rows = useMemo(() => (data.data ? bestToLp(data.data, mode) : null), [data.data, mode]);
  return (
    <>
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { key: 'yield', label: 'Highest yield' },
          { key: 'balanced', label: 'Yield vs. price swings' }
        ]}
      />
      <PoolTable
        rows={rows}
        loading={data.loading}
        error={data.error}
        onRetry={data.reload}
        heads={['Fees 24H', 'Yield 24H', 'Rhea APR', 'Price 24H', 'TVL']}
        cells={(r) => [
          formatUsd(r.feeVolume24h),
          <b key="y" className="up" title="24h fees ÷ TVL: what $100 of liquidity earned in a day">
            {formatPercent(r.yieldPct, 2)}
          </b>,
          formatPercent(r.apy + r.farmApy),
          <span key="m" className="disc-swing">
            <Change value={r.activity?.change.h24} />
            {r.swing && <em className={`swing swing--${r.swing.key}`}>{r.swing.label}</em>}
          </span>,
          formatUsd(r.tvl)
        ]}
        action={(r) => (
          <Link className="button button--outline button--sm" to={`${poolPath(r.id)}?tab=add`}>
            Add LP
          </Link>
        )}
        empty={<p className="muted small new-table__empty">No pools to show right now.</p>}
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

export default function Discover({ defaultTab = 'trending' }) {
  const { search } = useLocation();
  const tab = TABS.some((t) => t.key === search.get('tab')) ? search.get('tab') : defaultTab;
  const { list } = useWatchlist();

  return (
    <div className="page new-page">
      <header className="page-head">
        <span className="eyebrow">Discover</span>
        <h1>{TITLES[tab]}</h1>
        <p>{INTROS[tab]}</p>
      </header>
      <Tabs
        tabs={TABS.map((t) => (t.key === 'watchlist' ? { ...t, count: list.length || undefined } : t))}
        value={tab}
        onChange={(key) => navigate(`/discover?tab=${key}`, { replace: true })}
      />
      <div className="disc-body">
        {tab === 'new' ? (
          <NewLaunches />
        ) : tab === 'watchlist' ? (
          <Watchlist />
        ) : tab === 'hot' ? (
          <HotPairs />
        ) : tab === 'lp' ? (
          <BestToLp />
        ) : (
          <Trending gainers={tab === 'gainers'} />
        )}
      </div>
      {tab !== 'new' && (
        <p className="muted small">
          {tab === 'hot' || tab === 'lp'
            ? 'Data: Rhea pools and GeckoTerminal. Past fees do not promise future fees, and a concentrated range stops earning when the price leaves it. Not a recommendation.'
            : 'Data: Rhea pools and Intear. Not a recommendation — always check the contract before you buy.'}
        </p>
      )}
    </div>
  );
}
