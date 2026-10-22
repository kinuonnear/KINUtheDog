// Quick LP: the Telegram bot's step-by-step CLMM flow (api/telegram.js) as a floating panel on the
// Pools page, signed right there. Single token or both: pick what you put in, then strategy, width and
// amount. Single token: the range starts at the price now and spreads one way (the pool's 1st token above the
// price, its 2nd below — as the Create position form does for one-sided ranges); both tokens: ± around
// the price, the paired amount follows the one typed. The transactions
// come from the same builders the form uses (buildBins → planBins → buildDclBinsTransactions:
// storage, wrap NEAR, token tax and min amounts included), read on the live pool at signing.
// After the position is created: "View pool".
// KINU's Quick LP fee (config QUICK_LP_FEE, 0.2%, at most $1 a position, half for KINU holders) is
// taken from the amounts entered and sent to the treasury after the position's own transactions.
//
// The Telegram bot's "⚡ Sign & create" opens /pools?quick=<pool>&side=&strategy=&width=&amount= :
// the panel opens on its last step with the choices made in the chat, the user taps once and signs
// in their wallet; then the bot gets the transaction hashes and posts the result in the chat
// (api/telegram.js checks them on chain).

import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { navigate, poolPath } from '../router.jsx';
import { bpsText, CONTRACTS, NATIVE_NEAR, NEAR_GAS_RESERVE, QUICK_LP_FEE } from '../config.js';
import { formatAmount, formatChartPrice, formatRawAmount, formatUnits, toBigInt, tryParseUnits } from '../lib/format.js';
import { getToken, priceOf } from '../lib/tokens.js';
import { view } from '../lib/rpc.js';
import { wrapNeededFor } from '../lib/tx.js';
import { alignPoint, buildBins, buildDclBinsTransactions, fullRange, planBins, pointToPrice, priceToPoint } from '../lib/dclLiquidity.js';
import { refreshDclGraphFor } from '../lib/dclRouter.js';
import TaxNote from './TaxNote.jsx';
import { buildZapTransactions, quoteZap, valueShareX } from '../lib/zap.js';
import { notifyBot } from '../lib/telegram.js';
import { quickLpFees, quickLpFeesFor, withQuickLpFees } from '../lib/platformFee.js';
import { feeAfterDiscount } from '../lib/holder.js';

const WNEAR = CONTRACTS.wrapNear;
// Width presets, then Custom: any % up to WIDTH_MAX (below the price a range stops short of zero).
// Around the price, Custom takes how far below and how far above apart: "50:300" is −50% / +300%.
const SIDE_WIDTHS = ['10', '20', '30', '50', '70'];
const AROUND_WIDTHS = ['5', '10', '25', '50', '75'];
const WIDTH_MAX = { y: 99, x: 500, below: 99, above: 1000 };
/** A width typed in Custom ('y' / 'below' under the price, 'x' / 'above' over it), as a string; null when out of range. */
const customWidth = (mode, value) => {
  const v = Number(String(value).replace(',', '.'));
  return String(value).trim() !== '' && Number.isFinite(v) && v >= 1 && v <= (WIDTH_MAX[mode] || 99) ? String(Math.round(v * 10) / 10) : null;
};
/** An around width as [% below, % above]: "10" is ±10%, "50:300" is −50% / +300%. */
export const splitWidth = (w) => {
  const [lo, hi = lo] = String(w).split(':').map(Number);
  return [lo, hi];
};
/** Custom around the price: "lo:hi" ("lo" when both match), or null while either is out of range. */
const customAround = (lo, hi) => {
  const a = customWidth('below', lo);
  const b = customWidth('above', hi);
  return a && b ? (a === b ? a : `${a}:${b}`) : null;
};
/** How an around width reads: ±10% or −50% / +300%. */
const aroundText = (w) => {
  const [lo, hi] = splitWidth(w);
  return lo === hi ? `±${lo}%` : `−${lo}% / +${hi}%`;
};
// Amount buttons: a share of the wallet's balance of the token going in.
const SHARES = [10, 25, 50, 75, 100];
const STRATEGY_NAMES = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-Ask' };
const OPEN_EVENT = 'kinu:quick-lp';

/** Opens the panel for a CLMM pool: { id, tokenIds: [x, y], symbols: [sx, sy] }. */
export function openQuickLp(pool) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: pool }));
}

/**
 * A one-sided range from the price now (the form's useDclRange rule): the 1st token (x) sits above
 * the price, the 2nd (y) below it; points aligned to the pool's spacing.
 */
export function oneSidedRange({ current, delta, dx, dy, side, widthPct }) {
  const price = pointToPrice(current, dx, dy);
  const toPoint = (p, mode) => alignPoint(priceToPoint(p, dx, dy), delta, mode);
  const w = Number(widthPct) / 100;
  if (side === 'y') {
    const right = alignPoint(current, delta, 'floor');
    return { left: Math.min(toPoint(price * (1 - w), 'floor'), right - delta), right };
  }
  const left = alignPoint(current + 1, delta, 'ceil');
  return { left, right: Math.max(toPoint(price * (1 + w), 'ceil'), left + delta) };
}

/** Around the price now (± a %, or "below:above" %), or the full range (the form's presetRange rule). */
export function aroundRange({ current, delta, dx, dy, widthPct }) {
  if (widthPct === 'full') return fullRange(delta);
  const price = pointToPrice(current, dx, dy);
  const toPoint = (p, mode) => alignPoint(priceToPoint(p, dx, dy), delta, mode);
  const [lo, hi] = splitWidth(widthPct);
  const left = toPoint(price * (1 - lo / 100), 'floor');
  let right = toPoint(price * (1 + hi / 100), 'ceil');
  if (right <= left) right = left + delta;
  return { left, right };
}

function strategyOptions(side, sx) {
  if (side === 'y') return [['spot', '▤ Spot', `even buys of ${sx} on the way down`], ['curve', '⛰ Curve', 'most just below the price'], ['bidask', '📐 Bid-Ask', 'ladder: more the deeper it drops']];
  if (side === 'x') return [['spot', '▤ Spot', `even sells of ${sx} on the way up`], ['curve', '⛰ Curve', 'most just above the price'], ['bidask', '📐 Bid-Ask', 'ladder: more the higher it goes']];
  return [['spot', '▤ Spot', 'even across the range, any market'], ['curve', '⛰ Curve', 'peak at the price, calm markets'], ['bidask', '📐 Bid-Ask', 'heavier at the edges, volatile prices']];
}

/**
 * Both tokens: from the amount typed in one field, the other token's amount that the range and
 * strategy need at `current` (planBins, as the Create position form does). Raw strings.
 */
function planBoth({ meta, current, delta, width, strategy, last, texts, srcRaw: given = null }) {
  const range = aroundRange({ current, delta, dx: meta[0].decimals, dy: meta[1].decimals, widthPct: width });
  const bins = buildBins({ left: range.left, right: range.right, current, pointDelta: delta, strategy });
  const srcRaw = given ?? (tryParseUnits(texts[last], meta[last === 'x' ? 0 : 1].decimals) || '0');
  const plan = planBins({ bins, current, from: last, amount: Number(srcRaw) });
  const floor = (v) => BigInt(Math.max(0, Math.floor(v))).toString();
  return {
    plan,
    rawX: last === 'x' ? srcRaw : floor(plan.totalX),
    rawY: last === 'y' ? srcRaw : floor(plan.totalY)
  };
}

const trim = (text) => {
  const [w, f = ''] = text.split('.');
  const kept = f.slice(0, 8).replace(/0+$/, '');
  return kept ? `${w}.${kept}` : w;
};

/** The bot's choices from a /pools?quick= link, kept only where they are valid; null otherwise. */
export function parseQuickLink(search) {
  const id = search.get('quick') || '';
  const [x, y, fee] = id.split('|');
  if (!x || !y || !/^\d+$/.test(fee || '') || id.length > 200) return null;
  const side = ['x', 'y', 'z', 'zap'].includes(search.get('side')) ? search.get('side') : null;
  const strategy = STRATEGY_NAMES[search.get('strategy')] ? search.get('strategy') : null;
  const raw = search.get('width') || '';
  const [below, above = below] = raw.split(':');
  const width = !side || !strategy ? null : side === 'x' || side === 'y' ? customWidth(side, raw) : raw === 'full' ? raw : customAround(below, above);
  const amount = (search.get('amount') || '').replace(/,/g, '');
  return {
    id,
    tokenIds: [x, y],
    preset: {
      side,
      strategy: side ? strategy : null,
      width,
      text: width && side !== 'z' && /^\d*\.?\d+$/.test(amount) && Number(amount) > 0 ? amount : ''
    }
  };
}

function QuickLpPanel({ pool, onClose }) {
  const { accountId, connect, balances, prices, slippage, execute, refreshTokenBalances } = useApp();
  const [x, y] = pool.tokenIds;
  const [sx, sy] = pool.symbols;
  // 'x' 1st token only (above the price) · 'y' 2nd token only (below) · 'z' both tokens (around it)
  const preset = pool.preset || {};
  const [side, setSide] = useState(preset.side || null);
  const [strategy, setStrategy] = useState(preset.strategy || null);
  const [width, setWidth] = useState(preset.width || null);
  const [text, setText] = useState(preset.text || '');
  const [texts, setTexts] = useState({ x: '', y: '', last: 'x' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [meta, setMeta] = useState(null); // [token x, token y] metadata
  const [info, setInfo] = useState(null); // the pool as read when the panel opened (price, spacing, whitelist)
  const [pos, setPos] = useState(null); // null: centred; { x, y } once dragged
  const panelRef = useRef(null);
  const drag = useRef(null);
  const step = done ? 5 : !side ? 1 : !strategy ? 2 : !width ? 3 : 4;
  const both = side === 'z';
  const zap = side === 'zap'; // one token in, swapped into both sides (lib/zap.js, as the form's Zap in)
  const around = both || zap;
  const [zapId, setZapId] = useState(null);
  const [custom, setCustom] = useState(null); // Custom width being typed (around: the % below), or null
  const [customHi, setCustomHi] = useState(''); // around: the % above

  useEffect(() => {
    let live = true;
    Promise.all([getToken(x), getToken(y)])
      .then((m) => live && setMeta(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [x, y]);

  // Whitelist-only pools (set on the Rhea contract, e.g. NEAR Intents solver pools) accept
  // liquidity from their listed accounts only: same rule as the pool page (Liquidity.jsx).
  useEffect(() => {
    let live = true;
    view(CONTRACTS.dcl, 'get_pool', { pool_id: pool.id })
      .then((p) => live && setInfo(p || {}))
      .catch(() => live && setInfo({}));
    return () => {
      live = false;
    };
  }, [pool.id]);
  const whitelist = info ? (Array.isArray(info.whitelist) ? info.whitelist : []) : null;
  const restricted = Boolean(whitelist?.length) && !whitelist.includes(accountId);

  // A dragged panel grows or shrinks with each step: keep it fully on screen.
  useEffect(() => {
    if (!pos || !panelRef.current) return;
    const { height } = panelRef.current.getBoundingClientRect();
    const top = Math.max(8, Math.min(pos.y, window.innerHeight - height - 8));
    if (top !== pos.y) setPos({ ...pos, y: top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, done, side, strategy, width]);

  const back = () => {
    if (step === 4) setWidth(null);
    else if (step === 3) (setStrategy(null), setCustom(null));
    else if (step === 2) setSide(null);
  };

  const label = (id, symbol) => (id === WNEAR ? 'NEAR' : symbol);
  // What can go in: the token's balance; for wNEAR, wallet NEAR (kept 0.25 for gas) plus wNEAR.
  const spendOf = (id) => {
    if (!accountId) return 0n;
    if (id !== WNEAR) return toBigInt(balances[id] || '0');
    const near = toBigInt(balances[NATIVE_NEAR.id] || '0') - toBigInt(NEAR_GAS_RESERVE);
    return (near > 0n ? near : 0n) + toBigInt(balances[WNEAR] || '0');
  };

  // Zap: the token paid in — the wallet's NEAR when the pool holds wNEAR, or either pool token.
  const zapChoices = meta ? [...(x === WNEAR || y === WNEAR ? [NATIVE_NEAR] : []), ...meta.filter((t) => t.id !== WNEAR)] : [];
  const zapToken = zapChoices.find((t) => t.id === zapId) || zapChoices[0] || null;

  // Single token (or the zap's input).
  const token = zap ? zapToken : side === 'x' ? meta?.[0] : side === 'y' ? meta?.[1] : null;
  const tokenId = side === 'x' ? x : y;
  const isNear = !around && tokenId === WNEAR;
  const symbol = zap ? zapToken?.symbol || '' : side === 'x' ? label(x, sx) : label(y, sy);
  const zapSpend = () => {
    if (!accountId || !zapToken) return 0n;
    if (!zapToken.native) return toBigInt(balances[zapToken.id] || '0');
    const near = toBigInt(balances[NATIVE_NEAR.id] || '0') - toBigInt(NEAR_GAS_RESERVE);
    return near > 0n ? near : 0n;
  };
  const spendable = zap ? zapSpend() : side && !both ? spendOf(tokenId) : 0n;
  const usdPrice = zap ? priceOf(prices, zapToken?.native ? WNEAR : zapToken?.id) : side && !both ? priceOf(prices, tokenId) : 0;
  // How the zap splits, from the shape on the pool as read at open (the signed split is quoted live).
  const zapShareX = (() => {
    if (!zap || !meta || info?.current_point === undefined || !width || !strategy) return null;
    const range = aroundRange({ current: info.current_point, delta: info.point_delta, dx: meta[0].decimals, dy: meta[1].decimals, widthPct: width });
    const bins = buildBins({ left: range.left, right: range.right, current: info.current_point, pointDelta: info.point_delta, strategy });
    return valueShareX(planBins({ bins, current: info.current_point, from: 'x', amount: 0 }), info.current_point);
  })();
  const raw = token ? tryParseUnits(text, token.decimals) || '0' : '0';
  const tooMuch = accountId && toBigInt(raw) > spendable;

  // Both tokens: the paired amount, planned on the pool as read at open.
  const bothPlan = both && meta && info?.current_point !== undefined && width && strategy
    ? planBoth({ meta, current: info.current_point, delta: info.point_delta, width, strategy, last: texts.last, texts })
    : null;
  const bothShown = (k) => {
    if (!bothPlan || texts.last === k) return texts[k];
    const rawK = k === 'x' ? bothPlan.rawX : bothPlan.rawY;
    return toBigInt(rawK) > 0n ? trim(formatUnits(rawK, meta[k === 'x' ? 0 : 1].decimals)) : '';
  };
  const shortX = both && bothPlan && accountId && toBigInt(bothPlan.rawX) > spendOf(x);
  const shortY = both && bothPlan && accountId && toBigInt(bothPlan.rawY) > spendOf(y);
  const bothEmpty = !bothPlan || (toBigInt(bothPlan.rawX) === 0n && toBigInt(bothPlan.rawY) === 0n);
  const bothUsd = bothPlan && meta
    ? (Number(formatUnits(bothPlan.rawX, meta[0].decimals)) || 0) * priceOf(prices, x) + (Number(formatUnits(bothPlan.rawY, meta[1].decimals)) || 0) * priceOf(prices, y)
    : 0;

  // Range shown before signing, from market prices (the signed one is computed on the live pool).
  const px = priceOf(prices, x);
  const py = priceOf(prices, y);
  const price = px > 0 && py > 0 ? px / py : null;
  const [lo, hi] = width ? splitWidth(width).map((v) => v / 100) : [0, 0];
  const shownRange =
    !price || !width || width === 'full' ? null : side === 'y' ? [price * (1 - lo), price] : side === 'x' ? [price, price * (1 + lo)] : [price * (1 - lo), price * (1 + hi)];

  const setShare = (pct) => {
    if (!token) return;
    setText(formatUnits(((spendable * BigInt(pct)) / 100n).toString(), token.decimals));
  };

  const submit = async () => {
    if (!accountId) return connect();
    if (both ? bothEmpty : !token || toBigInt(raw) === 0n) return undefined;
    setBusy(true);
    const ok = await execute(
      async () => {
        // The live pool, right before the wallet opens.
        const fresh = await view(CONTRACTS.dcl, 'get_pool', { pool_id: pool.id }, { fresh: true });
        if (!fresh) throw new Error('Could not read the pool. Try again.');
        if (Array.isArray(fresh.whitelist) && fresh.whitelist.length && !fresh.whitelist.includes(accountId)) {
          throw new Error('This pool is whitelist only: Rhea accepts liquidity from its approved accounts only.');
        }
        const [mx, my] = meta;
        const current = fresh.current_point;
        if (zap) {
          // The shape on the live pool decides the split; each leg is quoted now and deposits use the
          // swaps' minimum outputs (lib/zap.js), as the Create position form's Zap in does.
          const range = aroundRange({ current, delta: fresh.point_delta, dx: mx.decimals, dy: my.decimals, widthPct: width });
          const bins = buildBins({ left: range.left, right: range.right, current, pointDelta: fresh.point_delta, strategy });
          const unitPlan = planBins({ bins, current, from: 'x', amount: 0 });
          const feeToken = zapToken.native ? WNEAR : zapToken.id;
          const fees = await quickLpFeesFor([{ token: feeToken, gross: raw, decimals: zapToken.decimals, usd: priceOf(prices, feeToken) }]);
          const quote = await quoteZap({ inputToken: zapToken, amountIn: fees[0].net, x: mx, y: my, pool: fresh, unitPlan, slippage, user: accountId });
          const txs = await buildZapTransactions({ zap: quote, inputToken: zapToken, x: mx, y: my, pool: fresh, slippage, accountId });
          return withQuickLpFees(txs, fees, { native: Boolean(zapToken.native) });
        }
        if (both) {
          // Two amounts were shown for the price at open: beyond the slippage they no longer hold.
          const moved = (Math.pow(1.0001, current - info.current_point) - 1) * 100;
          if (Math.abs(moved) > Number(slippage)) {
            setInfo(fresh);
            throw new Error(
              `The pool price moved ${moved > 0 ? '+' : ''}${moved.toFixed(2)}% since the amounts were shown — more than your ${slippage}% slippage. Amounts are updated; review and confirm again.`
            );
          }
          const gross = planBoth({ meta, current, delta: fresh.point_delta, width, strategy, last: texts.last, texts });
          const fees = await quickLpFeesFor([
            { token: x, gross: gross.rawX, decimals: mx.decimals, usd: priceOf(prices, x) },
            { token: y, gross: gross.rawY, decimals: my.decimals, usd: priceOf(prices, y) }
          ]);
          // Both sides go in at the same share (the highest fee rate of the two), so the position keeps
          // its shape; a side paying no fee just keeps that bit in the wallet.
          const ppm = fees.reduce((m, fee, i) => {
            const g = toBigInt(i ? gross.rawY : gross.rawX);
            if (g === 0n) return m;
            const share = (toBigInt(fee.amount) * 1_000_000n + g - 1n) / g; // parts per million, rounded up
            return share > m ? share : m;
          }, 0n);
          const src = toBigInt(texts.last === 'x' ? gross.rawX : gross.rawY);
          const { plan, rawX, rawY } = planBoth({ meta, current, delta: fresh.point_delta, width, strategy, last: texts.last, texts, srcRaw: (src - (src * ppm) / 1_000_000n).toString() });
          const wrapX = x === WNEAR ? await wrapNeededFor(accountId, gross.rawX, balances[WNEAR]) : '0';
          const wrapY = y === WNEAR ? await wrapNeededFor(accountId, gross.rawY, balances[WNEAR]) : '0';
          const txs = await buildDclBinsTransactions({ pool: fresh, plan, slippage, accountId, wrapX, wrapY, maxX: rawX, maxY: rawY });
          return withQuickLpFees(txs, fees);
        }
        // Single token: the range starts at the live price.
        const range = oneSidedRange({ current, delta: fresh.point_delta, dx: mx.decimals, dy: my.decimals, side, widthPct: width });
        const bins = buildBins({ left: range.left, right: range.right, current, pointDelta: fresh.point_delta, strategy });
        const fees = await quickLpFeesFor([{ token: tokenId, gross: raw, decimals: token.decimals, usd: priceOf(prices, tokenId) }]);
        const net = fees[0].net;
        const plan = planBins({ bins, current, from: side, amount: Number(net) });
        // The fee is wrapped with the deposit and sent from wNEAR after it.
        const wrap = isNear ? await wrapNeededFor(accountId, raw, balances[WNEAR]) : '0';
        const txs = await buildDclBinsTransactions({
          pool: fresh,
          plan,
          slippage,
          accountId,
          wrapX: side === 'x' && isNear ? wrap : '0',
          wrapY: side === 'y' && isNear ? wrap : '0',
          // Only the entered token, never more than entered less the fee (the plan is floating point).
          maxX: side === 'x' ? net : '0',
          maxY: side === 'y' ? net : '0'
        });
        return withQuickLpFees(txs, fees);
      },
      {
        pending: zap ? `Zapping ${symbol} into ${sx} / ${sy}` : both ? `Adding ${label(x, sx)} + ${label(y, sy)} to ${sx} / ${sy}` : `Adding ${symbol} to ${sx} / ${sy}`,
        success: zap ? 'Zap complete — position created' : 'Liquidity added'
      }
    );
    setBusy(false);
    if (ok) {
      // Opened from the Telegram bot: it posts the result in the chat once it sees the transactions.
      const hashes = (Array.isArray(ok) ? ok : []).map((o) => o?.transaction?.hash || o?.transaction_outcome?.id).filter(Boolean);
      notifyBot({ kind: 'quick-lp', account: accountId, hashes, pool: pool.id, label: [sideText, STRATEGY_NAMES[strategy], widthText].join(' · ') });
      refreshDclGraphFor(pool.id);
      refreshTokenBalances([x, y, NATIVE_NEAR.id]);
      setDone(true);
    }
    return undefined;
  };

  // Wide screens: opens in the middle of the page, then goes wherever its header is dragged.
  // Phones keep it docked above the tab bar (CSS).
  const wide = window.innerWidth > 760;
  const placed = !wide
    ? undefined
    : pos
      ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto', transform: 'none' }
      : { left: '50%', top: '50%', right: 'auto', bottom: 'auto', transform: 'translate(-50%, -50%)' };
  const onPointerDown = (event) => {
    if (!wide || event.pointerType === 'touch' || event.button !== 0 || event.target.closest('button, input')) return;
    const rect = panelRef.current.getBoundingClientRect();
    drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, w: rect.width, h: rect.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event) => {
    const d = drag.current;
    if (!d) return;
    setPos({
      x: Math.min(Math.max(8, event.clientX - d.dx), window.innerWidth - d.w - 8),
      y: Math.min(Math.max(8, event.clientY - d.dy), window.innerHeight - d.h - 8)
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const sideText = zap ? `Zap ${symbol}` : both ? 'Both tokens' : `${symbol} only`;
  // Step 3: presets and Custom read with this sign ('±' around the price, '−' below, '+' above).
  const widthMode = around ? 'below' : side;
  const sign = around ? '±' : side === 'y' ? '−' : '+';
  const customPick = custom === null ? null : around ? customAround(custom, customHi) : customWidth(widthMode, custom);
  const widthText = !width ? '' : around ? (width === 'full' ? 'Full range' : aroundText(width)) : `${side === 'y' ? '−' : '+'}${width}%`;
  const bothShort = shortX ? label(x, sx) : shortY ? label(y, sy) : null;

  // What the Quick LP fee comes to for the amounts shown (the signed one is worked out the same way).
  const feeRate = feeAfterDiscount(QUICK_LP_FEE.bps);
  const feeLegs = !QUICK_LP_FEE.enabled || !meta
    ? []
    : both
      ? bothPlan
        ? [
            { token: x, gross: bothPlan.rawX, decimals: meta[0].decimals, usd: priceOf(prices, x) },
            { token: y, gross: bothPlan.rawY, decimals: meta[1].decimals, usd: priceOf(prices, y) }
          ]
        : []
      : token && toBigInt(raw) > 0n
        ? [{ token: zap && zapToken?.native ? WNEAR : zap ? zapToken.id : tokenId, gross: raw, decimals: token.decimals, usd: usdPrice }]
        : [];
  const feeUsd = quickLpFees(feeLegs).reduce((sum, f, i) => sum + (Number(f.amount) / 10 ** feeLegs[i].decimals) * feeLegs[i].usd, 0);
  const feeNote = !QUICK_LP_FEE.enabled
    ? null
    : `Quick LP fee ${bpsText(feeRate)} (max $${QUICK_LP_FEE.maxUsd})${feeUsd > 0 ? ` ≈ $${formatAmount(feeUsd)}` : ''}, included in the amount${feeRate < QUICK_LP_FEE.bps ? ' · KINU holder rate' : ' · up to 75% off for $KINU holders'}`;

  return (
    <section ref={panelRef} className="qt qlp" style={placed} aria-label={`Quick LP ${sx} / ${sy}`}>
      <header className="qt__head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <strong title={`${sx} / ${sy}`}>
          <span aria-hidden>⚡</span> {sx} / {sy}
        </strong>
        {!done && !restricted && <span className="qlp__step">Step {step}/4</span>}
        {step > 1 && !done && (
          <button type="button" className="qt__slip" onClick={back} disabled={busy} title="Previous step">
            ← Back
          </button>
        )}
        <button type="button" className="qt__close" onClick={onClose} aria-label="Close quick LP" title="Close">
          ×
        </button>
      </header>

      {restricted && (
        <div className="whitelist-only qlp__wl">
          <strong>Whitelist only</strong>
          <p>
            This pool only accepts liquidity from {whitelist.length} approved account{whitelist.length === 1 ? '' : 's'} (set on the Rhea
            contract). You can still swap through it, but a deposit from your wallet would be rejected.
          </p>
          <small className="muted">{whitelist.join(' · ')}</small>
          <button type="button" className="button button--outline qlp__go" onClick={() => (onClose(), navigate(poolPath(pool.id)))}>
            View pool →
          </button>
        </div>
      )}

      {step > 1 && !done && <p className="qlp__picked">{[sideText, strategy && STRATEGY_NAMES[strategy], widthText].filter(Boolean).join(' · ')}</p>}

      {info === null && <p className="qlp__ask">Checking pool…</p>}

      {info !== null && !restricted && step === 1 && (
        <>
          <p className="qlp__ask">What do you put in?</p>
          <div className="qlp__opts">
            <button type="button" className="qlp__opt" onClick={() => setSide('y')}>
              <strong>💵 {label(y, sy)} only ↓</strong>
              <small>From the price down: buys {sx} as it falls</small>
            </button>
            <button type="button" className="qlp__opt" onClick={() => setSide('x')}>
              <strong>🎯 {label(x, sx)} only ↑</strong>
              <small>From the price up: sells {sx} as it rises</small>
            </button>
            <button type="button" className="qlp__opt" onClick={() => setSide('z')}>
              <strong>
                ⚖ Both tokens · {label(x, sx)} + {label(y, sy)}
              </strong>
              <small>Around the price: earns on moves both ways</small>
            </button>
            <button type="button" className="qlp__opt" onClick={() => setSide('zap')}>
              <strong>⚡ Zap in · one token, both sides</strong>
              <small>Pay {x === WNEAR || y === WNEAR ? 'NEAR' : `${sx} or ${sy}`}: KINU swaps the right share and opens the range</small>
            </button>
          </div>
        </>
      )}

      {!restricted && step === 2 && (
        <>
          <p className="qlp__ask">Pick a strategy</p>
          <div className="qlp__opts">
            {strategyOptions(side, sx).map(([key, name, hint]) => (
              <button key={key} type="button" className="qlp__opt" onClick={() => setStrategy(key)}>
                <strong>{name}</strong>
                <small>{hint}</small>
              </button>
            ))}
          </div>
        </>
      )}

      {!restricted && step === 3 && (
        <>
          <p className="qlp__ask">
            {around ? 'How wide around the price?' : side === 'y' ? 'How far below the price?' : 'How far above the price?'}{' '}
            <small>Tighter earns more fees but leaves the range sooner.</small>
          </p>
          <div className="qt__grid qlp__grid">
            {(around ? AROUND_WIDTHS : SIDE_WIDTHS).map((v) => (
              <button key={v} type="button" className="qt__btn" onClick={() => setWidth(v)}>
                <strong>{`${sign}${v}%`}</strong>
              </button>
            ))}
            <button
              type="button"
              className={`qt__btn${custom !== null ? ' is-active' : ''}`}
              onClick={() => (setCustom(custom === null ? '' : null), setCustomHi(''))}
            >
              <strong>Custom</strong>
            </button>
          </div>
          {custom !== null && (
            <form
              className="qlp__custom"
              onSubmit={(e) => {
                e.preventDefault();
                if (customPick) (setWidth(customPick), setCustom(null));
              }}
            >
              {/* Around the price: how far below and how far above, apart (the bottom stops short of zero). */}
              <div className={around ? 'qlp__custom-pair' : undefined}>
                {(around
                  ? [
                      ['below', '−', custom, setCustom, 'How far below the price, in %'],
                      ['above', '+', customHi, setCustomHi, 'How far above the price, in %']
                    ]
                  : [[widthMode, sign, custom, setCustom, side === 'y' ? 'How far below the price, in %' : 'How far above the price, in %']]
                ).map(([mode, mark, value, set, name], i) => (
                  <div key={mode} className="qlp__field">
                    <b>{mark}</b>
                    <input
                      autoFocus={i === 0}
                      inputMode="decimal"
                      placeholder={`1 – ${WIDTH_MAX[mode]}`}
                      value={value}
                      aria-label={name}
                      onChange={(e) => {
                        const v = e.target.value.replace(',', '.');
                        if (/^\d{0,4}\.?\d?$/.test(v)) set(v);
                      }}
                    />
                    <b>%</b>
                  </div>
                ))}
              </div>
              <button type="submit" className="button button--primary qlp__go" disabled={!customPick}>
                {customPick
                  ? `Use ${around ? aroundText(customPick) : `${sign}${customPick}%`}`
                  : around
                    ? `Below 1 – ${WIDTH_MAX.below}% · above 1 – ${WIDTH_MAX.above}%`
                    : `Enter 1 – ${WIDTH_MAX[widthMode]}%`}
              </button>
            </form>
          )}
        </>
      )}

      {!restricted && step === 4 && (
        <>
          {shownRange ? (
            <p className="qlp__range">
              Range ≈ {formatChartPrice(shownRange[0])} – {formatChartPrice(shownRange[1])} {sy} per {sx}
              {around ? ' · around the price now' : ' · from the price now'}
            </p>
          ) : width === 'full' ? (
            <p className="qlp__range">Full range: every price</p>
          ) : null}

          {both ? (
            <div className="qlp__amount">
              <div className="qlp__amount-head">
                <span>Amounts</span>
                <span className="muted">Type either one, the other follows</span>
              </div>
              {[
                ['x', label(x, sx), x],
                ['y', label(y, sy), y]
              ].map(([k, sym, id]) => (
                <div key={k}>
                  <div className="qlp__field">
                    <input
                      inputMode="decimal"
                      placeholder="0.0"
                      value={bothShown(k)}
                      aria-label={`Amount of ${sym}`}
                      onChange={(e) => {
                        const v = e.target.value.replace(',', '.');
                        if (/^\d*\.?\d*$/.test(v)) setTexts((t) => ({ ...t, [k]: v, last: k }));
                      }}
                    />
                    <b>{sym}</b>
                  </div>
                  {accountId && meta && (
                    <small className="muted qlp__bal">
                      Balance {formatRawAmount(spendOf(id).toString(), meta[k === 'x' ? 0 : 1].decimals)} {sym}
                    </small>
                  )}
                </div>
              ))}
              {bothUsd > 0 && <small className="muted">≈ ${formatAmount(bothUsd)} in total</small>}
            </div>
          ) : (
            <div className="qlp__amount">
              {zap && zapChoices.length > 1 && (
                <div className="qlp__chips qlp__pay">
                  <span>Pay with</span>
                  {zapChoices.map((t) => (
                    <button key={t.id} type="button" className={t.id === zapToken?.id ? 'is-active' : ''} onClick={() => (setZapId(t.id), setText(''))}>
                      {t.symbol}
                    </button>
                  ))}
                </div>
              )}
              <div className="qlp__amount-head">
                <span>Amount</span>
                {accountId && token && (
                  <span className="muted">
                    Balance {formatRawAmount(spendable.toString(), token.decimals)} {symbol}
                  </span>
                )}
              </div>
              <div className="qlp__field">
                <input
                  inputMode="decimal"
                  placeholder="0.0"
                  value={text}
                  aria-label={`Amount of ${symbol}`}
                  onChange={(e) => {
                    const v = e.target.value.replace(',', '.');
                    if (/^\d*\.?\d*$/.test(v)) setText(v);
                  }}
                />
                <b>{symbol}</b>
              </div>
              <div className="qlp__chips">
                {SHARES.map((p) => (
                  <button key={p} type="button" onClick={() => setShare(p)} disabled={!accountId} title={accountId ? undefined : 'Connect a wallet to use your balance'}>
                    {p === 100 ? 'Max' : `${p}%`}
                  </button>
                ))}
              </div>
              {usdPrice > 0 && Number(text) > 0 && <small className="muted">≈ ${formatAmount(Number(text) * usdPrice)}</small>}
              {zapShareX !== null && (
                <small className="muted">
                  Split ≈ {Math.round(zapShareX * 100)}% {label(x, sx)} / {100 - Math.round(zapShareX * 100)}% {label(y, sy)} · swap quoted at signing
                </small>
              )}
            </div>
          )}

          {feeNote && <small className="muted qlp__fee">{feeNote}</small>}
          {meta && <TaxNote tokens={meta} />}
          <button
            type="button"
            className="button button--primary qlp__go"
            onClick={submit}
            disabled={busy || !meta || (accountId && (both ? bothEmpty || Boolean(bothShort) : toBigInt(raw) === 0n || tooMuch))}
          >
            {!accountId
              ? 'Connect wallet'
              : busy
                ? 'Confirm in your wallet…'
                : both
                  ? bothShort
                    ? `Not enough ${bothShort}`
                    : 'Add liquidity'
                  : tooMuch
                    ? `Not enough ${symbol}`
                    : zap
                      ? `Zap ${symbol} in`
                      : `Add ${symbol} liquidity`}
          </button>
          <p className="qt__foot">Slippage {slippage}% · signed in your wallet. The range is set on the live pool price at signing.</p>
        </>
      )}

      {done && (
        <div className="qlp__done">
          <p className="qlp__ask">
            ✅ Position created <small>{[sideText, STRATEGY_NAMES[strategy], widthText].join(' · ')}</small>
          </p>
          <button type="button" className="button button--primary qlp__go" onClick={() => (onClose(), navigate(poolPath(pool.id)))}>
            View pool →
          </button>
          <button type="button" className="link-button qlp__both" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </section>
  );
}

/** The panel's host on the Pools page: shows the pool a row's ⚡ Quick LP (or a bot link) picked. */
export function QuickLpHost() {
  const [pool, setPool] = useState(null);
  useEffect(() => {
    const onOpen = (event) => setPool(event.detail);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // A /pools?quick= link (the Telegram bot): open once, then drop its fields from the address.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const link = parseQuickLink(params);
    if (!link) return undefined;
    ['quick', 'side', 'strategy', 'width', 'amount'].forEach((k) => params.delete(k));
    navigate(`/pools${params.toString() ? `?${params}` : ''}`, { replace: true });
    let live = true;
    Promise.all(link.tokenIds.map((id) => getToken(id).catch(() => null))).then((tokens) => {
      if (!live) return;
      // As the Pools rows name them: wNEAR shows as NEAR.
      const symbols = tokens.map((t, i) => (link.tokenIds[i] === WNEAR ? 'NEAR' : t?.symbol || link.tokenIds[i].split('.')[0].toUpperCase()));
      setPool({ id: link.id, tokenIds: link.tokenIds, symbols, preset: link.preset });
    });
    return () => {
      live = false;
    };
  }, []);
  if (!pool) return null;
  return <QuickLpPanel key={pool.id} pool={pool} onClose={() => setPool(null)} />;
}
