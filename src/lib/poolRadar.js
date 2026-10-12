// Pool radar for Discover: the most active Rhea pools (Rhea pool search, by 24h volume)
// with recent activity from GeckoTerminal, ranked two ways:
//   Hot pairs   — most traded over the last 1h / 6h / 24h;
//   Best to LP  — fees earned per dollar of liquidity, next to how much the price swings.

import { searchPools } from './rhea.js';
import { fetchPoolActivity } from './gecko.js';
import { BASE_TOKENS } from './trending.js';

const CANDIDATES = 60;
export const LP_MIN_TVL = 10_000; // smaller pools: a few trades distort the yield
const LIMIT = 20;

const SHARE_MS = 60_000; // the Discover banner and table share one fetch
let shared = null; // { at, promise }

async function loadRadar() {
  const { list } = await searchPools({ sort: 'volume_24h', limit: CANDIDATES, hideLow: true });
  const activity = await fetchPoolActivity(list).catch(() => ({}));
  return list.map((p) => ({ ...p, activity: activity[p.id] || null }));
}

/** The most active pools with their recent activity (activity null when Gecko has none). */
export function getPoolRadar() {
  if (!shared || Date.now() - shared.at > SHARE_MS) {
    const promise = loadRadar();
    shared = { at: Date.now(), promise };
    promise.catch(() => {
      if (shared?.promise === promise) shared = null;
    });
  }
  return shared.promise;
}

export const RADAR_WINDOWS = [
  { key: 'h1', label: '1H', hours: 1 },
  { key: 'h6', label: '6H', hours: 6 },
  { key: 'h24', label: '24H', hours: 24 }
];

/** Pool type groups for the Discover filter. */
export const RADAR_TYPES = [
  { key: 'all', label: 'All pools' },
  { key: 'clmm', label: 'CLMM', match: (p) => p.isDcl },
  { key: 'amm', label: 'AMM', match: (p) => p.label === 'AMM' },
  { key: 'stable', label: 'Stable / ALMM', match: (p) => !p.isDcl && p.label !== 'AMM' }
];

/** Type filter + search (symbol, token id or pool id) on radar rows. */
export function filterRadar(rows, { type = 'all', query = '' } = {}) {
  const match = RADAR_TYPES.find((t) => t.key === type)?.match;
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!match || match(r)) &&
      (!q || r.id.toLowerCase() === q || r.symbols.some((s) => s.toLowerCase().includes(q)) || r.tokenIds.some((id) => id.toLowerCase().includes(q)))
  );
}

/**
 * Most traded pools over a window (USD volume, or trade count). Pairs made only of NEAR
 * and stablecoins (NEAR/USDC, USDT/USDC…) always top the list, so they are left out.
 */
export function hotPairs(rows, { by = 'volume', window = 'h1' } = {}) {
  const value = (r) => (by === 'trades' ? r.activity?.trades[window] : r.activity?.volume[window]) || 0;
  return rows
    .filter((r) => value(r) > 0 && !r.tokenIds.every((id) => BASE_TOKENS.has(id)))
    .sort((a, b) => value(b) - value(a))
    .slice(0, LIMIT);
}

/**
 * Price swing over a window as a risk level for a concentrated range. The 24h bands
 * (5% / 15%) shrink with the square root of the window: a 1h move of 3% is already big.
 */
export function swingLevel(move, hours = 24) {
  if (move === null || !Number.isFinite(move)) return null;
  const k = Math.sqrt(hours / 24);
  if (move < 5 * k) return { key: 'low', label: 'Calm' };
  if (move < 15 * k) return { key: 'mid', label: 'Moving' };
  return { key: 'high', label: 'Volatile' };
}

/** Rhea's effective LP fee rate (24h fees / 24h volume), else the nominal fee tier. */
const feeRate = (p) => (p.volume24h > 0 && p.feeVolume24h > 0 ? p.feeVolume24h / p.volume24h : (p.feePercent || 0) / 100);

/**
 * Pools ranked for liquidity providers over a window. `fees` = fees earned in the window
 * (24h from Rhea; 1h / 6h from window volume × fee rate); `yieldPct` = fees / TVL (what $100
 * of liquidity earned, as a %); `move` = absolute price change over the window (%).
 * mode 'yield': highest yield first; 'balanced': yield discounted by the price swing,
 * so steady pools with good fees rise.
 */
export function bestToLp(rows, { mode = 'yield', window = 'h24' } = {}) {
  const hours = RADAR_WINDOWS.find((w) => w.key === window)?.hours || 24;
  const scored = rows
    .map((r) => {
      const fees = window === 'h24' ? r.feeVolume24h : (r.activity?.volume[window] || 0) * feeRate(r);
      const change = r.activity?.change[window];
      const move = change === null || change === undefined ? null : Math.abs(change);
      const yieldPct = r.tvl > 0 ? (fees / r.tvl) * 100 : 0;
      const k = Math.sqrt(hours / 24);
      return { ...r, fees, yieldPct, change, move, swing: swingLevel(move, hours), score: yieldPct / (1 + (move ?? 10 * k) / (10 * k)) };
    })
    .filter((r) => r.tvl >= LP_MIN_TVL && r.fees > 0);
  const key = mode === 'balanced' ? 'score' : 'yieldPct';
  return scored.sort((a, b) => b[key] - a[key]).slice(0, LIMIT);
}
