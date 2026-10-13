// Zap In: open a CLMM position from a single token.
// The input is split by the value share the chosen range/strategy needs on
// each side; the part that isn't already the right token is swapped (Rhea
// SmartRouter, or direct DCL routing), then the positions are opened.
// Deposits use each swap's *minimum* output, so they can never exceed what
// the wallet actually receives; any surplus simply stays in the wallet.

import { CONTRACTS } from '../config.js';
import { buildDclAppendTransactions, buildDclBinsTransactions, planAppend, planBinsByBudget } from './dclLiquidity.js';
import { buildSwapTransactions, getSwapQuote } from './swap.js';
import { toBigInt } from './format.js';

const SCALE = 1_000_000n;

/** True when `token` already is `targetId` (native NEAR counts as wrap.near). */
export function isSameToken(token, targetId) {
  return token.id === targetId || (token.native && targetId === CONTRACTS.wrapNear);
}

/** Share of the position value (0..1) that sits in token X, measured in token Y. */
export function valueShareX(plan, currentPoint) {
  const unitX = plan.bins.reduce((s, b) => s + b.xPerL, 0);
  const unitY = plan.bins.reduce((s, b) => s + b.yPerL, 0);
  const xInY = unitX * Math.pow(1.0001, currentPoint);
  const total = xInY + unitY;
  return total > 0 ? xInY / total : 0;
}

function splitAmount(amountIn, shareX) {
  const share = BigInt(Math.round(Math.min(1, Math.max(0, shareX)) * Number(SCALE)));
  const toX = (toBigInt(amountIn) * share) / SCALE;
  return { toX, toY: toBigInt(amountIn) - toX };
}

/** One side of a zap: kept (input already is that token), wrapped (native NEAR -> wNEAR) or swapped. */
async function quoteLeg({ inputToken, target, amount, slippage, user }) {
  if (amount <= 0n) return { target: target.id, amountIn: '0', kind: 'none', out: '0', minOut: '0' };
  if (isSameToken(inputToken, target.id)) {
    return {
      target: target.id,
      amountIn: amount.toString(),
      kind: inputToken.native ? 'wrap' : 'keep',
      out: amount.toString(),
      minOut: amount.toString()
    };
  }
  const quote = await getSwapQuote({ tokenIn: inputToken, tokenOut: target, amountIn: amount.toString(), slippage, user });
  return { target: target.id, amountIn: amount.toString(), kind: 'swap', quote, out: quote.amountOut, minOut: quote.minAmountOut };
}

/**
 * Quote a zap. Each leg is either kept (input already is that token),
 * wrapped (native NEAR -> wNEAR) or swapped.
 * @param unitPlan  planBins() result for the chosen range/strategy (any size)
 */
export async function quoteZap({ inputToken, amountIn, x, y, pool, unitPlan, slippage, user }) {
  const shareX = valueShareX(unitPlan, pool.current_point);
  const { toX, toY } = splitAmount(amountIn, shareX);

  const [legX, legY] = await Promise.all([
    quoteLeg({ inputToken, target: x, amount: toX, slippage, user }),
    quoteLeg({ inputToken, target: y, amount: toY, slippage, user })
  ]);
  const plan = planBinsByBudget({
    bins: unitPlan.bins,
    budgetX: Number(legX.minOut),
    budgetY: Number(legY.minOut)
  });
  return { shareX, legX, legY, plan, user: user || null, fetchedAt: Date.now() };
}

/** Swaps (if any) followed by the position deposit, in one wallet request. */
export async function buildZapTransactions({ zap, inputToken, x, y, pool, slippage, accountId }) {
  if (zap.user !== accountId) throw new Error('Zap quote is for another account. Refresh and try again.');
  const txs = [];
  for (const [legItem, target] of [
    [zap.legX, x],
    [zap.legY, y]
  ]) {
    if (legItem.kind === 'swap') {
      txs.push(...(await buildSwapTransactions({ tokenIn: inputToken, tokenOut: target, quote: legItem.quote, accountId })));
    }
  }
  // Native NEAR kept for the wNEAR side is wrapped right before the deposit.
  const wrapFor = (legItem, total) => (legItem.kind === 'wrap' ? total : 0);
  const wrapX = wrapFor(zap.legX, Math.floor(zap.plan.totalX));
  const wrapY = wrapFor(zap.legY, Math.floor(zap.plan.totalY));
  txs.push(
    ...(await buildDclBinsTransactions({
      pool,
      plan: zap.plan,
      slippage,
      accountId,
      wrapX: BigInt(wrapX).toString(),
      wrapY: BigInt(wrapY).toString()
    }))
  );
  return txs;
}

/* ------------------------------------------------------------------ */
/* Zap into an existing position                                       */
/* ------------------------------------------------------------------ */

/** Share of an existing position's value (0..1) held in token X, at the current price. */
export function positionShareX(positions) {
  const holdX = positions.reduce((s, p) => s + p.amountX, 0);
  const holdY = positions.reduce((s, p) => s + p.amountY, 0);
  const current = positions[0]?.currentPoint ?? 0;
  const xInY = holdX * Math.pow(1.0001, current);
  const total = xInY + holdY;
  return total > 0 ? xInY / total : 0;
}

/**
 * Quote adding ONE token to an existing position (its bins): the input is split by the value
 * the position holds on each side, the other side is swapped, and both are appended keeping the
 * range and shape. Amounts use each swap's minimum output, so they never exceed what arrives.
 * `zap.plan` carries display numbers; `zap.append` the raw plan (lib/dclLiquidity planAppend).
 */
export async function quoteZapToPosition({ inputToken, amountIn, x, y, positions, slippage, user }) {
  const shareX = positionShareX(positions);
  const { toX, toY } = splitAmount(amountIn, shareX);
  const [legX, legY] = await Promise.all([
    quoteLeg({ inputToken, target: x, amount: toX, slippage, user }),
    quoteLeg({ inputToken, target: y, amount: toY, slippage, user })
  ]);
  const append = planAppend(positions, { inX: toBigInt(legX.minOut), inY: toBigInt(legY.minOut) });
  return {
    shareX,
    legX,
    legY,
    append,
    plan: { totalX: Number(append.totalX), totalY: Number(append.totalY), bins: append.items },
    user: user || null,
    fetchedAt: Date.now()
  };
}

/** Swaps (if any), then deposit + append to the position's bins, in one wallet request. */
export async function buildZapAppendTransactions({ zap, inputToken, x, y, positions, slippage, accountId }) {
  if (zap.user !== accountId) throw new Error('Zap quote is for another account. Refresh and try again.');
  if (!zap.append.items.length) throw new Error('This amount is too small to add to the position.');
  const txs = [];
  for (const [legItem, target] of [
    [zap.legX, x],
    [zap.legY, y]
  ]) {
    if (legItem.kind === 'swap') {
      txs.push(...(await buildSwapTransactions({ tokenIn: inputToken, tokenOut: target, quote: legItem.quote, accountId })));
    }
  }
  // Native NEAR kept for the wNEAR side is wrapped right before the deposit.
  const wrapX = zap.legX.kind === 'wrap' ? zap.append.totalX : 0n;
  const wrapY = zap.legY.kind === 'wrap' ? zap.append.totalY : 0n;
  txs.push(
    ...(await buildDclAppendTransactions({
      positions,
      inX: zap.legX.minOut,
      inY: zap.legY.minOut,
      slippage,
      accountId,
      wrapX: wrapX.toString(),
      wrapY: wrapY.toString()
    }))
  );
  return txs;
}
