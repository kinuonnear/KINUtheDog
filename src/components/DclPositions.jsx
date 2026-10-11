// Grouped CLMM positions for one pool, with the same actions as the
// "Your Liquidity" panel on app.rhea.finance/poolV2: Claim fees, Add, Remove.

import { useState } from 'react';
import { useApp } from '../state.jsx';
import { Link, poolPath } from '../router.jsx';
import { buildDclClaimTransactions, buildDclRemoveTransactions, pointToPrice } from '../lib/dclLiquidity.js';
import { priceOf } from '../lib/tokens.js';
import { formatAmount, formatUsd, toNumber } from '../lib/format.js';
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
export function DclActions({ poolId, positions, x, y, onDone, onAdd, readOnly }) {
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
    <div className="lp-actions">
      <button type="button" className="button button--outline button--sm" disabled={!summary.hasFees || claiming} onClick={claim}>
        {claiming ? <Spinner size={12} /> : 'Claim'}
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

/** "Your liquidity" card on the CLMM pool page. */
export function DclGroupCard({ poolId, positions, x, y, onDone, onAdd }) {
  const { prices } = useApp();
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeDclGroup(positions, x, y, prices);

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
      <div className="dcl-group__foot">
        <button type="button" className="link-button" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide' : 'Show'} {positions.length} position{positions.length === 1 ? '' : 's'}
        </button>
        <DclActions poolId={poolId} positions={positions} x={x} y={y} onDone={onDone} onAdd={onAdd} />
      </div>
      {expanded && (
        <div className="dcl-group__list">
          {positions.map((p) => (
            <div className="dcl-group__item" key={p.id}>
              <span className={`range-badge ${p.inRange ? 'range-badge--in' : ''}`}>{p.inRange ? 'In range' : 'Out'}</span>
              <span className="mono">
                {formatAmount(pointToPrice(p.leftPoint, x.decimals, y.decimals))} – {formatAmount(pointToPrice(p.rightPoint, x.decimals, y.decimals))}
              </span>
              <span className="muted">
                {formatAmount(p.amountX / 10 ** x.decimals)} {x.symbol} + {formatAmount(p.amountY / 10 ** y.decimals)} {y.symbol}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
