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

/** { [poolId]: Gecko pool attributes } for the given pools (null when unknown). */
async function fetchAttributes(pools) {
  const out = {};
  const now = Date.now();
  const missing = [];
  pools.forEach((p) => {
    const hit = multiCache.get(geckoPoolId(p));
    if (hit && now - hit.at < MULTI_TTL_MS) out[p.id] = hit.value;
    else missing.push(p);
  });

  for (let i = 0; i < missing.length; i += MULTI_BATCH) {
    const batch = missing.slice(i, i + MULTI_BATCH);
    const url = `${ENDPOINTS.geckoterminal}/networks/near/pools/multi/${batch.map((p) => encodeURIComponent(geckoPoolId(p))).join(',')}`;
    // Gecko signals rate limiting with HTTP 429 or with a 200 whose body carries
    // error_code 429; back off and retry a couple of times before giving up.
    // A 429 sent without CORS headers surfaces as a network error, so that is retried too.
    let json = null;
    for (let attempt = 0; attempt <= 2 && !json; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, 6_000 * attempt));
      const res = await fetch(url).catch(() => null);
      if (!res) continue;
      const body = res.status === 429 ? null : await res.json().catch(() => null);
      if (res.status === 429 || body?.status?.error_code === 429) continue;
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
          trades: { h1: trades(a.transactions?.h1), h6: trades(a.transactions?.h6), h24: trades(a.transactions?.h24) }
        }
      ];
    })
  );
}
