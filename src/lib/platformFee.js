// Platform fee (see the whitepaper, section 6). Built but switched OFF: PLATFORM_FEE.enabled
// in config.js turns it on. When on, a swap's input pays `bps` to the public treasury in the
// same wallet request; quotes are made on the remaining amount, so "You receive" already
// includes the fee. Swaps that buy or sell $KINU pay nothing, and tokens the treasury is not
// registered for are skipped (users never pay the treasury's storage).

import { CONTRACTS, KINU_TOKEN, PLATFORM_FEE } from '../config.js';
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
