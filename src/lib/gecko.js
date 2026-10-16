// Windowed pool activity (volume over 1h–24h) from GeckoTerminal, which
// indexes every Rhea pool:
//   classic / stable / ALMM pools -> refv1-<pool id>
//   CLMM (DCL) pools              -> refv2-<tokenX>:<tokenY>:<fee>
// One multi-pool call returns exact 1h / 6h / 24h volume (plus price change and trade
// counts) for up to 30 pools.
// 4h and 12h aren't published; per-pool candles would hit Gecko's public rate
// limit, so those two windows are estimated between the nearest exact windows.

import { ENDPOINTS } from '../config.js';

export const WINDOWS = [
  { key: 'h24', label: '24H', hours: 24 },
  { key: 'h12', label: '12H', hours: 12 },
  { key: 'h6', label: '6H', hours: 6 },
  { key: 'h4', label: '4H', hours: 4 },
  { key: 'h1', label: '1H', hours: 1 }
];

/** Windows derived by interpolation rather than reported directly. */
export const ESTIMATED_WINDOWS = new Set(['h4', 'h12']);

/* ------------------------------------------------------------------ */
/* One shared lane for every GeckoTerminal request                      */
/* ------------------------------------------------------------------ */

// Gecko's public API allows about 30 requests a minute per IP. Every Gecko call in the app goes
// through this lane: a small burst, then one request every ~2.2 s; after a rate limit, Gecko gets
// a rest (15 s, doubling up to 2 min) instead of more requests. A 429 is sent without CORS headers,
// so the browser reports it as a network failure: both count as a rate limit here.
const BURST = 5;
const REFILL_MS = 2_200;
let tokens = BURST;
let refilledAt = Date.now();
let pausedUntil = 0;
let backoffMs = 0;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

// Nobody waits long in the lane: a caller that would wait more than this (or arrives during a
// rate-limit pause) gets a `rateLimited` error at once and shows its fallback (e.g. the chart's
// Intear candles) instead of a spinner.
const MAX_WAIT_MS = 2_500;

async function takeSlot(signal) {
  for (;;) {
    const now = Date.now();
    if (pausedUntil > now) throw busy();
    tokens = Math.min(BURST, tokens + (now - refilledAt) / REFILL_MS);
    refilledAt = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    const wait = (1 - tokens) * REFILL_MS;
    if (wait > MAX_WAIT_MS) throw busy();
    await sleep(wait, signal);
  }
}

function busy() {
  const error = new Error('GeckoTerminal is busy — retrying shortly.');
  error.rateLimited = true;
  return error;
}

function rateLimited() {
  backoffMs = backoffMs ? Math.min(backoffMs * 2, 120_000) : 15_000;
  pausedUntil = Date.now() + backoffMs;
  return busy();
}

/** fetch() for GeckoTerminal through the shared lane. Throws `rateLimited` errors on a 429. */
export async function geckoFetch(url, { signal } = {}) {
  await takeSlot(signal);
  let response;
  try {
    response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw rateLimited();
  }
  if (response.status === 429) throw rateLimited();
  backoffMs = 0;
  return response;
}

const MULTI_BATCH = 30;
const MULTI_TTL_MS = 60_000;

export function geckoPoolId(pool) {
  return pool.kind === 'DCL' || String(pool.id).includes('|') ? `refv2-${String(pool.id).split('|').join(':')}` : `refv1-${pool.id}`;
}

/** Linear interpolation between two cumulative windows (hours a < x < b). */
const between = (va, ha, vb, hb, hx) => va + ((vb - va) * (hx - ha)) / (hb - ha);

function windowsFrom(v) {
  const h1 = Number(v.h1) || 0;
  const h6 = Number(v.h6) || 0;
  const h24 = Number(v.h24) || 0;
  return {
    h1,
    h4: between(h1, 1, h6, 6, 4),
    h6,
    h12: between(h6, 6, h24, 24, 12),
    h24
  };
}

const multiCache = new Map(); // geckoId -> { at, value } (value: the pool's Gecko attributes)

/**
 * The same windowed activity from DexScreener, which indexes Rhea pools under the same addresses
 * and allows far more requests (~300 a minute): 30 pools per call, shaped like Gecko's attributes.
 */
async function dexScreenerAttributes(batch) {
  const url = `${ENDPOINTS.dexscreener}/latest/dex/pairs/near/${batch.map((p) => encodeURIComponent(geckoPoolId(p))).join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  const json = await res.json();
  const byAddress = new Map();
  (json.pairs || []).forEach((d) => {
    const tx = d.txns || {};
    byAddress.set(d.pairAddress, {
      volume_usd: { h1: d.volume?.h1, h6: d.volume?.h6, h24: d.volume?.h24 },
      price_change_percentage: { h1: d.priceChange?.h1, h6: d.priceChange?.h6, h24: d.priceChange?.h24 },
      transactions: { h1: tx.h1, h6: tx.h6, h24: tx.h24 },
      pool_created_at: d.pairCreatedAt // ms (Gecko gives an ISO date under the same key)
    });
  });
  return byAddress;
}

/** { [poolId]: Gecko pool attributes } for the given pools (null when unknown). */
async function fetchAttributes(pools) {
  const out = {};
  const now = Date.now();
  let missing = [];
  pools.forEach((p) => {
    const hit = multiCache.get(geckoPoolId(p));
    if (hit && now - hit.at < MULTI_TTL_MS) out[p.id] = hit.value;
    else missing.push(p);
  });

  // DexScreener first; GeckoTerminal for the pools it doesn't know (or if it fails).
  const batches = [];
  for (let i = 0; i < missing.length; i += MULTI_BATCH) batches.push(missing.slice(i, i + MULTI_BATCH));
  const found = await Promise.all(batches.map((b) => dexScreenerAttributes(b).catch(() => null)));
  const unknown = [];
  batches.forEach((batch, i) => {
    batch.forEach((p) => {
      const value = found[i]?.get(geckoPoolId(p));
      if (value) {
        multiCache.set(geckoPoolId(p), { at: Date.now(), value });
        out[p.id] = value;
      } else unknown.push(p);
    });
  });
  missing = unknown;

  for (let i = 0; i < missing.length; i += MULTI_BATCH) {
    const batch = missing.slice(i, i + MULTI_BATCH);
    const url = `${ENDPOINTS.geckoterminal}/networks/near/pools/multi/${batch.map((p) => encodeURIComponent(geckoPoolId(p))).join(',')}`;
    // Gecko signals rate limiting with HTTP 429 or with a 200 whose body carries
    // error_code 429; the shared lane backs off, and this retries once after it.
    let json = null;
    for (let attempt = 0; attempt <= 1 && !json; attempt += 1) {
      const res = await geckoFetch(url).catch(() => null);
      if (!res) continue;
      const body = await res.json().catch(() => null);
      if (body?.status?.error_code === 429) {
        rateLimited();
        continue;
      }
      if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
      json = body;
    }
    if (!json) {
      // Keep what earlier batches returned; these pools stay unknown (and uncached).
      if (Object.keys(out).length) continue;
      throw new Error('GeckoTerminal rate limit');
    }
    const byId = new Map((json.data || []).map((d) => [d.attributes?.address, d.attributes]));
    batch.forEach((p) => {
      const value = byId.get(geckoPoolId(p)) || null;
      multiCache.set(geckoPoolId(p), { at: Date.now(), value });
      out[p.id] = value;
    });
  }
  return out;
}

/** { [poolId]: { h1, h4, h6, h12, h24 } } USD volume for the given pools (null when unknown). */
export async function fetchWindowVolumes(pools) {
  const attrs = await fetchAttributes(pools);
  return Object.fromEntries(pools.map((p) => [p.id, attrs[p.id]?.volume_usd ? windowsFrom(attrs[p.id].volume_usd) : null]));
}

const pct = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const trades = (t) => (t ? (Number(t.buys) || 0) + (Number(t.sells) || 0) : 0);

/**
 * Recent activity per pool: volume windows, base-token price change (%) and trade counts.
 * { [poolId]: { volume: { h1, h4, h6, h12, h24 }, change: { h1, h6, h24 }, trades: { h1, h6, h24 } } | null }
 */
export async function fetchPoolActivity(pools) {
  const attrs = await fetchAttributes(pools);
  return Object.fromEntries(
    pools.map((p) => {
      const a = attrs[p.id];
      if (!a) return [p.id, null];
      const change = a.price_change_percentage || {};
      return [
        p.id,
        {
          volume: windowsFrom(a.volume_usd || {}),
          change: { h1: pct(change.h1), h6: pct(change.h6), h24: pct(change.h24) },
          trades: { h1: trades(a.transactions?.h1), h6: trades(a.transactions?.h6), h24: trades(a.transactions?.h24) },
          // When the pool was created (ms), or null.
          createdAt: (typeof a.pool_created_at === 'number' ? a.pool_created_at : Date.parse(a.pool_created_at)) || null
        }
      ];
    })
  );
}

/* ------------------------------------------------------------------ */
/* Candles of one pool                                                 */
/* ------------------------------------------------------------------ */

// Chart resolution -> Gecko timeframe + aggregate. Weekly bars are built from daily ones.
const OHLCV_FRAMES = {
  1: ['minute', 1, 60],
  5: ['minute', 5, 300],
  15: ['minute', 15, 900],
  60: ['hour', 1, 3600],
  240: ['hour', 4, 14400],
  '1D': ['day', 1, 86400],
  '1W': ['day', 1, 604800]
};

/**
 * Candles from this pool's own trades (GeckoTerminal), oldest first:
 * [{ time, open, high, low, close, volume }]. `tokenId` is the token being priced; prices are in
 * the pool's other token, or in USD with `usd`. Volume is in USD with `usd`, else in the other token.
 * A pool's price only moves when it trades, so empty buckets carry the last close (volume 0).
 * `trades` is how many buckets had real trades (0 = no history in this pool yet).
 * `before` (seconds): an older page, the candles before that time (for charts loading history as
 * they scroll back); filled up to its own last candle, not to now.
 */
export async function fetchPoolOhlc({ poolId, address, tokenId, resolution = '60', usd = false, countBack = 300, before = null, signal }) {
  const [frame, aggregate, step] = OHLCV_FRAMES[resolution] || OHLCV_FRAMES[60];
  const weekly = resolution === '1W';
  const params = new URLSearchParams({
    aggregate: String(aggregate),
    limit: String(Math.min(1000, weekly ? countBack * 7 : countBack)),
    currency: usd ? 'usd' : 'token',
    token: tokenId
  });
  if (before) params.set('before_timestamp', String(Math.floor(before) - 1));
  // `address`: a GeckoTerminal pool address as listed (any DEX); else derived from a Rhea pool id.
  const pool = address || geckoPoolId({ id: poolId });
  const response = await geckoFetch(`${ENDPOINTS.geckoterminal}/networks/near/pools/${encodeURIComponent(pool)}/ohlcv/${frame}?${params}`, { signal });
  if (!response.ok) throw new Error(`Pool chart HTTP ${response.status}`);
  const rows = (await response.json())?.data?.attributes?.ohlcv_list || [];
  let real = rows
    .map(([time, open, high, low, close, volume]) => ({ time: Number(time), open: +open, high: +high, low: +low, close: +close, volume: +volume || 0 }))
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0)
    .sort((a, b) => a.time - b.time);
  if (weekly) {
    const weeks = new Map();
    real.forEach((c) => {
      const t = Math.floor(c.time / step) * step;
      const w = weeks.get(t);
      if (!w) weeks.set(t, { ...c, time: t });
      else Object.assign(w, { high: Math.max(w.high, c.high), low: Math.min(w.low, c.low), close: c.close, volume: w.volume + c.volume });
    });
    real = [...weeks.values()];
  }
  if (before) real = real.filter((c) => c.time < before);
  if (before && weekly) return { candles: [], trades: 0 }; // weekly bars are built from days: no paging
  return { candles: fillBuckets(real, step, before ? 1e9 : countBack, before ? real[real.length - 1]?.time : null), trades: real.length };
}

/** One candle per bucket from the first trade (within the last `count` buckets) up to now (or `until`). */
function fillBuckets(real, step, count, until = null) {
  if (!real.length) return [];
  const now = until ?? Math.floor(Date.now() / 1000 / step) * step;
  const start = Math.max(real[0].time, now - (count - 1) * step);
  const byTime = new Map(real.map((c) => [c.time, c]));
  // The close carried into the window: the last real candle before it starts.
  let prev = [...real].reverse().find((c) => c.time < start)?.close ?? real[0].open;
  const out = [];
  for (let t = start; t <= now; t += step) {
    const c = byTime.get(t);
    if (c) {
      out.push(c);
      prev = c.close;
    } else {
      out.push({ time: t, open: prev, high: prev, low: prev, close: prev, volume: 0 });
    }
  }
  return out;
}
