// Market chart data: DexScreener resolves the deepest Rhea pair for two tokens,
// GeckoTerminal supplies its OHLCV candles.

import { ENDPOINTS } from '../config.js';

export const TIMEFRAMES = {
  '15m': { interval: 'minute', aggregate: 15, label: '15M' },
  '1h': { interval: 'hour', aggregate: 1, label: '1H' },
  '4h': { interval: 'hour', aggregate: 4, label: '4H' },
  '1d': { interval: 'day', aggregate: 1, label: '1D' }
};

const pairCache = new Map();

/** Deepest Rhea pair on NEAR for tokenA/tokenB (contract ids), or null. */
export async function findRheaPair(tokenA, tokenB) {
  if (!tokenA || !tokenB || tokenA === tokenB) return null;
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  const key = [a, b].sort().join('|');
  if (pairCache.has(key)) return pairCache.get(key);

  const response = await fetch(`${ENDPOINTS.dexscreener}/latest/dex/tokens/${encodeURIComponent(a)}`);
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const json = await response.json();
  const matches = (json?.pairs || []).filter((pair) => {
    const dex = String(pair?.dexId || '');
    if (pair?.chainId !== 'near' || !(dex.startsWith('rhea') || dex.startsWith('ref'))) return false;
    const base = String(pair?.baseToken?.address || '').toLowerCase();
    const quote = String(pair?.quoteToken?.address || '').toLowerCase();
    return (base === a && quote === b) || (base === b && quote === a);
  });
  matches.sort((x, y) => Number(y?.liquidity?.usd || 0) - Number(x?.liquidity?.usd || 0));
  const pair = matches[0] || null;
  pairCache.set(key, pair);
  return pair;
}

/**
 * Candles for a pair, expressed as the price of `baseAddress` in the other token.
 * GeckoTerminal and DexScreener can disagree on which side is "base", so the
 * token is selected by contract address rather than by side.
 */
export async function fetchCandles({ pair, baseAddress, timeframe = '1h', limit = 150 }) {
  const config = TIMEFRAMES[timeframe] || TIMEFRAMES['1h'];
  const params = new URLSearchParams({
    aggregate: String(config.aggregate),
    limit: String(limit),
    currency: 'token',
    token: String(baseAddress || pair.baseToken?.address || 'base').toLowerCase()
  });
  const url = `${ENDPOINTS.geckoterminal}/networks/near/pools/${encodeURIComponent(pair.pairAddress)}/ohlcv/${config.interval}?${params}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GeckoTerminal HTTP ${response.status}`);
  const json = await response.json();
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) throw new Error('No candle data for this pair.');

  const seen = new Set();
  return list
    .map((c) => ({
      time: Number(c[0]),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5])
    }))
    .filter((c) => {
      if (!Number.isFinite(c.time) || !Number.isFinite(c.close) || seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    })
    .sort((x, y) => x.time - y.time);
}
