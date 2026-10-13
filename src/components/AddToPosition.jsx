// Add to one position (a deposit's bins) without opening a new one: every bin grows by the
// same factor, so the range and shape stay as they are (lib/dclLiquidity.js → planAppend).
//   Dual tokens — enter one side, the other follows the position's token mix.
//   Zap in      — one token only: KINU swaps the share the position needs, then adds both
//                 (lib/zap.js → quoteZapToPosition), all in one wallet request.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced } from '../hooks.js';
import { appendCounterpart, buildDclAppendTransactions, planAppend } from '../lib/dclLiquidity.js';
import { buildZapAppendTransactions, quoteZapToPosition } from '../lib/zap.js';
import { priceOf } from '../lib/tokens.js';
import { formatAmount, formatUnits, formatUsd, maxBig, toBigInt, toNumber, tryParseUnits } from '../lib/format.js';
import { CONTRACTS } from '../config.js';
import { Modal, Spinner } from './ui.jsx';
import { AmountField, trimDecimals, useSpendable } from './Liquidity.jsx';
import { defaultZapToken, useZapSpendable, ZapBreakdown, ZapInput } from './ZapIn.jsx';

const PERCENTS = [0.25, 0.5, 0.75, 1];

function PercentRow({ onPick }) {
  return (
    <div className="segmented segmented--full add-pos__pct">
      {PERCENTS.map((f) => (
        <button key={f} type="button" onClick={() => onPick(f)}>
          {f === 1 ? 'MAX' : `${f * 100}%`}
        </button>
      ))}
    </div>
  );
}

export default function AddToPositionModal({ positions, x, y, title, onClose, onDone }) {
  const { accountId, slippage, execute, balances, prices } = useApp();
  const [mode, setMode] = useState('dual');
  const [input, setInput] = useState({ side: 'x', text: '' });
  const [zapToken, setZapToken] = useState(() => defaultZapToken(x, y));
  const [zapText, setZapText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const tokenIds = useMemo(() => [x.id, y.id], [x.id, y.id]);
  const [spendX, spendY] = useSpendable(tokenIds);
  const zapSpendable = useZapSpendable(zapToken);
  const holdX = positions.reduce((s, p) => s + p.amountX, 0);
  const holdY = positions.reduce((s, p) => s + p.amountY, 0);
  const needsX = holdX > 0;
  const needsY = holdY > 0;

  /* ---- Dual tokens ---- */
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

  // A share of the most the wallet can add while keeping the mix (MAX = all of it).
  const pickDual = (f) => {
    const kx = needsX ? Number(spendX) / holdX : Infinity;
    const ky = needsY ? Number(spendY) / holdY : Infinity;
    const k = Math.min(kx, ky) * f;
    if (!Number.isFinite(k) || k <= 0) return;
    const side = needsX ? 'x' : 'y';
    const raw =
      f === 1 && (side === 'x' ? kx <= ky : ky <= kx)
        ? side === 'x'
          ? spendX
          : spendY
        : BigInt(Math.floor((side === 'x' ? holdX : holdY) * k));
    setInput({ side, text: trimDecimals(formatUnits(raw, side === 'x' ? x.decimals : y.decimals)) });
  };

  /* ---- Zap in ---- */
  const zapRaw = toBigInt(tryParseUnits(zapText || '0', zapToken.decimals) || 0n);
  const debouncedZap = useDebounced(zapRaw.toString(), 450);
  const zap = useAsync(
    () => quoteZapToPosition({ inputToken: zapToken, amountIn: debouncedZap, x, y, positions, slippage, user: accountId || undefined }),
    [mode, zapToken.id, debouncedZap, slippage, accountId, positions.map((p) => `${p.id}:${p.liquidity}`).join(',')],
    { enabled: mode === 'zap' && toBigInt(debouncedZap) > 0n }
  );
  const zapReady = mode === 'zap' && zap.data && !zap.error && zap.data.append.items.length > 0 && toBigInt(debouncedZap) === zapRaw;
  const zapShort = zapRaw > zapSpendable;

  /* ---- Summary ---- */
  const addedX = mode === 'zap' ? (zap.data && zapReady ? zap.data.append.totalX : 0n) : plan.totalX;
  const addedY = mode === 'zap' ? (zap.data && zapReady ? zap.data.append.totalY : 0n) : plan.totalY;
  const addedBins = mode === 'zap' ? (zapReady ? zap.data.append.items.length : 0) : plan.items.length;
  const usd = toNumber(addedX, x.decimals) * priceOf(prices, x.id) + toNumber(addedY, y.decimals) * priceOf(prices, y.id);

  const submit = async () => {
    setSubmitting(true);
    const ok = await execute(
      async () => {
        if (mode === 'dual') {
          return buildDclAppendTransactions({
            positions,
            inX,
            inY,
            slippage,
            accountId,
            wrapX: wrapFor(x.id, plan.totalX),
            wrapY: wrapFor(y.id, plan.totalY)
          });
        }
        // Re-quote at signing time so the swap and the deposit match the latest prices.
        const fresh = await quoteZapToPosition({ inputToken: zapToken, amountIn: zapRaw.toString(), x, y, positions, slippage, user: accountId });
        return buildZapAppendTransactions({ zap: fresh, inputToken: zapToken, x, y, positions, slippage, accountId });
      },
      { pending: `Adding to ${x.symbol}/${y.symbol} ${title}`, success: 'Liquidity added to your position' }
    );
    setSubmitting(false);
    if (ok) {
      onDone?.();
      onClose();
    }
  };

  const disabled =
    submitting || (mode === 'dual' ? !plan.items.length || Boolean(short) : !zapReady || zapShort || zap.loading);
  const label = submitting
    ? 'Confirm in wallet…'
    : mode === 'dual'
      ? short
        ? `Not enough ${short}`
        : plan.items.length
          ? 'Add to position'
          : 'Enter an amount'
      : zapShort
        ? `Not enough ${zapToken.symbol}`
        : zapRaw <= 0n
          ? 'Enter an amount'
          : zap.loading || !zapReady
            ? 'Finding the best split…'
            : `Zap ${zapToken.symbol} into position`;

  return (
    <Modal title="Add to position" subtitle={`${x.symbol} / ${y.symbol} · ${title} · ${positions.length} bin${positions.length === 1 ? '' : 's'}`} onClose={onClose} width={480}>
      <div className="liq-form">
        <div className="segmented segmented--full add-pos__mode">
          <button type="button" className={mode === 'dual' ? 'active' : ''} onClick={() => setMode('dual')}>
            Dual tokens
          </button>
          <button type="button" className={mode === 'zap' ? 'active' : ''} onClick={() => setMode('zap')}>
            ⚡ Zap in · one token
          </button>
        </div>

        {mode === 'dual' ? (
          <>
            <AmountField
              token={x}
              value={text('x')}
              disabled={!needsX}
              spendable={spendX}
              onMax={() => pickDual(1)}
              note={!needsX ? 'this range holds none right now' : undefined}
              onChange={(t) => setInput({ side: 'x', text: t })}
            />
            <AmountField
              token={y}
              value={text('y')}
              disabled={!needsY}
              spendable={spendY}
              onMax={() => pickDual(1)}
              note={!needsY ? 'this range holds none right now' : undefined}
              onChange={(t) => setInput({ side: 'y', text: t })}
            />
            {accountId && <PercentRow onPick={pickDual} />}
          </>
        ) : (
          <>
            <ZapInput token={zapToken} setToken={setZapToken} text={zapText} setText={setZapText} spendable={zapSpendable} x={x} y={y} />
            {zapRaw > 0n && <ZapBreakdown zap={zap.data} loading={zap.loading} error={zap.error} token={zapToken} x={x} y={y} />}
          </>
        )}

        <dl className="kv">
          <div>
            <dt>Added</dt>
            <dd>
              {formatUsd(usd)} into {addedBins} bin{addedBins === 1 ? '' : 's'}
            </dd>
          </div>
          <div>
            <dt>Position after</dt>
            <dd>
              {formatAmount(holdX / 10 ** x.decimals + toNumber(addedX, x.decimals))} {x.symbol} +{' '}
              {formatAmount(holdY / 10 ** y.decimals + toNumber(addedY, y.decimals))} {y.symbol}
            </dd>
          </div>
          <div>
            <dt>Max slippage</dt>
            <dd>{slippage}%</dd>
          </div>
        </dl>
        <button type="button" className="button button--primary button--block button--lg" disabled={disabled} onClick={submit}>
          {submitting && <Spinner size={14} />}
          {label}
        </button>
        <p className="hint">
          {mode === 'dual'
            ? 'Same range, same shape: each bin grows by the same share, in the token mix it holds now.'
            : 'Only one token? KINU swaps the share your position needs (best route) and adds both to the same bins — one wallet request. Deposits use each swap’s guaranteed minimum.'}{' '}
          To use a different range, create a new position with the form.
        </p>
      </div>
    </Modal>
  );
}
