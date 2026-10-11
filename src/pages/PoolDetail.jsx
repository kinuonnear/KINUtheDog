import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useElementHeight, useLocalStorage, useMediaQuery } from '../hooks.js';
import { Link, useLocation } from '../router.jsx';
import { getDclPositions, getFarmStakes, getPool, getPoolShares, getPoolStats, dclPointToPrice, parseDclPoolId } from '../lib/rhea.js';
import { getTokens, priceOf } from '../lib/tokens.js';
import { view } from '../lib/rpc.js';
import { amountsForShares, isStableKind } from '../lib/liquidity.js';
import { AmmLiquidity, DclLiquidity, StableLiquidity } from '../components/Liquidity.jsx';
import { DclGroupCard } from '../components/DclPositions.jsx';
import { useDclRange } from '../components/DclCreatePosition.jsx';
import { fetchTrades } from '../lib/intear.js';

const RangeChart = lazy(() => import('../components/RangeChart.jsx'));
import { formatAmount, formatChartPrice, formatPercent, formatRawAmount, formatUsd, shortAccount, toBigInt, toNumber } from '../lib/format.js';
import { CONTRACTS, ENDPOINTS, NATIVE_NEAR } from '../config.js';
import { CopyButton, EmptyState, ErrorNotice, PairIcons, Skeleton, Stat, Tabs, TokenIcon } from '../components/ui.jsx';

/** Pool page on app.rhea.finance, for users who want the original UI. */
function rheaPoolUrl(pool) {
  if (pool.kind === 'DCL') {
    const { tokenX, tokenY, fee } = parseDclPoolId(pool.id);
    return `${ENDPOINTS.rheaApp}/poolV2/${encodeURIComponent(`${tokenX}<>${tokenY}`)}@${fee}`;
  }
  return `${ENDPOINTS.rheaApp}/${isStableKind(pool.kind) ? 'sauce' : 'pool'}/${pool.id}`;
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
    { enabled: Boolean(accountId) }
  );

  if (poolQuery.error && !pool) {
    return <EmptyState icon="⚠" title={`Pool #${poolId} could not be loaded`}>{poolQuery.error.message}</EmptyState>;
  }
  if (!pool || !tokenQuery.data) return <PoolSkeleton />;

  const tokens = pool.tokenIds.map((id) => tokenQuery.data[id] || { id, symbol: id.slice(0, 6), decimals: 0 });
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
  const spot = isSimple && reserves[0] > 0 && reserves.length === 2 ? reserves[1] / reserves[0] : null;

  const refresh = () => {
    poolQuery.reload();
    position.reload();
  };

  return (
    <>
      <PoolHeader
        tokens={tokens}
        label={pool.label}
        feePercent={pool.feePercent}
        idText={`#${pool.id}`}
        rheaUrl={rheaPoolUrl(pool)}
        swapLink={tokens.length >= 2 ? `/swap?from=${tokens[0].id === CONTRACTS.wrapNear ? NATIVE_NEAR.id : tokens[0].id}&to=${tokens[1].id}` : null}
      />

      <div className="stats-row">
        <Stat label="TVL" value={formatUsd(tvl)} />
        <Stat label="Volume 24h" value={stats.data ? formatUsd(stats.data.volume24h) : '—'} loading={stats.loading} />
        <Stat label="Fee APR" value={stats.data ? formatPercent(stats.data.apy) : '—'} loading={stats.loading} />
        <Stat
          label="Price"
          value={spot !== null ? `${formatAmount(spot)} ${tokens[1].symbol}` : '—'}
          hint={spot !== null ? `per 1 ${tokens[0].symbol}` : pool.label}
        />
      </div>

      <div className="pool-grid">
        <div className="pool-grid__main">
          <section className="card">
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

          {accountId && (
            <section className="card">
              <h3 className="card-title">Your position</h3>
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
                </div>
              )}
            </section>
          )}

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

        <aside className="pool-grid__side">
          <section className="card">
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
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Concentrated liquidity (DCL) pool page                              */
/* ------------------------------------------------------------------ */

function DclPool({ poolId, initialTab }) {
  const { accountId, prices } = useApp();
  const { tokenX, tokenY, fee } = parseDclPoolId(poolId);
  const tokenQuery = useAsync(() => getTokens([tokenX, tokenY]), [tokenX, tokenY]);
  const chain = useAsync(() => view(CONTRACTS.dcl, 'get_pool', { pool_id: poolId }), [poolId], { refreshMs: 30_000 });
  const stats = useAsync(() => getPoolStats(poolId), [poolId]);
  const positions = useAsync(
    async () => (await getDclPositions(accountId)).filter((p) => p.poolId === poolId),
    [poolId, accountId],
    { enabled: Boolean(accountId) }
  );

  const refresh = () => {
    chain.reload();
    positions.reload();
  };
  const scrollToForm = () => document.getElementById('new-position')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Deep link from the portfolio "Add" button: /pools/<id>?tab=add
  useEffect(() => {
    if (initialTab === 'add' && chain.data && tokenQuery.data) setTimeout(scrollToForm, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab, Boolean(chain.data && tokenQuery.data)]);

  if (chain.error && !chain.data) {
    return <EmptyState icon="⚠" title="Pool could not be loaded">{chain.error.message}</EmptyState>;
  }
  if (!tokenQuery.data || !chain.data) return <PoolSkeleton />;

  const x = tokenQuery.data[tokenX];
  const y = tokenQuery.data[tokenY];
  const price = dclPointToPrice(chain.data.current_point, x.decimals, y.decimals);
  const totalX = toNumber(chain.data.total_x || '0', x.decimals);
  const totalY = toNumber(chain.data.total_y || '0', y.decimals);
  const usdX = totalX * priceOf(prices, tokenX);
  const usdY = totalY * priceOf(prices, tokenY);
  const tvl = stats.data?.tvl || usdX + usdY;

  return (
    <div className="terminal">
      <PoolBar
        tokens={[x, y]}
        label="CLMM"
        feePercent={fee / 10000}
        rheaUrl={rheaPoolUrl({ kind: 'DCL', id: poolId })}
        swapLink={`/swap?from=${tokenX}&to=${tokenY}`}
        price={{ value: price, x, y }}
        stats={[
          { label: 'Total value locked', value: formatUsd(tvl) },
          { label: '24h volume', value: stats.data ? formatUsd(stats.data.volume24h) : '-' },
          { label: '24h fees', value: stats.data ? formatUsd(stats.data.feeVolume24h) : '-' },
          { label: '24h fees / TVL', value: stats.data && tvl > 0 ? formatPercent((stats.data.feeVolume24h / tvl) * 100) : '-' },
          { label: 'Trading fee', value: formatPercent(fee / 10000, 2) },
          { label: 'Fee APR', value: stats.data ? formatPercent(stats.data.apy) : '-', accent: true }
        ]}
      />
      <DclWorkspace
        poolId={poolId}
        pool={chain.data}
        x={x}
        y={y}
        reserves={[
          [x, totalX, usdX],
          [y, totalY, usdY]
        ]}
        positions={positions}
        onAdd={scrollToForm}
        onDone={refresh}
      />
    </div>
  );
}

const DOCK_TOP = 76;
// Share of the left column given to the chart (the rest is the data panel).
const DEFAULT_SPLIT = 0.68;
const MIN_SPLIT = 0.3;
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

/** CLMM page body: draggable range chart + Meteora-style create form. */
function DclWorkspace({ poolId, pool, x, y, reserves, positions, onAdd, onDone }) {
  const { accountId } = useApp();
  const rangeState = useDclRange(pool, x, y);
  const onDrag = (side, price) => rangeState.setEdge(side, { price });
  const gridRef = useRef(null);
  useDockedColumns(gridRef);
  const [panel, setPanel] = useState(accountId ? 'liquidity' : 'composition');

  // Resizable split between the chart and the bottom panel (desktop).
  const mainRef = useRef(null);
  const desktop = useMediaQuery('(min-width: 1081px)');
  const columnHeight = useElementHeight(mainRef);
  const [ratio, setRatio] = useLocalStorage('kinu.split.chart', DEFAULT_SPLIT);
  const chartHeight = desktop && columnHeight ? Math.round(columnHeight * ratio) : undefined;
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

  return (
    <div className="pool-grid pool-grid--wide" ref={gridRef}>
      <div className={`pool-grid__main ${desktop ? 'pool-grid__main--split' : ''}`} ref={mainRef}>
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
          <Tabs
            tabs={[
              { key: 'liquidity', label: 'Your liquidity', count: accountId ? positions.data?.length ?? 0 : undefined },
              { key: 'composition', label: 'Pool composition' },
              { key: 'trades', label: 'Transactions' }
            ]}
            value={panel}
            onChange={setPanel}
          />
          <div className="bottom-panel__body">
            {panel === 'liquidity' &&
              (!accountId ? (
                <p className="muted">Connect your wallet to see your positions in this pool.</p>
              ) : positions.loading && !positions.data ? (
                <Skeleton height={60} />
              ) : !positions.data?.length ? (
                <p className="muted">No concentrated positions in this pool yet. Create one with the form.</p>
              ) : (
                <DclGroupCard poolId={poolId} positions={positions.data} x={x} y={y} onAdd={onAdd} onDone={onDone} />
              ))}
            {panel === 'composition' && (
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
            {panel === 'trades' && <PoolTrades poolId={poolId} x={x} y={y} />}
          </div>
        </section>
      </div>
      <aside className="pool-grid__side">
        <section className="card" id="new-position">
          <DclLiquidity pool={pool} x={x} y={y} rangeState={rangeState} onDone={onDone} />
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

/** Compact Meteora-style pool bar: pair, type, fee and live stats in one row. */
function PoolBar({ tokens, label, feePercent, rheaUrl, swapLink, stats, price }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <header className="pool-bar card">
      <Link to="/pools" className="pool-bar__back" aria-label="All pools">
        {'\u2190'}
      </Link>
      <div className="pool-bar__pair">
        <PairIcons tokens={tokens} size={30} />
        <div>
          <strong>{tokens.map((t) => t.symbol).join(' / ')}</strong>
          <small>
            <span className={`kind kind--${label.toLowerCase()}`}>{label}</span> {formatPercent(feePercent, feePercent < 0.1 ? 3 : 2)} fee
          </small>
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
    </header>
  );
}

function PoolHeader({ tokens, label, feePercent, idText, rheaUrl, swapLink }) {
  return (
    <header className="pool-head">
      <Link to="/pools" className="back-link">
        ← All pools
      </Link>
      <div className="pool-head__main">
        <PairIcons tokens={tokens} size={44} />
        <div>
          <h1>{tokens.map((t) => t.symbol).join(' / ')}</h1>
          <div className="pool-head__meta">
            <span className={`kind kind--${label.toLowerCase()}`}>{label}</span>
            <span>{formatPercent(feePercent, feePercent < 0.1 ? 3 : 2)} fee</span>
            <span className="mono">{idText}</span>
          </div>
        </div>
        <div className="pool-head__actions">
          {swapLink && (
            <Link to={swapLink} className="button button--ghost">
              Swap
            </Link>
          )}
          <a className="button button--ghost" href={rheaUrl} target="_blank" rel="noopener noreferrer">
            Rhea ↗
          </a>
        </div>
      </div>
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
    <div className="page page--contained">
      <ClassicPool poolId={poolId} initialTab={initialTab} />
    </div>
  );
}
