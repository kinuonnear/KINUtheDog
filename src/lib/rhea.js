// Rhea Finance data layer.
//   Pool lists / TVL / volume / APY  -> api.rhea.finance/pool/search (same API as app.rhea.finance)
//   Live pool state                  -> v2.ref-finance.near / dclv2.ref-labs.near view calls
//   User positions                   -> exchange shares, boost-farm seeds, DCL liquidities, deposits

import { CONTRACTS, ENDPOINTS } from '../config.js';
import { view } from './rpc.js';
import { toBigInt } from './format.js';

// Pool categories exactly as app.rhea.finance names them.
// `type` / `labels` are the pool-search API parameters for each tab.
export const POOL_TYPES = [
  { key: 'all', label: 'All pools', type: 'all', hint: 'Every Rhea pool on NEAR.' },
  {
    key: 'amm',
    label: 'AMM',
    type: 'classic',
    hint: 'Classic x·y=k pools. Liquidity spreads across all prices; deposit both tokens at the pool ratio.'
  },
  {
    key: 'clmm',
    label: 'CLMM',
    type: 'dcl',
    hint: 'Concentrated liquidity. Choose a price range to earn more fees while the price stays inside it.'
  },
  {
    key: 'almm',
    label: 'ALMM',
    type: 'degen',
    hint: 'Oracle-guided adaptive pools for volatile pairs. Deposit one or both tokens in any ratio.'
  },
  {
    key: 'stable',
    label: 'Stable',
    type: 'stable',
    hint: 'Low-slippage pools for pegged assets (stablecoins, liquid-staked NEAR). Any ratio is accepted.'
  },
  {
    key: 'farm',
    label: 'Farm',
    type: 'all',
    labels: 'farm',
    hint: 'Pools with active Rhea farm rewards on top of trading fees.'
  }
];


export function poolKindLabel(kind) {
  switch (kind) {
    case 'SIMPLE_POOL':
      return 'AMM';
    case 'STABLE_SWAP':
    case 'RATED_SWAP':
      return 'Stable';
    case 'DEGEN_SWAP':
      return 'ALMM';
    case 'DCL':
      return 'CLMM';
    default:
      return kind || 'Unknown';
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSearchPool(raw) {
  const kind = raw.pool_kind;
  return {
    id: String(raw.id),
    kind,
    label: poolKindLabel(kind),
    isDcl: kind === 'DCL',
    tokenIds: raw.token_account_ids || [],
    symbols: raw.token_symbols || [],
    amounts: (raw.amounts || []).map(String),
    sharesTotalSupply: raw.shares_total_supply || '0',
    tvl: num(raw.tvl),
    volume24h: num(raw.volume_24h),
    feeVolume24h: num(raw.fee_volume_24h),
    apy: num(raw.apy),
    farmApy: num(raw.farm_apy),
    isFarm: Boolean(raw.is_farm),
    feePercent: num(raw.total_fee) * 100,
    amp: raw.amp || 0
  };
}

/** Pool list exactly as Rhea's own Pools page queries it. */
export async function searchPools({
  type = 'all',
  sort = 'tvl',
  order = 'desc',
  limit = 20,
  offset = 0,
  hideLow = true,
  tokenList = '',
  poolIds = '',
  labels = ''
} = {}) {
  const params = new URLSearchParams({
    type,
    // The API names the 24h-volume sort "24h" (as app.rhea.finance does).
    sort: sort === 'volume_24h' ? '24h' : sort,
    limit: String(limit),
    offset: String(offset),
    hide_low_pool: String(hideLow),
    hide_uncertified_token: 'false',
    order_by: order,
    labels,
    token_type: '',
    token_list: tokenList,
    pool_id_list: poolIds
  });
  const response = await fetch(`${ENDPOINTS.rheaApi}/pool/search?${params}`);
  if (!response.ok) throw new Error(`Rhea pool API HTTP ${response.status}`);
  const json = await response.json();
  if (json.code !== 0) throw new Error(json.msg || 'Rhea pool API error');
  return {
    list: (json.data?.list || []).map(normalizeSearchPool),
    total: Number(json.data?.total || 0)
  };
}

/** Market stats (TVL/volume/APY) for a single pool id; null when unknown. */
export async function getPoolStats(poolId) {
  try {
    const { list } = await searchPools({ poolIds: String(poolId), hideLow: false, limit: 1 });
    return list.find((p) => p.id === String(poolId)) || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Classic / stable pools (v2.ref-finance.near)                        */
/* ------------------------------------------------------------------ */

export async function getPool(poolId) {
  const raw = await view(CONTRACTS.exchange, 'get_pool', { pool_id: Number(poolId) }, { fresh: true });
  if (!raw) throw new Error(`Pool #${poolId} not found`);
  return {
    id: String(poolId),
    kind: raw.pool_kind,
    label: poolKindLabel(raw.pool_kind),
    tokenIds: raw.token_account_ids || [],
    amounts: (raw.amounts || []).map(String),
    feeBps: Number(raw.total_fee || 0),
    feePercent: Number(raw.total_fee || 0) / 100,
    sharesTotalSupply: String(raw.shares_total_supply || '0'),
    amp: raw.amp || 0
  };
}

export async function getPoolShares(poolId, accountId) {
  const shares = await view(
    CONTRACTS.exchange,
    'get_pool_shares',
    { pool_id: Number(poolId), account_id: accountId },
    { fresh: true }
  );
  return String(shares ?? '0');
}

/** Tokens the user holds inside the Rhea exchange (e.g. after a partial withdraw). */
export async function getDeposits(accountId) {
  const deposits = (await view(CONTRACTS.exchange, 'get_deposits', { account_id: accountId }, { fresh: true })) || {};
  return Object.fromEntries(Object.entries(deposits).filter(([, amount]) => toBigInt(amount) > 0n));
}

/** Exchange "lost & found": tokens a withdrawal couldn't deliver (e.g. no storage on the token). */
export async function getLostFound(accountId) {
  const tokens = (await view(CONTRACTS.exchange, 'list_lostfound_tokens', { account_id: accountId }, { fresh: true })) || {};
  return Object.fromEntries(Object.entries(tokens).filter(([, amount]) => toBigInt(amount) > 0n));
}

/**
 * Balances held for the account by the swap aggregator (aggregatedex.near). A swap normally
 * pays out in the same transaction; a balance here means that final transfer failed.
 */
export async function getAggregatorBalances(accountId) {
  const out = {};
  const PAGE = 100;
  for (let from = 0; from < 1000; from += PAGE) {
    const [tokens = [], amounts = []] =
      (await view(CONTRACTS.aggregator, 'query_user_exist_balance', { user: accountId, from_index: from, count: PAGE }, { fresh: true })) || [];
    tokens.forEach((token, i) => {
      if (toBigInt(amounts[i] || '0') > 0n) out[token] = String(amounts[i]);
    });
    if (tokens.length < PAGE) break;
  }
  return out;
}

export async function getExchangeStorage(accountId) {
  return view(CONTRACTS.exchange, 'get_user_storage_state', { account_id: accountId }, { fresh: true });
}

/** Boost-farm staked LP shares: { [poolId]: rawShares }. */
export async function getFarmStakes(accountId) {
  try {
    const seeds = (await view(CONTRACTS.boostFarm, 'list_farmer_seeds', { farmer_id: accountId }, { fresh: true })) || {};
    const stakes = {};
    Object.entries(seeds).forEach(([seedId, seed]) => {
      const [contract, poolId] = seedId.split('@');
      if (contract !== CONTRACTS.exchange || !poolId || poolId.includes('|')) return;
      const total = toBigInt(seed.free_amount) + toBigInt(seed.locked_amount);
      if (total > 0n) stakes[poolId] = total.toString();
    });
    return stakes;
  } catch {
    return {};
  }
}

/**
 * Classic/stable LP positions (wallet-held + farm-staked shares).
 * The indexer lists pools the account has touched; shares are re-read on-chain.
 */
export async function getClassicPositions(accountId) {
  const [touched, stakes] = await Promise.all([
    fetch(`${ENDPOINTS.rheaIndexer}/liquidity-pools/${encodeURIComponent(accountId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
    getFarmStakes(accountId)
  ]);

  const poolIds = new Set([
    ...(Array.isArray(touched) ? touched.map((p) => String(p.id)) : []),
    ...Object.keys(stakes)
  ]);

  const positions = await Promise.all(
    [...poolIds].map(async (poolId) => {
      try {
        const [pool, shares] = await Promise.all([getPool(poolId), getPoolShares(poolId, accountId)]);
        const staked = stakes[poolId] || '0';
        const totalUser = toBigInt(shares) + toBigInt(staked);
        if (totalUser === 0n) return null;
        const supply = toBigInt(pool.sharesTotalSupply);
        const amounts = pool.amounts.map((amount) =>
          supply > 0n ? ((toBigInt(amount) * totalUser) / supply).toString() : '0'
        );
        return { pool, shares, staked, totalShares: totalUser.toString(), amounts };
      } catch {
        return null;
      }
    })
  );

  return positions.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Concentrated liquidity (dclv2.ref-labs.near)                        */
/* ------------------------------------------------------------------ */

export function parseDclPoolId(poolId) {
  const [tokenX, tokenY, fee] = String(poolId).split('|');
  return { tokenX, tokenY, fee: Number(fee || 0) };
}

// Rhea DCL (iZiSwap design) keeps liquidity on discrete points: a position over
// [left, right) holds L·sqrtP(i) of token Y and L/sqrtP(i) of token X at every point i.
// Summing those geometric series gives the closed forms below.
const SQRT_RATE = Math.sqrt(1.0001);
const sqrtPriceAt = (point) => Math.pow(SQRT_RATE, point);

/** Raw token Y held by liquidity L over points [left, right). */
export function dclAmountY(liquidity, left, right) {
  if (right <= left) return 0;
  return (Number(liquidity) * (sqrtPriceAt(right) - sqrtPriceAt(left))) / (SQRT_RATE - 1);
}

/** Raw token X held by liquidity L over points [left, right). */
export function dclAmountX(liquidity, left, right) {
  if (right <= left) return 0;
  return ((Number(liquidity) * (1 / sqrtPriceAt(left) - 1 / sqrtPriceAt(right))) * SQRT_RATE) / (SQRT_RATE - 1);
}

/** Token amounts held by a DCL position (raw units, floats). */
export function dclPositionAmounts({ liquidity, leftPoint, rightPoint, currentPoint }) {
  // Below the current point the position holds Y, from the current point upward it holds X.
  const split = Math.min(Math.max(currentPoint, leftPoint), rightPoint);
  return {
    x: dclAmountX(liquidity, split, rightPoint),
    y: dclAmountY(liquidity, leftPoint, split)
  };
}

/** Human price of token X in token Y at a DCL point. */
export function dclPointToPrice(point, decimalsX, decimalsY) {
  return Math.pow(1.0001, point) * Math.pow(10, decimalsX - decimalsY);
}

export async function getDclPositions(accountId) {
  let liquidities = [];
  try {
    liquidities = (await view(CONTRACTS.dcl, 'list_liquidities', { account_id: accountId }, { fresh: true })) || [];
  } catch {
    return [];
  }
  if (!liquidities.length) return [];

  const poolIds = [...new Set(liquidities.map((l) => l.pool_id))];
  const pools = Object.fromEntries(
    await Promise.all(
      poolIds.map(async (id) => [id, await view(CONTRACTS.dcl, 'get_pool', { pool_id: id }).catch(() => null)])
    )
  );

  return liquidities
    .map((l) => {
      const pool = pools[l.pool_id];
      if (!pool) return null;
      const { tokenX, tokenY, fee } = parseDclPoolId(l.pool_id);
      const amounts = dclPositionAmounts({
        liquidity: l.amount,
        leftPoint: l.left_point,
        rightPoint: l.right_point,
        currentPoint: pool.current_point
      });
      return {
        id: l.lpt_id,
        poolId: l.pool_id,
        liquidity: String(l.amount),
        tokenX,
        tokenY,
        feePercent: fee / 10000,
        leftPoint: l.left_point,
        rightPoint: l.right_point,
        currentPoint: pool.current_point,
        inRange: pool.current_point >= l.left_point && pool.current_point < l.right_point,
        amountX: amounts.x,
        amountY: amounts.y,
        unclaimedFeeX: l.unclaimed_fee_x || '0',
        unclaimedFeeY: l.unclaimed_fee_y || '0'
      };
    })
    .filter(Boolean);
}
