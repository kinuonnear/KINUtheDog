// Zap Out: remove CLMM liquidity and receive ONE token, in one wallet request:
//   1. remove `percent` of the positions — both tokens and ALL unclaimed fees reach the wallet
//      (Rhea settles a position's fees whenever its liquidity changes);
//   2. swap the other token (liquidity share + its fees) into the chosen one;
//   3. a kept wNEAR side already arrives as native NEAR (the contract unwraps it since 2026-10-01).
// The swap spends only what is guaranteed to arrive: the removal's slippage minimums plus the
// fees, after a taxed token's tax on the way out (lib/tokenTax.js). Any extra stays in the wallet.

import { CONTRACTS, NATIVE_NEAR } from '../config.js';
import { buildDclRemoveTransactions, freshPool, positionsAtPoint, removeMinsInBand } from './dclLiquidity.js';
import { getDclQuote } from './dclRouter.js';
import { oneStep } from './rebalance.js';
import { buildSwapTransactions, getSwapQuote, measurePriceImpact } from './swap.js';
import { afterTax, dclTax, getTokenTax, taxBps } from './tokenTax.js';
import { ensureStorageTx, wrapNearTx } from './tx.js';
import { applySlippage, toBigInt } from './format.js';
import { amountsForShares, buildRemoveLiquidityTransactions, isStableKind, predictRemoveAmounts } from './liquidity.js';
import { routesThrough } from './zap.js';

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
    // Sold wNEAR must be wrapped again first: the contract pays wNEAR out as native NEAR (since its
    // 2026-10-01 upgrade), which is also how a kept wNEAR side already reaches the wallet.
    rewrap: sellToken.id === CONTRACTS.wrapNear ? amountIn : 0n,
    receiveMin: keep.min + toBigInt(swap?.quote.minAmountOut || '0'),
    receiveEst: keep.est + toBigInt(swap?.quote.amountOut || '0'),
    fees: { x: afterTax(feeX, taxX.out), y: afterTax(feeY, taxY.out) },
    taxed: Boolean(taxX.out || taxY.out),
    poolShare,
    user: user || null,
    fetchedAt: Date.now()
  };
}

/** Remove → (re-wrap sold NEAR) → swap, in one wallet request. */
export async function buildZapOutTransactions({ zap, slippage, accountId }) {
  if (zap.user !== accountId) throw new Error('This quote is for another account. Refresh and try again.');
  const txs = await buildDclRemoveTransactions({ positions: zap.positions, percent: zap.percent, slippage, accountId });
  if (zap.rewrap > 0n) {
    txs.push(await ensureStorageTx(CONTRACTS.wrapNear, accountId));
    txs.push(wrapNearTx(zap.rewrap.toString()));
  }
  if (zap.swap) {
    const { tokenIn, tokenOut, quote } = zap.swap;
    txs.push(...(await buildSwapTransactions({ tokenIn, tokenOut, quote, accountId })));
  }
  return txs.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Zap out of a classic / stable / ALMM pool (two tokens)              */
/* ------------------------------------------------------------------ */

/**
 * Quote removing `shares` of a two-token classic, stable or ALMM pool and receiving only side
 * `target` (0 | 1, in pool.tokenIds order). The removal pays both tokens to the wallet (a wNEAR
 * side as native NEAR); the other side is swapped from its guaranteed minimum (slippage, then any
 * tax on the way out of Rhea's exchange). Any extra stays in the wallet.
 * @param pool    pool from getPool()
 * @param tokens  the pool's tokens, in pool.tokenIds order
 */
export async function quoteClassicZapOut({ pool, tokens, shares, target, slippage, user }) {
  if (pool.tokenIds.length !== 2) throw new Error('Zap out works with two-token pools.');
  if (toBigInt(shares) <= 0n) throw new Error('Choose how much to remove.');
  const expected = isStableKind(pool.kind) ? await predictRemoveAmounts(pool.id, shares) : amountsForShares(pool, shares);
  const taxes = await Promise.all(pool.tokenIds.map((id) => getTokenTax(id)));
  const outBps = (i) => taxBps(taxes[i], { from: CONTRACTS.exchange, to: '' });
  const got = (i) => ({
    min: afterTax(toBigInt(applySlippage(expected[i], slippage)), outBps(i)),
    est: afterTax(toBigInt(expected[i]), outBps(i))
  });

  const keepIndex = target === 1 ? 1 : 0;
  const sellIndex = 1 - keepIndex;
  // wNEAR leaves the exchange as native NEAR: both the kept side and a sold side are NEAR.
  const asWallet = (t) => (t.id === CONTRACTS.wrapNear ? NATIVE_NEAR : t);
  const outToken = asWallet(tokens[keepIndex]);
  const sellToken = asWallet(tokens[sellIndex]);

  let swap = null;
  const amountIn = got(sellIndex).min;
  if (amountIn > 0n) {
    const params = { tokenIn: sellToken, tokenOut: outToken, amountIn: amountIn.toString(), slippage, user };
    let quote;
    try {
      quote = oneStep(await getSwapQuote(params));
    } catch {
      throw new Error(`No route to swap ${sellToken.symbol} into ${outToken.symbol} right now. Try again shortly or withdraw both tokens.`);
    }
    // A swap back through this same pool moves its price (about twice the average impact).
    if (routesThrough(quote, `${pool.tokenIds[0]}|${pool.tokenIds[1]}`)) {
      const impact = Number.isFinite(quote.priceImpact) ? quote.priceImpact : await measurePriceImpact(quote, params).catch(() => null);
      const move = Number.isFinite(impact) ? impact * 2 : 0;
      if (move > slippage) {
        throw new Error(
          `Swapping your ${sellToken.symbol} moves the price about ${move.toFixed(2)}% — more than your ${slippage}% slippage. Raise slippage, remove less, or withdraw both tokens.`
        );
      }
    }
    swap = { tokenIn: sellToken, tokenOut: outToken, amountIn: amountIn.toString(), quote };
  }

  const keep = got(keepIndex);
  return {
    pool,
    shares: String(shares),
    expected,
    outToken,
    sellToken,
    swap,
    receiveMin: keep.min + toBigInt(swap?.quote.minAmountOut || '0'),
    receiveEst: keep.est + toBigInt(swap?.quote.amountOut || '0'),
    user: user || null,
    fetchedAt: Date.now()
  };
}

/** Remove (both tokens to the wallet) → swap the other side, in one wallet request. */
export async function buildClassicZapOutTransactions({ zap, slippage, accountId }) {
  if (zap.user !== accountId) throw new Error('This quote is for another account. Refresh and try again.');
  const txs = await buildRemoveLiquidityTransactions({
    pool: zap.pool,
    shares: zap.shares,
    accountId,
    slippage,
    expectedAmounts: zap.expected
  });
  if (zap.swap) {
    const { tokenIn, tokenOut, quote } = zap.swap;
    txs.push(...(await buildSwapTransactions({ tokenIn, tokenOut, quote, accountId })));
  }
  return txs.filter(Boolean);
}
