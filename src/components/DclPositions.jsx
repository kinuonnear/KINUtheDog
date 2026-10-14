// CLMM positions for one pool, Meteora-style: one row per deposit (lib/lpPositions.js),
// each with Claim fees, Add (to the same bins), Remove, Rebalance and its range on the chart.

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { Link, poolPath } from '../router.jsx';
import { buildDclClaimTransactions, buildDclRemoveTransactions, pointToPrice } from '../lib/dclLiquidity.js';
import { priceOf } from '../lib/tokens.js';
import { formatAmount, formatChartPrice, formatPercent, formatUsd, toNumber } from '../lib/format.js';
import { dclAmountX, dclAmountY } from '../lib/rhea.js';
import { Modal, Spinner, TokenIcon } from './ui.jsx';
import RebalanceButton from './Rebalance.jsx';
import CompoundButton from './Compound.jsx';
import AddToPositionModal from './AddToPosition.jsx';
import { formatAge } from '../lib/lpHistory.js';
import { dclTax } from '../lib/tokenTax.js';
import { useAsync, useDebounced } from '../hooks.js';
import { buildZapOutTransactions, quoteZapOut } from '../lib/zapOut.js';
import { CONTRACTS } from '../config.js';
import { SlippagePicker } from './Slippage.jsx';
import ShareButton from './ShareCard.jsx';
import { positionShareCard } from '../lib/shareCard.js';
import { usePoolPnl } from './LpPnl.jsx';

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
const ZAP_OUT_REFRESH_MS = 20_000;

/** Remove a percentage of every position in the group (app.rhea.finance Remove modal). */
export function DclRemoveModal({ positions, x, y, onClose, onDone }) {
  const { accountId, slippage, setSlippage, execute, prices } = useApp();
  const [percent, setPercent] = useState(100);
  const [editSlippage, setEditSlippage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const summary = summarizeDclGroup(positions, x, y, prices);
  const share = percent / 100;
  // 'both': both tokens back; 'zap': everything (fees included) as one token.
  const [mode, setMode] = useState('both');
  const [target, setTarget] = useState(() => (y.id === CONTRACTS.wrapNear ? 'y' : x.id === CONTRACTS.wrapNear ? 'x' : 'y'));
  const sideLabel = (t) => (t.id === CONTRACTS.wrapNear ? 'NEAR' : t.symbol);
  const debouncedPercent = useDebounced(percent, 350);
  // Refreshed every 20s while the modal is open and the tab visible (and on ↻ Update).
  const zap = useAsync(
    () => quoteZapOut({ positions, percent: debouncedPercent, x, y, target, slippage, user: accountId || undefined }),
    [mode, debouncedPercent, target, slippage, accountId, positions.map((p) => `${p.id}:${p.liquidity}`).join(',')],
    { enabled: mode === 'zap', refreshMs: ZAP_OUT_REFRESH_MS }
  );
  const zapReady = mode === 'zap' && zap.data && !zap.error && debouncedPercent === percent;
  const refreshing = mode === 'zap' && zap.loading && Boolean(zap.data);
  const outSymbol = zap.data ? zap.data.outToken.symbol : sideLabel(target === 'x' ? x : y);
  const outDecimals = (target === 'x' ? x : y).decimals;
  const impact = zapReady && zap.data.swap && Number.isFinite(zap.data.swap.quote.priceImpact) ? zap.data.swap.quote.priceImpact : null;

  const submit = async () => {
    setSubmitting(true);
    const ok =
      mode === 'zap'
        ? await execute(
            async () => {
              // Quote again right before signing: removal minimums and the swap use the latest price.
              const fresh = await quoteZapOut({ positions, percent, x, y, target, slippage, user: accountId });
              return buildZapOutTransactions({ zap: fresh, slippage, accountId });
            },
            { pending: `Zapping ${percent}% of ${x.symbol}/${y.symbol} out to ${outSymbol}`, success: `Liquidity removed as ${outSymbol}` }
          )
        : await execute(() => buildDclRemoveTransactions({ positions, percent, slippage, accountId }), {
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
    <Modal title="Remove liquidity" subtitle={`${x.symbol} / ${y.symbol} · your position · ${positions.length} bin${positions.length === 1 ? '' : 's'}`} onClose={onClose} width={780}>
      {/* Two columns on wider screens (choices left, outcome right): no scrolling to see it all. */}
      <div className="liq-form remove-grid">
        <div className="remove-grid__col">
          <div className="segmented segmented--full add-pos__mode">
            <button type="button" className={mode === 'both' ? 'active' : ''} onClick={() => setMode('both')}>
              Both tokens
            </button>
            <button type="button" className={mode === 'zap' ? 'active' : ''} onClick={() => setMode('zap')}>
              ⚡ Zap out
            </button>
          </div>
          {mode === 'zap' && (
            <div className="zap-out__target">
              <span>Receive</span>
              <div className="segmented segmented--tight">
                {[
                  ['x', x],
                  ['y', y]
                ].map(([side, t]) => (
                  <button key={side} type="button" className={target === side ? 'active' : ''} onClick={() => setTarget(side)}>
                    <TokenIcon token={t} size={14} /> {sideLabel(t)}
                  </button>
                ))}
              </div>
            </div>
          )}
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
          {mode === 'zap' && (
            <div className="notice notice--warn zap-out__notice">
              <span>
                <b>⚡ Zap out includes your earned fees.</b>{' '}
                {summary.hasFees
                  ? `All unclaimed fees of this position (${formatAmount(summary.feeX)} ${x.symbol} + ${formatAmount(summary.feeY)} ${y.symbol} ≈ ${formatUsd(summary.feeUsd)}) are paid out and swapped into ${outSymbol} together with the liquidity you remove — even when you remove less than 100%.`
                  : `Any unclaimed fees are paid out and swapped into ${outSymbol} together with the liquidity you remove.`}
                {zap.data?.taxed ? ' A token tax applies on the way out and on the swap.' : ''} A little of the other token may stay in your wallet.
              </span>
            </div>
          )}
        </div>
        <div className="remove-grid__col">
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
            {zapReady && zap.data.swap && (
              <div>
                <dt>Swap</dt>
                <dd>
                  {formatAmount(toNumber(zap.data.swap.amountIn, zap.data.sellToken.decimals))} {zap.data.sellToken.symbol} → {outSymbol}
                  <small className="muted">
                    {' '}
                    · {zap.data.swap.quote.dexs?.join(' + ')}
                    {zap.data.swap.avoidsPool ? ' · avoids this pool' : ''}
                  </small>
                </dd>
              </div>
            )}
            <div>
              <dt>Max slippage</dt>
              <dd>
                <button type="button" className="pill-button" onClick={() => setEditSlippage((v) => !v)} aria-expanded={editSlippage}>
                  ⚙ {slippage}%
                </button>
              </dd>
            </div>
          </dl>
          {editSlippage && (
            <div className="add-pos__slippage">
              <SlippagePicker slippage={slippage} setSlippage={setSlippage} />
              <small className="muted">Also used for swaps and other liquidity actions in this browser.</small>
            </div>
          )}
          {mode === 'zap' && (
            <div className={`zap-out__receive ${refreshing ? 'zap-out__receive--busy' : ''}`}>
              <div className="zap-out__receive-head">
                <span>You receive</span>
                <span className="zap-out__update">
                  {zap.updatedAt && <UpdatedAgo at={zap.updatedAt} />}
                  <button type="button" className="fee-refresh" onClick={() => zap.reload()} disabled={zap.loading} title="Get a fresh quote now">
                    {zap.loading ? <Spinner size={11} /> : '↻'} Update
                  </button>
                </span>
              </div>
              {zapReady ? (
                <>
                  <strong>
                    ≈ {formatAmount(toNumber(zap.data.receiveEst, outDecimals))} <small>{outSymbol}</small>
                  </strong>
                  <div className="zap-out__receive-meta">
                    <span>
                      Min. {formatAmount(toNumber(zap.data.receiveMin, outDecimals))} {outSymbol}
                    </span>
                    {zap.data.swap && (
                      <span className={impact === null ? '' : impact > 5 ? 'down' : impact > 2 ? 'warn' : 'up'}>
                        Price impact {impact === null ? '—' : formatPercent(impact, 2)}
                      </span>
                    )}
                  </div>
                </>
              ) : zap.error ? (
                <p className="form-error">{zap.error.message}</p>
              ) : (
                <div className="zap-out__receive-meta">
                  <Spinner size={12} /> Finding the best route…
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="button button--primary button--block button--lg"
            disabled={submitting || (mode === 'zap' && !zapReady)}
            onClick={submit}
          >
            {submitting && <Spinner size={14} />}
            {submitting
              ? 'Confirm in wallet…'
              : mode === 'zap'
                ? zapReady
                  ? `Zap out ${percent}% to ${outSymbol}`
                  : zap.error
                    ? 'No zap route'
                    : 'Finding the best route…'
                : `Remove ${percent}%`}
          </button>
          <p className="hint">
            {mode === 'zap'
              ? `One wallet request: remove, then swap ${target === 'x' ? sideLabel(y) : sideLabel(x)} into ${outSymbol}${outSymbol === 'NEAR' ? ' (paid as native NEAR)' : ''}.`
              : 'Tokens and earned fees go straight back to your wallet.'}
          </p>
        </div>
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

export function DclActions({ poolId, positions, x, y, onDone, onAdd, readOnly, stacked = false, icons = false, claimOnly = false, extra = null }) {
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
      <CompoundButton positions={positions} x={x} y={y} onDone={onDone} />
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
      {extra}
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
/** Track scale: point -> % across the track (the range plus the current price, padded). */
function trackScale(positions) {
  const current = positions[0]?.currentPoint ?? 0;
  const lo = Math.min(current, ...positions.map((p) => p.leftPoint));
  const hi = Math.max(current, ...positions.map((p) => p.rightPoint));
  const pad = (hi - lo) * 0.06 || 1;
  return { current, pos: (pt) => ((pt - (lo - pad)) / (hi - lo + 2 * pad)) * 100 };
}

/** Where the position's range sits on the track (%), for lining things up under it. */
function rangeSpan(positions) {
  const { pos } = trackScale(positions);
  const start = pos(Math.min(...positions.map((p) => p.leftPoint)));
  const end = pos(Math.max(...positions.map((p) => p.rightPoint)));
  return { start, width: end - start };
}

function RangeTrack({ positions }) {
  const { current, pos } = trackScale(positions);
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
 * "Show on chart" lines up under the range bar of the track (same start and width; the track
 * is at most 220px wide). A range too short for the label falls back to the track's full width.
 */
function chartToggleStyle(positions) {
  const { start, width } = rangeSpan(positions);
  if (!(width >= 55)) return undefined;
  return { marginLeft: `calc(min(100%, 220px) * ${start / 100})`, width: `calc(min(100%, 220px) * ${width / 100})` };
}

/** "updated 8s ago", ticking. */
function UpdatedAgo({ at }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.round((now - at) / 1000));
  return <small className="fee-updated">updated {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`} ago</small>;
}

/** Name of a deposit group: "Position 2", or a fallback while / when the history is missing. */
export function depositTitle(group, loading) {
  if (group.number) return `Position ${group.number}`;
  return loading ? 'Your position' : 'Other bins';
}

/** One deposit (Meteora-style position): range, liquidity, fees, earning state and actions. */
function PositionRow({ poolId, group, x, y, pool, loading, pnl, onDone, onChart, onToggleChart }) {
  const { prices } = useApp();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const { positions } = group;
  const summary = summarizeDclGroup(positions, x, y, prices);
  const inRange = positions.filter((p) => p.inRange);
  const activeL = inRange.reduce((s, p) => s + Number(p.liquidity), 0);
  const poolL = Number(pool?.liquidity || 0);
  const activeShare = poolL > 0 ? (activeL / poolL) * 100 : null;
  const feeShare = summary.usd > 0 ? (summary.feeUsd / summary.usd) * 100 : 0;
  const px = priceOf(prices, x.id);
  const py = priceOf(prices, y.id);
  const title = depositTitle(group, loading);
  const toggleChart = onToggleChart ? () => onToggleChart(group) : null;

  return (
    <>
      <div
        className={`lp-board__row ${toggleChart ? 'lp-board__row--clickable' : ''} ${onChart ? 'lp-board__row--on-chart' : ''}`}
        onClick={(e) => {
          // Buttons and links in the row keep their own actions.
          if (toggleChart && !e.target.closest('button, a, input')) toggleChart();
        }}
        title={toggleChart ? (onChart ? 'Hide this range on the chart' : 'Show this range on the chart') : undefined}
      >
        <div className="lp-board__range" data-label="Price range">
          <span className="lp-board__title">
            <span className={`dot ${summary.inRange ? 'dot--in' : 'dot--out'}`} />
            {title}
            {group.openedAt && <small>{formatAge(Date.now() - group.openedAt)} ago</small>}
            {loading && !group.number && <Spinner size={10} />}
          </span>
          <strong className="mono">
            {summary.fullRange ? 'Full range' : `${formatChartPrice(summary.minPrice)} – ${formatChartPrice(summary.maxPrice)}`}
          </strong>
          <small>
            {y.symbol} per {x.symbol} · {positions.length} bin{positions.length === 1 ? '' : 's'}
          </small>
          <RangeTrack positions={positions} />
          {toggleChart && (
            <button
              type="button"
              className={`chart-toggle ${onChart ? 'chart-toggle--on' : ''}`}
              onClick={toggleChart}
              aria-pressed={onChart}
              style={chartToggleStyle(positions)}
            >
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
            {summary.inRange ? `${inRange.length} of ${positions.length} bins earning` : 'Not earning'}
          </span>
          <small className="muted">of active pool liquidity</small>
          <RebalanceButton positions={positions} x={x} y={y} title={title} onDone={onDone} className="button button--outline button--sm" />
          {/* This position's PnL card, right here: no detour to the Portfolio. */}
          <ShareButton
            label="Share PnL"
            className="button button--ghost button--sm lp-share"
            title="Share this position's card"
            build={(hideUsd, opts) =>
              positionShareCard({ x, y, poolId, summary, p: pnl, age: group.openedAt ? formatAge(Date.now() - group.openedAt) : null }, hideUsd, opts)
            }
          />
        </div>
        <div className="lp-board__actions" data-label="Actions">
          <DclActions poolId={poolId} positions={positions} x={x} y={y} onDone={onDone} onAdd={() => setAdding(true)} icons />
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
      {adding && <AddToPositionModal positions={positions} x={x} y={y} title={title} onClose={() => setAdding(false)} onDone={onDone} />}
    </>
  );
}

/**
 * "Your liquidity" on the CLMM pool page, Meteora-style: a summary bar for the pool and one
 * row per deposit (lib/lpPositions.js), each with its own range, fees and actions.
 * `deposits` comes from useDepositGroups; `chartKey` is the deposit shown on the chart and
 * `onToggleChart(group)` switches it.
 */
export function DclGroupCard({ poolId, positions, deposits, x, y, pool, onDone, onNew, chartKey, onToggleChart, updatedAt, onRefresh }) {
  const { prices } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  };
  const { groups, loading } = deposits;
  const summary = summarizeDclGroup(positions, x, y, prices);
  // Each position's PnL, for its share card (from the events this page already loaded).
  const pnlOf = usePoolPnl(deposits.events, poolId, x, y, prices, Boolean(deposits.error));
  const earning = groups.filter((g) => g.positions.some((p) => p.inRange)).length;

  // Fees already claimed in this pool (Claim, Compound, Remove and Add all pay them out), from
  // the account's liquidity events, after a taxed token's tax on the way out; valued at today's prices.
  const taxes = useAsync(() => Promise.all([dclTax(x.id), dclTax(y.id)]), [x.id, y.id]);
  const claimed = useMemo(() => {
    if (!deposits.events) return null;
    let fx = 0;
    let fy = 0;
    deposits.events.forEach((e) => {
      if (e.pool !== poolId) return;
      fx += toNumber(e.feeX || '0', x.decimals);
      fy += toNumber(e.feeY || '0', y.decimals);
    });
    const [tx, ty] = taxes.data || [];
    fx *= 1 - (tx?.out || 0) / 10_000;
    fy *= 1 - (ty?.out || 0) / 10_000;
    return { fx, fy, usd: fx * priceOf(prices, x.id) + fy * priceOf(prices, y.id) };
  }, [deposits.events, poolId, x.id, y.id, x.decimals, y.decimals, taxes.data, prices]);
  const claimedTitle = claimed ? `${formatAmount(claimed.fx)} ${x.symbol} + ${formatAmount(claimed.fy)} ${y.symbol} claimed (at today's prices)` : undefined;

  return (
    <div className="lp-board">
      <div className="lp-board__bar">
        <div>
          <span>Claimable fees</span>
          <strong className={summary.hasFees ? 'up' : ''}>{formatUsd(summary.feeUsd)}</strong>
          {updatedAt && <UpdatedAgo at={updatedAt} />}
          {onRefresh && (
            <button type="button" className="fee-refresh" onClick={refresh} disabled={refreshing} title="Refresh fees now">
              {refreshing ? <Spinner size={11} /> : '↻'} Refresh
            </button>
          )}
        </div>
        <div>
          <span>Positions earning</span>
          <strong>
            {earning}
            <small>/{groups.length}</small>
          </strong>
        </div>
        <div title={claimedTitle}>
          <span>Claimed fees</span>
          <strong>{claimed ? formatUsd(claimed.usd) : '—'}</strong>
        </div>
        <span className="lp-board__spacer" />
        <CompoundButton positions={positions} x={x} y={y} onDone={onDone} />
        <DclActions poolId={poolId} positions={positions} x={x} y={y} onDone={onDone} claimOnly />
        {onNew && (
          <button type="button" className="button button--outline button--sm" onClick={onNew} title="Open another position with its own range">
            + New position
          </button>
        )}
      </div>

      <div className="lp-board__table">
        <div className="lp-board__row lp-board__row--head">
          <span>Position · price range</span>
          <span>Your liquidity</span>
          <span>Claimable fees</span>
          <span>Active share</span>
          <span>Actions</span>
        </div>
        {groups.map((g) => (
          <PositionRow
            key={g.key}
            poolId={poolId}
            group={g}
            x={x}
            y={y}
            pool={pool}
            loading={loading}
            onDone={onDone}
            pnl={pnlOf(g.positions)}
            onChart={chartKey === g.key}
            onToggleChart={onToggleChart}
          />
        ))}
      </div>
    </div>
  );
}
