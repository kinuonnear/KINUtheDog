// Add to one position (a deposit's bins) without opening a new one: every bin grows by the
// same factor, so the range and shape stay as they are (lib/dclLiquidity.js → planAppend).
//   Dual tokens — enter one side, the other follows the position's token mix.
//   Zap in      — one token only: KINU swaps the share the position needs, then adds both
//                 (lib/zap.js → quoteZapToPosition), all in one wallet request.
// The pool price follows the page's live read while the modal is open and is read again (no
// cache) right before signing, so
// the amounts and slippage limits always match the pool (a stale price makes the add fail).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced } from '../hooks.js';
import { appendCounterpart, buildDclAppendTransactions, freshPool, getDclAssets, planAppend, pointToPrice, positionsAtPoint } from '../lib/dclLiquidity.js';
import { view } from '../lib/rpc.js';
import { buildZapAppendTransactions, quoteZapToPosition } from '../lib/zap.js';
import { priceOf } from '../lib/tokens.js';
import { formatAmount, formatChartPrice, formatUnits, formatUsd, maxBig, toBigInt, toNumber, tryParseUnits } from '../lib/format.js';
import { CONTRACTS } from '../config.js';
import { Modal, Spinner } from './ui.jsx';
import { AmountField, trimDecimals, useSpendable } from './Liquidity.jsx';
import { defaultZapToken, useZapSpendable, ZapBreakdown, ZapInput } from './ZapIn.jsx';
import { SlippagePicker } from './Slippage.jsx';
import TaxNote from './TaxNote.jsx';

const PERCENTS = [0.25, 0.5, 0.75, 1];

const formatUnitsShort = (raw, decimals) => formatAmount(toNumber(raw, decimals));
// Same cadence and cache key as the pool page's own read, so an open modal adds no RPC calls.
const LIVE_MS = 4_000;

/** Pool price, live: flashes up / down when it moves, with the time since the last read. */
function LivePrice({ point, updatedAt, x, y }) {
  const prev = useRef(point);
  const [dir, setDir] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (point === undefined || prev.current === undefined || point === prev.current) {
      prev.current = point;
      return undefined;
    }
    setDir(point > prev.current ? 'up' : 'down');
    prev.current = point;
    const t = setTimeout(() => setDir(null), 900);
    return () => clearTimeout(t);
  }, [point]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (point === undefined) return null;
  const age = updatedAt ? Math.max(0, Math.round((now - updatedAt) / 1000)) : null;
  return (
    <div className={`add-pos__live ${dir ? `add-pos__live--${dir}` : ''}`}>
      <span className="add-pos__live-dot" />
      <span>Pool price</span>
      <b>{formatChartPrice(pointToPrice(point, x.decimals, y.decimals))}</b>
      <small>
        {y.symbol}/{x.symbol}
      </small>
      <em>LIVE{age !== null ? ` · ${age}s` : ''}</em>
    </div>
  );
}

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

export default function AddToPositionModal({ positions: basePositions, x, y, title, onClose, onDone }) {
  const { accountId, slippage, setSlippage, execute, balances, prices } = useApp();
  const [editSlippage, setEditSlippage] = useState(false);
  // Live pool state: the position's token amounts follow the current price.
  const poolId = basePositions[0]?.poolId;
  const live = useAsync(() => view(CONTRACTS.dcl, 'get_pool', { pool_id: poolId }), [poolId], { refreshMs: LIVE_MS });
  const point = live.data?.current_point ?? basePositions[0]?.currentPoint;
  const positions = useMemo(() => positionsAtPoint(basePositions, point), [basePositions, point]);
  const [mode, setMode] = useState('dual');
  const [input, setInput] = useState({ side: 'x', text: '' });
  const [zapToken, setZapToken] = useState(() => defaultZapToken(x, y));
  const [zapText, setZapText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const tokenIds = useMemo(() => [x.id, y.id], [x.id, y.id]);
  const [walletX, walletY] = useSpendable(tokenIds);
  // Tokens parked in the CLMM balance (e.g. from an earlier deposit) are added first, untaxed.
  const parked = useAsync(() => getDclAssets(accountId), [accountId], { enabled: Boolean(accountId) });
  const parkedX = toBigInt(parked.data?.[x.id] || '0');
  const parkedY = toBigInt(parked.data?.[y.id] || '0');
  const spendX = walletX + parkedX;
  const spendY = walletY + parkedY;
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
    [mode, zapToken.id, debouncedZap, slippage, accountId, point, positions.map((p) => `${p.id}:${p.liquidity}`).join(',')],
    { enabled: mode === 'zap' && toBigInt(debouncedZap) > 0n }
  );
  const zapReady = mode === 'zap' && zap.data && !zap.error && zap.data.append.items.length > 0 && toBigInt(debouncedZap) === zapRaw;
  const zapShort = zapRaw > zapSpendable;

  /* ---- Summary ---- */
  const addedX = mode === 'zap' ? (zap.data && zapReady ? zap.data.append.totalX : 0n) : plan.totalX;
  const addedY = mode === 'zap' ? (zap.data && zapReady ? zap.data.append.totalY : 0n) : plan.totalY;
  const addedBins = mode === 'zap' ? (zapReady ? zap.data.append.items.length : 0) : plan.items.length;
  const usd = toNumber(addedX, x.decimals) * priceOf(prices, x.id) + toNumber(addedY, y.decimals) * priceOf(prices, y.id);
  // Rhea settles a position's unclaimed fees whenever its liquidity changes: adding pays them out.
  const feeUsd = basePositions.reduce(
    (s, p) => s + toNumber(p.unclaimedFeeX || '0', x.decimals) * priceOf(prices, x.id) + toNumber(p.unclaimedFeeY || '0', y.decimals) * priceOf(prices, y.id),
    0
  );

  const submit = async () => {
    setSubmitting(true);
    const ok = await execute(
      async () => {
        // Read the pool once more right before signing: amounts and slippage limits use that price.
        const pool = await freshPool(poolId);
        const now = positionsAtPoint(basePositions, pool.current_point);
        if (mode === 'dual') {
          const side = input.side;
          const counter = appendCounterpart(now, side, typed);
          const fx = side === 'x' ? typed : counter;
          const fy = side === 'y' ? typed : counter;
          const holdsX = now.some((p) => p.amountX > 0);
          const holdsY = now.some((p) => p.amountY > 0);
          if ((holdsX && fx > spendX) || (holdsY && fy > spendY)) {
            throw new Error(`The pool price moved: this now needs more ${holdsX && fx > spendX ? x.symbol : y.symbol} than your wallet has. Lower the amount and try again.`);
          }
          const fresh = planAppend(now, { inX: fx, inY: fy });
          return buildDclAppendTransactions({
            positions: now,
            inX: fx,
            inY: fy,
            slippage,
            accountId,
            wrapX: wrapFor(x.id, fresh.totalX),
            wrapY: wrapFor(y.id, fresh.totalY)
          });
        }
        // Re-quote at signing time so the swap and the deposit match the latest prices.
        const fresh = await quoteZapToPosition({ inputToken: zapToken, amountIn: zapRaw.toString(), x, y, positions: now, slippage, user: accountId });
        return buildZapAppendTransactions({ zap: fresh, inputToken: zapToken, x, y, positions: now, slippage, accountId });
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
              note={!needsX ? 'this range holds none right now' : parkedX > 0n ? `incl. ${formatUnitsShort(parkedX, x.decimals)} in Rhea` : undefined}
              onChange={(t) => setInput({ side: 'x', text: t })}
            />
            <AmountField
              token={y}
              value={text('y')}
              disabled={!needsY}
              spendable={spendY}
              onMax={() => pickDual(1)}
              note={!needsY ? 'this range holds none right now' : parkedY > 0n ? `incl. ${formatUnitsShort(parkedY, y.decimals)} in Rhea` : undefined}
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

        <TaxNote tokens={[x, y]} />
        <LivePrice point={point} updatedAt={live.updatedAt} x={x} y={y} />
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
          {feeUsd > 0 && (
            <div className="add-pos__fees">
              <dt>Unclaimed fees</dt>
              <dd>
                {formatUsd(feeUsd)} <small className="muted">paid to your wallet when you add</small>
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
        <p className="hint">
          {mode === 'dual'
            ? 'Same range, same shape: each bin grows by the same share, in the token mix it holds now.'
            : 'KINU swaps the share your position needs and adds both to the same bins, in one wallet request.'}
        </p>
        {/* The action stays in view at the bottom of the modal; only the form above scrolls. */}
        <div className="modal-actions">
          <button type="button" className="button button--primary button--block button--lg" disabled={disabled} onClick={submit}>
            {submitting && <Spinner size={14} />}
            {label}
          </button>
        </div>
      </div>
    </Modal>
  );
}
