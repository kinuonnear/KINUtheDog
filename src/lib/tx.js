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

// A registration practically never goes away, so a "registered" answer is reused for a while
// (unregistered ones are always asked again: they are about to change).
const REGISTERED_TTL_MS = 10 * 60_000;
const registered = new Map(); // "token|account" -> timestamp

/** Whether `accountId` is registered (NEP-145) on a token contract. */
export async function isStorageRegistered(tokenContract, accountId) {
  const key = `${tokenContract}|${accountId}`;
  if (Date.now() - (registered.get(key) || 0) < REGISTERED_TTL_MS) return true;
  try {
    const balance = await view(tokenContract, 'storage_balance_of', { account_id: accountId }, { fresh: true });
    const ok = balance !== null && balance !== undefined;
    if (ok) registered.set(key, Date.now());
    return ok;
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

/**
 * NEAR to wrap so the wallet holds `amount` (raw) of wNEAR, from its on-chain wNEAR balance read
 * right now — the page's balances can be a refresh behind (e.g. just after a wrap). Raw string.
 */
export async function wrapNeededFor(accountId, amount, fallbackBalance = '0', heldNow = null) {
  const need = BigInt(amount || '0');
  if (need <= 0n) return '0';
  const held = BigInt((heldNow ?? (await wNearBalance(accountId, fallbackBalance))) || '0');
  return need > held ? (need - held).toString() : '0';
}

/** The wallet's wNEAR balance read right now (raw string); `fallback` when the read fails. */
export async function wNearBalance(accountId, fallback = '0') {
  try {
    return String((await view(CONTRACTS.wrapNear, 'ft_balance_of', { account_id: accountId }, { fresh: true })) || '0');
  } catch {
    return String(fallback || '0');
  }
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
