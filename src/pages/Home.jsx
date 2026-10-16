// App home (/app): where you land after opening KINU. A short hero with your CLMM positions at a
// glance (before a wallet is connected, or with no positions: where the Smart LPs are), live
// prices with their 24h move, quick actions, the three LP steps, and Rhea's deepest and most
// traded pools.

import { useMemo } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import { getDclPositions, searchPools } from '../lib/rhea.js';
import { getTokens, priceOf } from '../lib/tokens.js';
import { enrichTokens } from '../lib/trending.js';
import { loadSmartLps } from '../lib/smartMoney.js';
import { formatPrice, formatUsd, shortAccount } from '../lib/format.js';
import { CONTRACTS, NATIVE_NEAR } from '../config.js';
import { ErrorNotice, Skeleton, TokenIcon } from '../components/ui.jsx';
import { loadBoard } from '../components/SmartLp.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import { PoolRow, PoolRowsSkeleton, usePoolTokens } from './Pools.jsx';
import '../home.css';

// Dollar amounts here read compact from $1K ($661.9K, $13.68M) so the columns line up.
const K = { compactAbove: 1e3 };
const SMART_MONEY_PATH = '/discover?tab=smartmoney';

const TICKER_TOKENS = [NATIVE_NEAR.id, 'kinu-3.nearlytrade.near', 'token.rhealab.near', 'meta-pool.near', 'nbtc.bridge.near'];
const marketId = (id) => (id === NATIVE_NEAR.id ? CONTRACTS.wrapNear : id);

/** A price short enough for a chip: compact from $1K, full precision for tiny prices. */
const chipPrice = (p) => (p >= 1000 ? formatUsd(p, K) : formatPrice(p));

function Change({ value }) {
  if (!Number.isFinite(value)) return null;
  return (
    <small className={value > 0 ? 'up' : value < 0 ? 'down' : ''}>
      {value > 0 ? '+' : ''}
      {value.toFixed(1)}%
    </small>
  );
}

/* ------------------------------------------------------------------ */
/* Live prices                                                          */
/* ------------------------------------------------------------------ */

function Ticker() {
  const { prices } = useApp();
  const tokens = useAsync(() => getTokens(TICKER_TOKENS), []);
  const market = useAsync(() => enrichTokens(TICKER_TOKENS.map(marketId)), [], { refreshMs: 120_000 });
  const changeOf = (id) => market.data?.find((m) => m.id === marketId(id))?.change24h;
  const items = (copy) =>
    TICKER_TOKENS.map((id) => {
      const token = id === NATIVE_NEAR.id ? NATIVE_NEAR : tokens.data?.[id];
      const price = prices?.get(id)?.price;
      return (
        <Link
          key={`${copy}-${id}`}
          to={`/swap?from=${id === NATIVE_NEAR.id ? 'usdt.tether-token.near' : NATIVE_NEAR.id}&to=${id}`}
          className="ticker__item"
          tabIndex={copy ? -1 : undefined}
        >
          <TokenIcon token={token || { symbol: prices?.get(id)?.symbol || '?' }} size={22} />
          <span>{token?.symbol || prices?.get(id)?.symbol || '…'}</span>
          <strong>{price ? chipPrice(price) : <Skeleton width={50} />}</strong>
          <Change value={changeOf(id)} />
        </Link>
      );
    });
  // Marquee: the list is rendered twice and the track slides by half its width, so it loops
  // seamlessly. Pauses on hover; still for users who prefer reduced motion.
  return (
    <div className="ticker ticker--marquee">
      <div className="ticker__track">
        <div className="ticker__set">{items(0)}</div>
        <div className="ticker__set" aria-hidden="true">
          {items(1)}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hero panel: your positions, or where the Smart LPs are               */
/* ------------------------------------------------------------------ */

function PanelSkeleton({ title }) {
  return (
    <aside className="hm-panel">
      <div className="hm-panel__head">
        <span>{title}</span>
      </div>
      <Skeleton width="70%" height={28} />
      <Skeleton width="100%" height={18} />
      <Skeleton width="100%" height={18} />
      <Skeleton width="80%" height={18} />
    </aside>
  );
}

/** The connected account's CLMM positions: value, unclaimed fees, in range or not, per pool. */
function PositionsPanel({ accountId, fallback }) {
  const { prices } = useApp();
  const positions = useAsync(() => getDclPositions(accountId), [accountId], { refreshMs: 120_000 });
  const list = positions.data || [];
  const ids = useMemo(() => [...new Set(list.flatMap((p) => [p.tokenX, p.tokenY]))].sort(), [list]);
  const tokens = useAsync(() => getTokens(ids), [ids.join(',')], { enabled: ids.length > 0 });

  const summary = useMemo(() => {
    if (!tokens.data || !list.length) return null;
    const usdOf = (id, raw) => (Number(raw) / 10 ** (tokens.data[id]?.decimals ?? 24)) * priceOf(prices, id);
    const pools = new Map();
    for (const p of list) {
      const value = usdOf(p.tokenX, p.amountX) + usdOf(p.tokenY, p.amountY);
      const fees = usdOf(p.tokenX, p.unclaimedFeeX) + usdOf(p.tokenY, p.unclaimedFeeY);
      const row = pools.get(p.poolId) || { poolId: p.poolId, tokens: [p.tokenX, p.tokenY], value: 0, fees: 0, total: 0, inRange: 0 };
      row.value += value;
      row.fees += fees;
      row.total += 1;
      row.inRange += p.inRange ? 1 : 0;
      pools.set(p.poolId, row);
    }
    const rows = [...pools.values()].sort((a, b) => b.value - a.value);
    return {
      rows,
      value: rows.reduce((s, r) => s + r.value, 0),
      fees: rows.reduce((s, r) => s + r.fees, 0),
      total: list.length,
      inRange: list.filter((p) => p.inRange).length
    };
  }, [list, tokens.data, prices]);

  if (positions.loading && !positions.data) return <PanelSkeleton title="Your positions" />;
  if (positions.error && !positions.data) return fallback;
  if (!list.length) return fallback;
  if (!summary) return <PanelSkeleton title="Your positions" />;

  const out = summary.total - summary.inRange;
  const symbol = (id) => (id === CONTRACTS.wrapNear ? 'NEAR' : tokens.data[id]?.symbol || '…');
  return (
    <aside className="hm-panel">
      <div className="hm-panel__head">
        <span>Your positions</span>
        <Link to="/portfolio">Portfolio →</Link>
      </div>
      <dl className="hm-panel__stats">
        <div>
          <dt>Value</dt>
          <dd>{formatUsd(summary.value, K)}</dd>
        </div>
        <div>
          <dt>Unclaimed fees</dt>
          <dd className="up">{formatUsd(summary.fees, K)}</dd>
        </div>
        <div>
          <dt>In range</dt>
          <dd>
            {summary.inRange}
            <small> / {summary.total}</small>
          </dd>
        </div>
      </dl>
      <ul className="hm-panel__list">
        {summary.rows.slice(0, 3).map((r) => (
          <li key={r.poolId}>
            <Link to={poolPath(r.poolId)}>
              <i className={r.inRange === r.total ? 'is-in' : r.inRange ? 'is-part' : 'is-out'} aria-hidden="true" />
              <b>{r.tokens.map(symbol).join(' / ')}</b>
              <small>
                {r.inRange === r.total ? 'In range' : r.inRange ? `${r.inRange} of ${r.total} in range` : 'Out of range'}
              </small>
              <span>{formatUsd(r.value, K)}</span>
            </Link>
          </li>
        ))}
        {summary.rows.length > 3 && (
          <li className="hm-panel__more">
            <Link to="/portfolio">
              +{summary.rows.length - 3} more pool{summary.rows.length - 3 === 1 ? '' : 's'} · Portfolio →
            </Link>
          </li>
        )}
      </ul>
      {out > 0 && (
        <p className="hm-panel__note">
          {out === 1 ? 'One position is' : `${out} positions are`} out of range and earning nothing.{' '}
          <Link to="/portfolio">Rebalance →</Link>
        </p>
      )}
    </aside>
  );
}

/** The tokens the Smart LP wallets hold the most liquidity in, right now. */
function SmartMoneyPanel() {
  const board = useAsync(loadBoard, []);
  const lps = useAsync(() => loadSmartLps(board.data), [board.data?.generatedAt], { enabled: Boolean(board.data) });
  const top = useMemo(
    () =>
      lps.data
        ? [...lps.data.entries()]
            .filter(([id]) => id !== CONTRACTS.wrapNear)
            .sort((a, b) => b[1].lps.length - a[1].lps.length || b[1].valueUsd - a[1].valueUsd)
            .slice(0, 4)
        : null,
    [lps.data]
  );
  const ids = top ? top.map(([id]) => id) : [];
  const market = useAsync(() => enrichTokens(ids), [ids.join(',')], { enabled: ids.length > 0 });
  const byId = useMemo(() => new Map((market.data || []).map((m) => [m.id, m])), [market.data]);

  if (!top) return <PanelSkeleton title="Smart money is in" />;
  return (
    <aside className="hm-panel">
      <div className="hm-panel__head">
        <span>Smart money is in</span>
        <Link to={SMART_MONEY_PATH}>See all →</Link>
      </div>
      <ul className="hm-panel__list hm-panel__list--tokens">
        {top.map(([id, smart]) => {
          const m = byId.get(id);
          const token = m?.token || { id, symbol: id.split('.')[0].toUpperCase() };
          return (
            <li key={id}>
              <Link to={SMART_MONEY_PATH}>
                <TokenIcon token={token} size={28} />
                <b>{token.symbol}</b>
                <small>
                  {m?.price ? formatPrice(m.price) : '—'} <Change value={m?.change24h} />
                </small>
                <span>
                  {smart.lps.length} <em>Smart LPs</em>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="hm-panel__note">Wallets from the Smart LP board with liquidity in these tokens’ pools now.</p>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Pools                                                                */
/* ------------------------------------------------------------------ */

function TopPools({ title, sort }) {
  const result = useAsync(() => searchPools({ sort, limit: 5 }), [sort], { refreshMs: 60_000 });
  const tokensOf = usePoolTokens(result.data?.list);
  return (
    <section className="card top-pools">
      <div className="card-head">
        <h3>{title}</h3>
        <Link to="/pools" className="link-button">
          All pools →
        </Link>
      </div>
      <ErrorNotice error={result.error} onRetry={result.reload} />
      <div className="pool-table pool-table--compact">
        <div className="pool-row hm-pool-head" aria-hidden="true">
          <span>Pool</span>
          <span>TVL</span>
          <span>Vol 24h</span>
          <span>APR</span>
        </div>
        {result.loading && !result.data ? (
          <PoolRowsSkeleton rows={5} />
        ) : (
          result.data?.list.map((pool) => <PoolRow key={pool.id} pool={pool} tokensOf={tokensOf} usdOpts={K} />)
        )}
      </div>
    </section>
  );
}

const ACTIONS = [
  ['⇄', 'Swap', 'The best route across NEAR', '/swap'],
  ['◎', 'Smart LP', 'The wallets that earn as LPs', '/discover?tab=smartlp'],
  ['≋', 'Pools', 'Every pool on NEAR, by fees earned', '/pools'],
  ['◔', 'Portfolio & PnL', 'Positions, fees and PnL in one view', '/portfolio']
];

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function Home() {
  const { accountId, connect, walletReady } = useApp();
  const totals = useAsync(() => searchPools({ limit: 100, hideLow: true }), []);
  const trackedTvl = totals.data?.list.reduce((sum, p) => sum + p.tvl, 0);
  const trackedVolume = totals.data?.list.reduce((sum, p) => sum + p.volume24h, 0);

  return (
    <div className="home">
      <section className="hero hm-hero">
        <FlowLines />
        <div className="hm-hero__grid">
          <div className="hero__content">
            <span className="hm-kicker">
              <i aria-hidden /> KINU · Built on NEAR
            </span>
            {accountId && (
              <p className="hm-welcome">
                Welcome back, <b>{shortAccount(accountId, 14, 6)}</b>
              </p>
            )}
            <h1>
              Liquidity, with a <em>sense of direction.</em>
            </h1>
            <p>Find the pools that pay, draw your range or zap in with one token, then rebalance and compound in one click.</p>
            <div className="hero__actions">
              <Link to="/discover" className="button button--primary button--lg">
                Explore Top Yields
              </Link>
              <Link to="/pools" className="button button--outline button--lg">
                Add liquidity
              </Link>
              {!accountId && (
                <button type="button" className="button button--ghost button--lg" onClick={connect} disabled={!walletReady}>
                  Connect wallet
                </button>
              )}
            </div>
            <div className="hero__stats">
              <div>
                <span>TVL · top 100 pools</span>
                <strong>{trackedTvl !== undefined ? formatUsd(trackedTvl) : <Skeleton width={110} height={26} />}</strong>
              </div>
              <div>
                <span>24h volume</span>
                <strong>{trackedVolume !== undefined ? formatUsd(trackedVolume) : <Skeleton width={110} height={26} />}</strong>
              </div>
              <div>
                <span>Pools</span>
                <strong>{totals.data ? totals.data.total.toLocaleString() : <Skeleton width={60} height={26} />}</strong>
              </div>
            </div>
          </div>
          {accountId ? <PositionsPanel accountId={accountId} fallback={<SmartMoneyPanel />} /> : <SmartMoneyPanel />}
        </div>
      </section>

      <Ticker />

      <section className="hm-actions">
        {ACTIONS.map(([icon, title, text, to]) => (
          <Link key={title} to={to} className="hm-action card">
            <span className="hm-action__icon" aria-hidden="true">
              {icon}
            </span>
            <span>
              <b>{title}</b>
              <small>{text}</small>
            </span>
            <i aria-hidden="true">→</i>
          </Link>
        ))}
      </section>

      <section className="lp-steps card">
        <div className="lp-steps__head">
          <span className="eyebrow eyebrow--glow">Smart LP setup</span>
          <h2>Concentrated liquidity in three steps</h2>
        </div>
        <ol className="lp-steps__list">
          <li>
            <b>1</b>
            <div>
              <h4>Pick a pool</h4>
              <p>Filter by AMM, CLMM, ALMM, Stable or Farm and sort by fees earned over the last hours.</p>
            </div>
          </li>
          <li>
            <b>2</b>
            <div>
              <h4>Shape your range</h4>
              <p>Drag Min / Max on the chart or type prices. Spot, Curve or Bid-Ask spreads your liquidity into bins.</p>
            </div>
          </li>
          <li>
            <b>3</b>
            <div>
              <h4>Deposit &amp; track</h4>
              <p>Add both tokens or zap in with one. Claim fees, add or remove in place, and follow PnL per position.</p>
            </div>
          </li>
        </ol>
        <Link to="/pools" className="button button--primary">
          Start an LP position
        </Link>
      </section>

      <div className="home-grid">
        <TopPools title="Deepest pools" sort="tvl" />
        <TopPools title="Most traded · 24h" sort="volume_24h" />
      </div>
    </div>
  );
}
