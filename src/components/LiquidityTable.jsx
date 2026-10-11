// One table for every liquidity position (AMM, Stable, ALMM, CLMM), one row per
// pool — modelled on the "Your Liquidity" table of app.rhea.finance/portfolio.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import { searchPools } from '../lib/rhea.js';
import { buildDclClaimTransactions } from '../lib/dclLiquidity.js';
import { formatAmount, formatPercent, formatUsd } from '../lib/format.js';
import { DclActions, FeesText, RangeText, summarizeDclGroup } from './DclPositions.jsx';
import { EmptyState, PairIcons, Spinner, Stat } from './ui.jsx';

/** Group CLMM positions by pool. `positions` carry x / y token metadata. */
function groupDcl(positions, prices) {
  const groups = new Map();
  positions.forEach((p) => {
    if (!groups.has(p.poolId)) groups.set(p.poolId, { poolId: p.poolId, x: p.x, y: p.y, positions: [] });
    groups.get(p.poolId).positions.push(p);
  });
  return [...groups.values()].map((g) => ({ ...g, summary: summarizeDclGroup(g.positions, g.x, g.y, prices) }));
}

export default function LiquidityTable({ classicRows, dclRows, depositUsd, readOnly, onDone }) {
  const { prices, accountId, execute } = useApp();
  const [claimingAll, setClaimingAll] = useState(false);

  const dclGroups = useMemo(() => groupDcl(dclRows, prices).sort((a, b) => b.summary.usd - a.summary.usd), [dclRows, prices]);
  const poolIds = [...classicRows.map((r) => r.pool.id), ...dclGroups.map((g) => g.poolId)];
  const stats = useAsync(
    async () => {
      const { list } = await searchPools({ poolIds: poolIds.join(','), hideLow: false, limit: poolIds.length });
      return Object.fromEntries(list.map((p) => [p.id, p]));
    },
    [poolIds.join(',')],
    { enabled: poolIds.length > 0 }
  );

  const poolsUsd = classicRows.reduce((s, r) => s + r.usd, 0) + dclGroups.reduce((s, g) => s + g.summary.usd, 0);
  const farmsUsd = classicRows.reduce((s, r) => {
    const staked = Number(r.staked || 0);
    const total = Number(r.totalShares || 0);
    return s + (total > 0 ? (r.usd * staked) / total : 0);
  }, 0);
  const feesUsd = dclGroups.reduce((s, g) => s + g.summary.feeUsd, 0);
  const claimable = dclGroups.filter((g) => g.summary.hasFees);

  const claimAll = async () => {
    setClaimingAll(true);
    const ok = await execute(
      async () => (await Promise.all(claimable.map((g) => buildDclClaimTransactions({ positions: g.positions, accountId })))).flat(),
      { pending: 'Claiming all CLMM fees', success: 'Fees claimed' }
    );
    setClaimingAll(false);
    if (ok) onDone?.();
  };

  const apr = (id) => {
    const p = stats.data?.[id];
    return p ? formatPercent(p.apy + p.farmApy) : stats.loading ? <Spinner size={12} /> : '—';
  };

  if (!classicRows.length && !dclGroups.length) {
    return (
      <div className="card">
        <EmptyState
          icon="≋"
          title="No liquidity positions"
          action={
            <Link to="/pools" className="button button--primary">
              Explore pools
            </Link>
          }
        >
          Provide liquidity to a Rhea pool to earn a share of every trade.
        </EmptyState>
      </div>
    );
  }

  return (
    <section className="card lp-table-card">
      <div className="lp-summary">
        <Stat label="Pools liquidity" value={formatUsd(poolsUsd)} hint={`${classicRows.length + dclGroups.length} pool${classicRows.length + dclGroups.length === 1 ? '' : 's'}`} />
        <Stat label="Farms liquidity" value={formatUsd(farmsUsd)} hint="Staked LP shares" />
        <Stat label="Unclaimed fees" value={formatUsd(feesUsd)} hint="CLMM positions" />
        <Stat label="Dex inner" value={formatUsd(depositUsd)} hint="Tokens parked on Rhea" />
      </div>

      {!readOnly && claimable.length > 1 && (
        <div className="lp-table__bar">
          <span className="muted small">{claimable.length} pools have fees to claim.</span>
          <button type="button" className="button button--outline button--sm" onClick={claimAll} disabled={claimingAll}>
            {claimingAll ? <Spinner size={12} /> : 'Claim all'}
          </button>
        </div>
      )}

      <div className="lp-table">
        <div className="lp-row lp-row--head">
          <span>Pool</span>
          <span>Price range</span>
          <span>Pool APR</span>
          <span>Your liquidity</span>
          <span>Unclaimed fees</span>
          <span>Action</span>
        </div>

        {dclGroups.map((g) => (
          <div className="lp-row" key={g.poolId}>
            <Link to={poolPath(g.poolId)} className="lp-row__pool">
              <PairIcons tokens={[g.x, g.y]} size={30} />
              <span>
                <strong>
                  {g.x.symbol} / {g.y.symbol}
                </strong>
                <small>
                  <span className="kind kind--clmm">CLMM</span>
                  {formatPercent(Number(g.poolId.split('|')[2]) / 10000, 2)} fee · {g.positions.length} position
                  {g.positions.length === 1 ? '' : 's'}
                </small>
              </span>
            </Link>
            <span className="lp-row__range" data-label="Price range">
              <RangeText summary={g.summary} x={g.x} y={g.y} />
              <span className={`range-badge ${g.summary.inRange ? 'range-badge--in' : ''}`}>{g.summary.inRange ? 'In range' : 'Out of range'}</span>
            </span>
            <span data-label="Pool APR">{apr(g.poolId)}</span>
            <span className="lp-row__value" data-label="Your liquidity">
              <strong>{formatUsd(g.summary.usd)}</strong>
              <small className="muted">
                {formatAmount(g.summary.amountX)} {g.x.symbol} + {formatAmount(g.summary.amountY)} {g.y.symbol}
              </small>
            </span>
            <span data-label="Unclaimed fees">
              <FeesText summary={g.summary} x={g.x} y={g.y} />
            </span>
            <span className="lp-row__actions">
              <DclActions poolId={g.poolId} positions={g.positions} x={g.x} y={g.y} onDone={onDone} readOnly={readOnly} />
            </span>
          </div>
        ))}

        {classicRows.map((r) => (
          <div className="lp-row" key={r.pool.id}>
            <Link to={poolPath(r.pool.id)} className="lp-row__pool">
              <PairIcons tokens={r.parts.map((p) => p.token)} size={30} />
              <span>
                <strong>{r.parts.map((p) => p.token.symbol).join(' / ')}</strong>
                <small>
                  <span className={`kind kind--${r.pool.label.toLowerCase()}`}>{r.pool.label}</span>
                  {formatPercent(r.pool.feePercent, r.pool.feePercent < 0.1 ? 3 : 2)} fee
                  {r.staked !== '0' && <span className="kind kind--farm">Farming</span>}
                </small>
              </span>
            </Link>
            <span className="lp-row__range" data-label="Price range">
              <span>Full range</span>
              <span className="muted small">{formatPercent(r.sharePct, 4)} of pool</span>
            </span>
            <span data-label="Pool APR">{apr(r.pool.id)}</span>
            <span className="lp-row__value" data-label="Your liquidity">
              <strong>{formatUsd(r.usd)}</strong>
              <small className="muted">{r.parts.map((p) => `${formatAmount(p.amount)} ${p.token.symbol}`).join(' + ')}</small>
            </span>
            <span data-label="Unclaimed fees">
              <span className="muted small">Auto-compounded</span>
            </span>
            <span className="lp-row__actions">
              {readOnly ? (
                <Link to={poolPath(r.pool.id)} className="button button--ghost button--sm">
                  View
                </Link>
              ) : (
                <div className="lp-actions">
                  <Link to={`${poolPath(r.pool.id)}?tab=add`} className="button button--outline button--sm">
                    Add
                  </Link>
                  <Link to={`${poolPath(r.pool.id)}?tab=remove`} className="button button--ghost button--sm">
                    Remove
                  </Link>
                </div>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
