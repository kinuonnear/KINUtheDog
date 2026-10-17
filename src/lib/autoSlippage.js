// Auto slippage for swaps: how far the price may move before a swap fails, picked from the pair.
// Stablecoin pairs barely move, so they get a tight limit; NEAR and the main assets a normal one;
// anything else (small caps, memes) more room, so swaps don't fail on a moving price. Taxed tokens
// are handled separately (lib/tokenTax.js). Intear's own "Auto" was checked on 2026-10-18 and gave
// ~1.7% to every pair, stablecoins included, so KINU uses these rules instead.

const STABLES = new Set([
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // USDC
  'usdt.tether-token.near', // USDT
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near', // USDC.e
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near', // USDT.e
  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near' // DAI
]);

const MAJORS = new Set([
  ...STABLES,
  'near',
  'wrap.near',
  'aurora', // ETH
  '2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near', // WBTC
  'linear-protocol.near',
  'meta-pool.near',
  'token.rhealab.near'
]);

export const AUTO_SLIPPAGE = { stable: 0.2, major: 0.5, other: 1 };

const idOf = (token) => (token?.native ? 'near' : token?.id || token?.contract || '');

/** Max slippage (percent) for swapping tokenIn → tokenOut. */
export function autoSlippageFor(tokenIn, tokenOut) {
  const a = idOf(tokenIn);
  const b = idOf(tokenOut);
  if (STABLES.has(a) && STABLES.has(b)) return AUTO_SLIPPAGE.stable;
  if (MAJORS.has(a) && MAJORS.has(b)) return AUTO_SLIPPAGE.major;
  return AUTO_SLIPPAGE.other;
}
