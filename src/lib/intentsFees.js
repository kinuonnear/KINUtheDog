// KINU's fee on Bridge transfers (NEAR Intents 1Click `appFees`), shared by the page (to show it) and
// api/intents-quote.js (which sets it on every quote, so the browser can't change it). 1Click splits
// the fee 50/50 with KINU: at 40 bps the user pays 0.40% in all, 0.20% to KINU's treasury.
// Stablecoin pairs and the same asset across chains (where 1Click's own share is 1 bp) pay 20 bps.

export const KINU_FEE_RECIPIENT = 'kinu-treasury.near';
export const KINU_FEE_BPS = 40;
export const KINU_FEE_STABLE_BPS = 20;

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDT0', 'USDCE', 'USDTE']);
// Wrapped forms count as the asset itself (wNEAR on NEAR is NEAR elsewhere).
const BASE = { WNEAR: 'NEAR', WETH: 'ETH', WBTC: 'BTC', CBBTC: 'BTC', XBTC: 'BTC' };

const norm = (symbol) => {
  const s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return BASE[s] || s;
};

/** The fee in basis points for a transfer of `fromSymbol` arriving as `toSymbol`. */
export function kinuFeeBps(fromSymbol, toSymbol) {
  const a = norm(fromSymbol);
  const b = norm(toSymbol);
  return (STABLES.has(a) && STABLES.has(b)) || (a && a === b) ? KINU_FEE_STABLE_BPS : KINU_FEE_BPS;
}

/** "0.40%" */
export const feePercent = (bps) => `${(bps / 100).toFixed(2)}%`;

// Earn (lib/earn.js): KINU's fee on moving into and out of a yield vault through 1Click. Below 40 bps,
// 1Click keeps its 20 bps and KINU gets half of the fee asked: at 20 bps the user pays 0.30% each way,
// 0.10% to KINU's treasury.
export const EARN_FEE_BPS = 20;
/** The vault share tokens Earn deposits into (1Click asset ids); kept here so the server knows them. */
export const EARN_RECEIPT_ASSETS = new Set([
  'nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near', // Gauntlet USDC Prime (Morpho, Base)
  'nep141:sol-0xa69aa1bcb03a369e338156a8718ad60271145803.omdep.near' // Kamino SOL Balanced (Solana)
]);
export const isEarnAsset = (assetId) => EARN_RECEIPT_ASSETS.has(assetId);

/** The `appFees` fee (bps) for a quote: Earn's when either side is a vault share, otherwise the Bridge's. */
export function quoteFeeBps(originAsset, destinationAsset, symbolOf) {
  if (isEarnAsset(originAsset) || isEarnAsset(destinationAsset)) return EARN_FEE_BPS;
  return kinuFeeBps(symbolOf(originAsset), symbolOf(destinationAsset));
}

/** What the user pays in all for a fee asked of 1Click (1Click keeps at least 20 bps; KINU gets half). */
export const totalFeeBps = (bps) => (bps >= 40 ? bps : Math.ceil(bps / 2) + 20);
