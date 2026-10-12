// One-click Rebalance: move CLMM positions that left their range back around the
// current price. One wallet request does it all:
//   1. withdraw the out-of-range positions (tokens + earned fees go to the wallet)
//   2. swap the share of the withdrawn tokens the new range needs on the other side
//   3. open the new range with the chosen strategy
// Only what is withdrawn is reused; the swap's *minimum* output sizes the deposit,
// so the deposit can never exceed what arrives. Any remainder stays in the wallet.

import { CONTRACTS } from '../config.js';
import { view } from './rpc.js';
import { toBigInt } from './format.js';
import { alignPoint, buildBins, buildDclBinsTransactions, buildDclRemoveTransactions, planBins, planBinsByBudget, removeMinsInBand } from './dclLiquidity.js';
import { buildSwapTransactions, getSwapQuote, selectRoute } from './swap.js';
import { valueShareX } from './zap.js';

/** Price-width presets for the new range, as ± around the current price. */
export const REBALANCE_WIDTHS = [
  { key: 'same', label: 'Same width' },
  { key: '5', label: '±5%', pct: 5 },
  { key: '10', label: '±10%', pct: 10 },
  { key: '25', label: '±25%', pct: 25 }
];

/** Withdraw from these positions is all that the rebalance can spend (raw, after slippage). */
export function withdrawnAmounts(positions, slippage) {
  return positions.reduce(
    (sum, p) => {
      const { minX, minY } = removeMinsInBand({ left: p.leftPoint, right: p.rightPoint, current: p.currentPoint, liquidity: p.liquidity, slippage });
      return { x: sum.x + toBigInt(minX), y: sum.y + toBigInt(minY) };
    },
    { x: 0n, y: 0n }
  );
}

/** New [left, right] around the current point: the old total width, or ±pct of price. */
export function newRange({ positions, current, pointDelta, width }) {
  let half;
  if (width === 'same' || !width) {
    const left = Math.min(...positions.map((p) => p.leftPoint));
    const right = Math.max(...positions.map((p) => p.rightPoint));
    half = Math.max(pointDelta, Math.round((right - left) / 2));
  } else {
    const pct = REBALANCE_WIDTHS.find((w) => w.key === width)?.pct || 10;
    half = Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));
  }
  // half >= pointDelta, so the aligned edges always straddle the current point.
  const left = alignPoint(current - half, pointDelta, 'floor');
  let right = alignPoint(current + half, pointDelta, 'ceil');
  if (right <= current) right += pointDelta;
  return { left, right };
}

/** A one-step route from a quote (a two-step bridge route can't run inside one request). */
function oneStep(quote) {
  if (!quote.hybrid) return quote;
  const direct = (quote.routes || []).filter((r) => !r.quote.hybrid);
  if (!direct.length) throw new Error('No direct route for this swap right now. Try again shortly.');
  const top = direct.reduce((a, b) => (toBigInt(b.quote.amountOut) > toBigInt(a.quote.amountOut) ? b : a));
  return selectRoute(quote, top.source);
}

/**
 * Quote a rebalance. x / y are token metadata; positions are from getDclPositions (one pool).
 * Returns everything the modal shows and buildRebalanceTransactions needs.
 */
export async function quoteRebalance({ positions, x, y, width, strategy, slippage, user }) {
  const pool = await view(CONTRACTS.dcl, 'get_pool', { pool_id: positions[0].poolId }, { fresh: true });
  const current = pool.current_point;
  const range = newRange({ positions, current, pointDelta: pool.point_delta, width });
  const bins = buildBins({ left: range.left, right: range.right, current, pointDelta: pool.point_delta, strategy });
  const unitPlan = planBins({ bins, current, from: 'x', amount: 0 });

  const held = withdrawnAmounts(positions, slippage);
  // Value in raw Y units: raw X × raw price at the current point.
  const rawPrice = Math.pow(1.0001, current);
  const valueX = Number(held.x) * rawPrice;
  const total = valueX + Number(held.y);
  if (!(total > 0)) throw new Error('Nothing to rebalance.');
  const targetX = valueShareX(unitPlan, current) * total;

  let swap = null;
  let budgetX = Number(held.x);
  let budgetY = Number(held.y);
  const excessX = valueX - targetX; // > 0: sell X for Y; < 0: sell Y for X
  if (Math.abs(excessX) / total > 0.002) {
    const sellX = excessX > 0;
    const amountIn = sellX
      ? BigInt(Math.floor(Math.min(Number(held.x), excessX / rawPrice)))
      : BigInt(Math.floor(Math.min(Number(held.y), -excessX)));
    if (amountIn > 0n) {
      const tokenIn = sellX ? x : y;
      const tokenOut = sellX ? y : x;
      let quote;
      try {
        quote = oneStep(await getSwapQuote({ tokenIn, tokenOut, amountIn: amountIn.toString(), slippage, user }));
      } catch (error) {
        if (/no (liquidity )?route/i.test(error.message)) {
          throw new Error(
            `There isn't enough liquidity to swap the ${tokenIn.symbol} this range needs right now. Withdraw instead, or try a range further from the price.`
          );
        }
        throw error;
      }
      // The swap usually runs through this same pool and moves its price. In a CLMM pool the
      // final price moves about twice the average impact; past the slippage band the deposit
      // would be refused, so stop here instead of failing on-chain.
      const move = Number.isFinite(quote.priceImpact) ? quote.priceImpact * 2 : 0;
      if (move > slippage) {
        throw new Error(
          `The swap for the new range moves the price about ${move.toFixed(2)}% — more than your ${slippage}% slippage, so the deposit would fail. Raise slippage in ⚙ or withdraw instead.`
        );
      }
      swap = { tokenIn, tokenOut, amountIn: amountIn.toString(), quote };
      if (sellX) {
        budgetX -= Number(amountIn);
        budgetY += Number(quote.minAmountOut);
      } else {
        budgetY -= Number(amountIn);
        budgetX += Number(quote.minAmountOut);
      }
    }
  }

  const plan = planBinsByBudget({ bins: unitPlan.bins, budgetX: Math.max(0, budgetX), budgetY: Math.max(0, budgetY) });
  if (!(plan.totalX > 0 || plan.totalY > 0)) throw new Error('The withdrawn amount is too small to open a new range.');
  return { pool, range, strategy, held, swap, plan, user: user || null, fetchedAt: Date.now() };
}

/** Withdraw → swap → deposit, in one wallet request. */
export async function buildRebalanceTransactions({ rebalance, positions, slippage, accountId }) {
  if (rebalance.user !== accountId) throw new Error('This quote is for another account. Refresh and try again.');
  const txs = await buildDclRemoveTransactions({ positions, percent: 100, slippage, accountId });
  if (rebalance.swap) {
    const { tokenIn, tokenOut, quote } = rebalance.swap;
    txs.push(...(await buildSwapTransactions({ tokenIn, tokenOut, quote, accountId })));
  }
  txs.push(...(await buildDclBinsTransactions({ pool: rebalance.pool, plan: rebalance.plan, slippage, accountId })));
  return txs;
}
