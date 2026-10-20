// KINU Holder: a wallet holding at least HOLDER.minUsd of $KINU at the live price (wallet balance
// only; KINU in LP positions doesn't count). Holders get the ★ badge; with HOLDER.perks on they also
// pay HOLDER.feeShare of KINU's swap fee and see
// the full Pool Analysis. Nothing is locked or staked:
// the status follows the balance and the price. A wallet that qualified keeps the status through a
// price drop of up to HOLDER.grace (35%: $13 at a $20 bar) while it still holds the KINU it had then.

import { HOLDER, KINU_TOKEN } from '../config.js';
import { toNumber } from './format.js';
import { priceOf } from './tokens.js';

const KINU_DECIMALS = 18;

// Transfers of taxed KINU can arrive ~1% short: "still holds" allows for that.
const KEPT = 0.98;

/**
 * { amount, usd, price, isHolder, grace, missingUsd } for a wallet's balances. `qualifiedAmount`:
 * the KINU the wallet held when it last met the $ bar (remembered per wallet, see state.jsx).
 */
export function holderStatus(balances, prices, qualifiedAmount = 0) {
  const raw = balances?.[KINU_TOKEN];
  const amount = raw ? toNumber(raw, KINU_DECIMALS) : 0;
  const price = priceOf(prices, KINU_TOKEN);
  const usd = amount * price;
  const full = price > 0 && usd >= HOLDER.minUsd;
  const grace = !full && price > 0 && qualifiedAmount > 0 && amount >= qualifiedAmount * KEPT && usd >= HOLDER.minUsd * (1 - HOLDER.grace);
  const isHolder = full || grace;
  return { amount, usd, price, isHolder, full, grace, missingUsd: isHolder ? 0 : Math.max(0, HOLDER.minUsd - usd) };
}

const QUALIFIED_KEY = 'kinu.holder.';
export function readQualified(accountId) {
  try {
    return Number(localStorage.getItem(QUALIFIED_KEY + accountId)) || 0;
  } catch {
    return 0;
  }
}
export function writeQualified(accountId, amount) {
  try {
    localStorage.setItem(QUALIFIED_KEY + accountId, String(amount));
  } catch {
    /* storage blocked: no grace after a reload */
  }
}

// The connected wallet's status for the fee code, which runs outside React (set by state.jsx).
let holderNow = false;
export const setHolderNow = (on) => {
  holderNow = Boolean(on);
};
export const isHolderNow = () => holderNow;

/** KINU's swap fee in bps after the holder discount. */
export const feeAfterDiscount = (bps) => (holderNow && HOLDER.perks.feeDiscount ? bps * HOLDER.feeShare : bps);
