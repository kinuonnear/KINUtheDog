// One table for every liquidity position (AMM, Stable, ALMM, CLMM), one row per
// pool — modelled on the "Your Liquidity" table of app.rhea.finance/portfolio.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import { searchPools } from '../lib/rhea.js';
import { buildDclClaimTransactions } from '../lib/dclLiquidity.js';
import { formatAmount, formatPercent, formatUsd } from '../lib/format.js';
import { formatAge } from '../lib/lpHistory.js';
import { DclActions, depositTitle, RangeText, summarizeDclGroup } from './DclPositions.jsx';
import RebalanceButton from './Rebalance.jsx';
import { groupDeposits } from '../lib/lpPositions.js';
import { PnlValue } from './LpPnl.jsx';
import { EmptyState, PairIcons, Spinner, Stat } from './ui.jsx';

/** Group CLMM positions by pool, then by deposit. `positions` carry x / y token metadata. */
function groupDcl(positions, prices, events) {
  const groups = new Map();
  positions.forEach((p) => {
    if (!groups.has(p.poolId)) groups.set(p.poolId, { poolId: p.poolId, x: p.x, y: p.y, positions: [] });
    groups.get(p.poolId).positions.push(p);
  });
  return [...groups.values()].map((g) => ({
    ...g,
    summary: summarizeDclGroup(g.positions, g.x, g.y, prices),
    deposits: groupDeposits(g.positions, events)
  }));
}

/** Age / invested / fees / PnL of a set of CLMM positions from the event history. */
function perf(positions, open) {
  if (!open) return null;
  const infos = positions.map((p) => open.get(p.id)).filter(Boolean);
  const known = infos.filter((i) => i.known);
  const sum = (list, fn) => list.reduce((s, i) => s + fn(i), 0);
  const gross = sum(known, (i) => i.ledger.investedUsd);
  const pnl = sum(known, (i) => i.pnl);
  return {
    known: known.length > 0,
    partial: known.length < positions.length,
    openedAt: known.length ? Math.min(...known.map((i) => i.ledger.openedAt)) : null,
    invested: sum(known, (i) => i.invested),
    fees: sum(infos, (i) => (i.ledger?.feesUsd || 0) + i.unclaimed),
    unclaimed: sum(infos, (i) => i.unclaimed),
    pnl,
    pnlPct: gross > 0 ? (pnl / gross) * 100 : null
  };
}

const placeholder = (loading) => (loading ? <Spinner size={12} /> : <span className="muted">—</span>);

function AgeCell({ p, loading }) {
  return <span data-label="Age">{p?.openedAt ? formatAge(Date.now() - p.openedAt) : placeholder(loading)}</span>;
}

/** Invested · Value · Fees · uPnL cells. */
function PerfCells({ p, loading, value, amounts }) {
  const dash = placeholder(loading);
  return (
    <>
      <span data-label="Invested">
        {p?.known ? (
          <>
            {formatUsd(p.invested)}
            {p.partial && (
              <small className="muted" title="Some positions predate the loaded history">
                {' '}
                *
              </small>
            )}
          </>
        ) : (
          dash
        )}
      </span>
      <span className="lp-row__value" data-label="Value">
        <strong>{formatUsd(value)}</strong>
        {amounts && <small className="muted">{amounts}</small>}
      </span>
      <span data-label="Fees">
        {p ? (
          <span className="lp-fees">
            <b className={p.fees > 0 ? 'up' : ''}>{formatUsd(p.fees)}</b>
            {p.unclaimed > 0 && p.fees - p.unclaimed > 0.005 && <small className="muted">{formatUsd(p.unclaimed)} unclaimed</small>}
          </span>
        ) : (
          dash
        )}
      </span>
      <span data-label="uPnL">{p?.known ? <PnlValue value={p.pnl} pct={p.pnlPct} /> : dash}</span>
    </>
  );
}

export default function LiquidityTable({ classicRows, dclRows, depositUsd, readOnly, history, onDone }) {
  const { prices, accountId, execute } = useApp();
  const [claimingAll, setClaimingAll] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const open = history?.model?.open || null;
  const histLoading = Boolean(history?.loading);
  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const events = history?.events || null;
  const dclGroups = useMemo(() => groupDcl(dclRows, prices, events).sort((a, b) => b.summary.usd - a.summary.usd), [dclRows, prices, events]);
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
          <span>Position / Pool</span>
          <span>Age</span>
          <span>Price range</span>
          <span>Invested</span>
          <span>Value</span>
          <span>Fees</span>
          <span>uPnL</span>
          <span>Pool APR</span>
          <span>Action</span>
        </div>

        {dclGroups.map((g) => {
          const p = perf(g.positions, open);
          const isOpen = expanded.has(g.poolId);
          return (
            <div className="lp-group" key={g.poolId}>
              <div className="lp-row">
                <span className="lp-row__pool">
                  <button
                    type="button"
                    className={`lp-expand ${isOpen ? 'lp-expand--open' : ''}`}
                    onClick={() => toggle(g.poolId)}
                    aria-label={isOpen ? 'Hide positions' : 'Show positions'}
                  >
                    ▸
                  </button>
                  <Link to={poolPath(g.poolId)} className="lp-row__pool">
                    <PairIcons tokens={[g.x, g.y]} size={30} />
                    <span>
                      <strong>
                        {g.x.symbol} / {g.y.symbol}
                      </strong>
                      <small>
                        <span className="kind kind--clmm">CLMM</span>
                        {formatPercent(Number(g.poolId.split('|')[2]) / 10000, 2)} · {g.deposits.length} position{g.deposits.length === 1 ? '' : 's'}
                      </small>
                    </span>
                  </Link>
                </span>
                <AgeCell p={p} loading={histLoading} />
                <span className="lp-row__range" data-label="Price range">
                  <RangeText summary={g.summary} x={g.x} y={g.y} />
                  <span className={`range-badge ${g.summary.inRange ? 'range-badge--in' : ''}`}>{g.summary.inRange ? 'In range' : 'Out of range'}</span>
                </span>
                <PerfCells
                  p={p}
                  loading={histLoading}
                  value={g.summary.usd}
                  amounts={`${formatAmount(g.summary.amountX)} ${g.x.symbol} + ${formatAmount(g.summary.amountY)} ${g.y.symbol}`}
                />
                <span data-label="Pool APR">{apr(g.poolId)}</span>
                <span className="lp-row__actions">
                  <DclActions poolId={g.poolId} positions={g.positions} x={g.x} y={g.y} onDone={onDone} readOnly={readOnly} />
                </span>
              </div>
              {isOpen &&
                g.deposits.map((d) => {
                  const dp = perf(d.positions, open);
                  const ds = summarizeDclGroup(d.positions, g.x, g.y, prices);
                  const title = depositTitle(d, histLoading);
                  return (
                    <div className="lp-row lp-row--sub" key={d.key}>
                      <span className="lp-row__pool lp-sub__id">
                        <span className={`dot ${ds.inRange ? 'dot--in' : 'dot--out'}`} />
                        {title}
                        <small className="muted">
                          {' '}
                          · {d.positions.length} bin{d.positions.length === 1 ? '' : 's'}
                        </small>
                      </span>
                      <AgeCell p={dp} loading={histLoading} />
                      <span className="lp-row__range" data-label="Price range">
                        <RangeText summary={ds} x={g.x} y={g.y} />
                      </span>
                      <PerfCells
                        p={dp}
                        loading={histLoading}
                        value={ds.usd}
                        amounts={`${formatAmount(ds.amountX)} ${g.x.symbol} + ${formatAmount(ds.amountY)} ${g.y.symbol}`}
                      />
                      <span />
                      <span className="lp-row__actions">
                        {!readOnly && <RebalanceButton positions={d.positions} title={title} x={g.x} y={g.y} onDone={onDone} />}
                      </span>
                    </div>
                  );
                })}
            </div>
          );
        })}

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
            <span data-label="Age" className="muted">
              —
            </span>
            <span className="lp-row__range" data-label="Price range">
              <span>Full range</span>
              <span className="muted small">{formatPercent(r.sharePct, 4)} of pool</span>
            </span>
            <span data-label="Invested" className="muted">
              —
            </span>
            <span className="lp-row__value" data-label="Value">
              <strong>{formatUsd(r.usd)}</strong>
              <small className="muted">{r.parts.map((p) => `${formatAmount(p.amount)} ${p.token.symbol}`).join(' + ')}</small>
            </span>
            <span data-label="Fees">
              <span className="muted small">Auto-compounded</span>
            </span>
            <span data-label="uPnL" className="muted">
              —
            </span>
            <span data-label="Pool APR">{apr(r.pool.id)}</span>
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
