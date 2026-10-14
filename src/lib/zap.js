// Zap In: open a CLMM position from a single token.
// The input is split by the value share the chosen range/strategy needs on
// each side; the part that isn't already the right token is swapped (Rhea
// SmartRouter, or direct DCL routing), then the positions are opened.
// Deposits use each swap's *minimum* output, so they can never exceed what
// the wallet actually receives; any surplus simply stays in the wallet.

import { CONTRACTS } from '../config.js';
import { buildDclAppendTransactions, buildDclBinsTransactions, planAppend, planBinsByBudget } from './dclLiquidity.js';
import { buildSwapTransactions, getSwapQuote, measurePriceImpact } from './swap.js';
import { oneStep } from './rebalance.js';
import { buildAddLiquidityTransactions } from './liquidity.js';
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

/** Whether a swap quote trades through the given CLMM pool ("x|y|fee"). */
export function routesThrough(quote, poolId) {
  if (quote.dcl) return quote.dcl.poolIds.includes(poolId);
  // Rhea's SmartRouter message is opaque: any hop between the pool's two tokens may use it.
  const [a, b] = poolId.split('|');
  const t = quote.routeTokens;
  if (!Array.isArray(t)) return true;
  return t.some((id, i) => i > 0 && ((t[i - 1] === a && id === b) || (t[i - 1] === b && id === a)));
}

/**
 * A zap swaps part of the input and then deposits into the pool. When a swap runs through that
 * same pool it moves the pool's price first — in a CLMM pool by about twice the average impact —
 * and past the slippage band the deposit is refused on-chain (E204). Stop at the quote instead.
 */
async function checkZapImpact(legs, { poolId, inputToken, slippage }) {
  let move = 0;
  for (const leg of legs) {
    if (leg.kind !== 'swap' || !routesThrough(leg.quote, poolId)) continue;
    let impact = leg.quote.priceImpact;
    if (!Number.isFinite(impact)) {
      impact = await measurePriceImpact(leg.quote, { tokenIn: inputToken, tokenOut: { id: leg.target }, amountIn: leg.amountIn }).catch(() => null);
    }
    if (Number.isFinite(impact)) move += impact * 2;
  }
  if (move > slippage) {
    throw new Error(
      `The swap inside this zap moves the pool price about ${move.toFixed(2)}% — more than your ${slippage}% slippage, so the deposit would fail. Raise slippage in ⚙, zap a smaller amount, or add both tokens.`
    );
  }
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
  // One-step routes only: a zap is a single wallet request (lib/rebalance.js oneStep).
  const quote = oneStep(await getSwapQuote({ tokenIn: inputToken, tokenOut: target, amountIn: amount.toString(), slippage, user }));
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
  await checkZapImpact([legX, legY], { poolId: pool.pool_id, inputToken, slippage });
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
  await checkZapImpact([legX, legY], { poolId: positions[0].poolId, inputToken, slippage });
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

/* ------------------------------------------------------------------ */
/* Zap into a classic (x·y=k) pool                                     */
/* ------------------------------------------------------------------ */

/**
 * Quote a zap into a two-token classic pool: half the input's value goes to each side (the part
 * that isn't already that token is swapped), and the deposit follows the pool's ratio from each
 * swap's guaranteed minimum — the rest stays in the wallet. When a swap may trade through this
 * same pool it moves the ratio first: the ratio used is the one after that swap, and a move past
 * the slippage band stops at the quote (the deposit would be refused on-chain).
 * @param pool    classic pool from getPool() (kind SIMPLE_POOL, two tokens)
 * @param tokens  the pool's tokens, in pool.tokenIds order
 */
export async function quoteClassicZap({ inputToken, amountIn, pool, tokens, slippage, user }) {
  if (pool.kind !== 'SIMPLE_POOL' || pool.tokenIds.length !== 2) throw new Error('Zap in works with two-token classic pools.');
  const [a, b] = tokens;
  let rA = toBigInt(pool.amounts[0]);
  let rB = toBigInt(pool.amounts[1]);
  if (rA <= 0n || rB <= 0n) throw new Error('This pool is empty: add both tokens to set its first price.');

  const { toX, toY } = splitAmount(amountIn, 0.5);
  const [legA, legB] = await Promise.all([
    quoteLeg({ inputToken, target: a, amount: toX, slippage, user }),
    quoteLeg({ inputToken, target: b, amount: toY, slippage, user })
  ]);
  const pairKey = `${a.id}|${b.id}`;
  await checkZapImpact([legA, legB], { poolId: pairKey, inputToken, slippage });

  // Input is one of the pool's tokens and its swap may run through this pool: the reserves the
  // deposit meets are the ones after that swap.
  if (legB.kind === 'swap' && isSameToken(inputToken, a.id) && routesThrough(legB.quote, pairKey)) {
    rA += toBigInt(legB.amountIn);
    rB -= toBigInt(legB.out);
  } else if (legA.kind === 'swap' && isSameToken(inputToken, b.id) && routesThrough(legA.quote, pairKey)) {
    rB += toBigInt(legA.amountIn);
    rA -= toBigInt(legA.out);
  }
  if (rA <= 0n || rB <= 0n) throw new Error('This zap is too large for the pool. Try a smaller amount.');

  const haveA = toBigInt(legA.minOut);
  const haveB = toBigInt(legB.minOut);
  let depA = haveA;
  let depB = (haveA * rB) / rA;
  if (depB > haveB) {
    depB = haveB;
    depA = (haveB * rA) / rB;
  }
  if (depA <= 0n || depB <= 0n) throw new Error('Amount too small to zap into this pool.');

  return {
    legA,
    legB,
    deposit: [depA.toString(), depB.toString()],
    user: user || null,
    fetchedAt: Date.now()
  };
}

/** Swaps (if any) followed by the classic add_liquidity, in one wallet request. */
export async function buildClassicZapTransactions({ zap, inputToken, pool, tokens, slippage, accountId }) {
  if (zap.user !== accountId) throw new Error('Zap quote is for another account. Refresh and try again.');
  const txs = [];
  for (const [legItem, target] of [
    [zap.legA, tokens[0]],
    [zap.legB, tokens[1]]
  ]) {
    if (legItem.kind === 'swap') {
      txs.push(...(await buildSwapTransactions({ tokenIn: inputToken, tokenOut: target, quote: legItem.quote, accountId })));
    }
  }
  // Native NEAR kept for the wNEAR side is wrapped right before the deposit.
  const wrapIndex = [zap.legA, zap.legB].findIndex((legItem) => legItem.kind === 'wrap');
  const wrapAmount = wrapIndex >= 0 ? zap.deposit[wrapIndex] : '0';
  txs.push(...(await buildAddLiquidityTransactions({ pool, amounts: zap.deposit, accountId, slippage, wrapAmount })));
  return txs;
}
