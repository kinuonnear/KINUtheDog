// New tokens on Rhea: launches from Nearly (every Nearly launch opens a Rhea CLMM pool),
// newest first, plus factual risk flags. Flags describe on-chain facts only — they are
// not ratings or recommendations.

import { KINU_TOKEN } from '../config.js';

const API = 'https://nearly.trade/api';
const DAY = 86_400_000;

async function getJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Nearly API ${response.status}`);
  return response.json();
}

function normalize(raw) {
  const nearUsd = Number(raw.near_usd) || 0;
  return {
    id: raw.token,
    name: raw.name,
    symbol: raw.symbol,
    icon: raw.icon || null,
    creator: raw.creator,
    poolId: raw.pool_id,
    quote: raw.quote,
    createdAt: Number(raw.created_at_ms) || 0,
    priceUsd: Number(raw.price_usd) || 0,
    fdvUsd: Number(raw.fdv_usd) || 0,
    liquidityUsd: (Number(raw.liquidity_near) || 0) * nearUsd,
    volume24hUsd: (Number(raw.volume_24h_near) || 0) * nearUsd,
    change24h: Number.isFinite(Number(raw.change_24h)) ? Number(raw.change_24h) * 100 : null,
    holders: Number(raw.holders) || 0,
    trades24h: Number(raw.trades_24h) || 0
  };
}

/** Newest Nearly launches (each with a Rhea CLMM pool). */
export async function getRecentLaunches({ limit = 60, signal } = {}) {
  const list = await getJson(`${API}/launches?limit=${limit}`, signal);
  return (Array.isArray(list) ? list : []).map(normalize);
}

/** The Nearly launch record of one token, or null when it wasn't launched on Nearly. */
export async function getLaunch(tokenId, signal) {
  try {
    const raw = await getJson(`${API}/launch/${encodeURIComponent(tokenId)}`, signal);
    return raw?.token ? normalize(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Factual flags for a launch.
 * @param knownSymbols  Map symbol(upper) -> contract of established tokens (pinned / whitelisted)
 * @param seen          Map symbol(upper) -> number of launches in the list using it
 */
export function launchFlags(launch, { knownSymbols, seen } = {}) {
  const flags = [];
  const symbol = String(launch.symbol || '').toUpperCase();
  if (launch.id === KINU_TOKEN) flags.push({ kind: 'good', label: 'Official $KINU' });
  else if (symbol === 'KINU') flags.push({ kind: 'bad', label: 'Not the official $KINU' });
  else if (knownSymbols?.has(symbol) && knownSymbols.get(symbol) !== launch.id) flags.push({ kind: 'bad', label: `Uses the ${symbol} name` });
  else if ((seen?.get(symbol) || 0) > 1) flags.push({ kind: 'warn', label: 'Name used before' });
  if (launch.createdAt && Date.now() - launch.createdAt < DAY) flags.push({ kind: 'info', label: 'Under 24h old' });
  if (launch.liquidityUsd < 500) {
    flags.push({ kind: 'warn', label: 'Thin liquidity', title: 'Under $500 of NEAR/RHEA in the pool — what sellers can receive. Selling can move the price a lot.' });
  }
  if (launch.holders < 10) flags.push({ kind: 'warn', label: 'Few holders', title: 'Fewer than 10 holders on Nearly.' });
  return flags;
}
