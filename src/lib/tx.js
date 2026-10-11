// Transaction building helpers shared by swap and liquidity flows.
// Transactions are plain descriptors; the wallet module converts and signs them.

import { CONTRACTS, DEPOSIT, GAS } from '../config.js';
import { view } from './rpc.js';

export function functionCall(methodName, args, gas, deposit = '0') {
  return { type: 'FunctionCall', params: { methodName, args, gas, deposit } };
}

export function transaction(receiverId, actions) {
  return { receiverId, actions };
}

/** Whether `accountId` is registered (NEP-145) on a token contract. */
export async function isStorageRegistered(tokenContract, accountId) {
  try {
    const balance = await view(tokenContract, 'storage_balance_of', { account_id: accountId }, { fresh: true });
    return balance !== null && balance !== undefined;
  } catch {
    // Some legacy tokens don't implement NEP-145: treat as registered.
    return true;
  }
}

const boundsCache = new Map();

async function storageMinimum(tokenContract) {
  if (boundsCache.has(tokenContract)) return boundsCache.get(tokenContract);
  let min = DEPOSIT.ftStorageFallback;
  try {
    const bounds = await view(tokenContract, 'storage_balance_bounds');
    if (bounds?.min) min = String(bounds.min);
  } catch {
    // keep fallback
  }
  boundsCache.set(tokenContract, min);
  return min;
}

/** Storage-deposit transaction for `accountId` on `tokenContract`, or null if not needed. */
export async function ensureStorageTx(tokenContract, accountId) {
  if (await isStorageRegistered(tokenContract, accountId)) return null;
  const min = await storageMinimum(tokenContract);
  return transaction(tokenContract, [
    functionCall('storage_deposit', { account_id: accountId, registration_only: true }, GAS.storageDeposit, min)
  ]);
}

export function wrapNearTx(amount) {
  return transaction(CONTRACTS.wrapNear, [functionCall('near_deposit', {}, GAS.nearDeposit, amount)]);
}

export function ftTransferCallTx(tokenContract, receiverId, amount, msg, gas = GAS.ftTransferCall) {
  return transaction(tokenContract, [
    functionCall('ft_transfer_call', { receiver_id: receiverId, amount, msg }, gas, DEPOSIT.oneYocto)
  ]);
}

const MERGE_GAS_LIMIT = 300_000_000_000_000n;

const totalGas = (tx) => tx.actions.reduce((sum, a) => sum + BigInt(a.params.gas || 0), 0n);

/**
 * Merge consecutive transactions to the same receiver to reduce wallet
 * prompts, without letting a merged transaction exceed 300 TGas.
 */
export function mergeTransactions(transactions) {
  const merged = [];
  transactions.filter(Boolean).forEach((tx) => {
    const last = merged[merged.length - 1];
    if (last && last.receiverId === tx.receiverId && totalGas(last) + totalGas(tx) <= MERGE_GAS_LIMIT) {
      last.actions.push(...tx.actions);
    } else {
      merged.push({ receiverId: tx.receiverId, actions: [...tx.actions] });
    }
  });
  return merged;
}
