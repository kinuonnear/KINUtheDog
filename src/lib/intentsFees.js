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
