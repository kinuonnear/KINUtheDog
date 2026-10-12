// NEAR JSON-RPC client with endpoint failover, request de-duplication,
// a concurrency limit and a short-lived view cache.

import { ENDPOINTS } from '../config.js';

const MAX_CONCURRENT = 6;
const REQUEST_TIMEOUT_MS = 12_000;
const VIEW_CACHE_MS = 4_000;

let active = 0;
const queue = [];
let preferred = 0;

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

export async function rpc(method, params) {
  await acquire();
  try {
    const endpoints = ENDPOINTS.rpc;
    let lastError;
    for (let attempt = 0; attempt < endpoints.length * 2; attempt += 1) {
      const index = (preferred + attempt) % endpoints.length;
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
          throw error;
        }
        preferred = index;
        return json.result;
      } catch (error) {
        lastError = error;
        if (!error.retryable) throw error;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
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
