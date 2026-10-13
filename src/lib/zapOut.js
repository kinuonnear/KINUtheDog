// Zap Out: remove CLMM liquidity and receive ONE token, in one wallet request:
//   1. remove `percent` of the positions — both tokens and ALL unclaimed fees reach the wallet
//      (Rhea settles a position's fees whenever its liquidity changes);
//   2. swap the other token (liquidity share + its fees) into the chosen one;
//   3. wNEAR kept on the chosen side is unwrapped to native NEAR.
// The swap spends only what is guaranteed to arrive: the removal's slippage minimums plus the
// fees, after a taxed token's tax on the way out (lib/tokenTax.js). Any extra stays in the wallet.

import { CONTRACTS, DEPOSIT, GAS, NATIVE_NEAR } from '../config.js';
import { buildDclRemoveTransactions, freshPool, positionsAtPoint, removeMinsInBand } from './dclLiquidity.js';
import { getDclQuote } from './dclRouter.js';
import { oneStep } from './rebalance.js';
import { buildSwapTransactions, getSwapQuote, measurePriceImpact } from './swap.js';
import { afterTax, dclTax } from './tokenTax.js';
import { functionCall, transaction } from './tx.js';
import { toBigInt } from './format.js';

// Above this share of the pool's active liquidity, removing it changes the pool too much for a
// quote taken beforehand: the swap then avoids this pool.
const OWN_POOL_SHARE = 0.05;

const raw = (n) => (n > 0 ? BigInt(Math.floor(n)) : 0n);

/**
 * Quote a zap out of `percent` of `positions` (one pool) into side `target` ('x' | 'y').
 * A wNEAR side is paid out as native NEAR.
 */
export async function quoteZapOut({ positions, percent, x, y, target, slippage, user }) {
  const pool = await freshPool(positions[0].poolId);
  const now = positionsAtPoint(positions, pool.current_point);
  const share = Number(percent) / 100;

  let minX = 0n;
  let minY = 0n;
  let estX = 0;
  let estY = 0;
  let removedActive = 0;
  now.forEach((p) => {
    const amount = (toBigInt(p.liquidity) * BigInt(percent)) / 100n;
    if (amount <= 0n) return;
    const m = removeMinsInBand({ left: p.leftPoint, right: p.rightPoint, current: p.currentPoint, liquidity: amount.toString(), slippage });
    minX += toBigInt(m.minX);
    minY += toBigInt(m.minY);
    estX += p.amountX * share;
    estY += p.amountY * share;
    if (p.inRange) removedActive += Number(amount);
  });
  const feeX = now.reduce((s, p) => s + toBigInt(p.unclaimedFeeX || '0'), 0n);
  const feeY = now.reduce((s, p) => s + toBigInt(p.unclaimedFeeY || '0'), 0n);

  // What reaches the wallet: guaranteed (minimums) and expected, after tax on the way out.
  const [taxX, taxY] = await Promise.all([dclTax(x.id), dclTax(y.id)]);
  const got = {
    x: { min: afterTax(minX, taxX.out) + afterTax(feeX, taxX.out), est: afterTax(raw(estX), taxX.out) + afterTax(feeX, taxX.out) },
    y: { min: afterTax(minY, taxY.out) + afterTax(feeY, taxY.out), est: afterTax(raw(estY), taxY.out) + afterTax(feeY, taxY.out) }
  };

  const keepSide = target === 'x' ? 'x' : 'y';
  const sellSide = keepSide === 'x' ? 'y' : 'x';
  const keepToken = keepSide === 'x' ? x : y;
  const sellToken = sellSide === 'x' ? x : y;
  const native = keepToken.id === CONTRACTS.wrapNear;
  const outToken = native ? NATIVE_NEAR : keepToken;
  const poolShare = Number(pool.liquidity) > 0 ? removedActive / Number(pool.liquidity) : 0;
  const avoidPool = poolShare > OWN_POOL_SHARE;

  let swap = null;
  const amountIn = got[sellSide].min;
  if (amountIn > 0n) {
    const params = { tokenIn: sellToken, tokenOut: outToken, amountIn: amountIn.toString(), slippage, user };
    let quote;
    try {
      // Most of this pool's liquidity is yours: once removed, the swap must go another way.
      if (avoidPool) {
        quote = await getDclQuote({ ...params, excludePools: [pool.pool_id] });
        quote.priceImpact = await measurePriceImpact(quote, params).catch(() => null);
      } else {
        quote = oneStep(await getSwapQuote(params));
      }
    } catch {
      throw new Error(
        avoidPool
          ? `Your liquidity is most of this pool, and there is no other route to swap ${sellToken.symbol} into ${outToken.symbol} right now. Remove as both tokens instead.`
          : `No route to swap ${sellToken.symbol} into ${outToken.symbol} right now. Try again shortly or remove as both tokens.`
      );
    }
    // In a CLMM pool the final price moves about twice the average impact.
    const move = Number.isFinite(quote.priceImpact) ? quote.priceImpact * 2 : 0;
    if (move > slippage) {
      throw new Error(
        `Swapping your ${sellToken.symbol} moves the price about ${move.toFixed(2)}% — more than your ${slippage}% slippage. Raise slippage, remove less, or remove as both tokens.`
      );
    }
    swap = { tokenIn: sellToken, tokenOut: outToken, amountIn: amountIn.toString(), quote, avoidsPool: avoidPool };
  }

  const keep = got[keepSide];
  return {
    pool,
    positions: now,
    percent,
    keepToken,
    outToken,
    sellToken,
    swap,
    // wNEAR kept on the chosen side, unwrapped to native NEAR (the guaranteed part).
    unwrap: native ? keep.min : 0n,
    receiveMin: keep.min + toBigInt(swap?.quote.minAmountOut || '0'),
    receiveEst: keep.est + toBigInt(swap?.quote.amountOut || '0'),
    fees: { x: afterTax(feeX, taxX.out), y: afterTax(feeY, taxY.out) },
    taxed: Boolean(taxX.out || taxY.out),
    poolShare,
    user: user || null,
    fetchedAt: Date.now()
  };
}

/** Remove → swap → unwrap, in one wallet request. */
export async function buildZapOutTransactions({ zap, slippage, accountId }) {
  if (zap.user !== accountId) throw new Error('This quote is for another account. Refresh and try again.');
  const txs = await buildDclRemoveTransactions({ positions: zap.positions, percent: zap.percent, slippage, accountId });
  if (zap.swap) {
    const { tokenIn, tokenOut, quote } = zap.swap;
    txs.push(...(await buildSwapTransactions({ tokenIn, tokenOut, quote, accountId })));
  }
  if (zap.unwrap > 0n) {
    txs.push(transaction(CONTRACTS.wrapNear, [functionCall('near_withdraw', { amount: zap.unwrap.toString() }, GAS.nearDeposit, DEPOSIT.oneYocto)]));
  }
  return txs;
}
