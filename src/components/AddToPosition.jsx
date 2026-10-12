// Add to one position (a deposit's bins) without opening a new one: every bin grows by the
// same factor, so the range and shape stay as they are (lib/dclLiquidity.js → planAppend).

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { appendCounterpart, buildDclAppendTransactions, planAppend } from '../lib/dclLiquidity.js';
import { priceOf } from '../lib/tokens.js';
import { formatAmount, formatUnits, formatUsd, maxBig, toBigInt, toNumber, tryParseUnits } from '../lib/format.js';
import { CONTRACTS } from '../config.js';
import { Modal, Spinner } from './ui.jsx';
import { AmountField, trimDecimals, useSpendable } from './Liquidity.jsx';

export default function AddToPositionModal({ positions, x, y, title, onClose, onDone }) {
  const { accountId, slippage, execute, balances, prices } = useApp();
  const [input, setInput] = useState({ side: 'x', text: '' });
  const [submitting, setSubmitting] = useState(false);
  const tokenIds = useMemo(() => [x.id, y.id], [x.id, y.id]);
  const [spendX, spendY] = useSpendable(tokenIds);
  const holdX = positions.reduce((s, p) => s + p.amountX, 0);
  const holdY = positions.reduce((s, p) => s + p.amountY, 0);
  const needsX = holdX > 0;
  const needsY = holdY > 0;

  // The typed side decides; the other follows the position's current token mix.
  const typed = toBigInt(tryParseUnits(input.text || '0', input.side === 'x' ? x.decimals : y.decimals) || 0n);
  const other = appendCounterpart(positions, input.side, typed);
  const inX = input.side === 'x' ? typed : other;
  const inY = input.side === 'y' ? typed : other;
  const text = (side) => {
    if (side === input.side) return input.text;
    const value = side === 'x' ? inX : inY;
    return value > 0n ? trimDecimals(formatUnits(value, side === 'x' ? x.decimals : y.decimals)) : '';
  };
  const plan = planAppend(positions, { inX, inY });
  const wrapFor = (id, amount) => (id === CONTRACTS.wrapNear ? maxBig(0n, amount - toBigInt(balances[CONTRACTS.wrapNear] || '0')).toString() : '0');
  const short = (needsX && inX > spendX ? x.symbol : null) || (needsY && inY > spendY ? y.symbol : null);
  const usd = toNumber(plan.totalX, x.decimals) * priceOf(prices, x.id) + toNumber(plan.totalY, y.decimals) * priceOf(prices, y.id);

  // Max: the most the wallet can add while keeping the mix.
  const max = () => {
    const kx = needsX ? Number(spendX) / holdX : Infinity;
    const ky = needsY ? Number(spendY) / holdY : Infinity;
    const side = kx <= ky ? 'x' : 'y';
    const amount = side === 'x' ? spendX : spendY;
    setInput({ side, text: trimDecimals(formatUnits(amount, side === 'x' ? x.decimals : y.decimals)) });
  };

  const submit = async () => {
    setSubmitting(true);
    const ok = await execute(
      () =>
        buildDclAppendTransactions({
          positions,
          inX,
          inY,
          slippage,
          accountId,
          wrapX: wrapFor(x.id, plan.totalX),
          wrapY: wrapFor(y.id, plan.totalY)
        }),
      { pending: `Adding to ${x.symbol}/${y.symbol} ${title}`, success: 'Liquidity added to your position' }
    );
    setSubmitting(false);
    if (ok) {
      onDone?.();
      onClose();
    }
  };

  return (
    <Modal title="Add to position" subtitle={`${x.symbol} / ${y.symbol} · ${title} · ${positions.length} bin${positions.length === 1 ? '' : 's'}`} onClose={onClose} width={480}>
      <div className="liq-form">
        <AmountField
          token={x}
          value={text('x')}
          disabled={!needsX}
          spendable={spendX}
          onMax={max}
          note={!needsX ? 'this range holds none right now' : undefined}
          onChange={(t) => setInput({ side: 'x', text: t })}
        />
        <AmountField
          token={y}
          value={text('y')}
          disabled={!needsY}
          spendable={spendY}
          onMax={max}
          note={!needsY ? 'this range holds none right now' : undefined}
          onChange={(t) => setInput({ side: 'y', text: t })}
        />
        <dl className="kv">
          <div>
            <dt>Added</dt>
            <dd>
              {formatUsd(usd)} into {plan.items.length} bin{plan.items.length === 1 ? '' : 's'}
            </dd>
          </div>
          <div>
            <dt>Position after</dt>
            <dd>
              {formatAmount(holdX / 10 ** x.decimals + toNumber(plan.totalX, x.decimals))} {x.symbol} +{' '}
              {formatAmount(holdY / 10 ** y.decimals + toNumber(plan.totalY, y.decimals))} {y.symbol}
            </dd>
          </div>
          <div>
            <dt>Max slippage</dt>
            <dd>{slippage}%</dd>
          </div>
        </dl>
        <button
          type="button"
          className="button button--primary button--block button--lg"
          disabled={submitting || !plan.items.length || Boolean(short)}
          onClick={submit}
        >
          {submitting && <Spinner size={14} />}
          {submitting ? 'Confirm in wallet…' : short ? `Not enough ${short}` : plan.items.length ? 'Add to position' : 'Enter an amount'}
        </button>
        <p className="hint">
          Same range, same shape: each bin grows by the same share, in the token mix it holds now. To use a different range,
          create a new position with the form.
        </p>
      </div>
    </Modal>
  );
}
