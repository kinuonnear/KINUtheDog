// Live feed for Discover: swaps on Rhea pools, newest first (Intear's trade feed).
//   Everyone   — the global feed (latest ~50 trades per request), merged as it streams in;
//   Big buys   — buys ≥ BIG_BUY_USD of the most active tokens, filtered on the server;
//   Following  — each followed trader's own recent trades, filtered on the server.
// Kept light on purpose: each source polls only while its view is open and the browser tab is
// visible; lists in memory are bounded; token data comes from shared caches.

import { useEffect, useState } from 'react';
import { backgroundRefreshAllowed } from './walletActivity.js';
import { fetchTrades } from './intear.js';
import { getPoolRadar } from './poolRadar.js';
import { BASE_TOKENS } from './trending.js';

const KEEP = 200;
const KEEP_BIG = 50; // big buys seen live stay longer than the rolling window

export const FEED_MIN_SIZES = [0, 10, 100, 1000];
export const BIG_BUY_USD = 250;
export const BIG_BUY_TOKENS = 8; // most active tokens checked for big buys
export const MAX_FOLLOW_POLL = 15; // followed traders whose history is loaded

const isBigBuy = (t) => t.side === 'buy' && t.usd >= BIG_BUY_USD;
const newestFirst = (a, b) => b.time - a.time;

/**
 * Runs `load()` now and every `ms` while `enabled` and the tab is visible; `merge(prev, fresh)`
 * builds the next list. Returns { trades, error, loading }.
 */
function usePolled(load, merge, { enabled, ms, key }) {
  const [state, setState] = useState({ trades: [], error: null, loading: true });

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let busy = false;
    setState((s) => ({ ...s, loading: true }));
    // The first load always runs; later ones only while the tab is visible.
    const tick = async (force = false) => {
      if (busy || (!force && !backgroundRefreshAllowed())) return;
      busy = true;
      try {
        const fresh = await load();
        if (alive) setState((s) => ({ trades: merge(s.trades, fresh), error: null, loading: false }));
      } catch (error) {
        if (alive) setState((s) => ({ ...s, error, loading: false }));
      } finally {
        busy = false;
      }
    };
    tick(true);
    const timer = setInterval(() => tick(), ms);
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ms, key]);

  return state;
}

/** Everyone: the global feed, merged into a rolling list (big buys kept a little longer). */
export function useLiveTrades(enabled) {
  return usePolled(
    () => fetchTrades({ limit: 60 }),
    (prev, fresh) => {
      const byId = new Map(prev.map((t) => [t.id, t]));
      fresh.forEach((t) => byId.set(t.id, t));
      const sorted = [...byId.values()].sort(newestFirst);
      const olderBig = sorted.slice(KEEP).filter(isBigBuy).slice(0, KEEP_BIG);
      return [...sorted.slice(0, KEEP), ...olderBig];
    },
    { enabled, ms: 6_000, key: 'all' }
  );
}

/** Tokens (not NEAR / stablecoins) of the most active Rhea pools, by 24h volume. */
async function activeTokens() {
  const rows = await getPoolRadar();
  const ids = [];
  rows.forEach((p) =>
    p.tokenIds.forEach((id) => {
      if (!BASE_TOKENS.has(id) && !ids.includes(id)) ids.push(id);
    })
  );
  return ids.slice(0, BIG_BUY_TOKENS);
}

const snapshot = (limit) => (prev, fresh) => {
  const byId = new Map(fresh.flat().map((t) => [t.id, t]));
  return [...byId.values()].sort(newestFirst).slice(0, limit);
};

/** Big buys: recent buys ≥ BIG_BUY_USD of the most active tokens (one request per token). */
export function useBigBuys(enabled) {
  return usePolled(
    async () => {
      const tokens = await activeTokens();
      return Promise.all(tokens.map((tokenId) => fetchTrades({ tokenId, side: 'buy', minUsd: BIG_BUY_USD, limit: 20 }).catch(() => [])));
    },
    snapshot(80),
    { enabled, ms: 60_000, key: 'big' }
  );
}

/** Following: each followed trader's latest trades (first MAX_FOLLOW_POLL traders). */
export function useFollowedTrades(enabled, traders) {
  const list = traders.slice(0, MAX_FOLLOW_POLL);
  return usePolled(
    () => Promise.all(list.map((trader) => fetchTrades({ trader, limit: 20 }).catch(() => []))),
    snapshot(150),
    { enabled: enabled && list.length > 0, ms: 30_000, key: list.join(',') }
  );
}

const FEED_BASE = new Set([...BASE_TOKENS, 'near']);

/**
 * Shows a swap from the side of the token that is not NEAR / a stablecoin: a trader query can
 * return "sold $X of wNEAR" for what is "bought $X of TOKEN".
 */
function normalizeTrade(t) {
  if (!FEED_BASE.has(t.token) || !t.counterparty || FEED_BASE.has(t.counterparty)) return t;
  return {
    ...t,
    token: t.counterparty,
    amountRaw: t.counterpartyAmountRaw,
    counterparty: t.token,
    counterpartyAmountRaw: t.amountRaw,
    side: t.side === 'buy' ? 'sell' : 'buy'
  };
}

/** Merges trade lists (newest first, no duplicates), each swap shown from its non-base token. */
export function mergeTrades(...lists) {
  const byId = new Map(lists.flat().map((t) => [t.id, normalizeTrade(t)]));
  return [...byId.values()].sort(newestFirst);
}

/** Feed filters: sub-tab (everyone / big / following), minimum USD size, NEAR & stablecoin trades. */
export function filterFeed(trades, { view, minUsd, showBase, following, baseTokens }) {
  return trades.filter((t) => {
    if (t.usd < minUsd) return false;
    if (view === 'big' && !isBigBuy(t)) return false;
    if (view === 'following' && !following.includes(t.trader)) return false;
    // Swaps whose traded token is NEAR or a stablecoin are mostly arbitrage bots.
    if (!showBase && view !== 'following' && baseTokens.has(t.token)) return false;
    return true;
  });
}

/** Loose check for a NEAR account id (named or 64-hex implicit). */
export const isAccountId = (id) => /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id) && id.length >= 2 && id.length <= 64;
