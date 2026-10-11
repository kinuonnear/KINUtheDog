// Market data from Intear's public price indexer (prices.intear.tech) — the
// same feed that powers the Intear DEX terminal: USD candles for any NEAR
// token, token stats (supply, liquidity, holders) and recent trades.

import { CONTRACTS } from '../config.js';

const BASE = 'https://prices.intear.tech';

export const RESOLUTIONS = [
  { key: '1', label: '1m', seconds: 60 },
  { key: '5', label: '5m', seconds: 300 },
  { key: '15', label: '15m', seconds: 900 },
  { key: '60', label: '1h', seconds: 3600 },
  { key: '240', label: '4h', seconds: 14400 },
  { key: '1D', label: '1D', seconds: 86400 },
  { key: '1W', label: '1W', seconds: 604800 }
];

/** Intear indexes native NEAR as wrap.near. */
export const intearTokenId = (token) => (token?.native ? CONTRACTS.wrapNear : token?.contract || token?.id);

async function getJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Intear HTTP ${response.status}`);
  return response.json();
}

/** USD OHLCV candles, oldest first. `time` is in seconds (lightweight-charts format). */
export async function fetchOhlc({ tokenId, resolution = '60', countBack = 300, signal }) {
  const params = new URLSearchParams({
    token: tokenId,
    resolution,
    count_back: String(countBack),
    to: String(Date.now())
  });
  const rows = await getJson(`${BASE}/ohlc?${params}`, signal);
  if (!Array.isArray(rows)) throw new Error('Invalid candle response');
  const seen = new Set();
  return rows
    .map((r) => ({
      time: Math.floor(Number(r.timestamp_millis) / 1000),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume)
    }))
    .filter((c) => {
      const ok = [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0 && !seen.has(c.time);
      if (ok) seen.add(c.time);
      return ok;
    })
    .sort((a, b) => a.time - b.time);
}

/** Token stats: price, 24h change, supply, liquidity, volume, holders. */
export async function fetchTokenInfo(tokenId, signal) {
  const info = await getJson(`${BASE}/token?token_id=${encodeURIComponent(tokenId)}`, signal);
  const decimals = Number(info?.metadata?.decimals ?? 0);
  const price = Number(info?.price_usd);
  const rawNow = Number(info?.price_usd_raw);
  const rawAgo = Number(info?.price_usd_raw_24h_ago);
  const circulating = Number(info?.circulating_supply) / 10 ** decimals;
  return {
    price: Number.isFinite(price) ? price : null,
    change24h: rawAgo > 0 && rawNow > 0 ? ((rawNow - rawAgo) / rawAgo) * 100 : null,
    circulatingSupply: Number.isFinite(circulating) && circulating > 0 ? circulating : null,
    liquidityUsd: Number(info?.liquidity_usd) || 0,
    volume24hUsd: Number(info?.volume_usd_24h) || 0,
    holders: Number(info?.holders) || null,
    mainPoolUrl: info?.main_pool_url || null
  };
}

/** Most recent trades of a token (newest first). */
export async function fetchTrades({ tokenId, limit = 30, signal }) {
  const params = new URLSearchParams({ token: tokenId, limit: String(limit) });
  const json = await getJson(`${BASE}/trades?${params}`, signal);
  return (json?.trades || []).map((t) => ({
    id: t.id,
    time: Number(t.timestamp_millis),
    side: t.side === 'sell' ? 'sell' : 'buy',
    trader: t.trader,
    usd: Number(t.usd_value) || 0,
    amountRaw: String(t.amount || '0'),
    counterparty: t.counterparty,
    counterpartyAmountRaw: String(t.counterparty_amount || '0'),
    txHash: t.transaction_id
  }));
}

// Tokens that read better as the "quote" side, so the chart shows the other token.
const QUOTE_TOKENS = new Set([
  'near',
  'wrap.near',
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // USDC
  'usdt.tether-token.near',
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near', // USDC.e
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near' // USDT.e
]);

/** Which side of a pair the chart shows by default: the non-quote token. */
export function defaultChartSide(tokenIn, tokenOut) {
  const inQuote = QUOTE_TOKENS.has(tokenIn?.id);
  const outQuote = QUOTE_TOKENS.has(tokenOut?.id);
  if (!outQuote) return 'out';
  if (!inQuote) return 'in';
  return tokenIn?.native || tokenIn?.id === 'wrap.near' ? 'in' : 'out';
}
