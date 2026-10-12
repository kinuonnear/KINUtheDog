// Pool radar for Discover: the most active Rhea pools (Rhea pool search, by 24h volume)
// with recent activity from GeckoTerminal, ranked two ways:
//   Hot pairs   — most traded in the last hour;
//   Best to LP  — fees earned per dollar of liquidity, next to how much the price swings.

import { searchPools } from './rhea.js';
import { fetchPoolActivity } from './gecko.js';
import { BASE_TOKENS } from './trending.js';

const CANDIDATES = 60;
export const LP_MIN_TVL = 10_000; // smaller pools: a few trades distort the yield
const LIMIT = 20;

/** The most active pools with their recent activity (activity null when Gecko has none). */
export async function getPoolRadar() {
  const { list } = await searchPools({ sort: 'volume_24h', limit: CANDIDATES, hideLow: true });
  const activity = await fetchPoolActivity(list).catch(() => ({}));
  return list.map((p) => ({ ...p, activity: activity[p.id] || null }));
}

/**
 * Most traded pools in the last hour (USD volume, or trade count). Pairs made only of NEAR
 * and stablecoins (NEAR/USDC, USDT/USDC…) always top the list, so they are left out.
 */
export function hotPairs(rows, by = 'volume') {
  const value = (r) => (by === 'trades' ? r.activity?.trades.h1 : r.activity?.volume.h1) || 0;
  return rows
    .filter((r) => value(r) > 0 && !r.tokenIds.every((id) => BASE_TOKENS.has(id)))
    .sort((a, b) => value(b) - value(a))
    .slice(0, LIMIT);
}

/** Price swing of the last 24h as a risk level for a concentrated range. */
export function swingLevel(move) {
  if (move === null || !Number.isFinite(move)) return null;
  if (move < 5) return { key: 'low', label: 'Calm' };
  if (move < 15) return { key: 'mid', label: 'Moving' };
  return { key: 'high', label: 'Volatile' };
}

/**
 * Pools ranked for liquidity providers. `yieldPct` = 24h fees / TVL (what $100 of liquidity
 * earned in a day, as a %); `move` = absolute 24h price change (%).
 * mode 'yield': highest yield first; 'balanced': yield discounted by the price swing,
 * so steady pools with good fees rise.
 */
export function bestToLp(rows, mode = 'yield') {
  const scored = rows
    .filter((r) => r.tvl >= LP_MIN_TVL && r.feeVolume24h > 0)
    .map((r) => {
      const change = r.activity?.change.h24;
      const move = change === null || change === undefined ? null : Math.abs(change);
      const yieldPct = (r.feeVolume24h / r.tvl) * 100;
      return { ...r, yieldPct, move, swing: swingLevel(move), score: yieldPct / (1 + (move ?? 10) / 10) };
    });
  const key = mode === 'balanced' ? 'score' : 'yieldPct';
  return scored.sort((a, b) => b[key] - a[key]).slice(0, LIMIT);
}
