import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useChainUpdates, useElementHeight, useLocalStorage, useMediaQuery } from '../hooks.js';
import { Link, poolsReturnPath, useLocation } from '../router.jsx';
import { parseLpLink } from '../lib/lpLink.js';
import { getDclPositions, getFarmStakes, getPool, getPoolShares, getPoolStats, dclPointToPrice, parseDclPoolId } from '../lib/rhea.js';
import { asPoolToken, getToken, getTokens, priceOf } from '../lib/tokens.js';
import { view } from '../lib/rpc.js';
import { useLiveDclPool } from '../lib/liveEvents.js';
import { positionsAtPoint } from '../lib/dclLiquidity.js';
import AprValue from '../components/AprValue.jsx';
import FeeTiers from '../components/FeeTiers.jsx';
import AmmPnl from '../components/AmmPnl.jsx';
import { amountsForShares, isStableKind } from '../lib/liquidity.js';
import { AmmLiquidity, DclLiquidity, FeeCompoundNote, StableLiquidity } from '../components/Liquidity.jsx';
import { DclGroupCard } from '../components/DclPositions.jsx';
import PositionPanel from '../components/PositionPanel.jsx';
import { useDepositGroups } from '../lib/lpPositions.js';
import { useDclRange } from '../components/DclCreatePosition.jsx';
import { fetchTrades, quoteRank } from '../lib/intear.js';

const RangeChart = lazy(() => import('../components/RangeChart.jsx'));
const SwapChart = lazy(() => import('../components/swap/SwapChart.jsx'));
import { formatAmount, formatChartPrice, formatPercent, formatRawAmount, formatUsd, shortAccount, toBigInt, toNumber } from '../lib/format.js';
import { CONTRACTS, ENDPOINTS, NATIVE_NEAR } from '../config.js';
import { CopyButton, EmptyState, ErrorNotice, PairIcons, Skeleton, Spinner, Tabs, TokenIcon } from '../components/ui.jsx';

const LIVE_FEES_MS = 15_000; // your positions' claimable fees

/** Pool page on app.rhea.finance, for users who want the original UI. */
function rheaPoolUrl(pool) {
  if (pool.kind === 'DCL') {
    const { tokenX, tokenY, fee } = parseDclPoolId(pool.id);
    return `${ENDPOINTS.rheaApp}/poolV2/${encodeURIComponent(`${tokenX}<>${tokenY}`)}@${fee}`;
  }
  return `${ENDPOINTS.rheaApp}/${isStableKind(pool.kind) ? 'sauce' : 'pool'}/${pool.id}`;
}

/**
 * Phones: the liquidity form sits below the chart and pool data. A floating button jumps to it,
 * and steps aside while the form is on screen.
 */
function MobileAddCta({ targetId, label = '+ Add liquidity' }) {
  const [formVisible, setFormVisible] = useState(false);
  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target || typeof IntersectionObserver === 'undefined') return undefined;
    // Any part of the form on screen: the button steps aside (a tall form never reaches a share).
    const observer = new IntersectionObserver(([entry]) => setFormVisible(entry.isIntersecting), { threshold: 0 });
    observer.observe(target);
    return () => observer.disconnect();
  });
  return (
    <button
      type="button"
      className={`mobile-add-cta ${formVisible ? 'mobile-add-cta--hidden' : ''}`}
      onClick={() => document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      tabIndex={formVisible ? -1 : 0}
      aria-hidden={formVisible}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Classic / stable pool page                                          */
/* ------------------------------------------------------------------ */

function ClassicPool({ poolId, initialTab }) {
  const { accountId, prices } = useApp();

  const poolQuery = useAsync(() => getPool(poolId), [poolId], { refreshMs: 30_000 });
  const stats = useAsync(() => getPoolStats(poolId), [poolId]);
  const pool = poolQuery.data;
  const tokenQuery = useAsync(() => getTokens(pool.tokenIds), [pool?.tokenIds.join()], { enabled: Boolean(pool) });
  const position = useAsync(
    async () => {
      const [shares, stakes] = await Promise.all([getPoolShares(poolId, accountId), getFarmStakes(accountId)]);
      return { shares, staked: stakes[String(poolId)] || '0' };
    },
    [poolId, accountId],
    { enabled: Boolean(accountId), refreshMs: LIVE_FEES_MS }
  );
  useChainUpdates(() => position.reload());
  // Price of a stable / ALMM pool: what a small swap of token 0 returns (fee added back).
  const curved = pool && pool.kind !== 'SIMPLE_POOL' && pool.tokenIds.length === 2;
  const curvePrice = useAsync(
    async () => {
      const [a, b] = await Promise.all(pool.tokenIds.map((id) => getToken(id)));
      const amountIn = 10n ** BigInt(Math.max(0, (a?.decimals ?? 0) - 2)); // 0.01 token
      const out = await view(CONTRACTS.exchange, 'get_return', { pool_id: Number(poolId), token_in: pool.tokenIds[0], amount_in: amountIn.toString(), token_out: pool.tokenIds[1] });
      const rate = toNumber(out, b?.decimals ?? 0) / toNumber(amountIn.toString(), a?.decimals ?? 0);
      const fee = (pool.feePercent || 0) / 100;
      return rate > 0 ? rate / (1 - fee) : null;
    },
    [poolId, curved],
    { enabled: Boolean(curved), refreshMs: 30_000 }
  );

  if (poolQuery.error && !pool) {
    return <EmptyState icon="⚠" title={`Pool #${poolId} could not be loaded`}>{poolQuery.error.message}</EmptyState>;
  }
  if (!pool || !tokenQuery.data) return <PoolSkeleton />;

  const tokens = pool.tokenIds.map((id) => asPoolToken(tokenQuery.data[id] || { id, symbol: id.slice(0, 6), decimals: 0 }));
  const reserves = pool.amounts.map((a, i) => toNumber(a, tokens[i].decimals));
  const reserveUsd = reserves.map((r, i) => r * priceOf(prices, pool.tokenIds[i]));
  const tvl = stats.data?.tvl || reserveUsd.reduce((a, b) => a + b, 0);
  const supply = toBigInt(pool.sharesTotalSupply);

  const userShares = toBigInt(position.data?.shares || '0');
  const userStaked = toBigInt(position.data?.staked || '0');
  const userTotal = userShares + userStaked;
  const userPct = supply > 0n ? (Number(userTotal) / Number(supply)) * 100 : 0;
  const userAmounts = amountsForShares(pool, userTotal.toString());
  const userUsd = userAmounts.reduce((sum, a, i) => sum + toNumber(a, tokens[i].decimals) * priceOf(prices, pool.tokenIds[i]), 0);

  const isSimple = pool.kind === 'SIMPLE_POOL';
  // Simple pools: the reserve ratio. Stable / ALMM pools price along a curve, so the reserve
  // ratio is meaningless there: they use a small on-chain quote instead (curvePrice below).
  const spot = isSimple && reserves[0] > 0 && reserves.length === 2 ? reserves[1] / reserves[0] : (curvePrice.data ?? null);

  const refresh = () => {
    poolQuery.reload();
    position.reload();
  };

  // Chart: the pool's own candles (GeckoTerminal lists Rhea classic pools as refv1-<id>), the
  // main token priced against the other one.
  // The less quote-like token is charted (NEAR/USDC → NEAR in USDC; KINU/NEAR → KINU).
  const [chartBase, chartQuote] =
    tokens[1] && quoteRank(tokens[0]?.id) > quoteRank(tokens[1].id) ? [tokens[1], tokens[0]] : [tokens[0], tokens[1]];
  const chartPools =
    tokens.length === 2
      ? [
          {
            address: `refv1-${pool.id}`,
            name: `${chartBase.symbol} / ${chartQuote.symbol}`,
            fee: formatPercent(pool.feePercent, pool.feePercent < 0.1 ? 3 : 2),
            rheaId: String(pool.id),
            dex: 'rhea-finance',
            tvl,
            baseId: chartBase.id,
            quoteId: chartQuote.id
          }
        ]
      : null;

  return (
    <div className="classic-pool">
      {/* The same pool bar as CLMM pages: pair, price, live stats and actions in one row. */}
      <PoolBar
        tokens={tokens}
        label={pool.label}
        feePercent={pool.feePercent}
        idText={`#${pool.id}`}
        poolId={pool.id}
        rheaUrl={rheaPoolUrl(pool)}
        swapLink={tokens.length >= 2 ? `/swap?from=${tokens[0].id === CONTRACTS.wrapNear ? NATIVE_NEAR.id : tokens[0].id}&to=${tokens[1].id}` : null}
        price={spot !== null ? { value: spot, x: tokens[0], y: tokens[1] } : null}
        stats={[
          tvl < 1 ? { label: 'Total value locked', value: 'Empty pool', hint: 'be the first LP' } : { label: 'Total value locked', value: formatUsd(tvl) },
          { label: '24h volume', value: stats.data ? formatUsd(stats.data.volume24h) : '-' },
          { label: '24h fees', value: stats.data ? formatUsd(stats.data.feeVolume24h) : '-' },
          { label: '24h fees / TVL', value: stats.data && tvl >= 1 ? formatPercent((stats.data.feeVolume24h / tvl) * 100) : '-' },
          { label: 'Trading fee', value: formatPercent(pool.feePercent, pool.feePercent < 0.1 ? 3 : 2) },
          {
            label: 'Fee APR',
            value: stats.data ? <AprValue apr={stats.data.apy} tokenIds={pool.tokenIds} estimated={stats.data.apyEstimated} /> : '-',
            accent: true
          }
        ]}
      />

      <div className="pool-grid">
        <div className="pool-grid__main">
          {chartPools && (
            <Suspense fallback={<div className="card chart-card chart-card--loading"><Spinner size={22} /></div>}>
              <SwapChart
                token={chartBase}
                counter={chartQuote}
                pools={chartPools}
                height={380}
                corner={<CompositionBadge reserves={tokens.map((token, i) => [token, reserves[i], reserveUsd[i]])} />}
              />
            </Suspense>
          )}
          {/* Reserves with the pool contract under it, one column beside Your position. */}
          <div className="classic-card--half classic-stack">
            {/* With a chart, phones read the reserves on it (CompositionBadge) and skip this card. */}
            <section className={chartPools ? 'card pool-reserves' : 'card'}>
              <h3 className="card-title">Reserves</h3>
              <div className="reserves">
                {tokens.map((token, i) => {
                  const share = tvl > 0 ? (reserveUsd[i] / reserveUsd.reduce((a, b) => a + b, 0)) * 100 : 0;
                  return (
                    <div className="reserve" key={token.id}>
                      <TokenIcon token={token} size={32} />
                      <div className="reserve__body">
                        <strong>{formatAmount(reserves[i])} {token.symbol}</strong>
                        <small>
                          {formatUsd(reserveUsd[i])} · {shortAccount(token.id, 12, 8)} <CopyButton text={token.id} />
                        </small>
                      </div>
                      <span className="reserve__pct">{Number.isFinite(share) ? `${share.toFixed(1)}%` : ''}</span>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="card">
              <h3 className="card-title">Pool contract</h3>
              <dl className="kv">
                <div>
                  <dt>Exchange</dt>
                  <dd className="mono">{CONTRACTS.exchange}</dd>
                </div>
                <div>
                  <dt>Pool kind</dt>
                  <dd className="mono">{pool.kind}</dd>
                </div>
                {pool.amp > 0 && (
                  <div>
                    <dt>Amplification</dt>
                    <dd>{pool.amp}</dd>
                  </div>
                )}
                <div>
                  <dt>LP supply</dt>
                  <dd>{formatRawAmount(pool.sharesTotalSupply, 24)}</dd>
                </div>
              </dl>
            </section>
          </div>

          {accountId && (
            <section className="card classic-card--half">
              <h3 className="card-title">Your position</h3>
              <FeeCompoundNote />
              {position.loading && !position.data ? (
                <Skeleton height={40} />
              ) : userTotal === 0n ? (
                <p className="muted">You don&apos;t have liquidity in this pool yet.</p>
              ) : (
                <div className="position">
                  <div className="position__value">
                    <strong>{formatUsd(userUsd)}</strong>
                    <span className="muted">{formatPercent(userPct, 4)} of pool</span>
                  </div>
                  <dl className="kv">
                    {tokens.map((token, i) => (
                      <div key={token.id}>
                        <dt>{token.symbol}</dt>
                        <dd>{formatRawAmount(userAmounts[i], token.decimals)}</dd>
                      </div>
                    ))}
                    {userStaked > 0n && (
                      <div>
                        <dt>Staked in farm</dt>
                        <dd>{formatPercent((Number(userStaked) / Number(userTotal)) * 100)}</dd>
                      </div>
                    )}
                  </dl>
                  <AmmPnl accountId={accountId} pool={pool} tokens={tokens} userAmounts={userAmounts} userShares={userTotal.toString()} prices={prices} />
                </div>
              )}
            </section>
          )}

          {pool.tokenIds.length === 2 && (
            <section className="card classic-card--full">
              <h3 className="card-title">Fee tiers for this pair</h3>
              <FeeTiers tokenIds={pool.tokenIds} currentId={String(poolId)} />
            </section>
          )}

        </div>

        <aside className="pool-grid__side">
          <section className="card" id="pool-liquidity">
            {isSimple ? (
              <AmmLiquidity
                pool={pool}
                initialTab={initialTab}
                tokens={tokens}
                shares={position.data?.shares || '0'}
                staked={position.data?.staked || '0'}
                onDone={refresh}
              />
            ) : isStableKind(pool.kind) ? (
              <StableLiquidity
                pool={pool}
                initialTab={initialTab}
                tokens={tokens}
                shares={position.data?.shares || '0'}
                staked={position.data?.staked || '0'}
                onDone={refresh}
              />
            ) : (
              <EmptyState icon="⚖" title={`${pool.label} pool`}>
                This pool type can&apos;t be managed here yet.
              </EmptyState>
            )}
          </section>
        </aside>
      </div>
      <MobileAddCta targetId="pool-liquidity" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Concentrated liquidity (DCL) pool page                              */
/* ------------------------------------------------------------------ */

function DclPool({ poolId, initialTab }) {
  const { accountId, prices } = useApp();
  const { tokenX, tokenY, fee } = parseDclPoolId(poolId);
  const tokenQuery = useAsync(() => getTokens([tokenX, tokenY]), [tokenX, tokenY]);
  // Live pool state: the price moves between quoting and signing, so the deposit form follows it.
  // Pushed by Intear's event stream when it is connected, polled otherwise (lib/liveEvents.js).
  const chain = useLiveDclPool(poolId);
  const stats = useAsync(() => getPoolStats(poolId), [poolId]);
  const positions = useAsync(
    async () => (await getDclPositions(accountId)).filter((p) => p.poolId === poolId),
    [poolId, accountId],
    // Unclaimed fees grow all the time: re-read every 30 s.
    { enabled: Boolean(accountId), refreshMs: 30_000 }
  );
  // Between reads, the positions follow the live pool price (lib/liveEvents.js): their token
  // amounts and in-range status move with it instead of waiting for the next read.
  const livePoint = chain.data?.current_point;
  const liveData = useMemo(
    () => (positions.data && Number.isFinite(livePoint) ? positionsAtPoint(positions.data, livePoint) : positions.data),
    [positions.data, livePoint]
  );
  const shownPositions = { ...positions, data: liveData };

  const refresh = () => {
    chain.reload();
    positions.reload();
  };
  // A wallet that finished a request after reporting it closed or failed (state.jsx follow-up).
  useChainUpdates(refresh);
  // On wide screens the form is already in view in the side panel, so scrolling alone shows nothing:
  // the form also flashes, and (from a button, on desktop) its first amount field takes the focus.
  const scrollToForm = ({ focus = false } = {}) => {
    const form = document.getElementById('new-position');
    if (!form) return;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.classList.remove('is-flash');
    void form.offsetWidth; // restart the animation
    form.classList.add('is-flash');
    setTimeout(() => form.classList.remove('is-flash'), 1300);
    if (focus && window.matchMedia('(min-width: 1081px)').matches) {
      setTimeout(() => form.querySelector('input:not([disabled])')?.focus({ preventScroll: true }), 350);
    }
  };

  // Deep link from the portfolio "Add" button: /pools/<id>?tab=add
  useEffect(() => {
    if (initialTab === 'add' && chain.data && tokenQuery.data) setTimeout(scrollToForm, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab, Boolean(chain.data && tokenQuery.data)]);

  if (chain.error && !chain.data) {
    return <EmptyState icon="⚠" title="Pool could not be loaded">{chain.error.message}</EmptyState>;
  }
  if (!tokenQuery.data?.[tokenX] || !tokenQuery.data?.[tokenY] || !chain.data) return <PoolSkeleton />;

  const x = asPoolToken(tokenQuery.data[tokenX]);
  const y = asPoolToken(tokenQuery.data[tokenY]);
  const price = dclPointToPrice(chain.data.current_point, x.decimals, y.decimals);
  const totalX = toNumber(chain.data.total_x || '0', x.decimals);
  const totalY = toNumber(chain.data.total_y || '0', y.decimals);
  const usdX = totalX * priceOf(prices, tokenX);
  const usdY = totalY * priceOf(prices, tokenY);
  // The pool's own reserves when both tokens have a price (Rhea's API can't price tokens off its
  // list, e.g. KINU, and then reports ~0); Rhea's number otherwise.
  const priced = priceOf(prices, tokenX) > 0 && priceOf(prices, tokenY) > 0;
  const tvl = priced ? usdX + usdY : stats.data?.tvl || usdX + usdY;
  // No liquidity in range and (almost) nothing deposited: say so instead of "<$0.000001".
  const empty = String(chain.data.liquidity || '0') === '0' && tvl < 1;

  return (
    <div className="terminal">
      <DclWorkspace
        bar={
      <PoolBar
        tokens={[x, y]}
        label="CLMM"
        feePercent={fee / 10000}
        poolId={poolId}
        actions={false}
        price={{ value: price, x, y }}
        stats={[
          empty
            ? { label: 'Total value locked', value: 'Empty pool', hint: 'be the first LP' }
            : { label: 'Total value locked', value: formatUsd(tvl) },
          // Fee APR early (the bar shares the chart column); the trading fee is the chip by the pair.
          { label: 'Fee APR', value: stats.data ? <AprValue apr={stats.data.apy} tokenIds={[tokenX, tokenY]} estimated={stats.data.apyEstimated} /> : '-', accent: true },
          { label: '24h volume', value: stats.data ? formatUsd(stats.data.volume24h) : '-' },
          { label: '24h fees', value: stats.data ? formatUsd(stats.data.feeVolume24h) : '-' },
          { label: '24h fees / TVL', value: stats.data && tvl > 0 && !empty ? formatPercent((stats.data.feeVolume24h / tvl) * 100) : '-' }
        ]}
      />
        }
        links={{ swap: `/swap?from=${tokenX}&to=${tokenY}`, rhea: rheaPoolUrl({ kind: 'DCL', id: poolId }) }}
        poolId={poolId}
        pool={chain.data}
        x={x}
        y={y}
        reserves={[
          [x, totalX, usdX],
          [y, totalY, usdY]
        ]}
        positions={shownPositions}
        onAdd={() => scrollToForm({ focus: true })}
        onDone={refresh}
      />
      <MobileAddCta targetId="new-position" />
    </div>
  );
}

const DOCK_TOP = 76;
// Share of the left column given to the chart (the rest is the data panel).
const DEFAULT_SPLIT = 0.68;
const MIN_SPLIT = 0.3;
const MIN_CHART_PX = 340;
const MIN_PANEL_PX = 150;
// Create position panel width when dragged: the chart column keeps at least MIN_MAIN_PX.
const MIN_SIDE_PX = 380;
const MAX_SIDE_PX = 760;
const MIN_MAIN_PX = 560;
const MAX_SPLIT = 0.9; // px below the viewport top where the workspace docks (top bar + gap)

/**
 * Independent wheel scrolling for the two workspace columns (desktop):
 * the page scrolls until the workspace is docked under the top bar, then the
 * hovered column scrolls on its own; scrolling up past a column's top scrolls
 * the page back. Over the price chart the wheel zooms the chart instead; over the
 * data panel it scrolls the whole column (chart and data together).
 */
function useDockedColumns(gridRef) {
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return undefined;
    const columns = [...grid.children];
    const onWheel = (event) => {
      if (window.innerWidth <= 1080 || event.ctrlKey) return;
      if (event.target.closest?.('.range-chart__canvas')) return; // chart zooms
      const top = grid.getBoundingClientRect().top;
      const column = event.currentTarget;
      const pageCanScroll = document.documentElement.scrollHeight - window.innerHeight - window.scrollY > 1;
      if (event.deltaY > 0 && pageCanScroll && top > DOCK_TOP + 1) {
        event.preventDefault();
        window.scrollBy({ top: Math.min(event.deltaY, top - DOCK_TOP) });
      } else if (event.deltaY < 0 && column.scrollTop <= 0 && window.scrollY > 0) {
        event.preventDefault();
        window.scrollBy({ top: event.deltaY });
      }
    };
    columns.forEach((c) => c.addEventListener('wheel', onWheel, { passive: false }));
    return () => columns.forEach((c) => c.removeEventListener('wheel', onWheel));
  }, [gridRef]);
}

/**
 * CLMM page body: draggable range chart + Meteora-style create form. `bar`: the pool bar, shown
 * above the chart (the side panel reaches the top); `links`: Swap / Rhea in the panel head.
 */
/** The pool's two tokens and their share of its value, in the chart's top-right corner. */
function CompositionBadge({ reserves }) {
  const total = reserves.reduce((sum, [, , usd]) => sum + (Number(usd) || 0), 0);
  if (!(total > 0)) return null;
  const pct = reserves.map(([, , usd]) => ((Number(usd) || 0) / total) * 100);
  return (
    <div className="pool-comp" title="Pool composition">
      {reserves.map(([token, amount], i) => (
        <div className="pool-comp__row" key={token.id}>
          <TokenIcon token={token} size={14} />
          <b>{formatAmount(amount, { compactAbove: 1e5 })}</b>
          <span>{token.symbol}</span>
          <em>{pct[i].toFixed(0)}%</em>
        </div>
      ))}
      {reserves.length === 2 && (
        <i className="pool-comp__bar">
          <span style={{ width: `${pct[0]}%` }} />
        </i>
      )}
    </div>
  );
}

function DclWorkspace({ bar, links, poolId, pool, x, y, reserves, positions, onAdd, onDone }) {
  const { accountId } = useApp();
  // ?left=&right= (points): open the form on that range — Smart LP's "Use this range".
  const { search } = useLocation();
  // ?range=10 (an LP link, lib/lpLink.js): ±10% around the price now; ?below= / ?above=: one-sided.
  const [initialRange] = useState(() => {
    const left = Number(search.get('left'));
    const right = Number(search.get('right'));
    if (search.has('left') && search.has('right') && Number.isInteger(left) && Number.isInteger(right) && right > left) return { left, right };
    const link = parseLpLink(search);
    if (link?.below) return { below: link.below };
    if (link?.above) return { above: link.above };
    return link?.range ? { preset: link.range } : null;
  });
  const rangeState = useDclRange(pool, x, y, initialRange);
  // Phones opened from an LP link (e.g. the Telegram bot) go straight to the filled-in form.
  useEffect(() => {
    if (!parseLpLink(search) || window.matchMedia('(min-width: 1081px)').matches) return undefined;
    const timer = setTimeout(() => document.getElementById('new-position')?.scrollIntoView({ block: 'start' }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onDrag = (side, price) => rangeState.setEdge(side, { price });
  const gridRef = useRef(null);
  useDockedColumns(gridRef);
  const [panel, setPanel] = useState(accountId ? 'liquidity' : 'composition');
  // One position per deposit (Meteora-style); click one to show its range on the chart.
  const deposits = useDepositGroups(accountId, positions.data);
  const [chartKey, setChartKey] = useState(null);
  const chartGroup = deposits.groups.find((g) => g.key === chartKey);
  const mine = chartGroup
    ? chartGroup.positions.map((p) => ({
        min: dclPointToPrice(p.leftPoint, x.decimals, y.decimals),
        max: dclPointToPrice(p.rightPoint, x.decimals, y.decimals),
        inRange: p.inRange
      }))
    : null;
  // The selected position is also the one managed in the side panel (Add liquidity / Rebalance).
  // The view the panel opens on ('add' | 'remove'); the nonce re-applies it when the same position is picked again.
  const [panelView, setPanelView] = useState({ view: 'add', nonce: 0 });
  const selectPosition = (group, view = 'add') => {
    setPanelView((v) => ({ view, nonce: v.nonce + 1 }));
    setChartKey(group.key);
    // On narrow screens the panel sits below the table: bring it into view.
    if (!desktop) setTimeout(() => document.getElementById('new-position')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  const toggleChart = (group) => {
    if (chartKey === group.key) setChartKey(null);
    else selectPosition(group);
  };
  // "+ New position": back to the Create position form first (a selected position shows its own panel).
  const newPosition = () => {
    setChartKey(null);
    setTimeout(onAdd, 0);
  };

  // Resizable split between the chart and the bottom panel (desktop).
  const mainRef = useRef(null);
  const desktop = useMediaQuery('(min-width: 1081px)');
  // Phones: the composition sits on the chart, so its tab goes away.
  const phone = useMediaQuery('(max-width: 760px)');
  const shownPanel = phone && panel === 'composition' ? 'liquidity' : panel;
  const barRef = useRef(null);
  const barHeight = useElementHeight(barRef) || 0;
  // The chart / panel split shares what the pool bar leaves of the column.
  const columnHeight = Math.max(0, (useElementHeight(mainRef) || 0) - (barHeight ? barHeight + 10 : 0)) || undefined;
  const [ratio, setRatio] = useLocalStorage('kinu.split.chart', DEFAULT_SPLIT);
  // The chart keeps a usable height on short screens (e.g. 100% zoom on a laptop): at least
  // MIN_CHART_PX, while the panel below keeps MIN_PANEL_PX where the column allows both.
  const chartHeight =
    desktop && columnHeight
      ? Math.round(Math.max(Math.min(MIN_CHART_PX, columnHeight - MIN_PANEL_PX), Math.min(columnHeight * ratio, columnHeight - MIN_PANEL_PX)))
      : undefined;
  const startResize = (event) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const rect = mainRef.current.getBoundingClientRect();
    const move = (e) => setRatio(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, (e.clientY - rect.top) / rect.height)));
    const up = (e) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };
  const nudgeSplit = (e) => {
    if (e.key === 'ArrowUp') setRatio((r) => Math.max(MIN_SPLIT, r - 0.04));
    if (e.key === 'ArrowDown') setRatio((r) => Math.min(MAX_SPLIT, r + 0.04));
  };

  // Resizable width of the Create position panel (desktop); null = the default width.
  const [sideWidth, setSideWidth] = useLocalStorage('kinu.split.side', null);
  const clampSide = (w) => {
    const gridWidth = gridRef.current?.getBoundingClientRect().width || 1400;
    return Math.round(Math.min(Math.max(MIN_SIDE_PX, w), Math.max(MIN_SIDE_PX, Math.min(MAX_SIDE_PX, gridWidth - MIN_MAIN_PX))));
  };
  const startSideResize = (event) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const right = gridRef.current.getBoundingClientRect().right;
    const move = (e) => setSideWidth(clampSide(right - e.clientX - handle.offsetWidth / 2));
    const up = (e) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };
  const nudgeSide = (e) => {
    const current = sideWidth || gridRef.current?.lastElementChild?.getBoundingClientRect().width || 470;
    if (e.key === 'ArrowLeft') setSideWidth(clampSide(current + 20));
    if (e.key === 'ArrowRight') setSideWidth(clampSide(current - 20));
  };

  return (
    <div
      className={`pool-grid pool-grid--wide ${desktop ? 'pool-grid--resizable' : ''}`}
      ref={gridRef}
      style={desktop && sideWidth ? { '--side-w': `${sideWidth}px` } : undefined}
    >
      <div className={`pool-grid__main ${desktop ? 'pool-grid__main--split' : ''}`} ref={mainRef}>
        {bar && (
          <div className="pool-grid__bar" ref={barRef}>
            {bar}
          </div>
        )}
        <div className="split-top" style={chartHeight ? { height: chartHeight } : undefined}>
        <Suspense fallback={<div className="card chart-card--loading"><Skeleton height={420} radius={16} /></div>}>
          <RangeChart
            poolId={poolId}
            bins={{ left: rangeState.range.left, right: rangeState.range.right, pointDelta: pool.point_delta }}
            x={x}
            y={y}
            currentPrice={rangeState.currentPrice}
            minPrice={rangeState.minPrice}
            maxPrice={rangeState.maxPrice}
            fullRange={rangeState.full}
            onDrag={onDrag}
            mine={mine}
            hideRange={Boolean(mine)}
            corner={<CompositionBadge reserves={reserves} />}
          />
        </Suspense>
        </div>
        {desktop && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize chart"
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            onPointerDown={startResize}
            onDoubleClick={() => setRatio(DEFAULT_SPLIT)}
            onKeyDown={nudgeSplit}
          >
            <span />
          </div>
        )}
        <section className="card bottom-panel">
          {/* "+ New position" sits on the tab row, so the positions table starts higher. */}
          <div className="bottom-panel__head">
          <Tabs
            tabs={[
              // One position per deposit; its CLMM bins are details inside it.
              { key: 'liquidity', label: 'Your liquidity', count: accountId ? deposits.groups.length : undefined },
              { key: 'composition', label: 'Pool composition' },
              { key: 'tiers', label: 'Fee tiers' },
              { key: 'trades', label: 'Transactions' }
            ].filter((t) => !(phone && t.key === 'composition'))}
            value={shownPanel}
            onChange={setPanel}
          />
            <button type="button" className="button button--outline button--sm" onClick={newPosition} title="Open another position with its own range">
              + New position
            </button>
          </div>
          <div className="bottom-panel__body">
            {shownPanel === 'liquidity' &&
              (!accountId ? (
                <p className="muted">Connect your wallet to see your positions in this pool.</p>
              ) : positions.loading && !positions.data ? (
                <Skeleton height={60} />
              ) : !positions.data?.length ? (
                <p className="muted">No concentrated positions in this pool yet. Create one with the form.</p>
              ) : (
                <DclGroupCard
                  poolId={poolId}
                  positions={positions.data}
                  deposits={deposits}
                  x={x}
                  y={y}
                  pool={pool}
                  onDone={onDone}
                  chartKey={chartKey}
                  onToggleChart={toggleChart}
                  onSelect={selectPosition}
                  updatedAt={positions.updatedAt}
                  onRefresh={positions.reload}
                />
              ))}
            {shownPanel === 'composition' && (
              <div className="reserves">
                {reserves.map(([token, amount, usd]) => (
                  <div className="reserve" key={token.id}>
                    <TokenIcon token={token} size={32} />
                    <div className="reserve__body">
                      <strong>
                        {formatAmount(amount)} {token.symbol}
                      </strong>
                      <small>
                        {formatUsd(usd)} · {shortAccount(token.id, 12, 8)} <CopyButton text={token.id} />
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {shownPanel === 'tiers' && <FeeTiers tokenIds={[x.id, y.id]} currentId={poolId} />}
            {shownPanel === 'trades' && <PoolTrades poolId={poolId} x={x} y={y} />}
          </div>
        </section>
      </div>
      {desktop && (
        <div
          className="side-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the position panel"
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={startSideResize}
          onDoubleClick={() => setSideWidth(null)}
          onKeyDown={nudgeSide}
        >
          <span />
        </div>
      )}
      <aside className="pool-grid__side">
        <section className="card" id="new-position">
          {chartGroup ? (
            <PositionPanel key={chartGroup.key} request={panelView} group={chartGroup} x={x} y={y} loading={deposits.loading} onBack={() => setChartKey(null)} onDone={onDone} />
          ) : (
            <DclLiquidity pool={pool} x={x} y={y} rangeState={rangeState} onDone={onDone} headExtra={links && <PanelLinks links={links} />} />
          )}
        </section>
      </aside>
    </div>
  );
}

/** Recent swaps through this exact pool (Intear trade feed). */
function PoolTrades({ poolId, x, y }) {
  const trades = useAsync(
    async () => (await fetchTrades({ tokenId: x.id, limit: 100 })).filter((t) => t.poolId === `REFDCL-${poolId}`).slice(0, 15),
    [poolId, x.id],
    { refreshMs: 30_000 }
  );
  if (trades.loading && !trades.data) return <Skeleton height={60} />;
  if (!trades.data?.length) return <p className="muted">No recent swaps through this pool.</p>;
  return (
    <>
      <div className="pool-trades">
        {trades.data.map((t) => {
          const xAmount = toNumber(t.amountRaw, x.decimals);
          const yAmount = toNumber(t.counterpartyAmountRaw, y.decimals);
          return (
            <a key={t.id} className="pool-trades__row" href={`${ENDPOINTS.explorer}/txns/${t.txHash}`} target="_blank" rel="noopener noreferrer">
              <span className={t.side === 'buy' ? 'up' : 'down'}>{t.side === 'buy' ? `Buy ${x.symbol}` : `Sell ${x.symbol}`}</span>
              <span className="mono">
                {formatAmount(xAmount)} {x.symbol}
              </span>
              <span className="mono muted">
                {formatAmount(yAmount)} {y.symbol}
              </span>
              <span>{formatUsd(t.usd)}</span>
              <span className="muted">{new Date(t.time).toLocaleString()}</span>
            </a>
          );
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

/** Swap / Rhea ↗ beside the side panel's title (CLMM pools). */
function PanelLinks({ links }) {
  return (
    <div className="panel-links">
      <Link to={links.swap} className="panel-link" title="Swap these tokens">
        ⇄ Swap
      </Link>
      <a className="panel-link" href={links.rhea} target="_blank" rel="noopener noreferrer" title="Open this pool on Rhea">
        Rhea {'↗'}
      </a>
    </div>
  );
}

/** Compact Meteora-style pool bar: pair, type, fee and live stats in one row. `actions={false}` leaves out Swap / Rhea. */
/** DexScreener lists Rhea pools as refv1-<id> (classic) and refv2-<x>:<y>:<fee> (CLMM). */
const dexScreenerUrl = (poolId) =>
  `https://dexscreener.com/near/${String(poolId).includes('|') ? `refv2-${String(poolId).split('|').join(':')}` : `refv1-${poolId}`}`;

function PoolBar({ tokens, label, feePercent, rheaUrl, swapLink, stats, price, idText, poolId, actions = true }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <header className="pool-bar card">
      <Link to={poolsReturnPath()} className="pool-bar__back" aria-label="Back to pools" title="Back to pools">
        {'\u2190'}
      </Link>
      <div className="pool-bar__pair">
        <PairIcons tokens={tokens} size={30} />
        <div>
          <strong>{tokens.map((t) => t.symbol).join(' / ')}</strong>
          <small>
            <span className={`kind kind--${label.toLowerCase()}`}>{label}</span> {formatPercent(feePercent, feePercent < 0.1 ? 3 : 2)} fee
            {idText && <span className="mono"> · {idText}</span>}
          </small>
          {poolId && (
            <span className="pool-bar__refs">
              <CopyButton text={String(poolId)} label="⧉ Pool ID" />
              <a className="link-button" href={dexScreenerUrl(poolId)} target="_blank" rel="noopener noreferrer" title="This pool on DexScreener">
                DexScreener ↗
              </a>
            </span>
          )}
        </div>
      </div>
      <div className="pool-bar__stats">
        {price && (
          <div className="pool-bar__price">
            <span>Current pool price</span>
            <strong>
              {flipped ? formatChartPrice(1 / price.value) : formatChartPrice(price.value)}{' '}
              <small>{flipped ? `${price.x.symbol}/${price.y.symbol}` : `${price.y.symbol}/${price.x.symbol}`}</small>
              <button type="button" className="flip" onClick={() => setFlipped((v) => !v)} title="Flip price" aria-label="Flip price">
                {'\u21c4'}
              </button>
            </strong>
          </div>
        )}
        {stats.map((st) => (
          <div key={st.label}>
            <span>{st.label}</span>
            <strong className={st.accent ? 'up' : ''}>
              {st.value}
              {st.hint && <small> {st.hint}</small>}
            </strong>
          </div>
        ))}
      </div>
      {actions && (
      <div className="pool-bar__actions">
        {swapLink && (
          <Link to={swapLink} className="button button--ghost button--sm">
            Swap
          </Link>
        )}
        <a className="button button--ghost button--sm" href={rheaUrl} target="_blank" rel="noopener noreferrer">
          Rhea {'\u2197'}
        </a>
      </div>
      )}
    </header>
  );
}

function PoolSkeleton() {
  return (
    <div className="pool-skeleton">
      <Skeleton width={220} height={36} />
      <div className="stats-row">
        {[0, 1, 2, 3].map((i) => (
          <div className="stat" key={i}>
            <Skeleton width={80} />
            <Skeleton width={120} height={24} />
          </div>
        ))}
      </div>
      <Skeleton height={220} radius={16} />
    </div>
  );
}

export default function PoolDetail({ poolId }) {
  const { search } = useLocation();
  const initialTab = search.get('tab') || undefined;
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [poolId]);
  const isDcl = poolId.includes('|');
  if (!isDcl && !/^\d+$/.test(poolId)) {
    return (
      <div className="page">
        <ErrorNotice error={new Error(`“${poolId}” is not a valid pool id.`)} />
      </div>
    );
  }
  return isDcl ? (
    <DclPool poolId={poolId} initialTab={initialTab} />
  ) : (
    // Full window width, like CLMM pool pages (a 1240px cap made wide screens scroll a long column).
    <div className="page page--classic-pool">
      <ClassicPool poolId={poolId} initialTab={initialTab} />
    </div>
  );
}
