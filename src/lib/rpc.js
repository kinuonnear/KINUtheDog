// NEAR JSON-RPC client with endpoint failover, request de-duplication,
// a concurrency limit and a short-lived view cache.

import { ENDPOINTS } from '../config.js';
import { backgroundRefreshAllowed } from './walletActivity.js';

const MAX_CONCURRENT = 6;
const REQUEST_TIMEOUT_MS = 12_000;
const VIEW_CACHE_MS = 4_000;

let active = 0;
const queue = [];
let preferred = 0; // index into ENDPOINTS.rpc (the reserve is never preferred)
const ALL_ENDPOINTS = [...ENDPOINTS.rpc, ...(ENDPOINTS.rpcReserve || [])];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve)).then(() => {
    active += 1;
  });
}

function release() {
  active -= 1;
  const next = queue.shift();
  if (next) next();
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`RPC HTTP ${response.status}`);
      error.retryable = response.status === 429 || response.status >= 500;
      error.rateLimited = response.status === 429;
      error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('RPC request timed out');
      timeout.retryable = true;
      throw timeout;
    }
    if (error.retryable === undefined) error.retryable = true; // network failure
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Auto RPC: start on the endpoint that answers fastest from here      */
/* ------------------------------------------------------------------ */

const PROBE_TIMEOUT_MS = 4_000;
const PROBE_EVERY_MS = 10 * 60_000;
const PROBE_KEY = 'kinu.rpc.ranking';
let probing = null;
let lastProbe = 0;

/**
 * Time one small call per endpoint: a view_account query, the kind of read KINU makes most.
 * (gas_price was flaky on load-balanced endpoints.) Failures and rate limits rank last.
 */
async function probeOnce() {
  const endpoints = ENDPOINTS.rpc;
  const times = await Promise.all(
    endpoints.map(async (url, index) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const started = performance.now();
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'kinu-probe',
            method: 'query',
            params: { request_type: 'view_account', finality: 'final', account_id: 'wrap.near' }
          }),
          signal: controller.signal
        });
        const json = response.ok ? await response.json() : null;
        return { index, ms: json?.result ? performance.now() - started : Infinity };
      } catch {
        return { index, ms: Infinity };
      } finally {
        clearTimeout(timer);
      }
    })
  );
  const best = times.filter((t) => Number.isFinite(t.ms)).sort((a, b) => a.ms - b.ms)[0];
  if (best) preferred = best.index;
  lastProbe = Date.now();
  try {
    sessionStorage.setItem(PROBE_KEY, JSON.stringify({ at: lastProbe, preferred, times: times.map((t) => Math.round(t.ms)) }));
  } catch {
    // storage unavailable: the ranking still applies to this page
  }
  return times;
}

/**
 * Pick the fastest healthy endpoint for this visitor (reused for 10 minutes across reloads in
 * this tab). Failover is unchanged: a rate-limited or failing endpoint still hands over to the
 * next one. The wallets keep their own list (ENDPOINTS.walletRpc).
 */
export function autoSelectRpc({ force = false } = {}) {
  if (probing) return probing;
  if (!force) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(PROBE_KEY) || 'null');
      if (saved && Date.now() - saved.at < PROBE_EVERY_MS && Number.isInteger(saved.preferred) && saved.preferred < ENDPOINTS.rpc.length) {
        preferred = saved.preferred;
        lastProbe = saved.at;
        return Promise.resolve(null);
      }
    } catch {
      // ignore
    }
  }
  probing = probeOnce().finally(() => {
    probing = null;
  });
  return probing;
}

/** Re-rank every 10 minutes while the tab is visible. */
export function startAutoRpc() {
  autoSelectRpc().catch(() => {});
  setInterval(() => {
    if (backgroundRefreshAllowed() && Date.now() - lastProbe >= PROBE_EVERY_MS) autoSelectRpc({ force: true }).catch(() => {});
  }, 60_000);
}

/* ------------------------------------------------------------------ */
/* Rate-limit cooldown: rest an endpoint that said "too many requests"  */
/* ------------------------------------------------------------------ */

const COOLDOWN_MS = 60_000;
const cooldownUntil = new Map(); // endpoint index -> timestamp

function coolDown(index, retryAfterSec) {
  const ms = retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, 5 * 60_000) : COOLDOWN_MS;
  cooldownUntil.set(index, Date.now() + ms);
}

/** Primary endpoints first (from the preferred one), then the reserve; resting endpoints last. */
function endpointOrder(count) {
  const now = Date.now();
  const primary = ENDPOINTS.rpc.length;
  const order = [
    ...Array.from({ length: primary }, (_, i) => (preferred + i) % primary),
    ...Array.from({ length: count - primary }, (_, i) => primary + i)
  ];
  const ready = order.filter((i) => !(cooldownUntil.get(i) > now));
  const resting = order.filter((i) => cooldownUntil.get(i) > now);
  return [...ready, ...resting];
}

export async function rpc(method, params) {
  await acquire();
  try {
    const endpoints = ALL_ENDPOINTS;
    let lastError;
    // Each endpoint gets two tries; endpoints resting after a rate limit come last.
    const order = endpointOrder(endpoints.length);
    for (let attempt = 0; attempt < endpoints.length * 2; attempt += 1) {
      const index = order[attempt % order.length];
      try {
        const json = await postJson(endpoints[index], {
          jsonrpc: '2.0',
          id: 'kinu',
          method,
          params
        });
        if (json.error) {
          const error = new Error(
            json.error.data?.toString?.() || json.error.message || 'RPC error'
          );
          error.rpc = json.error;
          // Rate limits / shut-down endpoints come back as JSON errors (code -429):
          // move on to the next endpoint. Contract errors are final.
          error.retryable = json.error.code === -429 || /rate limit|deprecated|discontinued/i.test(json.error.message || '');
          error.rateLimited = json.error.code === -429 || /rate limit/i.test(json.error.message || '');
          throw error;
        }
        if (index < ENDPOINTS.rpc.length) preferred = index; // the reserve never becomes the default
        return json.result;
      } catch (error) {
        lastError = error;
        if (!error.retryable) throw error;
        if (error.rateLimited) coolDown(index, error.retryAfter);
        // Moving on to a fresh endpoint needs no wait; a second round over the same ones backs off.
        if (attempt + 1 >= endpoints.length || !error.rateLimited) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  } finally {
    release();
  }
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

const inflight = new Map();
const cache = new Map();

/**
 * Call a view method. Results are cached for a few seconds and identical
 * concurrent calls share one request.
 */
export function view(contractId, methodName, args = {}, { fresh = false } = {}) {
  const key = `${contractId}:${methodName}:${JSON.stringify(args)}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < VIEW_CACHE_MS) {
    return Promise.resolve(hit.value);
  }
  if (inflight.has(key)) return inflight.get(key);

  const promise = rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: methodName,
    args_base64: toBase64(JSON.stringify(args))
  })
    .then((result) => {
      if (result?.error) throw new Error(result.error);
      const text = new TextDecoder().decode(new Uint8Array(result.result || []));
      const value = text ? JSON.parse(text) : null;
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

export async function viewAccount(accountId) {
  return rpc('query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: accountId
  });
}

export function clearViewCache() {
  cache.clear();
}
