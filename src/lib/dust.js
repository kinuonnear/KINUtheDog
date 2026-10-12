// Dust sweeper: swap many small token balances into NEAR or USDC in one wallet request.
// Quotes are fetched one at a time (SmartRouter rate-limits bursts); tokens without a route
// are skipped. $KINU, NEAR / wNEAR and the target token are never swept.

import { CONTRACTS, KINU_TOKEN, NATIVE_NEAR } from '../config.js';
import { buildSwapTransactions, getSwapQuote } from './swap.js';

export const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const DUST_TARGETS = [
  { key: 'near', label: 'NEAR' },
  { key: USDC, label: 'USDC' }
];
export const DUST_LIMITS = [0.1, 1, 5];
export const MAX_SWEEP = 10;
const QUOTE_GAP_MS = 1100;

const NEVER = new Set([NATIVE_NEAR.id, CONTRACTS.wrapNear, KINU_TOKEN]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wallet rows (from the portfolio) that count as dust for this target and limit. */
export function dustRows(rows, { target, limitUsd }) {
  return rows
    .filter((r) => r.usd > 0 && r.usd < limitUsd && r.raw && r.raw !== '0')
    .filter((r) => !NEVER.has(r.id) && r.id !== target)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, MAX_SWEEP);
}

/**
 * Quote each row into the target, one after another. Returns [{ row, quote } | { row, error }].
 * onProgress(done, total) lets the UI show progress.
 */
export async function quoteDust({ rows, targetToken, slippage, user, onProgress }) {
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    try {
      const quote = await getSwapQuote({ tokenIn: row.token, tokenOut: targetToken, amountIn: row.raw, slippage, user });
      out.push({ row, quote });
    } catch (error) {
      out.push({ row, error: error.message || 'No route' });
    }
    onProgress?.(i + 1, rows.length);
    if (i < rows.length - 1) await wait(QUOTE_GAP_MS);
  }
  return out;
}

/** All swaps for the quoted rows, in one list for a single wallet request. */
export async function buildDustTransactions({ items, targetToken, accountId }) {
  const txs = [];
  const seen = new Set();
  for (const { row, quote } of items) {
    for (const tx of await buildSwapTransactions({ tokenIn: row.token, tokenOut: targetToken, quote, accountId })) {
      // Every swap registers storage it needs; in a batch the same registration repeats.
      const setup = tx.actions.every((a) => ['storage_deposit', 'tokens_storage_deposit'].includes(a.params.methodName));
      const key = setup ? JSON.stringify([tx.receiverId, tx.actions.map((a) => [a.params.methodName, a.params.args])]) : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      txs.push(tx);
    }
  }
  if (!txs.length) throw new Error('Nothing to sweep.');
  return txs;
}
