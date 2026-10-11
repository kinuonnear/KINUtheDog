// Zap In: open a CLMM position from a single token.
// The input is split by the value share the chosen range/strategy needs on
// each side; the part that isn't already the right token is swapped (Rhea
// SmartRouter, or direct DCL routing), then the positions are opened.
// Deposits use each swap's *minimum* output, so they can never exceed what
// the wallet actually receives; any surplus simply stays in the wallet.

import { CONTRACTS } from '../config.js';
import { buildDclBinsTransactions, planBinsByBudget } from './dclLiquidity.js';
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

/**
 * Quote a zap. Each leg is either kept (input already is that token),
 * wrapped (native NEAR -> wNEAR) or swapped.
 * @param unitPlan  planBins() result for the chosen range/strategy (any size)
 */
export async function quoteZap({ inputToken, amountIn, x, y, pool, unitPlan, slippage, user }) {
  const shareX = valueShareX(unitPlan, pool.current_point);
  const { toX, toY } = splitAmount(amountIn, shareX);

  const leg = async (target, amount) => {
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
  };

  const [legX, legY] = await Promise.all([leg(x, toX), leg(y, toY)]);
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
