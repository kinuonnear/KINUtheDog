import { useEffect } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, useLocation } from '../router.jsx';
import { getDclPositions, getFarmStakes, getPool, getPoolShares, getPoolStats, dclPointToPrice, parseDclPoolId } from '../lib/rhea.js';
import { getTokens, priceOf } from '../lib/tokens.js';
import { view } from '../lib/rpc.js';
import { amountsForShares, isStableKind } from '../lib/liquidity.js';
import { AmmLiquidity, DclLiquidity, StableLiquidity } from '../components/Liquidity.jsx';
import { DclGroupCard } from '../components/DclPositions.jsx';
import { formatAmount, formatPercent, formatRawAmount, formatUsd, shortAccount, toBigInt, toNumber } from '../lib/format.js';
import { CONTRACTS, ENDPOINTS, NATIVE_NEAR } from '../config.js';
import { CopyButton, EmptyState, ErrorNotice, PairIcons, Skeleton, Stat, TokenIcon } from '../components/ui.jsx';

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

  return (
    <>
      <PoolHeader
        tokens={[x, y]}
        label="CLMM"
        feePercent={fee / 10000}
        idText="Concentrated"
        rheaUrl={rheaPoolUrl({ kind: 'DCL', id: poolId })}
        swapLink={`/swap?from=${tokenX}&to=${tokenY}`}
      />
      <div className="stats-row">
        <Stat label="TVL" value={formatUsd(stats.data?.tvl || usdX + usdY)} />
        <Stat label="Volume 24h" value={stats.data ? formatUsd(stats.data.volume24h) : '—'} loading={stats.loading} />
        <Stat label="Fee APR" value={stats.data ? formatPercent(stats.data.apy) : '—'} loading={stats.loading} />
        <Stat label="Price" value={`${formatAmount(price)} ${y.symbol}`} hint={`per 1 ${x.symbol}`} />
      </div>
      <div className="pool-grid">
        <div className="pool-grid__main">
          <section className="card">
            <h3 className="card-title">Reserves</h3>
            <div className="reserves">
              {[
                [x, totalX, usdX],
                [y, totalY, usdY]
              ].map(([token, amount, usd]) => (
                <div className="reserve" key={token.id}>
                  <TokenIcon token={token} size={32} />
                  <div className="reserve__body">
                    <strong>{formatAmount(amount)} {token.symbol}</strong>
                    <small>{formatUsd(usd)} · {shortAccount(token.id, 12, 8)}</small>
                  </div>
                </div>
              ))}
            </div>
          </section>
          {accountId && (
            <section className="card">
              <h3 className="card-title">Your liquidity</h3>
              {positions.loading && !positions.data ? (
                <Skeleton height={60} />
              ) : !positions.data?.length ? (
                <p className="muted">No concentrated positions in this pool yet — open one with the form.</p>
              ) : (
                <DclGroupCard
                  poolId={poolId}
                  positions={positions.data}
                  x={x}
                  y={y}
                  onAdd={scrollToForm}
                  onDone={refresh}
                />
              )}
            </section>
          )}
        </div>
        <aside className="pool-grid__side">
          <section className="card" id="new-position">
            <DclLiquidity pool={chain.data} x={x} y={y} onDone={refresh} />
          </section>
        </aside>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

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
  return <div className="page">{isDcl ? <DclPool poolId={poolId} initialTab={initialTab} /> : <ClassicPool poolId={poolId} initialTab={initialTab} />}</div>;
}
