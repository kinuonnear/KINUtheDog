// KINU Holder: tiers by the $ value of $KINU in the wallet at the live price (HOLDER.tiers: $10 → 10%
// off KINU's fees, $20 → 25%, $100 → 50%, $500 → 75%; KINU in LP positions doesn't count). Holders
// get the ★ badge and, with HOLDER.perks.feeDiscount, their tier's share off KINU's swap and Quick LP
// fees. Nothing is locked or staked: the tier follows the balance and the price. A wallet keeps the
// tier it reached through a price drop of up to HOLDER.grace (35%) while it still holds that KINU.

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
export const TIERS = HOLDER.tiers.map(([minUsd, off]) => ({ minUsd, off })).sort((a, b) => a.minUsd - b.minUsd);

/** The highest tier whose bar (times `factor`) `usd` reaches, or -1. */
const tierAt = (usd, factor = 1) => TIERS.reduce((t, tier, i) => (usd >= tier.minUsd * factor ? i : t), -1);

/**
 * { amount, usd, price, tier, off, isHolder, full, grace, next, missingUsd } for a wallet's
 * balances. `qualified`: { amount, tier } the wallet held when it last reached a tier (remembered
 * per wallet, see state.jsx). `next`: the tier above, with missingUsd to reach it.
 */
export function holderStatus(balances, prices, qualified = { amount: 0, tier: -1 }) {
  const raw = balances?.[KINU_TOKEN];
  const amount = raw ? toNumber(raw, KINU_DECIMALS) : 0;
  const price = priceOf(prices, KINU_TOKEN);
  const usd = amount * price;
  const fullTier = price > 0 ? tierAt(usd) : -1;
  // The tier reached before holds down to (1 - grace) of its bar, as long as that KINU wasn't sold.
  const kept = price > 0 && qualified.amount > 0 && amount >= qualified.amount * KEPT;
  const tier = Math.max(fullTier, kept ? Math.min(qualified.tier, tierAt(usd, 1 - HOLDER.grace)) : -1);
  const next = TIERS[tier + 1] || null;
  return {
    amount,
    usd,
    price,
    tier,
    off: tier >= 0 ? TIERS[tier].off : 0,
    isHolder: tier >= 0,
    full: tier >= 0 && tier === fullTier,
    grace: tier > fullTier,
    next,
    missingUsd: next ? Math.max(0, next.minUsd - usd) : 0
  };
}

const QUALIFIED_KEY = 'kinu.holder.';
/** { amount, tier } remembered for a wallet ("amount|tier"; an older plain amount was the $20 tier). */
export function readQualified(accountId) {
  try {
    const [amount, tier] = String(localStorage.getItem(QUALIFIED_KEY + accountId) || '').split('|');
    const kinu = Number(amount) || 0;
    return { amount: kinu, tier: kinu > 0 ? (tier === undefined ? 1 : Number(tier)) : -1 };
  } catch {
    return { amount: 0, tier: -1 };
  }
}
export function writeQualified(accountId, amount, tier = -1) {
  try {
    localStorage.setItem(QUALIFIED_KEY + accountId, amount > 0 ? `${amount}|${tier}` : '0');
  } catch {
    /* storage blocked: no grace after a reload */
  }
}

// The connected wallet's share off, for the fee code, which runs outside React (set by state.jsx).
let holderOff = 0;
export const setHolderNow = (off) => {
  holderOff = Number(off) > 0 ? Number(off) : 0;
};
export const isHolderNow = () => holderOff > 0;

/** A KINU fee in bps after the connected wallet's holder discount. */
export const feeAfterDiscount = (bps) => (holderOff > 0 && HOLDER.enabled && HOLDER.perks.feeDiscount ? bps * (1 - holderOff) : bps);
