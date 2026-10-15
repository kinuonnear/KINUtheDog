// Trending on Rhea: tokens ranked by 24h volume across Rhea pools (light: one pool search),
// then enriched per token from Intear (price, 24h change, liquidity, holders).
// NEAR and stablecoins are left out — they top every list and aren't "trending".

import { CONTRACTS, KINU_TOKEN } from '../config.js';
import { searchPools } from './rhea.js';
import { getTokens } from './tokens.js';
import { fetchTokenInfo } from './intear.js';

export const BASE_TOKENS = new Set([
  CONTRACTS.wrapNear,
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // USDC
  'usdt.tether-token.near',
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near', // USDC.e
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near', // USDT.e
  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near' // DAI
]);

/** Price / 24h change / liquidity / holders for token ids, with metadata. */
export async function enrichTokens(ids) {
  const meta = await getTokens(ids);
  const infos = await Promise.all(ids.map((id) => fetchTokenInfo(id).catch(() => null)));
  return ids.map((id, i) => ({
    id,
    token: meta[id] || { id, symbol: id.slice(0, 8), decimals: 0 },
    price: infos[i]?.price ?? null,
    change24h: infos[i]?.change24h ?? null,
    liquidityUsd: infos[i]?.liquidityUsd ?? null,
    volume24hUsd: infos[i]?.volume24hUsd ?? null,
    holders: infos[i]?.holders ?? null,
    createdAt: infos[i]?.createdAt ?? null,
    official: id === KINU_TOKEN
  }));
}

const SHARE_MS = 60_000; // the Discover banner and table share one fetch
const shared = new Map(); // limit -> { at, promise }

/** Top tokens by 24h Rhea pool volume (each pool's volume counts for both of its tokens). */
export function getTrending({ limit = 20 } = {}) {
  const hit = shared.get(limit);
  if (hit && Date.now() - hit.at < SHARE_MS) return hit.promise;
  const promise = loadTrending(limit);
  shared.set(limit, { at: Date.now(), promise });
  promise.catch(() => {
    if (shared.get(limit)?.promise === promise) shared.delete(limit);
  });
  return promise;
}

async function loadTrending(limit) {
  const { list } = await searchPools({ sort: 'volume_24h', limit: 60, hideLow: true });
  const volume = new Map();
  list.forEach((pool) => {
    pool.tokenIds.forEach((id) => {
      if (!BASE_TOKENS.has(id)) volume.set(id, (volume.get(id) || 0) + pool.volume24h);
    });
  });
  const ids = [...volume.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
  const rows = await enrichTokens(ids);
  return rows.map((r) => ({ ...r, rheaVolume: volume.get(r.id) }));
}
