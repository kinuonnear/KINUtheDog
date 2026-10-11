// Token metadata, prices and balances.
//   metadata  -> ft_metadata on each token contract (cached in memory + localStorage)
//   prices    -> Rhea indexer /list-token-price
//   balances  -> FastNEAR FT index + view_account for native NEAR

import { CONTRACTS, ENDPOINTS, NATIVE_NEAR, NEAR_ICON } from '../config.js';
import { view, viewAccount } from './rpc.js';
import { toBigInt } from './format.js';

const META_STORAGE_KEY = 'kinu.meta.v3';
const MAX_STORED_ICON = 24_000;

const metaCache = new Map();
const metaInflight = new Map();

function loadStoredMeta() {
  try {
    const stored = JSON.parse(localStorage.getItem(META_STORAGE_KEY) || '{}');
    Object.entries(stored).forEach(([id, meta]) => metaCache.set(id, meta));
  } catch {
    // storage unavailable or corrupt: start empty
  }
}
loadStoredMeta();

let persistTimer = null;
function persistMeta() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const entries = {};
      metaCache.forEach((meta, id) => {
        if (id === NATIVE_NEAR.id) return;
        entries[id] =
          meta.icon && meta.icon.length > MAX_STORED_ICON
            ? { ...meta, icon: null, iconChecked: false }
            : meta;
      });
      localStorage.setItem(META_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // quota exceeded: memory cache still works
    }
  }, 500);
}

function normalizeMeta(id, raw) {
  return {
    id,
    contract: id,
    symbol: raw?.symbol || id.slice(0, 10),
    name: raw?.name || raw?.symbol || id,
    decimals: Number(raw?.decimals ?? 0),
    // wrap.near publishes no icon on-chain; show the NEAR mark for wNEAR.
    icon: raw?.icon || (id === CONTRACTS.wrapNear ? NEAR_ICON : null)
  };
}

export function getCachedToken(id) {
  if (id === NATIVE_NEAR.id) return NATIVE_NEAR;
  return metaCache.get(id) || null;
}

export async function getToken(id) {
  if (!id) return null;
  if (id === NATIVE_NEAR.id) return NATIVE_NEAR;
  const cached = metaCache.get(id);
  if (cached && (cached.icon !== null || cached.iconChecked)) return cached;
  if (metaInflight.has(id)) return metaInflight.get(id);

  const promise = view(id, 'ft_metadata')
    .then((raw) => {
      const meta = { ...normalizeMeta(id, raw), iconChecked: true };
      metaCache.set(id, meta);
      persistMeta();
      return meta;
    })
    .catch(() => {
      // Fall back to indexer data if the contract can't be read.
      const priced = priceCache.value?.get(id);
      const meta = {
        ...normalizeMeta(id, priced ? { symbol: priced.symbol, decimals: priced.decimals } : null),
        iconChecked: true
      };
      metaCache.set(id, meta);
      return meta;
    })
    .finally(() => metaInflight.delete(id));

  metaInflight.set(id, promise);
  return promise;
}

export async function getTokens(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const list = await Promise.all(unique.map((id) => getToken(id)));
  return Object.fromEntries(list.filter(Boolean).map((t) => [t.id, t]));
}

/* ------------------------------------------------------------------ */
/* Prices                                                              */
/* ------------------------------------------------------------------ */

const PRICE_TTL_MS = 60_000;
const priceCache = { at: 0, value: null, promise: null };

/** Map<tokenId, { price:number, symbol, decimals }> from the Rhea indexer. */
export async function getPrices({ fresh = false } = {}) {
  if (!fresh && priceCache.value && Date.now() - priceCache.at < PRICE_TTL_MS) {
    return priceCache.value;
  }
  if (priceCache.promise) return priceCache.promise;

  priceCache.promise = fetch(`${ENDPOINTS.rheaIndexer}/list-token-price`)
    .then((r) => {
      if (!r.ok) throw new Error(`Price feed HTTP ${r.status}`);
      return r.json();
    })
    .then((json) => {
      const map = new Map();
      Object.entries(json || {}).forEach(([id, info]) => {
        const price = Number(info?.price);
        map.set(id, {
          price: Number.isFinite(price) ? price : 0,
          symbol: info?.symbol || '',
          decimals: Number(info?.decimal ?? 0)
        });
      });
      const wrapped = map.get(CONTRACTS.wrapNear);
      if (wrapped) map.set(NATIVE_NEAR.id, { ...wrapped, symbol: 'NEAR' });
      priceCache.value = map;
      priceCache.at = Date.now();
      return map;
    })
    .finally(() => {
      priceCache.promise = null;
    });

  return priceCache.promise;
}

export function priceOf(prices, tokenId) {
  return prices?.get(tokenId)?.price || 0;
}

/* ------------------------------------------------------------------ */
/* Token discovery                                                     */
/* ------------------------------------------------------------------ */

let whitelistPromise = null;

/** Tokens whitelisted on the Rhea exchange (the "verified" set). */
export function getWhitelistedTokens() {
  if (!whitelistPromise) {
    whitelistPromise = view(CONTRACTS.exchange, 'get_whitelisted_tokens').catch((error) => {
      whitelistPromise = null;
      throw error;
    });
  }
  return whitelistPromise;
}

/**
 * Search the indexer price list by symbol or contract id.
 * Returns lightweight entries; full metadata is loaded lazily.
 */
export function searchPriceList(prices, query, limit = 60) {
  const q = query.trim().toLowerCase();
  if (!q || !prices) return [];
  const exact = [];
  const partial = [];
  prices.forEach((info, id) => {
    if (id === NATIVE_NEAR.id) return;
    const symbol = (info.symbol || '').toLowerCase();
    if (symbol === q || id === q) exact.push({ id, ...info });
    else if (symbol.includes(q) || id.includes(q)) partial.push({ id, ...info });
  });
  const byPrice = (a, b) => (b.price > 0) - (a.price > 0);
  return [...exact.sort(byPrice), ...partial.sort(byPrice)].slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Balances                                                            */
/* ------------------------------------------------------------------ */

const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

/** Native NEAR: total, locked-by-storage and spendable (all yocto strings). */
export async function getNearBalance(accountId) {
  const account = await viewAccount(accountId);
  const amount = toBigInt(account.amount);
  const storage = BigInt(account.storage_usage || 0) * STORAGE_PRICE_PER_BYTE;
  const available = amount > storage ? amount - storage : 0n;
  return {
    total: amount.toString(),
    storage: storage.toString(),
    available: available.toString()
  };
}

export async function getFtBalance(tokenId, accountId) {
  const contract = tokenId === NATIVE_NEAR.id ? CONTRACTS.wrapNear : tokenId;
  const raw = await view(contract, 'ft_balance_of', { account_id: accountId }, { fresh: true });
  return String(raw ?? '0');
}

/**
 * All balances for an account: { near: availableYocto, [tokenId]: raw }.
 * Uses FastNEAR's FT index, with a direct RPC read as fallback per token.
 */
export async function getAllBalances(accountId) {
  const [near, fts] = await Promise.all([
    getNearBalance(accountId),
    fetch(`${ENDPOINTS.fastnear}/v1/account/${encodeURIComponent(accountId)}/ft`)
      .then((r) => (r.ok ? r.json() : { tokens: [] }))
      .catch(() => ({ tokens: [] }))
  ]);

  const balances = { [NATIVE_NEAR.id]: near.available };
  (fts.tokens || []).forEach((token) => {
    if (token?.contract_id && token.balance && token.balance !== '0') {
      balances[token.contract_id] = String(token.balance);
    }
  });
  return { balances, near };
}
