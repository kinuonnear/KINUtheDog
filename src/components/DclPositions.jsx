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
export function DclActions({ poolId, positions, x, y, onDone, onAdd, readOnly, stacked = false }) {
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

  return (
    <div className={`lp-actions ${stacked ? 'lp-actions--stack' : ''}`}>
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

/** "Your liquidity" card on the CLMM pool page: one combined view of every position. */
export function DclGroupCard({ poolId, positions, x, y, onDone, onAdd }) {
  const { prices } = useApp();
  const summary = summarizeDclGroup(positions, x, y, prices);
  const inRange = positions.filter((p) => p.inRange).length;

  return (
    <div className="dcl-group">
      <div className="dcl-group__grid">
        <div>
          <span className="stat__label">Your liquidity</span>
          <strong className="dcl-group__value">{formatUsd(summary.usd)}</strong>
          <span className="muted small">
            {formatAmount(summary.amountX)} {x.symbol} + {formatAmount(summary.amountY)} {y.symbol}
          </span>
        </div>
        <div>
          <span className="stat__label">Price range</span>
          <RangeText summary={summary} x={x} y={y} />
          <span className={`range-badge ${summary.inRange ? 'range-badge--in' : ''}`}>{summary.inRange ? 'In range' : 'Out of range'}</span>
        </div>
        <div>
          <span className="stat__label">Unclaimed fees</span>
          <FeesText summary={summary} x={x} y={y} />
          {summary.hasFees && <span className="muted small">{formatUsd(summary.feeUsd)}</span>}
        </div>
      </div>
      <div className="dcl-group__row">
        <PositionDistribution positions={positions} x={x} y={y} />
        <div className="dcl-group__side">
          <div className="dcl-group__count">
            <strong>{positions.length}</strong>
            <span>
              position{positions.length === 1 ? '' : 's'} in this pool
              <small>
                <i className="dot dot--in" /> {inRange} in range · <i className="dot dot--out" /> {positions.length - inRange} out of range
              </small>
            </span>
          </div>
          <DclActions poolId={poolId} positions={positions} x={x} y={y} onDone={onDone} onAdd={onAdd} stacked />
          <p className="hint">Claim and Remove act on all {positions.length} positions at once.</p>
        </div>
      </div>
    </div>
  );
}
