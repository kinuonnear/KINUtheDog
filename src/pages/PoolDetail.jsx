import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { getDclPositions, getFarmStakes, getPool, getPoolShares, getPoolStats, dclPointToPrice, parseDclPoolId } from '../lib/rhea.js';
import { getTokens, priceOf } from '../lib/tokens.js';
import { view } from '../lib/rpc.js';
import {
  amountsForShares,
  buildAddLiquidityTransactions,
  buildRemoveLiquidityTransactions,
  expectedShares,
  pairedAmount
} from '../lib/liquidity.js';
import {
  formatAmount,
  formatPercent,
  formatRawAmount,
  formatUnits,
  formatUsd,
  maxBig,
  shortAccount,
  toBigInt,
  toNumber,
  tryParseUnits
} from '../lib/format.js';
import { CONTRACTS, ENDPOINTS, NATIVE_NEAR, NEAR_GAS_RESERVE } from '../config.js';
import { CopyButton, EmptyState, ErrorNotice, PairIcons, Skeleton, Spinner, Stat, Tabs, TokenIcon } from '../components/ui.jsx';

/* ------------------------------------------------------------------ */
/* Liquidity panel (classic pools)                                     */
/* ------------------------------------------------------------------ */

// Inputs show at most 8 decimals (rounded down so balances are never exceeded).
function trimDecimals(text) {
  const [whole, fraction = ''] = text.split('.');
  const kept = fraction.slice(0, 8).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

function AddLiquidity({ pool, tokens, onDone }) {
  const { accountId, connect, balances, nearBalance, slippage, execute } = useApp();
  const [inputs, setInputs] = useState(() => pool.tokenIds.map(() => ''));
  const [submitting, setSubmitting] = useState(false);

  const wrapIndex = pool.tokenIds.indexOf(CONTRACTS.wrapNear);
  const nativeSpendable = useMemo(() => {
    if (!nearBalance) return 0n;
    const rest = toBigInt(nearBalance.available) - toBigInt(NEAR_GAS_RESERVE);
    return rest > 0n ? rest : 0n;
  }, [nearBalance]);

  // Spendable per token; wNEAR also counts native NEAR (wrapped automatically).
  const spendable = pool.tokenIds.map((id, i) => {
    const ft = toBigInt(balances[id] || '0');
    return i === wrapIndex ? ft + nativeSpendable : ft;
  });

  const raws = inputs.map((value, i) => tryParseUnits(value, tokens[i]?.decimals ?? 0));

  const setAmount = (index, value) => {
    const text = value.replace(',', '.');
    if (!/^\d*\.?\d*$/.test(text)) return;
    const raw = tryParseUnits(text, tokens[index]?.decimals ?? 0);
    setInputs(
      pool.tokenIds.map((_, j) => {
        if (j === index) return text;
        if (!raw || pool.tokenIds.length !== 2) return inputs[j];
        return trimDecimals(formatUnits(pairedAmount(pool, index, j, raw), tokens[j]?.decimals ?? 0));
      })
    );
  };

  const setMax = (index) => {
    if (pool.tokenIds.length !== 2) return;
    const other = 1 - index;
    // Largest deposit that fits both balances at the current ratio.
    let amount = spendable[index];
    const needed = toBigInt(pairedAmount(pool, index, other, amount.toString()));
    if (needed > spendable[other]) amount = toBigInt(pairedAmount(pool, other, index, spendable[other].toString()));
    setAmount(index, trimDecimals(formatUnits(amount.toString(), tokens[index]?.decimals ?? 0)));
  };

  const complete = raws.every((r) => r && toBigInt(r) > 0n);
  const insufficientIndex = complete ? raws.findIndex((r, i) => toBigInt(r) > spendable[i]) : -1;
  const shares = complete ? expectedShares(pool, raws) : '0';
  const supply = toBigInt(pool.sharesTotalSupply);
  const sharePct = supply > 0n && toBigInt(shares) > 0n ? (Number(shares) / Number(supply + toBigInt(shares))) * 100 : 0;

  const wrapAmount =
    complete && wrapIndex >= 0
      ? maxBig(0n, toBigInt(raws[wrapIndex]) - toBigInt(balances[CONTRACTS.wrapNear] || '0')).toString()
      : '0';

  const submit = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const result = await execute(
      () => buildAddLiquidityTransactions({ pool, amounts: raws, accountId, slippage, wrapAmount }),
      { pending: 'Adding liquidity', success: 'Liquidity added' }
    );
    setSubmitting(false);
    if (result) {
      setInputs(pool.tokenIds.map(() => ''));
      onDone();
    }
  };

  let label = 'Add liquidity';
  let disabled = false;
  if (!accountId) label = 'Connect wallet';
  else if (!complete) {
    label = 'Enter amounts';
    disabled = true;
  } else if (insufficientIndex >= 0) {
    label = `Insufficient ${tokens[insufficientIndex]?.symbol}`;
    disabled = true;
  } else if (submitting) {
    label = 'Confirm in wallet…';
    disabled = true;
  }

  return (
    <div className="liq-form">
      {pool.tokenIds.map((id, i) => (
        <div className="swap-field" key={id}>
          <div className="swap-field__top">
            <span>
              {tokens[i]?.symbol}
              {i === wrapIndex && <small className="muted"> · NEAR is wrapped automatically</small>}
            </span>
            {accountId && (
              <span className="swap-field__balance">
                Balance {formatRawAmount(spendable[i].toString(), tokens[i]?.decimals ?? 0)}
                <button type="button" className="mini-button" onClick={() => setMax(i)}>
                  Max
                </button>
              </span>
            )}
          </div>
          <div className="swap-field__row">
            <input inputMode="decimal" placeholder="0.0" value={inputs[i]} onChange={(e) => setAmount(i, e.target.value)} />
            <span className="token-select token-select--static">
              <TokenIcon token={tokens[i]} size={24} />
              <strong>{tokens[i]?.symbol}</strong>
            </span>
          </div>
        </div>
      ))}

      {complete && (
        <dl className="kv">
          <div>
            <dt>LP shares (est.)</dt>
            <dd>{formatRawAmount(shares, 24)}</dd>
          </div>
          <div>
            <dt>Share of pool</dt>
            <dd>{formatPercent(sharePct, 4)}</dd>
          </div>
          {accountId && toBigInt(wrapAmount) > 0n && (
            <div>
              <dt>NEAR to wrap</dt>
              <dd>{formatRawAmount(wrapAmount, 24)} NEAR</dd>
            </div>
          )}
          <div>
            <dt>Max slippage</dt>
            <dd>{slippage}%</dd>
          </div>
        </dl>
      )}

      <button type="button" className="button button--primary button--block button--lg" disabled={disabled} onClick={submit}>
        {submitting && <Spinner size={14} />}
        {label}
      </button>
    </div>
  );
}

function RemoveLiquidity({ pool, tokens, shares, staked, onDone }) {
  const { accountId, connect, slippage, execute } = useApp();
  const [percent, setPercent] = useState(50);
  const [submitting, setSubmitting] = useState(false);

  const removeShares = ((toBigInt(shares) * BigInt(percent)) / 100n).toString();
  const out = amountsForShares(pool, removeShares);

  if (!accountId) {
    return (
      <EmptyState title="Connect to manage your position" action={<button className="button button--primary" onClick={connect}>Connect wallet</button>} />
    );
  }

  if (toBigInt(shares) === 0n) {
    return (
      <EmptyState title="No removable liquidity">
        {toBigInt(staked) > 0n
          ? 'Your LP shares are staked in a Rhea farm. Unstake them on app.rhea.finance first.'
          : 'You have no LP shares in this pool yet.'}
      </EmptyState>
    );
  }

  const submit = async () => {
    setSubmitting(true);
    const result = await execute(
      () => buildRemoveLiquidityTransactions({ pool, shares: removeShares, accountId, slippage }),
      { pending: 'Removing liquidity', success: 'Liquidity removed' }
    );
    setSubmitting(false);
    if (result) onDone();
  };

  return (
    <div className="liq-form">
      <div className="range-block">
        <div className="range-block__value">{percent}%</div>
        <input type="range" min="1" max="100" value={percent} onChange={(e) => setPercent(Number(e.target.value))} aria-label="Percent to remove" />
        <div className="segmented segmented--full">
          {[25, 50, 75, 100].map((p) => (
            <button key={p} type="button" className={percent === p ? 'active' : ''} onClick={() => setPercent(p)}>
              {p === 100 ? 'Max' : `${p}%`}
            </button>
          ))}
        </div>
      </div>
      <dl className="kv">
        {pool.tokenIds.map((id, i) => (
          <div key={id}>
            <dt>
              <TokenIcon token={tokens[i]} size={18} /> {tokens[i]?.symbol}
            </dt>
            <dd>{formatRawAmount(out[i], tokens[i]?.decimals ?? 0)}</dd>
          </div>
        ))}
        <div>
          <dt>Max slippage</dt>
          <dd>{slippage}%</dd>
        </div>
      </dl>
      <button type="button" className="button button--primary button--block button--lg" disabled={submitting} onClick={submit}>
        {submitting && <Spinner size={14} />}
        {submitting ? 'Confirm in wallet…' : 'Remove liquidity'}
      </button>
      <p className="hint">Tokens are withdrawn straight back to your wallet in the same transaction.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Classic / stable pool page                                          */
/* ------------------------------------------------------------------ */

function ClassicPool({ poolId }) {
  const { accountId, prices } = useApp();
  const [tab, setTab] = useState('add');

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
        rheaUrl={`${ENDPOINTS.rheaApp}/pool/${pool.id}`}
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
              <>
                <Tabs
                  tabs={[
                    { key: 'add', label: 'Add' },
                    { key: 'remove', label: 'Remove' }
                  ]}
                  value={tab}
                  onChange={setTab}
                  size="block"
                />
                {tab === 'add' ? (
                  <AddLiquidity pool={pool} tokens={tokens} onDone={refresh} />
                ) : (
                  <RemoveLiquidity
                    pool={pool}
                    tokens={tokens}
                    shares={position.data?.shares || '0'}
                    staked={position.data?.staked || '0'}
                    onDone={refresh}
                  />
                )}
              </>
            ) : (
              <EmptyState
                icon="⚖"
                title={`${pool.label} pool`}
                action={
                  <a className="button button--ghost" href={`${ENDPOINTS.rheaApp}/pool/${pool.id}`} target="_blank" rel="noopener noreferrer">
                    Manage on Rhea ↗
                  </a>
                }
              >
                Stable and rated pools use a different deposit formula. Manage this position directly on Rhea.
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

function DclPool({ poolId }) {
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
        rheaUrl={`${ENDPOINTS.rheaApp}/pools`}
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
              <h3 className="card-title">Your positions</h3>
              {positions.loading && !positions.data ? (
                <Skeleton height={40} />
              ) : !positions.data?.length ? (
                <p className="muted">No concentrated positions in this pool.</p>
              ) : (
                positions.data.map((p) => (
                  <div className="dcl-position" key={p.id}>
                    <span className={`range-badge ${p.inRange ? 'range-badge--in' : ''}`}>{p.inRange ? 'In range' : 'Out of range'}</span>
                    <span>
                      {formatAmount(dclPointToPrice(p.leftPoint, x.decimals, y.decimals))} – {formatAmount(dclPointToPrice(p.rightPoint, x.decimals, y.decimals))} {y.symbol}/{x.symbol}
                    </span>
                    <span className="muted">
                      {formatAmount(p.amountX / 10 ** x.decimals)} {x.symbol} + {formatAmount(p.amountY / 10 ** y.decimals)} {y.symbol}
                    </span>
                  </div>
                ))
              )}
            </section>
          )}
        </div>
        <aside className="pool-grid__side">
          <section className="card">
            <EmptyState
              icon="◎"
              title="Concentrated liquidity"
              action={
                <a className="button button--ghost" href={`${ENDPOINTS.rheaApp}/pools`} target="_blank" rel="noopener noreferrer">
                  Add a range on Rhea ↗
                </a>
              }
            >
              Concentrated positions need a price range. Create and manage them on Rhea; they appear in your KINU
              portfolio automatically.
            </EmptyState>
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
  return <div className="page">{isDcl ? <DclPool poolId={poolId} /> : <ClassicPool poolId={poolId} />}</div>;
}
