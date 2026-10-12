// Auto-compound: claim a pool's CLMM fees and add them back into the same positions, in one
// wallet request (lib/dclLiquidity.js → buildDclCompoundTransactions).

import { useState } from 'react';
import { useApp } from '../state.jsx';
import { buildDclCompoundTransactions, planCompound } from '../lib/dclLiquidity.js';
import { priceOf } from '../lib/tokens.js';
import { formatAmount, formatUsd, toNumber } from '../lib/format.js';
import { Modal, Spinner, TokenIcon } from './ui.jsx';

function Pair({ ax, ay, x, y }) {
  return (
    <span className="compound__pair">
      <span>
        <TokenIcon token={x} size={16} /> {formatAmount(ax)} {x.symbol}
      </span>
      <span>
        <TokenIcon token={y} size={16} /> {formatAmount(ay)} {y.symbol}
      </span>
    </span>
  );
}

function CompoundModal({ positions, x, y, onClose, onDone }) {
  const { accountId, slippage, execute, prices } = useApp();
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState('shape');
  const plan = planCompound(positions, { mode });
  const n = (v, t) => toNumber(v, t.decimals);
  const usd = (vx, vy) => n(vx, x) * priceOf(prices, x.id) + n(vy, y) * priceOf(prices, y.id);
  const leftX = plan.feeX - plan.totalX;
  const leftY = plan.feeY - plan.totalY;

  const submit = async () => {
    setSubmitting(true);
    const ok = await execute(() => buildDclCompoundTransactions({ positions, slippage, accountId, mode }), {
      pending: `Compounding ${x.symbol}/${y.symbol} fees`,
      success: 'Fees compounded into your positions'
    });
    setSubmitting(false);
    if (ok) {
      onDone?.();
      onClose();
    }
  };

  return (
    <Modal title="Compound fees" subtitle={`${x.symbol} / ${y.symbol} · put earned fees back to work`} onClose={onClose} width={480}>
      <div className="liq-form compound">
        <div className="rebalance__field">
          <span className="eyebrow">Add fees to</span>
          <div className="segmented segmented--full">
            <button type="button" className={mode === 'shape' ? 'active' : ''} onClick={() => setMode('shape')}>
              All positions · keep my shape
            </button>
            <button type="button" className={mode === 'earning' ? 'active' : ''} onClick={() => setMode('earning')}>
              Earning positions only
            </button>
          </div>
          <small className="muted">
            {mode === 'shape'
              ? 'Fees are pooled: positions in range take both tokens, the rest of each token goes to positions on its side of the price.'
              : 'Only positions in range get fees, in their token ratio. The rest stays in your wallet.'}
          </small>
        </div>
        <dl className="kv">
          <div>
            <dt>Claimable fees</dt>
            <dd>
              <Pair ax={n(plan.feeX, x)} ay={n(plan.feeY, y)} x={x} y={y} />
              <small className="muted">{formatUsd(usd(plan.feeX, plan.feeY))}</small>
            </dd>
          </div>
          <div>
            <dt>Added back</dt>
            <dd>
              <Pair ax={n(plan.totalX, x)} ay={n(plan.totalY, y)} x={x} y={y} />
              <small className="muted">
                {formatUsd(usd(plan.totalX, plan.totalY))} into {plan.items.length} position{plan.items.length === 1 ? '' : 's'}
              </small>
            </dd>
          </div>
          {(leftX > 0n || leftY > 0n) && (
            <div>
              <dt>Stays in your wallet</dt>
              <dd>
                <Pair ax={n(leftX, x)} ay={n(leftY, y)} x={x} y={y} />
              </dd>
            </div>
          )}
          <div>
            <dt>Max slippage</dt>
            <dd>{slippage}%</dd>
          </div>
        </dl>
        <button type="button" className="button button--primary button--block button--lg" disabled={submitting || !plan.items.length} onClick={submit}>
          {submitting && <Spinner size={14} />}
          {submitting ? 'Confirm in wallet…' : plan.items.length ? 'Compound' : 'Nothing to compound'}
        </button>
        <p className="hint">
          One wallet request: claim fees, deposit them and add them to your existing positions. Positions outside the range
          start earning again when the price returns to them.
        </p>
      </div>
    </Modal>
  );
}

/** Shown when some positions have fees that fit back into them. */
export default function CompoundButton({ positions, x, y, onDone, className = 'button button--outline button--sm' }) {
  const [open, setOpen] = useState(false);
  if (!planCompound(positions).items.length) return null;
  return (
    <>
      <button type="button" className={`${className} compound-button`} onClick={() => setOpen(true)} title="Add earned fees back into your positions">
        ↻ Compound
      </button>
      {open && <CompoundModal positions={positions} x={x} y={y} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}
