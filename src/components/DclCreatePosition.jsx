// Meteora-style "Create position" for Rhea CLMM pools:
//   amounts with auto-fill · strategy (Spot / Curve / Bid-Ask) · draggable
//   liquidity-depth histogram · min / max inputs with % and tick steppers.
// The range lives in useDclRange() so the page's RangeChart can drag it too.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced } from '../hooks.js';
import {
  alignPoint,
  buildBins,
  buildDclBinsTransactions,
  fullRange,
  getMarketDepth,
  planBins,
  pointToPrice,
  priceToPoint,
  rangeSide,
  STRATEGIES
} from '../lib/dclLiquidity.js';
import { view } from '../lib/rpc.js';
import { formatAmount, formatChartPrice, formatPercent, formatRawAmount, formatUnits, formatUsd, maxBig, toBigInt, tryParseUnits } from '../lib/format.js';
import { mergeTransactions } from '../lib/tx.js';
import { estimateNetworkFee } from '../lib/gasEstimate.js';
import { priceOf } from '../lib/tokens.js';
import { CONTRACTS, NEAR_GAS_RESERVE } from '../config.js';
import { Spinner, TokenIcon } from './ui.jsx';
import { SlippagePicker } from './Slippage.jsx';
import TaxNote from './TaxNote.jsx';
import { refreshDclGraphFor } from '../lib/dclRouter.js';
import { buildZapTransactions, quoteZap } from '../lib/zap.js';
import { defaultZapToken, useZapQuote, useZapSpendable, ZapBreakdown, ZapInput } from './ZapIn.jsx';

const PRESETS = [
  { key: '5', label: '±5%' },
  { key: '10', label: '±10%' },
  { key: '25', label: '±25%' },
  { key: '50', label: '±50%' },
  { key: 'full', label: 'Full' }
];

/** Calls a deposit will make, for the fee estimate when no wallet is connected. */
function sketchDeposit({ depositX, depositY, bins, swaps, wrap }) {
  const call = (receiverId, methodName, args, gas) => ({ receiverId, actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit: '0' } }] });
  const txs = [];
  for (let i = 0; i < swaps; i += 1) txs.push(call('token', 'ft_transfer_call', { receiver_id: CONTRACTS.aggregator }, '300000000000000'));
  if (wrap) txs.push(call(CONTRACTS.wrapNear, 'near_deposit', {}, '10000000000000'));
  if (depositX) txs.push(call('token-x', 'ft_transfer_call', { receiver_id: CONTRACTS.dcl, msg: '"Deposit"' }, '600000000000000'));
  if (depositY) txs.push(call('token-y', 'ft_transfer_call', { receiver_id: CONTRACTS.dcl, msg: '"Deposit"' }, '600000000000000'));
  txs.push(bins > 1 ? call(CONTRACTS.dcl, 'batch_add_liquidity', {}, '600000000000000') : call(CONTRACTS.dcl, 'add_liquidity', {}, '300000000000000'));
  return txs;
}

function trimDecimals(text) {
  const [whole, fraction = ''] = String(text).split('.');
  const kept = fraction.slice(0, 8).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

/* ------------------------------------------------------------------ */
/* Range state (shared by chart and form)                              */
/* ------------------------------------------------------------------ */

export function useDclRange(pool, x, y) {
  const delta = pool.point_delta;
  const current = pool.current_point;
  const currentPrice = pointToPrice(current, x.decimals, y.decimals);
  const toPoint = useCallback((price, mode) => alignPoint(priceToPoint(price, x.decimals, y.decimals), delta, mode), [x.decimals, y.decimals, delta]);

  const presetRange = useCallback(
    (key) => {
      if (key === 'full') return fullRange(delta);
      const pctv = Number(key) / 100;
      const left = toPoint(currentPrice * (1 - pctv), 'floor');
      let right = toPoint(currentPrice * (1 + pctv), 'ceil');
      if (right <= left) right = left + delta;
      return { left, right };
    },
    [currentPrice, delta, toPoint]
  );

  const [preset, setPresetKey] = useState('10');
  const [range, setRangeState] = useState(() => presetRange('10'));

  const setPreset = (key) => {
    setPresetKey(key);
    setRangeState(presetRange(key));
  };

  /** Move one edge to a price (or point); keeps left < right. */
  const setEdge = useCallback(
    (side, { price, point }) => {
      const p = point ?? toPoint(price, side === 'min' ? 'floor' : 'ceil');
      setPresetKey('custom');
      setRangeState((r) => {
        if (side === 'min') return { left: Math.min(p, r.right - delta), right: r.right };
        return { left: r.left, right: Math.max(p, r.left + delta) };
      });
    },
    [toPoint, delta]
  );

  const nudge = (side, steps) => setEdge(side, { point: (side === 'min' ? range.left : range.right) + steps * delta });

  const full = range.left <= fullRange(delta).left && range.right >= fullRange(delta).right;
  return {
    preset,
    setPreset,
    range,
    setEdge,
    nudge,
    full,
    current,
    currentPrice,
    minPrice: pointToPrice(range.left, x.decimals, y.decimals),
    maxPrice: pointToPrice(range.right, x.decimals, y.decimals)
  };
}

/* ------------------------------------------------------------------ */
/* Liquidity depth histogram with draggable handles                    */
/* ------------------------------------------------------------------ */

const BARS = 64;

function DepthHistogram({ pool, x, y, rangeState, plan }) {
  const depth = useAsync(() => getMarketDepth(pool.pool_id), [pool.pool_id], { refreshMs: 60_000 });
  const svgRef = useRef(null);
  const { range, current, full, setEdge } = rangeState;
  // While a handle is dragged: { side, x (percent under the pointer), win (frozen window) }.
  const [dragging, setDragging] = useState(null);

  // Visible window in points: the range plus padding (bounded for full-range positions).
  const liveWindow = useMemo(() => {
    let lo = Math.min(range.left, current);
    let hi = Math.max(range.right, current);
    if (full || hi - lo > 120000) {
      const segs = depth.data?.segments || [];
      lo = segs.length ? Math.min(segs[0].left, current - 4000) : current - 20000;
      hi = segs.length ? Math.max(segs[segs.length - 1].right, current + 4000) : current + 20000;
    }
    const pad = Math.max((hi - lo) * 0.3, pool.point_delta * 6);
    return { lo: lo - pad, hi: hi + pad };
  }, [range.left, range.right, current, full, depth.data, pool.point_delta]);
  // The scale stays put while dragging, so the handle stays under the pointer.
  const windowPts = dragging?.win || liveWindow;

  const span = windowPts.hi - windowPts.lo;
  const toX = (pt) => ((pt - windowPts.lo) / span) * 100;

  const bars = useMemo(() => {
    const segs = depth.data?.segments || [];
    const values = Array.from({ length: BARS }, (_, i) => {
      const mid = windowPts.lo + ((i + 0.5) / BARS) * span;
      const seg = segs.find((s) => mid >= s.left && mid < s.right);
      return { mid, value: seg ? seg.liquidity : 0 };
    });
    const max = Math.max(...values.map((v) => v.value), 1);
    return values.map((v) => ({ ...v, h: v.value / max }));
  }, [depth.data, windowPts, span]);

  const preview = useMemo(() => {
    if (!plan?.bins?.length) return [];
    const densities = plan.bins.map((b) => b.weight);
    const max = Math.max(...densities, 1e-9);
    return plan.bins.map((b) => ({ ...b, h: b.weight / max }));
  }, [plan]);

  // Drag a handle (or press anywhere on the chart to move the nearest one there). The handle
  // follows the pointer every frame; the range snaps to bins at most once per frame.
  const startDrag = (event, forcedSide) => {
    if (full || event.button > 0) return;
    event.preventDefault();
    const el = svgRef.current;
    const win = windowPts;
    const winSpan = win.hi - win.lo;
    const ratioAt = (e) => {
      const rect = el.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    };
    const startRatio = ratioAt(event);
    const side =
      forcedSide ||
      (Math.abs(startRatio * 100 - toX(range.left)) <= Math.abs(startRatio * 100 - toX(range.right)) ? 'min' : 'max');
    let pending = null;
    let frame = null;
    let lastPoint = null;
    const apply = () => {
      frame = null;
      if (pending === null) return;
      const ratio = pending;
      pending = null;
      setDragging({ side, x: ratio * 100, win });
      const point = alignPoint(win.lo + ratio * winSpan, pool.point_delta, 'round');
      if (point !== lastPoint) {
        lastPoint = point;
        setEdge(side, { point });
      }
    };
    const queue = (ratio) => {
      pending = ratio;
      if (frame === null) frame = requestAnimationFrame(apply);
    };
    const move = (e) => queue(ratioAt(e));
    const up = (e) => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (pending !== null) apply();
      el.releasePointerCapture?.(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDragging(null);
    };
    el.setPointerCapture?.(event.pointerId);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    queue(startRatio);
  };

  const leftX = dragging?.side === 'min' ? dragging.x : Math.max(0, toX(range.left));
  const rightX = dragging?.side === 'max' ? dragging.x : Math.min(100, toX(range.right));
  const curX = toX(current);

  return (
    <div className="depth">
      <div className={`depth__chart ${full ? '' : 'depth__chart--drag'} ${dragging ? 'depth__chart--dragging' : ''}`} ref={svgRef} onPointerDown={(e) => startDrag(e)}>
        {bars.map((b, i) => {
          const inRange = b.mid >= range.left && b.mid < range.right;
          return (
            <span
              key={i}
              className={`depth__bar ${b.mid < current ? 'depth__bar--y' : 'depth__bar--x'} ${inRange ? 'depth__bar--in' : ''}`}
              style={{ left: `${(i / BARS) * 100}%`, width: `${100 / BARS}%`, height: `${Math.max(2, b.h * 100)}%` }}
            />
          );
        })}
        <span className="depth__band" style={{ left: `${leftX}%`, width: `${Math.max(0, rightX - leftX)}%` }} />
        <span className="depth__current" style={{ left: `${curX}%` }}>
          <em>Current</em>
        </span>
        {!full && (
          <>
            <button
              type="button"
              className={`depth__handle ${dragging?.side === 'min' ? 'depth__handle--active' : ''}`}
              style={{ left: `${leftX}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                startDrag(e, 'min');
              }}
              aria-label="Drag min price"
            />
            <button
              type="button"
              className={`depth__handle ${dragging?.side === 'max' ? 'depth__handle--active' : ''}`}
              style={{ left: `${rightX}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                startDrag(e, 'max');
              }}
              aria-label="Drag max price"
            />
          </>
        )}
        {depth.loading && !depth.data && (
          <span className="depth__loading">
            <Spinner size={14} />
          </span>
        )}
      </div>
      {preview.length > 0 && (
        <div className="depth__preview" title="Your liquidity shape">
          {preview.map((b, i) => (
            <span
              key={i}
              className={`depth__pbar ${b.amountX > 0 && b.amountY > 0 ? 'both' : b.amountX > 0 ? 'x' : 'y'}`}
              style={{ left: `${Math.max(0, toX(b.left))}%`, width: `${Math.max(0.4, Math.min(100, toX(b.right)) - Math.max(0, toX(b.left)))}%`, height: `${Math.max(8, b.h * 100)}%` }}
            />
          ))}
        </div>
      )}
      <div className="depth__axis">
        <span>{formatChartPrice(pointToPrice(windowPts.lo, x.decimals, y.decimals))}</span>
        <span>{formatChartPrice(pointToPrice(current, x.decimals, y.decimals))}</span>
        <span>{formatChartPrice(pointToPrice(windowPts.hi, x.decimals, y.decimals))}</span>
      </div>
      <div className="depth__legend">
        <span>
          <i className="y" /> {y.symbol} side
        </span>
        <span>
          <i className="x" /> {x.symbol} side
        </span>
        <span className="muted">Bars: pool liquidity · strip: your shape</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Min / max price inputs                                              */
/* ------------------------------------------------------------------ */

function PriceEdge({ label, side, price, current, onCommit, onNudge, disabled }) {
  const [text, setText] = useState(null);
  const shown = text ?? (disabled ? (side === 'min' ? '0' : '∞') : formatChartPrice(price));
  const change = current ? (price / current - 1) * 100 : 0;
  const commit = () => {
    if (text === null) return;
    const n = Number(text.replace(',', '.'));
    if (n > 0) onCommit(n);
    setText(null);
  };
  return (
    <div className="price-edge">
      <span className="price-edge__label">{label}</span>
      <div className="price-edge__row">
        <input
          inputMode="decimal"
          value={shown}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {!disabled && <span className={`price-edge__pct ${change >= 0 ? 'up' : 'down'}`}>{`${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</span>}
        <div className="price-edge__steps">
          <button type="button" disabled={disabled} onClick={() => onNudge(1)} aria-label={`Raise ${label}`}>
            +
          </button>
          <button type="button" disabled={disabled} onClick={() => onNudge(-1)} aria-label={`Lower ${label}`}>
            −
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Form                                                                */
/* ------------------------------------------------------------------ */

function useSpendable(tokenIds) {
  const { balances, nearBalance } = useApp();
  return useMemo(() => {
    let native = 0n;
    if (nearBalance) {
      const rest = toBigInt(nearBalance.available) - toBigInt(NEAR_GAS_RESERVE);
      native = rest > 0n ? rest : 0n;
    }
    return tokenIds.map((id) => toBigInt(balances[id] || '0') + (id === CONTRACTS.wrapNear ? native : 0n));
  }, [tokenIds, balances, nearBalance]);
}

export default function DclCreatePosition({ pool, x, y, rangeState, onDone }) {
  const { accountId, connect, slippage, setSlippage, execute, balances, prices } = useApp();
  const [showSlippage, setShowSlippage] = useState(false);
  const [strategy, setStrategy] = useState('spot');
  const [inputs, setInputs] = useState({ x: '', y: '' });
  const [lastEdited, setLastEdited] = useState('x');
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState('dual'); // 'dual' | 'zap'
  const [zapToken, setZapToken] = useState(() => defaultZapToken(x, y));
  const [zapText, setZapText] = useState('');
  const { range, current, full } = rangeState;

  const tokenIds = useMemo(() => [pool.token_x, pool.token_y], [pool.token_x, pool.token_y]);
  const spendable = useSpendable(tokenIds);
  const side = rangeSide(range.left, range.right, current);
  // If the range is one-sided, only that token can be entered.
  const source = side === 'x' ? 'x' : side === 'y' ? 'y' : lastEdited;
  useEffect(() => {
    if (side !== 'both') setLastEdited(side);
  }, [side]);

  const bins = useMemo(
    () => buildBins({ left: range.left, right: range.right, current, pointDelta: pool.point_delta, strategy }),
    [range.left, range.right, current, pool.point_delta, strategy]
  );
  const sourceToken = source === 'x' ? x : y;
  const sourceRaw = tryParseUnits(inputs[source], sourceToken.decimals) || '0';
  const plan = useMemo(() => planBins({ bins, current, from: source, amount: Number(sourceRaw) }), [bins, current, source, sourceRaw]);

  // Zap In: the unit shape (amount-independent) decides how the single input is split.
  const unitPlan = useMemo(() => planBins({ bins, current, from: 'x', amount: 0 }), [bins, current]);
  const zapRaw = tryParseUnits(zapText, zapToken.decimals) || '0';
  const zapSpendable = useZapSpendable(zapToken);
  const shapeKey = `${range.left}:${range.right}:${strategy}`;
  const zapQuote = useZapQuote({
    enabled: mode === 'zap',
    token: zapToken,
    amountRaw: zapRaw,
    x,
    y,
    pool,
    unitPlan,
    shapeKey,
    slippage,
    accountId
  });
  const zapStale = mode === 'zap' && (zapQuote.loading || (zapQuote.data && zapQuote.data.legX && toBigInt(zapRaw) !== toBigInt(zapQuote.data.legX.amountIn) + toBigInt(zapQuote.data.legY.amountIn)));

  const rawX = source === 'x' ? sourceRaw : plan.bins.reduce((s, b) => s + BigInt(Math.floor(b.amountX)), 0n).toString();
  const rawY = source === 'y' ? sourceRaw : plan.bins.reduce((s, b) => s + BigInt(Math.floor(b.amountY)), 0n).toString();
  const shownX = source === 'x' ? inputs.x : toBigInt(rawX) > 0n ? trimDecimals(formatUnits(rawX, x.decimals)) : '';
  const shownY = source === 'y' ? inputs.y : toBigInt(rawY) > 0n ? trimDecimals(formatUnits(rawY, y.decimals)) : '';

  const wrapFor = (tokenId, raw) =>
    tokenId === CONTRACTS.wrapNear ? maxBig(0n, toBigInt(raw) - toBigInt(balances[CONTRACTS.wrapNear] || '0')).toString() : '0';
  const wrapX = wrapFor(pool.token_x, rawX);
  const wrapY = wrapFor(pool.token_y, rawY);

  const storage = useAsync(() => view(CONTRACTS.dcl, 'get_user_storage_detail', { user_id: accountId }), [accountId], {
    enabled: Boolean(accountId)
  });
  const zapMode = mode === 'zap';
  const activePlan = zapMode && zapQuote.data ? zapQuote.data.plan : plan;
  const positionsCount = activePlan.bins.filter((b) => b.amountX >= 1 || b.amountY >= 1).length || bins.length;
  const hasAmount = zapMode ? toBigInt(zapRaw) > 0n : toBigInt(rawX) > 0n || toBigInt(rawY) > 0n;

  // What this deposit costs on top of the tokens: gas for every step, plus one-time storage.
  // Built from the same transactions the button sends (estimated per call from mainnet medians).
  const costKey = useDebounced(
    [mode, rawX, rawY, wrapX, wrapY, positionsCount, zapQuote.data?.fetchedAt || '', accountId || ''].join('|'),
    500
  );
  const costs = useAsync(
    async () => {
      let txs;
      if (accountId && (!zapMode || zapQuote.data)) {
        txs = zapMode
          ? await buildZapTransactions({ zap: zapQuote.data, inputToken: zapToken, x, y, pool, slippage, accountId })
          : await buildDclBinsTransactions({ pool, plan, slippage, accountId, wrapX, wrapY });
      } else {
        const legs = zapMode && zapQuote.data ? [zapQuote.data.legX, zapQuote.data.legY] : [];
        txs = sketchDeposit({
          depositX: zapMode ? (zapQuote.data?.plan.totalX || 0) > 0 : toBigInt(rawX) > 0n,
          depositY: zapMode ? (zapQuote.data?.plan.totalY || 0) > 0 : toBigInt(rawY) > 0n,
          bins: positionsCount,
          swaps: legs.filter((l) => l.kind === 'swap').length,
          wrap: legs.some((l) => l.kind === 'wrap') || toBigInt(wrapX) + toBigInt(wrapY) > 0n
        });
      }
      const merged = mergeTransactions(txs);
      return { ...(await estimateNetworkFee(merged)), txCount: merged.length };
    },
    [costKey],
    { enabled: hasAmount && (!zapMode || Boolean(zapQuote.data)) }
  );
  const nearUsd = priceOf(prices, CONTRACTS.wrapNear);
  const short = zapMode
    ? toBigInt(zapRaw) > zapSpendable
      ? `Insufficient ${zapToken.symbol}`
      : null
    : toBigInt(rawX) > spendable[0]
      ? `Insufficient ${x.symbol}`
      : toBigInt(rawY) > spendable[1]
        ? `Insufficient ${y.symbol}`
        : null;

  // Price the amounts were entered at: the pool price refreshes every few seconds and the
  // paired amount follows it, so show how far it has moved since.
  const anchorRef = useRef(null);
  const [, setAccepted] = useState(0); // re-render after "Accept new price"
  const priceDrift = anchorRef.current === null ? 0 : (Math.pow(1.0001, current - anchorRef.current) - 1) * 100;
  const acceptPrice = () => {
    anchorRef.current = current;
    setAccepted((n) => n + 1);
  };

  // Zap amounts are typed in the Zap box: anchor the drift there too.
  useEffect(() => {
    anchorRef.current = zapText ? current : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zapText]);

  const setAmount = (which, text) => {
    const clean = text.replace(',', '.');
    if (!/^\d*\.?\d*$/.test(clean)) return;
    anchorRef.current = current;
    setLastEdited(which);
    setInputs((v) => ({ ...v, [which]: clean }));
  };

  /**
   * Re-read the pool right before the wallet opens. Beyond the slippage tolerance the deposit
   * would fail on-chain, so stop and let the user review the updated amounts instead.
   */
  const livePool = async () => {
    const fresh = (await view(CONTRACTS.dcl, 'get_pool', { pool_id: pool.pool_id }, { fresh: true }).catch(() => null)) || pool;
    const moved = (Math.pow(1.0001, fresh.current_point - current) - 1) * 100;
    if (Math.abs(moved) > Number(slippage)) {
      onDone?.(); // refresh the pool so the form shows the new amounts
      throw new Error(
        `The pool price moved ${moved > 0 ? '+' : ''}${moved.toFixed(2)}% while you were confirming — more than your ${slippage}% slippage. Amounts have been updated; review and confirm again.`
      );
    }
    return fresh;
  };
  const setFraction = (which, fraction) => {
    const index = which === 'x' ? 0 : 1;
    const token = which === 'x' ? x : y;
    const raw = (spendable[index] * BigInt(Math.round(fraction * 100))) / 100n;
    setAmount(which, trimDecimals(formatUnits(raw.toString(), token.decimals)));
  };

  const submit = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const ok = zapMode
      ? await execute(
          async () => {
            // Always execute a fresh, user-bound quote on the live pool.
            const fresh = await livePool();
            const zap = await quoteZap({ inputToken: zapToken, amountIn: zapRaw, x, y, pool: fresh, unitPlan, slippage, user: accountId });
            return buildZapTransactions({ zap, inputToken: zapToken, x, y, pool: fresh, slippage, accountId });
          },
          { pending: `Zapping ${zapToken.symbol} into ${x.symbol}/${y.symbol}`, success: 'Zap complete — position created' }
        )
      : await execute(async () => buildDclBinsTransactions({ pool: await livePool(), plan, slippage, accountId, wrapX, wrapY }), {
          pending: `Creating ${positionsCount} position${positionsCount === 1 ? '' : 's'}`,
          success: 'Liquidity added'
        });
    setSubmitting(false);
    if (ok) {
      setInputs({ x: '', y: '' });
      setZapText('');
      refreshDclGraphFor(pool.pool_id); // a new pool's first liquidity makes it routable
      onDone?.();
    }
  };

  const amountRow = (which, token, value, index) => {
    const disabled = (which === 'x' && side === 'y') || (which === 'y' && side === 'x');
    return (
      <div className={`amount-row ${disabled ? 'amount-row--disabled' : ''}`}>
        <div className="amount-row__token">
          <TokenIcon token={token} size={26} />
          <div>
            <strong>{token.symbol}</strong>
            {accountId && (
              <small>
                {formatRawAmount(spendable[index].toString(), token.decimals)}
                {!disabled && (
                  <>
                    <button type="button" onClick={() => setFraction(which, 0.5)}>
                      50%
                    </button>
                    <button type="button" onClick={() => setFraction(which, 1)}>
                      MAX
                    </button>
                  </>
                )}
              </small>
            )}
          </div>
        </div>
        <input
          inputMode="decimal"
          placeholder={disabled ? 'Not needed' : '0.0'}
          disabled={disabled}
          value={disabled ? '' : value}
          onChange={(e) => setAmount(which, e.target.value)}
        />
      </div>
    );
  };

  const strategyInfo = STRATEGIES.find((s) => s.key === strategy);
  // Price moved since the amounts were entered: within slippage the user may accept it;
  // beyond slippage the deposit would be refused, so acceptance is required first.
  const driftShown = (zapMode ? toBigInt(zapRaw) > 0n : hasAmount) && Math.abs(priceDrift) >= 0.05;
  const mustAccept = driftShown && Math.abs(priceDrift) > Number(slippage);

  let label = 'Create position';
  if (!accountId) label = 'Connect wallet';
  else if (!hasAmount) label = 'Enter an amount';
  else if (short) label = short;
  else if (zapMode && zapQuote.error) label = 'No route for this zap';
  else if (zapMode && zapStale) label = 'Finding best split…';
  else if (mustAccept) label = 'Price moved — accept new price';
  else if (zapMode) label = `Zap in ${zapToken.symbol}`;
  const blocked = (zapMode && (Boolean(zapQuote.error) || zapStale || !zapQuote.data)) || mustAccept;

  return (
    <div className="create-pos">
      <section>
        <div className="create-pos__head">
          <h3>Amount</h3>
          <div className="segmented">
            <button type="button" className={!zapMode ? 'active' : ''} onClick={() => setMode('dual')}>
              Dual tokens
            </button>
            <button type="button" className={zapMode ? 'active' : ''} onClick={() => setMode('zap')}>
              ⚡ Zap in
            </button>
          </div>
        </div>
        {zapMode ? (
          <>
            <ZapInput token={zapToken} setToken={setZapToken} text={zapText} setText={setZapText} spendable={zapSpendable} x={x} y={y} />
            <p className="liq-hint">
              Deposit a single token — KINU swaps the right share into {x.symbol}/{y.symbol} and opens the position in one
              wallet request.
            </p>
          </>
        ) : (
          <>
            {amountRow('x', x, shownX, 0)}
            {amountRow('y', y, shownY, 1)}
            <p className="liq-hint">Auto-fill keeps both sides in the right ratio.</p>
          </>
        )}
      </section>

      <section>
        <div className="create-pos__head">
          <h3>Strategy</h3>
        </div>
        <div className="strategy">
          {STRATEGIES.map((s) => (
            <button key={s.key} type="button" className={strategy === s.key ? 'active' : ''} onClick={() => setStrategy(s.key)}>
              <StrategyIcon kind={s.key} />
              {s.label}
            </button>
          ))}
        </div>
        <p className="liq-hint">{strategyInfo.hint}</p>
      </section>

      <section>
        <div className="create-pos__head">
          <h3>Price range</h3>
          <span className="muted small">
            {y.symbol} per {x.symbol}
          </span>
        </div>
        <DepthHistogram pool={pool} x={x} y={y} rangeState={rangeState} plan={hasAmount ? activePlan : { bins: activePlan.bins }} />
        <div className="segmented segmented--full">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={rangeState.preset === p.key ? 'active' : ''} onClick={() => rangeState.setPreset(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="price-edges">
          <PriceEdge
            label="Min price"
            side="min"
            price={rangeState.minPrice}
            current={rangeState.currentPrice}
            disabled={full}
            onCommit={(price) => rangeState.setEdge('min', { price })}
            onNudge={(n) => rangeState.nudge('min', n)}
          />
          <PriceEdge
            label="Max price"
            side="max"
            price={rangeState.maxPrice}
            current={rangeState.currentPrice}
            disabled={full}
            onCommit={(price) => rangeState.setEdge('max', { price })}
            onNudge={(n) => rangeState.nudge('max', n)}
          />
        </div>
        {side !== 'both' && (
          <p className="liq-hint warn">
            Range is {side === 'x' ? 'above' : 'below'} the current price — only {side === 'x' ? x.symbol : y.symbol} is deposited. It
            starts earning once the price enters the range.
          </p>
        )}
      </section>

      {zapMode && hasAmount && (
        <ZapBreakdown zap={zapQuote.data} loading={zapQuote.loading} error={zapQuote.error} token={zapToken} x={x} y={y} />
      )}

      <dl className="kv create-pos__summary">
        <div>
          <dt>Positions created</dt>
          <dd>
            {positionsCount} · {Math.round((range.right - range.left) / pool.point_delta)} ticks
          </dd>
        </div>
        <div>
          <dt>Range width</dt>
          <dd>
            {full ? 'Full range' : `${formatPercent((rangeState.maxPrice / rangeState.minPrice - 1) * 100, 1)}`}
          </dd>
        </div>
        <div>
          <dt>Fee tier</dt>
          <dd>{formatPercent(pool.fee / 10000, 2)}</dd>
        </div>
        {!zapMode && accountId && toBigInt(wrapX) + toBigInt(wrapY) > 0n && (
          <div>
            <dt>NEAR to wrap</dt>
            <dd>{formatRawAmount((toBigInt(wrapX) + toBigInt(wrapY)).toString(), 24)} NEAR</dd>
          </div>
        )}
        <div>
          <dt>Max slippage</dt>
          <dd>{slippage}%</dd>
        </div>
      </dl>

      <dl className="kv create-pos__costs">
        <div>
          <dt>Network fee (gas)</dt>
          <dd title={costs.data ? `Up to ${costs.data.maxFeeNear.toFixed(4)} NEAR if every step used all its gas — unused gas is refunded.` : undefined}>
            {costs.data ? (
              <>
                ≈ {costs.data.feeNear.toFixed(4)} NEAR
                <small className="muted">
                  {' '}
                  · {costs.data.txCount} transaction{costs.data.txCount === 1 ? '' : 's'}
                </small>
              </>
            ) : hasAmount && costs.loading ? (
              <Spinner size={12} />
            ) : (
              <span className="muted">—</span>
            )}
          </dd>
        </div>
        {(costs.data?.storageNear > 0 || (!costs.data && accountId && storage.data === null)) && (
          <div>
            <dt>One-time storage</dt>
            <dd title="Registration on Rhea's CLMM contract and token storage. Paid once per account; refundable when unregistering.">
              {formatAmount(costs.data ? costs.data.storageNear : 0.5)} NEAR
            </dd>
          </div>
        )}
        {zapMode && (
          <div>
            <dt>Swap trading fee</dt>
            <dd className="muted">included in the swap output above</dd>
          </div>
        )}
        {costs.data && (
          <div className="create-pos__total">
            <dt>Total cost</dt>
            <dd>
              ≈ {(costs.data.feeNear + costs.data.storageNear).toFixed(4)} NEAR
              {nearUsd > 0 && <small className="muted"> ({formatUsd((costs.data.feeNear + costs.data.storageNear) * nearUsd)})</small>}
            </dd>
          </div>
        )}
      </dl>

      <TaxNote tokens={[x, y]} />

      <div className="live-price">
        <span className="live-price__dot" aria-hidden />
        Live pool price · updates every few seconds
        {driftShown && (
          <>
            <b className={mustAccept ? 'down' : 'warn'}>
              {priceDrift > 0 ? '+' : ''}
              {priceDrift.toFixed(2)}% since you entered amounts{zapMode ? '' : ' — paired amount updated'}
              {mustAccept ? ` — beyond your ${slippage}% slippage` : ''}
            </b>
            <button type="button" className={`accept-price ${mustAccept ? 'accept-price--required' : ''}`} onClick={acceptPrice}>
              {mustAccept ? 'Accept new price' : 'Accept'}
            </button>
          </>
        )}
        <button
          type="button"
          className="pill-button live-price__slippage"
          onClick={() => setShowSlippage((v) => !v)}
          aria-expanded={showSlippage}
          title="Max slippage"
        >
          ⚙ {slippage}%
        </button>
      </div>
      {showSlippage && (
        <div className="add-pos__slippage">
          <span className="eyebrow">Max slippage</span>
          <SlippagePicker slippage={slippage} setSlippage={setSlippage} />
          <small className="muted">Also used for swaps and other liquidity actions in this browser.</small>
        </div>
      )}
      <button
        type="button"
        className="button button--primary button--block button--lg"
        disabled={(accountId && (!hasAmount || Boolean(short) || blocked)) || submitting}
        onClick={submit}
      >
        {submitting && <Spinner size={14} />}
        {submitting ? 'Confirm in wallet…' : label}
      </button>
    </div>
  );
}

function StrategyIcon({ kind }) {
  const heights = kind === 'curve' ? [3, 6, 10, 14, 10, 6, 3] : kind === 'bidask' ? [14, 10, 6, 3, 6, 10, 14] : [9, 9, 9, 9, 9, 9, 9];
  return (
    <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden="true">
      {heights.map((h, i) => (
        <rect key={i} x={i * 4} y={14 - h} width="3" height={h} rx="0.5" fill="currentColor" />
      ))}
    </svg>
  );
}
