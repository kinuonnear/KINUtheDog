// Grouped CLMM positions for one pool, with the same actions as the
// "Your Liquidity" panel on app.rhea.finance/poolV2: Claim fees, Add, Remove.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { Link, poolPath } from '../router.jsx';
import { buildDclClaimTransactions, buildDclRemoveTransactions, pointToPrice } from '../lib/dclLiquidity.js';
import { priceOf } from '../lib/tokens.js';
import { formatAmount, formatChartPrice, formatUsd, toNumber } from '../lib/format.js';
import { dclAmountX, dclAmountY } from '../lib/rhea.js';
import { Modal, Spinner, TokenIcon } from './ui.jsx';
import RebalanceButton from './Rebalance.jsx';

/** Summary numbers for a set of positions in one pool. */
export function summarizeDclGroup(positions, x, y, prices) {
  const amountX = positions.reduce((s, p) => s + p.amountX, 0) / 10 ** x.decimals;
  const amountY = positions.reduce((s, p) => s + p.amountY, 0) / 10 ** y.decimals;
  const feeX = positions.reduce((s, p) => s + toNumber(p.unclaimedFeeX, x.decimals), 0);
  const feeY = positions.reduce((s, p) => s + toNumber(p.unclaimedFeeY, y.decimals), 0);
  const px = priceOf(prices, x.id);
  const py = priceOf(prices, y.id);
  const left = Math.min(...positions.map((p) => p.leftPoint));
  const right = Math.max(...positions.map((p) => p.rightPoint));
  return {
    amountX,
    amountY,
    usd: amountX * px + amountY * py,
    feeX,
    feeY,
    feeUsd: feeX * px + feeY * py,
    hasFees: feeX > 0 || feeY > 0,
    inRange: positions.some((p) => p.inRange),
    minPrice: pointToPrice(left, x.decimals, y.decimals),
    maxPrice: pointToPrice(right, x.decimals, y.decimals),
    fullRange: left <= -790000 && right >= 790000
  };
}

export function RangeText({ summary, x, y }) {
  if (summary.fullRange) return <span>Full range</span>;
  return (
    <span>
      <b className="mono">
        {formatAmount(summary.minPrice)} – {formatAmount(summary.maxPrice)}
      </b>{' '}
      <span className="muted small">
        {y.symbol}/{x.symbol}
      </span>
    </span>
  );
}

export function FeesText({ summary, x, y }) {
  if (!summary.hasFees) return <span className="muted">—</span>;
  return (
    <span className="fees">
      <span>
        <TokenIcon token={x} size={16} /> {formatAmount(summary.feeX)}
      </span>
      <span>
        <TokenIcon token={y} size={16} /> {formatAmount(summary.feeY)}
      </span>
    </span>
  );
}

const PERCENTS = [25, 50, 75, 100];

/** Remove a percentage of every position in the group (app.rhea.finance Remove modal). */
export function DclRemoveModal({ positions, x, y, onClose, onDone }) {
  const { accountId, slippage, execute, prices } = useApp();
  const [percent, setPercent] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const summary = summarizeDclGroup(positions, x, y, prices);
  const share = percent / 100;

  const submit = async () => {
    setSubmitting(true);
    const ok = await execute(() => buildDclRemoveTransactions({ positions, percent, slippage, accountId }), {
      pending: `Removing ${percent}% of ${x.symbol}/${y.symbol}`,
      success: 'Liquidity removed'
    });
    setSubmitting(false);
    if (ok) {
      onDone?.();
      onClose();
    }
  };

  return (
    <Modal title="Remove liquidity" subtitle={`${x.symbol} / ${y.symbol} · ${positions.length} position${positions.length === 1 ? '' : 's'}`} onClose={onClose}>
      <div className="liq-form">
        <div className="range-block">
          <div className="range-block__value">{percent}%</div>
          <input type="range" min="1" max="100" value={percent} onChange={(e) => setPercent(Number(e.target.value))} aria-label="Percent to remove" />
          <div className="segmented segmented--full">
            {PERCENTS.map((p) => (
              <button key={p} type="button" className={percent === p ? 'active' : ''} onClick={() => setPercent(p)}>
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
          </div>
        </div>
        <dl className="kv">
          <div>
            <dt>
              <TokenIcon token={x} size={18} /> {x.symbol}
            </dt>
            <dd>{formatAmount(summary.amountX * share)}</dd>
          </div>
          <div>
            <dt>
              <TokenIcon token={y} size={18} /> {y.symbol}
            </dt>
            <dd>{formatAmount(summary.amountY * share)}</dd>
          </div>
          <div>
            <dt>Value</dt>
            <dd>{formatUsd(summary.usd * share)}</dd>
          </div>
          {summary.hasFees && (
            <div>
              <dt>Unclaimed fees (paid out too)</dt>
              <dd>{formatUsd(summary.feeUsd)}</dd>
            </div>
          )}
          <div>
            <dt>Max slippage</dt>
            <dd>{slippage}%</dd>
          </div>
        </dl>
        <button type="button" className="button button--primary button--block button--lg" disabled={submitting} onClick={submit}>
          {submitting && <Spinner size={14} />}
          {submitting ? 'Confirm in wallet…' : `Remove ${percent}%`}
        </button>
        <p className="hint">Tokens and earned fees go straight back to your wallet.</p>
      </div>
    </Modal>
  );
}

/** Claim / Add / Remove buttons for one pool's positions. */
function ActionIcon({ kind }) {
  const paths = {
    claim: <path d="M9 2v9M5.5 7.5 9 11l3.5-3.5M3 14h12" />,
    add: <path d="M9 3v12M3 9h12" />,
    remove: <path d="M3 9h12" />
  };
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

export function DclActions({ poolId, positions, x, y, onDone, onAdd, readOnly, stacked = false, icons = false, claimOnly = false }) {
  const { accountId, execute, prices } = useApp();
  const [removing, setRemoving] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const summary = summarizeDclGroup(positions, x, y, prices);

  const claim = async () => {
    setClaiming(true);
    const ok = await execute(() => buildDclClaimTransactions({ positions, accountId }), {
      pending: `Claiming ${x.symbol}/${y.symbol} fees`,
      success: 'Fees claimed'
    });
    setClaiming(false);
    if (ok) onDone?.();
  };

  if (readOnly) {
    return (
      <Link to={poolPath(poolId)} className="button button--ghost button--sm">
        View
      </Link>
    );
  }

  if (claimOnly) {
    return (
      <button type="button" className="button button--outline button--sm" disabled={!summary.hasFees || claiming} onClick={claim}>
        {claiming ? <Spinner size={12} /> : 'Claim all'}
      </button>
    );
  }

  if (icons) {
    const addProps = onAdd ? { onClick: onAdd } : {};
    const AddTag = onAdd ? 'button' : Link;
    return (
      <div className="icon-actions">
        <button type="button" className="icon-action icon-action--claim" disabled={!summary.hasFees || claiming} onClick={claim} title="Claim fees" aria-label="Claim fees">
          {claiming ? <Spinner size={12} /> : <ActionIcon kind="claim" />}
        </button>
        <AddTag
          type={onAdd ? 'button' : undefined}
          to={onAdd ? undefined : `${poolPath(poolId)}?tab=add`}
          className="icon-action icon-action--add"
          title="Add liquidity"
          aria-label="Add liquidity"
          {...addProps}
        >
          <ActionIcon kind="add" />
        </AddTag>
        <button type="button" className="icon-action icon-action--remove" onClick={() => setRemoving(true)} title="Remove liquidity" aria-label="Remove liquidity">
          <ActionIcon kind="remove" />
        </button>
        {removing && <DclRemoveModal positions={positions} x={x} y={y} onClose={() => setRemoving(false)} onDone={onDone} />}
      </div>
    );
  }

  return (
    <div className={`lp-actions ${stacked ? 'lp-actions--stack' : ''}`}>
      <RebalanceButton positions={positions} x={x} y={y} onDone={onDone} />
      <button type="button" className="button button--outline button--sm" disabled={!summary.hasFees || claiming} onClick={claim}>
        {claiming ? <Spinner size={12} /> : stacked ? `Claim fees${summary.hasFees ? ` · ${formatUsd(summary.feeUsd)}` : ''}` : 'Claim'}
      </button>
      {onAdd ? (
        <button type="button" className="button button--outline button--sm" onClick={onAdd}>
          Add
        </button>
      ) : (
        <Link to={`${poolPath(poolId)}?tab=add`} className="button button--outline button--sm">
          Add
        </Link>
      )}
      <button type="button" className="button button--ghost button--sm" onClick={() => setRemoving(true)}>
        Remove
      </button>
      {removing && <DclRemoveModal positions={positions} x={x} y={y} onClose={() => setRemoving(false)} onDone={onDone} />}
    </div>
  );
}

const BUCKETS = 32;

/**
 * All positions of a pool merged into one liquidity distribution (like the
 * "Your Liquidity" chart on app.rhea.finance): liquidity summed per price
 * bucket, coloured by the token held on each side of the current price.
 */
export function PositionDistribution({ positions, x, y }) {
  const [hover, setHover] = useState(null);
  const current = positions[0]?.currentPoint ?? 0;

  const model = useMemo(() => {
    const lo = Math.min(...positions.map((p) => p.leftPoint));
    const hi = Math.max(...positions.map((p) => p.rightPoint));
    const span = Math.max(hi - lo, 1);
    const from = Math.min(lo, current) - span * 0.04;
    const to = Math.max(hi, current) + span * 0.04;
    const width = (to - from) / BUCKETS;
    const buckets = Array.from({ length: BUCKETS }, (_, i) => {
      const left = from + i * width;
      const right = left + width;
      let liquidity = 0;
      let amountX = 0;
      let amountY = 0;
      positions.forEach((p) => {
        const a = Math.max(left, p.leftPoint);
        const b = Math.min(right, p.rightPoint);
        if (b <= a) return;
        liquidity += Number(p.liquidity) * ((b - a) / width);
        const split = Math.min(Math.max(current, a), b);
        amountX += dclAmountX(p.liquidity, split, b);
        amountY += dclAmountY(p.liquidity, a, split);
      });
      return { left, right, liquidity, amountX, amountY };
    });
    const max = Math.max(...buckets.map((b) => b.liquidity), 1);
    return { from, to, buckets: buckets.map((b) => ({ ...b, h: b.liquidity / max })) };
  }, [positions, current]);

  const toPct = (point) => ((point - model.from) / (model.to - model.from)) * 100;
  const price = (point) => pointToPrice(point, x.decimals, y.decimals);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => model.from + t * (model.to - model.from));
  const hovered = hover !== null ? model.buckets[hover] : null;

  return (
    <div className="pos-dist">
      <div className="pos-dist__chart" onMouseLeave={() => setHover(null)}>
        {model.buckets.map((b, i) => {
          const containsCurrent = current >= b.left && current < b.right;
          const side = containsCurrent ? 'cur' : b.right <= current ? 'y' : 'x';
          return (
            <span
              key={i}
              className={`pos-dist__bar pos-dist__bar--${side} ${hover === i ? 'hover' : ''}`}
              style={{ left: `${(i / BUCKETS) * 100}%`, width: `${100 / BUCKETS}%`, height: `${b.liquidity > 0 ? Math.max(3, b.h * 100) : 0}%` }}
              onMouseEnter={() => setHover(i)}
            />
          );
        })}
        <span className="pos-dist__current" style={{ left: `${toPct(current)}%` }}>
          <em>{formatChartPrice(price(current))}</em>
        </span>
        {hovered && hovered.liquidity > 0 && (
          <div className="pos-dist__tip" style={{ left: `${Math.min(80, Math.max(2, (hover / BUCKETS) * 100))}%` }}>
            <b>
              {formatChartPrice(price(hovered.left))} – {formatChartPrice(price(hovered.right))}
            </b>
            <span>
              {formatAmount(hovered.amountX / 10 ** x.decimals)} {x.symbol} + {formatAmount(hovered.amountY / 10 ** y.decimals)} {y.symbol}
            </span>
          </div>
        )}
      </div>
      <div className="pos-dist__axis">
        {ticks.map((t) => (
          <span key={t}>{formatChartPrice(price(t))}</span>
        ))}
      </div>
      <div className="depth__legend">
        <span>
          <i className="y" /> {y.symbol}
        </span>
        <span>
          <i className="x" /> {x.symbol}
        </span>
        <span className="muted">
          {y.symbol} per {x.symbol}
        </span>
      </div>
    </div>
  );
}

/** Mini range track: every position as a segment, plus the current price. */
function RangeTrack({ positions }) {
  const current = positions[0]?.currentPoint ?? 0;
  const lo = Math.min(current, ...positions.map((p) => p.leftPoint));
  const hi = Math.max(current, ...positions.map((p) => p.rightPoint));
  const pad = (hi - lo) * 0.06 || 1;
  const pos = (pt) => ((pt - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  return (
    <div className="range-track" aria-hidden="true">
      {positions.map((p) => (
        <span
          key={p.id}
          className={`range-track__seg ${p.inRange ? 'in' : ''}`}
          style={{ left: `${pos(p.leftPoint)}%`, width: `${Math.max(1.5, pos(p.rightPoint) - pos(p.leftPoint))}%` }}
        />
      ))}
      <span className="range-track__now" style={{ left: `${pos(current)}%` }} />
    </div>
  );
}

/**
 * "Your liquidity" on the CLMM pool page: a summary bar and one combined row
 * for all of the pool's positions (range, liquidity, claimable fees, active
 * share, actions). The row expands to the liquidity distribution.
 */
export function DclGroupCard({ poolId, positions, x, y, pool, onDone, onAdd, onChart = false, onToggleChart }) {
  const { prices } = useApp();
  const [open, setOpen] = useState(false);
  const summary = summarizeDclGroup(positions, x, y, prices);
  const inRange = positions.filter((p) => p.inRange);
  const activeL = inRange.reduce((s2, p) => s2 + Number(p.liquidity), 0);
  const poolL = Number(pool?.liquidity || 0);
  const activeShare = poolL > 0 ? (activeL / poolL) * 100 : null;
  const feeShare = summary.usd > 0 ? (summary.feeUsd / summary.usd) * 100 : 0;
  const px = priceOf(prices, x.id);
  const py = priceOf(prices, y.id);

  return (
    <div className="lp-board">
      <div className="lp-board__bar">
        <div>
          <span>Claimable fees</span>
          <strong className={summary.hasFees ? 'up' : ''}>{formatUsd(summary.feeUsd)}</strong>
        </div>
        <div>
          <span>Positions</span>
          <strong>
            {inRange.length}
            <small>/{positions.length} in range</small>
          </strong>
        </div>
        <div>
          <span>Liquidity</span>
          <strong>{formatUsd(summary.usd)}</strong>
        </div>
        <span className="lp-board__spacer" />
        <DclActions poolId={poolId} positions={positions} x={x} y={y} onDone={onDone} claimOnly />
      </div>

      <div className="lp-board__table">
        <div className="lp-board__row lp-board__row--head">
          <span>Price range</span>
          <span>Your liquidity</span>
          <span>Claimable fees</span>
          <span>Active share</span>
          <span>Actions</span>
        </div>
        <div
          className={`lp-board__row ${onToggleChart ? 'lp-board__row--clickable' : ''} ${onChart ? 'lp-board__row--on-chart' : ''}`}
          onClick={(e) => {
            // Buttons and links in the row keep their own actions.
            if (onToggleChart && !e.target.closest('button, a, input')) onToggleChart();
          }}
          title={onToggleChart ? (onChart ? 'Hide your range on the chart' : 'Show your range on the chart') : undefined}
        >
          <div className="lp-board__range" data-label="Price range">
            <strong className="mono">
              {summary.fullRange ? 'Full range' : `${formatChartPrice(summary.minPrice)} – ${formatChartPrice(summary.maxPrice)}`}
            </strong>
            <small>
              {y.symbol} per {x.symbol} · {positions.length} position{positions.length === 1 ? '' : 's'}
            </small>
            <RangeTrack positions={positions} />
            {onToggleChart && (
              <button type="button" className={`chart-toggle ${onChart ? 'chart-toggle--on' : ''}`} onClick={onToggleChart} aria-pressed={onChart}>
                {onChart ? '◉ Shown on chart' : '◎ Show on chart'}
              </button>
            )}
          </div>
          <div className="lp-board__cell" data-label="Your liquidity">
            <strong>{formatUsd(summary.usd)}</strong>
            <span>
              <TokenIcon token={x} size={14} /> {formatAmount(summary.amountX)}
            </span>
            <span>
              <TokenIcon token={y} size={14} /> {formatAmount(summary.amountY)}
            </span>
          </div>
          <div className="lp-board__cell" data-label="Claimable fees">
            <strong>
              {formatUsd(summary.feeUsd)} <em className="pill">{feeShare.toFixed(2)}%</em>
            </strong>
            <span>
              <TokenIcon token={x} size={14} /> {formatAmount(summary.feeX)} <small>({formatUsd(summary.feeX * px)})</small>
            </span>
            <span>
              <TokenIcon token={y} size={14} /> {formatAmount(summary.feeY)} <small>({formatUsd(summary.feeY * py)})</small>
            </span>
          </div>
          <div className="lp-board__cell" data-label="Active share">
            <strong className={inRange.length ? 'up' : 'warn'}>{activeShare !== null ? `${activeShare.toFixed(2)}%` : '—'}</strong>
            <span className={`range-badge ${summary.inRange ? 'range-badge--in' : ''}`}>
              {summary.inRange ? `${inRange.length} of ${positions.length} earning` : 'Not earning'}
            </span>
            <small className="muted">of active pool liquidity</small>
            <RebalanceButton positions={positions} x={x} y={y} onDone={onDone} className="button button--outline button--sm" />
          </div>
          <div className="lp-board__actions" data-label="Actions">
            <DclActions poolId={poolId} positions={positions} x={x} y={y} onDone={onDone} onAdd={onAdd} icons />
            <button type="button" className={`icon-action icon-action--more ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)} title="Liquidity distribution" aria-expanded={open}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
        {open && (
          <div className="lp-board__detail">
            <PositionDistribution positions={positions} x={x} y={y} />
          </div>
        )}
      </div>
    </div>
  );
}
