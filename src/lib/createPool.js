// Creating Rhea pools — the same calls app.rhea.finance makes:
//   CLMM (DCL):  dclv2.ref-labs.near  create_pool { token_a, token_b, fee, init_point }  0.1 NEAR
//   Classic:     v2.ref-finance.near   add_simple_pool { tokens, fee }                    0.05 NEAR
// Before sending, existing pools are checked: the DCL contract allows one pool per
// pair + fee tier and panics with "E405: pool already exist" otherwise.

import { CONTRACTS } from '../config.js';
import { view } from './rpc.js';
import { searchPools } from './rhea.js';
import { ensureStorageTx, functionCall, transaction } from './tx.js';
import { POINT_MAX, POINT_MIN, priceToPoint } from './dclLiquidity.js';

/** CLMM fee tiers (contract units: 1e-6, so 2000 = 0.2%). */
export const DCL_FEE_TIERS = [
  { fee: 100, label: '0.01%', hint: 'Stable pairs' },
  { fee: 400, label: '0.04%', hint: 'Correlated pairs' },
  { fee: 2000, label: '0.2%', hint: 'Most pairs' },
  { fee: 10000, label: '1%', hint: 'Volatile / new tokens' }
];

/** Classic pool fee presets (basis points). */
export const CLASSIC_FEES = [
  { bps: 5, label: '0.05%' },
  { bps: 20, label: '0.2%' },
  { bps: 30, label: '0.3%' },
  { bps: 100, label: '1%' }
];

export const CREATE_DEPOSIT = {
  dcl: '100000000000000000000000', // 0.1 NEAR
  classic: '50000000000000000000000' // 0.05 NEAR
};

const CREATE_GAS = '180000000000000';
const CLASSIC_GAS = '30000000000000';

/** The contract orders a CLMM pool's tokens alphabetically: `x|y|fee`. */
export function sortedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

export function dclPoolId(a, b, fee) {
  return `${sortedPair(a, b).join('|')}|${fee}`;
}

/**
 * Existing CLMM pools for a pair: [{ fee, label, pool | null, tvl }].
 * get_pool returns null for a pool that doesn't exist; an RPC failure throws, so a failed
 * check is never mistaken for "not created" (TVL is only decoration and may be missing).
 */
export async function getDclPoolsForPair(tokenA, tokenB) {
  const [{ list }, pools] = await Promise.all([
    searchPools({ type: 'dcl', tokenList: tokenA, hideLow: false, limit: 100 }).catch(() => ({ list: [] })),
    Promise.all(DCL_FEE_TIERS.map((t) => view(CONTRACTS.dcl, 'get_pool', { pool_id: dclPoolId(tokenA, tokenB, t.fee) })))
  ]);
  const tvlById = new Map(list.map((p) => [p.id, p.tvl]));
  return DCL_FEE_TIERS.map((tier, i) => {
    const pool = pools[i];
    return { ...tier, pool, tvl: pool ? tvlById.get(pool.pool_id) ?? null : null };
  });
}

/** Classic pools already holding exactly this pair: [{ id, feePercent, tvl }]. */
export async function getClassicPoolsForPair(tokenA, tokenB) {
  const { list } = await searchPools({ type: 'classic', tokenList: tokenA, hideLow: false, limit: 100 }).catch(() => ({ list: [] }));
  return list
    .filter((p) => !p.isDcl && p.tokenIds.length === 2 && p.tokenIds.includes(tokenA) && p.tokenIds.includes(tokenB))
    .map((p) => ({ id: p.id, feePercent: p.feePercent, tvl: p.tvl }));
}

/**
 * Initial point for a new CLMM pool. `price` is "1 tokenA = price tokenB" in human units;
 * the point is expressed for the sorted pair (token X = alphabetically first).
 * null when the price is outside what the contract can represent (it would reject it).
 */
export function initPointFor({ tokenA, tokenB, price }) {
  const [x] = sortedPair(tokenA.id, tokenB.id);
  const aIsX = tokenA.id === x;
  const priceYperX = aIsX ? price : 1 / price;
  const [decX, decY] = aIsX ? [tokenA.decimals, tokenB.decimals] : [tokenB.decimals, tokenA.decimals];
  const point = Math.round(priceToPoint(priceYperX, decX, decY));
  return Number.isFinite(point) && point >= POINT_MIN && point <= POINT_MAX ? point : null;
}

/** Rhea's contract must be able to receive both tokens, and so must the user. */
async function storageFor(tokens, contract, accountId) {
  const txs = [];
  for (const token of tokens) {
    txs.push(await ensureStorageTx(token, accountId));
    txs.push(await ensureStorageTx(token, contract));
  }
  return txs.filter(Boolean);
}

export async function buildCreateDclPoolTransactions({ tokenA, tokenB, fee, initPoint, accountId }) {
  const [x, y] = sortedPair(tokenA, tokenB);
  return [
    ...(await storageFor([x, y], CONTRACTS.dcl, accountId)),
    transaction(CONTRACTS.dcl, [functionCall('create_pool', { token_a: x, token_b: y, fee, init_point: initPoint }, CREATE_GAS, CREATE_DEPOSIT.dcl)])
  ];
}

export async function buildCreateClassicPoolTransactions({ tokenA, tokenB, feeBps, accountId }) {
  return [
    ...(await storageFor([tokenA, tokenB], CONTRACTS.exchange, accountId)),
    transaction(CONTRACTS.exchange, [functionCall('add_simple_pool', { tokens: [tokenA, tokenB], fee: feeBps }, CLASSIC_GAS, CREATE_DEPOSIT.classic)])
  ];
}

/** Pool id returned by add_simple_pool, read from the wallet's execution outcome (null when unknown). */
export function createdClassicPoolId(outcomes) {
  for (const outcome of [...(outcomes || [])].reverse()) {
    const value = outcome?.status?.SuccessValue;
    if (!value) continue;
    try {
      const id = JSON.parse(atob(value));
      if (Number.isInteger(id)) return String(id);
    } catch {
      // not the pool id
    }
  }
  return null;
}
