// Platform fee (see the whitepaper, section 6). Built but switched OFF: PLATFORM_FEE.enabled
// in config.js turns it on. When on, a swap's input pays `bps` to the public treasury in the
// same wallet request; quotes are made on the remaining amount, so "You receive" already
// includes the fee. Swaps that buy or sell $KINU pay nothing, and tokens the treasury is not
// registered for are skipped (users never pay the treasury's storage).

import { CONTRACTS, KINU_TOKEN, PLATFORM_FEE, QUICK_LP_FEE } from '../config.js';
import { toBigInt } from './format.js';
import { feeAfterDiscount } from './holder.js';
import { functionCall, isStorageRegistered, transaction } from './tx.js';

const FT_TRANSFER_GAS = '10000000000000'; // 10 TGas
const registered = new Map(); // token -> Promise<boolean>

const contractOf = (token) => (token?.native ? CONTRACTS.wrapNear : token?.contract || token?.id);

function treasuryRegistered(token) {
  if (!registered.has(token)) {
    registered.set(
      token,
      isStorageRegistered(token, PLATFORM_FEE.treasury).catch(() => {
        registered.delete(token);
        return false;
      })
    );
  }
  return registered.get(token);
}

/** Fee amount (raw) taken from `gross` at `bps` (fractional bps allowed: KINU holders pay half). */
export const feeOf = (gross, bps = PLATFORM_FEE.bps) => (toBigInt(gross) * BigInt(Math.round(bps * 100))) / 1_000_000n;

/**
 * The platform fee for swapping `amountIn` (raw, gross) of tokenIn -> tokenOut, or null when
 * no fee applies: switched off, a $KINU swap, a token the treasury isn't registered for, or dust.
 * Returns { token, amount, net, bps }: `net` is what is actually swapped.
 */
export async function platformFeeFor({ tokenIn, tokenOut, amountIn }) {
  if (!PLATFORM_FEE.enabled || !PLATFORM_FEE.treasury || !(PLATFORM_FEE.bps > 0)) return null;
  if ([tokenIn, tokenOut].some((t) => contractOf(t) === KINU_TOKEN)) return null;
  const token = contractOf(tokenIn);
  const bps = feeAfterDiscount(PLATFORM_FEE.bps);
  const amount = feeOf(amountIn, bps);
  if (amount <= 0n || !(await treasuryRegistered(token))) return null;
  return { token, amount: amount.toString(), net: (toBigInt(amountIn) - amount).toString(), bps };
}

/**
 * Add the fee to swap transactions built for the net amount: wrap the fee too when paying with
 * native NEAR, and send it to the treasury right before the swap's token transfer.
 */
export function withPlatformFee(txs, fee) {
  if (!fee) return txs;
  const out = txs.map((tx) => ({ ...tx, actions: [...tx.actions] }));
  if (fee.token === CONTRACTS.wrapNear) {
    const wrap = out.find((tx) => tx.receiverId === CONTRACTS.wrapNear && tx.actions.some((a) => a.params.methodName === 'near_deposit'));
    if (wrap) {
      wrap.actions = wrap.actions.map((a) =>
        a.params.methodName === 'near_deposit'
          ? { ...a, params: { ...a.params, deposit: (toBigInt(a.params.deposit) + toBigInt(fee.amount)).toString() } }
          : a
      );
    }
  }
  const feeTx = transaction(fee.token, [
    functionCall('ft_transfer', { receiver_id: PLATFORM_FEE.treasury, amount: fee.amount, memo: 'KINU platform fee' }, FT_TRANSFER_GAS, '1')
  ]);
  let at = -1;
  out.forEach((tx, i) => {
    if (tx.receiverId === fee.token && tx.actions.some((a) => a.params.methodName === 'ft_transfer_call')) at = i;
  });
  out.splice(at >= 0 ? at : out.length, 0, feeTx);
  return out;
}

/** Short disclosure for route details, or null. */
export const feeLabel = (fee) => (fee ? `Includes ${(fee.bps / 100).toFixed(fee.bps % 10 ? 2 : 1)}% KINU fee` : null);

/* ---------------------------------------------------------------- Quick LP fee */

/**
 * Quick LP's fee on a new position (QUICK_LP_FEE), without the treasury check: `legs` are
 * { token, gross, decimals, usd } (token: the contract, wrap.near for NEAR; gross: raw amount going
 * in; usd: its price). Each leg pays bps (less for KINU holders); when they add up to more than maxUsd, all are scaled
 * down by the same share, so the deposit keeps its proportions. Legs without a price, in $KINU,
 * or rounding to nothing pay nothing. Returns [{ token, amount, net }] in the legs' order.
 */
export function quickLpFees(legs) {
  const zero = (l) => ({ token: l.token, amount: '0', net: toBigInt(l.gross).toString() });
  if (!QUICK_LP_FEE.enabled || !(QUICK_LP_FEE.bps > 0)) return legs.map(zero);
  const paying = legs.map((l) => l.token !== KINU_TOKEN && l.usd > 0 && toBigInt(l.gross) > 0n);
  // KINU holders pay the discounted rate (lib/holder.js), as on swaps; the $ cap stays the same.
  const bps = feeAfterDiscount(QUICK_LP_FEE.bps);
  const raw = legs.map((l, i) => (paying[i] ? feeOf(l.gross, bps) : 0n));
  const usd = legs.reduce((s, l, i) => s + (Number(raw[i]) / 10 ** l.decimals) * l.usd, 0);
  // Scale by a whole-number share (parts per million) so the amounts stay exact integers.
  const keep = usd > QUICK_LP_FEE.maxUsd ? BigInt(Math.floor((QUICK_LP_FEE.maxUsd / usd) * 1_000_000)) : 1_000_000n;
  return legs.map((l, i) => {
    const amount = (raw[i] * keep) / 1_000_000n;
    return { token: l.token, amount: amount.toString(), net: (toBigInt(l.gross) - amount).toString() };
  });
}

/** quickLpFees, with fees in tokens the treasury can't receive dropped (users never pay its storage). */
export async function quickLpFeesFor(legs) {
  const fees = quickLpFees(legs);
  const ok = await Promise.all(fees.map((f) => (toBigInt(f.amount) > 0n ? treasuryRegistered(f.token) : false)));
  return fees.map((f, i) => (ok[i] ? f : { ...f, amount: '0', net: toBigInt(legs[i].gross).toString() }));
}

/**
 * The fee transfers, added after the position's own transactions (paid once those went through).
 * `native`: the fee is paid from wallet NEAR, wrapped in the same transaction first.
 */
export function withQuickLpFees(txs, fees, { native = false } = {}) {
  const out = [...txs];
  fees
    .filter((f) => toBigInt(f.amount) > 0n)
    .forEach((f) => {
      const transfer = functionCall('ft_transfer', { receiver_id: PLATFORM_FEE.treasury, amount: f.amount, memo: 'KINU Quick LP fee' }, FT_TRANSFER_GAS, '1');
      const wrap = native && f.token === CONTRACTS.wrapNear ? [functionCall('near_deposit', {}, FT_TRANSFER_GAS, f.amount)] : [];
      out.push(transaction(f.token, [...wrap, transfer]));
    });
  return out;
}
