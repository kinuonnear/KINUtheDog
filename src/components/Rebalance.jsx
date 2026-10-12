// Rebalance button + modal for CLMM positions that left their range (lib/rebalance.js):
// withdraw → swap the needed share → reopen around the current price, in one request.

import { useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { buildRebalanceTransactions, quoteRebalance, REBALANCE_WIDTHS } from '../lib/rebalance.js';
import { pointToPrice, STRATEGIES } from '../lib/dclLiquidity.js';
import { formatAmount, toNumber } from '../lib/format.js';
import { Modal, Spinner, TokenIcon } from './ui.jsx';

function RangeLine({ left, right, x, y }) {
  return (
    <b className="mono">
      {formatAmount(pointToPrice(left, x.decimals, y.decimals))} – {formatAmount(pointToPrice(right, x.decimals, y.decimals))}{' '}
      <span className="muted small">
        {y.symbol}/{x.symbol}
      </span>
    </b>
  );
}

function Amounts({ ax, ay, x, y }) {
  const parts = [
    ax > 0 && (
      <span key="x">
        <TokenIcon token={x} size={16} /> {formatAmount(ax)} {x.symbol}
      </span>
    ),
    ay > 0 && (
      <span key="y">
        <TokenIcon token={y} size={16} /> {formatAmount(ay)} {y.symbol}
      </span>
    )
  ].filter(Boolean);
  return <span className="rebalance__amounts">{parts.length ? parts : '—'}</span>;
}

function RebalanceModal({ positions, x, y, onClose, onDone }) {
  const { accountId, slippage, execute } = useApp();
  const [width, setWidth] = useState('same');
  const [strategy, setStrategy] = useState('spot');
  const [submitting, setSubmitting] = useState(false);
  const ids = positions.map((p) => p.id).join(',');

  const quote = useAsync(
    () => quoteRebalance({ positions, x, y, width, strategy, slippage, user: accountId }),
    [ids, width, strategy, slippage, accountId],
    { refreshMs: 30_000 }
  );
  const q = quote.data;
  const oldLeft = Math.min(...positions.map((p) => p.leftPoint));
  const oldRight = Math.max(...positions.map((p) => p.rightPoint));

  const submit = async () => {
    setSubmitting(true);
    // Re-quote at signing time so the swap and deposit match the latest pool price.
    const ok = await execute(
      async () => {
        const fresh = await quoteRebalance({ positions, x, y, width, strategy, slippage, user: accountId });
        return buildRebalanceTransactions({ rebalance: fresh, positions, slippage, accountId });
      },
      { pending: `Rebalancing ${x.symbol}/${y.symbol}`, success: 'Position rebalanced' }
    );
    setSubmitting(false);
    if (ok) {
      onDone?.();
      onClose();
    }
  };

  return (
    <Modal
      title="Rebalance position"
      subtitle={`${x.symbol} / ${y.symbol} · ${positions.length} position${positions.length === 1 ? '' : 's'} out of range — not earning fees`}
      onClose={onClose}
      width={520}
    >
      <div className="liq-form rebalance">
        <dl className="kv">
          <div>
            <dt>Current range</dt>
            <dd>
              <RangeLine left={oldLeft} right={oldRight} x={x} y={y} />
            </dd>
          </div>
          <div>
            <dt>Pool price now</dt>
            <dd className="mono">{q ? formatAmount(pointToPrice(q.pool.current_point, x.decimals, y.decimals)) : '…'}</dd>
          </div>
        </dl>

        <div className="rebalance__field">
          <span className="eyebrow">New range width</span>
          <div className="segmented segmented--full">
            {REBALANCE_WIDTHS.map((w) => (
              <button key={w.key} type="button" className={width === w.key ? 'active' : ''} onClick={() => setWidth(w.key)}>
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="rebalance__field">
          <span className="eyebrow">Strategy</span>
          <div className="segmented segmented--full">
            {STRATEGIES.map((s) => (
              <button key={s.key} type="button" className={strategy === s.key ? 'active' : ''} onClick={() => setStrategy(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
          <small className="muted">{STRATEGIES.find((s) => s.key === strategy)?.hint}</small>
        </div>

        {quote.error ? (
          <div className="notice notice--warn">{quote.error.message}</div>
        ) : !q ? (
          <div className="rebalance__loading">
            <Spinner size={14} /> Planning the new range…
          </div>
        ) : (
          <ol className="rebalance__steps">
            <li>
              <strong>Withdraw</strong>
              <Amounts ax={toNumber(q.held.x, x.decimals)} ay={toNumber(q.held.y, y.decimals)} x={x} y={y} />
              <small className="muted">Earned fees are paid to your wallet too.</small>
            </li>
            <li>
              <strong>Swap</strong>
              {q.swap ? (
                <span>
                  {formatAmount(toNumber(q.swap.amountIn, q.swap.tokenIn.decimals))} {q.swap.tokenIn.symbol} → at least{' '}
                  {formatAmount(toNumber(q.swap.quote.minAmountOut, q.swap.tokenOut.decimals))} {q.swap.tokenOut.symbol}
                  <small className="muted"> · {q.swap.quote.source}</small>
                </span>
              ) : (
                <span className="muted">Not needed — the withdrawn tokens already fit the new range.</span>
              )}
            </li>
            <li>
              <strong>Open the new range</strong>
              <RangeLine left={q.range.left} right={q.range.right} x={x} y={y} />
              <Amounts ax={q.plan.totalX / 10 ** x.decimals} ay={q.plan.totalY / 10 ** y.decimals} x={x} y={y} />
            </li>
          </ol>
        )}

        <button
          type="button"
          className="button button--primary button--block button--lg"
          disabled={!q || Boolean(quote.error) || submitting}
          onClick={submit}
        >
          {submitting && <Spinner size={14} />}
          {submitting ? 'Confirm in wallet…' : 'Rebalance'}
        </button>
        <p className="hint">
          One wallet request · max slippage {slippage}%. Amounts are sized from minimums, so a small remainder may stay in your
          wallet.
        </p>
      </div>
    </Modal>
  );
}

/** Shown only when some positions are out of range; rebalances those positions. */
export default function RebalanceButton({ positions, x, y, onDone, className = 'button button--outline button--sm' }) {
  const [open, setOpen] = useState(false);
  const out = positions.filter((p) => !p.inRange && !(p.leftPoint <= -790000 && p.rightPoint >= 790000));
  if (!out.length) return null;
  return (
    <>
      <button type="button" className={`${className} rebalance-button`} onClick={() => setOpen(true)} title="Move out-of-range liquidity back around the price">
        ⟲ Rebalance
      </button>
      {open && <RebalanceModal positions={out} x={x} y={y} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}
