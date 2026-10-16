// Intear API (api.intea.rs, docs.intear.tech/api): candles for any NEAR token in USD or NEAR,
// up to 5,000 per request with paging back in time, and live candles over one shared WebSocket
// (updated after every block). Candles are a token's market price across every pool.
//
// Intear leaves out candles in which the price didn't move and nothing traded; the charts get
// one candle per bucket (a flat one carrying the last close), like the pool candles.

const API = 'https://api.intea.rs';
const WS_URL = 'wss://api.intea.rs/ws';
const MAX_COUNT = 5000;

/** Chart resolution keys (lib/intear.js RESOLUTIONS) -> Intear's. */
const RESOLUTION = { 1: '1', 5: '5', 15: '15', 60: '60', 240: '240', '1D': 'D', '1W': 'W' };
const STEP = { 1: 60, 5: 300, 15: 900, 60: 3600, 240: 14400, '1D': 86400, '1W': 604800 };

/** One token's candle columns ({ time, usd | near: { open, … } }) -> [{ time (s), open, high, low, close, volume }]. */
function toCandles(columns, quote) {
  const series = columns?.[quote];
  // Volume always in USD when the USD columns came along (charts show volume in dollars).
  const vol = columns?.usd?.volume || series?.volume;
  if (!columns?.time || !series) return [];
  const out = [];
  columns.time.forEach((ms, i) => {
    const c = {
      time: Math.floor(ms / 1000),
      open: Number(series.open?.[i]),
      high: Number(series.high?.[i]),
      low: Number(series.low?.[i]),
      close: Number(series.close?.[i]),
      volume: Number(vol?.[i]) || 0
    };
    // `near` is null before wrap.near had a price.
    if ([c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0)) out.push(c);
  });
  return out;
}

/**
 * One candle per bucket from the first candle to `until` (seconds): gaps get a flat candle at the
 * last close. Daily and shorter only (weekly buckets are left as Intear sends them).
 */
export function fillGaps(candles, step, until = null) {
  if (!candles.length || !step || step > 86_400) return candles;
  const out = [];
  const end = until ?? candles[candles.length - 1].time;
  let i = 0;
  let prev = null;
  for (let t = candles[0].time; t <= end; t += step) {
    while (i < candles.length && candles[i].time < t) i += 1;
    if (i < candles.length && candles[i].time === t) {
      prev = candles[i];
      out.push(prev);
      i += 1;
    } else if (prev) {
      const c = prev.close;
      out.push({ time: t, open: c, high: c, low: c, close: c, volume: 0 });
    }
  }
  return out;
}

/**
 * Candles of one or more tokens, oldest first, per token: { [tokenId]: candles }.
 * `quote`: 'usd' or 'near'. `toMillis`: the latest candle start to include (paging back);
 * without it the candles reach the current bucket, gaps filled.
 */
export async function fetchCandles({ tokenIds, resolution = '60', quote = 'usd', countBack = 1500, toMillis = null, signal }) {
  const ids = [...new Set(tokenIds)].filter(Boolean);
  const params = new URLSearchParams({
    tokens: ids.join(','),
    resolution: RESOLUTION[resolution] || '60',
    quote: quote === 'near' ? 'near,usd' : quote,
    count_back: String(Math.min(MAX_COUNT, Math.max(1, countBack)))
  });
  if (toMillis) params.set('to_millis', String(Math.floor(toMillis)));
  const response = await fetch(`${API}/candles?${params}`, { signal });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error?.message || `Intear API HTTP ${response.status}`);
  const step = STEP[resolution] || 3600;
  const now = Math.floor(Date.now() / 1000 / step) * step;
  const out = {};
  ids.forEach((id) => {
    const candles = toCandles(json?.tokens?.[id], quote);
    out[id] = fillGaps(candles, step, toMillis ? null : now);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Live candles: one socket for every chart                            */
/* ------------------------------------------------------------------ */

const RETRY_MS = [1_000, 3_000, 10_000, 30_000];
const IDLE_CLOSE_MS = 30_000;

const subs = new Map(); // id -> { params, quote, onCandles }
let socket = null;
let nextId = 1;
let retries = 0;
let retryTimer = null;
let idleTimer = null;

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function subscribeMessage(id, sub) {
  return { id, method: 'candles.subscribe', params: sub.params };
}

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (socket || !subs.size || typeof WebSocket === 'undefined') return;
  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    retries = 0;
    subs.forEach((sub, id) => send(subscribeMessage(id, sub)));
  };
  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const sub = subs.get(message.sub);
    if (!sub || !message.tokens) return;
    const out = {};
    Object.entries(message.tokens).forEach(([id, columns]) => {
      out[id] = toCandles(columns, sub.quote);
    });
    sub.onCandles(out);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    // Candles may have moved while disconnected: each chart reloads its history.
    subs.forEach((sub) => sub.onReset?.());
    scheduleRetry();
  };
  ws.onerror = () => ws.close();
}

function scheduleRetry() {
  if (retryTimer || !subs.size) return;
  const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
  retries += 1;
  retryTimer = setTimeout(connect, wait);
}

if (typeof document !== 'undefined') {
  // Phones drop sockets in background tabs: reconnect at once when the visitor comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket && subs.size) {
      retries = 0;
      connect();
    }
  });
}

/**
 * Live candles of `tokenIds` at `resolution` in `quote` ('usd' | 'near'): `onCandles({ [id]: candles })`
 * gets the candles that changed in each block (the latest one, a new one once it opens).
 * `onReset()` runs after a reconnect. Returns an unsubscribe function.
 */
export function subscribeCandles({ tokenIds, resolution = '60', quote = 'usd' }, onCandles, onReset) {
  const id = nextId++;
  const sub = {
    quote,
    onCandles,
    onReset,
    params: { tokens: [...new Set(tokenIds)].filter(Boolean), resolution: RESOLUTION[resolution] || '60', quote: quote === 'near' ? ['near', 'usd'] : [quote], series: ['open', 'high', 'low', 'close', 'volume'] }
  };
  subs.set(id, sub);
  clearTimeout(idleTimer);
  if (socket) send(subscribeMessage(id, sub));
  else connect();
  return () => {
    if (!subs.delete(id)) return;
    send({ id: nextId++, method: 'unsubscribe', params: { sub: id } });
    if (subs.size) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!subs.size && socket) socket.close();
    }, IDLE_CLOSE_MS);
  };
}

/* ------------------------------------------------------------------ */
/* Chart helpers                                                       */
/* ------------------------------------------------------------------ */

const WNEAR = 'wrap.near';

/** A token's market candles in USD or NEAR (`quote`), oldest first. */
export async function fetchMarketCandles({ tokenId, resolution = '60', quote = 'usd', countBack = 1500, toMillis = null, signal }) {
  // wNEAR priced in NEAR is always 1: chart it in USD.
  const q = tokenId === WNEAR ? 'usd' : quote;
  const res = await fetchCandles({ tokenIds: [tokenId], resolution, quote: q, countBack, toMillis, signal });
  return res[tokenId] || [];
}

/**
 * Price of token X in token Y, oldest first. Against wNEAR it is Intear's own NEAR quote; against
 * any other token it is X's USD price over Y's at the same candle (Y's last close fills Y's gaps).
 * A ratio's true high / low can't be recovered from two series: approximated with Y's close.
 */
export async function fetchMarketPair({ tokenX, tokenY, resolution = '60', countBack = 1500, toMillis = null, signal }) {
  if (tokenY === WNEAR) return fetchMarketCandles({ tokenId: tokenX, resolution, quote: 'near', countBack, toMillis, signal });
  const res = await fetchCandles({ tokenIds: [tokenX, tokenY], resolution, quote: 'usd', countBack, toMillis, signal });
  return pairOf(res[tokenX] || [], res[tokenY] || []);
}

/** X candles over Y candles, matched by time. */
export function pairOf(xs, ys, lastY = null) {
  const byTime = new Map(ys.map((c) => [c.time, c]));
  let y = lastY;
  const out = [];
  xs.forEach((x) => {
    y = byTime.get(x.time) || y;
    if (!y) return;
    const open = x.open / y.open;
    const close = x.close / y.close;
    const high = Math.max(open, close, x.high / y.close);
    const low = Math.min(open, close, x.low / y.close);
    if ([open, close, high, low].every((n) => Number.isFinite(n) && n > 0)) out.push({ time: x.time, open, high, low, close, volume: x.volume });
  });
  return out;
}
