// CLMM (DCL) position history rebuilt from on-chain events.
//
// Every add / remove on dclv2.ref-labs.near emits a NEP-297 event
// (standard "dcl.ref"): `liquidity_added` carries the tokens paid in,
// `liquidity_removed` the tokens refunded and the fees claimed, and `liquidity_append`
// (adding to an existing position: Add to position, Compound) the tokens paid in plus the
// fees the contract pays to the wallet at that moment. Replaying those
// per position (lpt_id) gives open time, invested amount, withdrawals, claimed
// fees and realized PnL; entry / exit values use Intear's hourly USD candles at
// the time of each event.
//
//   NearBlocks  -> list of the account's transactions to the DCL contract
//                  (FastNEAR's account index when NearBlocks is rate-limited)
//   FastNEAR    -> the receipts (and event logs) of those transactions
//
// Parsed events are cached in localStorage per account: transactions never
// change, so later loads only fetch what is new.

import { CONTRACTS } from '../config.js';
import { fetchOhlc } from './intear.js';
import { toNumber } from './format.js';
import { getTransactions } from './fastnearTx.js';

const NEARBLOCKS = 'https://api.nearblocks.io/v1';
// NearBlocks' free API rejects pages above 25 transactions (HTTP 429).
const PAGE_SIZE = 25;
const MAX_PAGES = 40; // 1,000 most recent DCL transactions
// An unfinished history (e.g. NearBlocks rate-limited the first read) is completed a few pages per
// visit from where it stopped, instead of re-reading every page from the newest each time.
const BACKFILL_PAGES = 8;
const TX_BATCH = 20; // FastNEAR limit per request
// v2: liquidity_append events are kept too (v1 caches skipped them, so history is re-read once).
const CACHE_PREFIX = 'kinu.lphist.v2.';
const HOUR = 3_600_000;
const DAY = 86_400_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, init, { retries = 3, backoff = 6_000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await wait(backoff * (attempt + 1));
      continue;
    }
    throw new Error(res.status === 429 ? 'History source is busy — try again in a minute.' : `History HTTP ${res.status}`);
  }
}

function readCache(account) {
  try {
    localStorage.removeItem(`kinu.lphist.v1.${account}`); // superseded by v2
    const raw = JSON.parse(localStorage.getItem(CACHE_PREFIX + account) || 'null');
    if (raw && Array.isArray(raw.events) && Array.isArray(raw.seen)) return raw;
  } catch {
    // ignore
  }
  return { complete: false, seen: [], events: [], cursor: null };
}

function writeCache(account, cache) {
  try {
    localStorage.setItem(CACHE_PREFIX + account, JSON.stringify(cache));
  } catch {
    // quota: the in-memory result is still returned
  }
}

const LIQUIDITY_METHOD = /liquidity/;

const FASTNEAR_ACCOUNT = 'https://tx.main.fastnear.com/v0/account';
const FALLBACK_PAGES = 2; // 400 most recent signed transactions

/**
 * Fallback when NearBlocks is rate-limited: the account's recent signed transactions from
 * FastNEAR. That list carries no receiver or method, so every new one is read (fetchEvents
 * keeps only DCL liquidity events). It counts as complete only when it reached the account's first
 * signed transaction (a small wallet's whole history fits in its pages).
 */
async function listViaFastnear(account, cache) {
  const seen = new Set(cache.seen);
  const fresh = [];
  let resume = null;
  let reachedEnd = false;
  for (let page = 0; page < FALLBACK_PAGES; page += 1) {
    const json = await fetchJson(
      FASTNEAR_ACCOUNT,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: account, is_signer: true, limit: 200, desc: true, ...(resume ? { resume_token: resume } : {}) })
      },
      { retries: 1, backoff: 2_000 }
    );
    const txs = json.account_txs || [];
    let caughtUp = false;
    for (const t of txs) {
      if (seen.has(t.transaction_hash)) {
        caughtUp = true;
        break;
      }
      fresh.push({ hash: t.transaction_hash, relevant: t.is_success !== false });
    }
    if (caughtUp) break;
    if (!json.resume_token || txs.length < 200) {
      reachedEnd = true;
      break;
    }
    resume = json.resume_token;
  }
  return { fresh, complete: cache.complete || reachedEnd };
}

/** New successful liquidity transactions (newest first) not in `seen`; FastNEAR if NearBlocks is busy. */
async function listNewTxs(account, cache) {
  try {
    return await listViaNearblocks(account, cache);
  } catch (error) {
    try {
      return await listViaFastnear(account, cache);
    } catch {
      throw error;
    }
  }
}

/**
 * One run of NearBlocks pages from `cursor` ('' = newest): stops at a transaction already seen
 * (`stopAtSeen`), at the end of the history, or after `maxPages`. Returns the new transactions,
 * whether the end was reached and the cursor to continue from.
 */
async function nearblocksPages(account, seen, { cursor = '', maxPages, stopAtSeen }) {
  const fresh = [];
  let next = cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      to: CONTRACTS.dcl,
      per_page: String(PAGE_SIZE)
    });
    if (next) params.set('cursor', next);
    // One quick retry: if NearBlocks stays busy, FastNEAR takes over (listNewTxs).
    const json = await fetchJson(`${NEARBLOCKS}/account/${encodeURIComponent(account)}/txns-only?${params}`, undefined, { retries: 1, backoff: 3_000 });
    const txns = json.txns || [];
    let caughtUp = false;
    for (const t of txns) {
      if (seen.has(t.transaction_hash)) {
        if (stopAtSeen) {
          caughtUp = true;
          break;
        }
        continue;
      }
      const relevant = t.outcomes?.status !== false && (t.actions || []).some((a) => LIQUIDITY_METHOD.test(a.method || ''));
      fresh.push({ hash: t.transaction_hash, relevant });
    }
    if (caughtUp) return { fresh, reachedEnd: false, cursor: next, caughtUp: true };
    if (!json.cursor || txns.length < PAGE_SIZE) return { fresh, reachedEnd: true, cursor: null, caughtUp: false };
    next = json.cursor;
  }
  return { fresh, reachedEnd: false, cursor: next, caughtUp: false };
}

async function listViaNearblocks(account, cache) {
  const seen = new Set(cache.seen);
  // Newest first, until a transaction this browser already read: new activity since last time.
  const head = await nearblocksPages(account, seen, { maxPages: MAX_PAGES, stopAtSeen: seen.size > 0 });
  if (cache.complete || head.reachedEnd) return { fresh: head.fresh, complete: true, cursor: null };
  // Unfinished: the first read continues from where it stopped; a known history keeps its cursor.
  return { fresh: head.fresh, complete: false, cursor: seen.size ? cache.cursor || null : head.cursor };
}

const big = (v) => Number(v || 0);

/** a − b for raw token amounts (strings), never below 0. */
function minusRaw(a, b) {
  try {
    const d = BigInt(a || '0') - BigInt(b || '0');
    return (d > 0n ? d : 0n).toString();
  } catch {
    return a || '0';
  }
}

/** dcl.ref events owned by `account` from a batch of transactions. */
async function fetchEvents(account, hashes) {
  // Shared with the token PnL, which reads many of the same transactions (lib/fastnearTx.js).
  const transactions = await getTransactions(hashes);
  const events = [];
  transactions.forEach((tx) => {
    const hash = tx.transaction?.hash;
    (tx.receipts || []).forEach((rc, ri) => {
      if (rc.receipt?.receiver_id !== CONTRACTS.dcl) return;
      const outcome = rc.execution_outcome?.outcome;
      if (!outcome || outcome.status?.Failure) return;
      const ts = Math.floor(Number(rc.execution_outcome.block_timestamp) / 1e6);
      (outcome.logs || []).forEach((log, li) => {
        if (!log.startsWith('EVENT_JSON:')) return;
        let e;
        try {
          e = JSON.parse(log.slice(11));
        } catch {
          return;
        }
        if (e.standard !== 'dcl.ref' || !['liquidity_added', 'liquidity_removed', 'liquidity_append'].includes(e.event)) return;
        (e.data || []).forEach((d, di) => {
          if (d.owner_id !== account) return;
          const base = {
            hash,
            ts,
            seq: ri * 1000 + li * 10 + di,
            lpt: d.lpt_id,
            pool: d.pool_id,
            left: d.left_point,
            right: d.right_point,
            cur: d.cur_amount
          };
          if (e.event === 'liquidity_append') {
            events.push({
              ...base,
              kind: 'append',
              delta: d.added_amount,
              x: d.paid_token_x,
              y: d.paid_token_y,
              feeX: d.claim_fee_token_x,
              feeY: d.claim_fee_token_y
            });
            return;
          }
          events.push(
            e.event === 'liquidity_added'
              ? {
                  ...base,
                  kind: 'add',
                  delta: d.added_amount,
                  x: d.paid_token_x,
                  y: d.paid_token_y
                }
              : {
                  ...base,
                  kind: 'remove',
                  delta: d.removed_amount,
                  x: d.refund_token_x,
                  y: d.refund_token_y,
                  feeX: d.claim_fee_token_x,
                  feeY: d.claim_fee_token_y
                }
          );
        });
      });
    });
  });
  return events;
}

const inflight = new Map();

/** All DCL liquidity events of an account, oldest first (cached + incremental). */
export function loadDclEvents(account) {
  if (inflight.has(account)) return inflight.get(account);
  const job = (async () => {
    const cache = readCache(account);
    let listed;
    try {
      listed = await listNewTxs(account, cache);
    } catch (error) {
      // The index is busy: what was cached is still right, only possibly not the newest.
      if (cache.events.length) return { events: cache.events, complete: cache.complete, stale: true };
      throw error;
    }
    const { fresh, complete } = listed;
    // Where an unfinished NearBlocks history continues next time (kept when this read didn't say).
    const cursor = listed.cursor !== undefined ? listed.cursor : cache.cursor || null;
    const toFetch = fresh.filter((t) => t.relevant).map((t) => t.hash);
    const events = [];
    for (let i = 0; i < toFetch.length; i += TX_BATCH * 3) {
      const chunk = [];
      for (let j = i; j < Math.min(i + TX_BATCH * 3, toFetch.length); j += TX_BATCH) chunk.push(toFetch.slice(j, j + TX_BATCH));
      (await Promise.all(chunk.map((hashes) => fetchEvents(account, hashes)))).forEach((list) => events.push(...list));
    }
    const all = [...cache.events, ...events];
    const unique = new Map(all.map((e) => [`${e.hash}:${e.seq}`, e]));
    const sorted = [...unique.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const next = {
      complete,
      cursor: complete ? null : cursor,
      seen: [...new Set([...fresh.map((t) => t.hash), ...cache.seen])],
      events: sorted
    };
    writeCache(account, next);
    if (!complete) setTimeout(() => backfill(account), 2_000);
    return { events: sorted, complete };
  })().finally(() => inflight.delete(account));
  inflight.set(account, job);
  return job;
}

/**
 * Completes an unfinished history in the background, a few NearBlocks pages per visit from the
 * saved cursor (or from the newest when there is none), so a page never waits for it. A busy
 * NearBlocks just leaves it for the next visit.
 */
const backfilling = new Set();
async function backfill(account) {
  if (backfilling.has(account) || inflight.has(account)) return;
  backfilling.add(account);
  try {
    const cache = readCache(account);
    if (cache.complete) return;
    const seen = new Set(cache.seen);
    const tail = await nearblocksPages(account, seen, { cursor: cache.cursor || '', maxPages: BACKFILL_PAGES, stopAtSeen: false });
    const toFetch = tail.fresh.filter((t) => t.relevant).map((t) => t.hash);
    const events = [];
    for (let i = 0; i < toFetch.length; i += TX_BATCH) events.push(...(await fetchEvents(account, toFetch.slice(i, i + TX_BATCH))));
    const latest = readCache(account); // a visit may have added newer events meanwhile
    const unique = new Map([...latest.events, ...events].map((e) => [`${e.hash}:${e.seq}`, e]));
    writeCache(account, {
      complete: tail.reachedEnd,
      cursor: tail.reachedEnd ? null : tail.cursor,
      seen: [...new Set([...latest.seen, ...tail.fresh.map((t) => t.hash)])],
      events: [...unique.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq)
    });
  } catch {
    // busy: next visit
  } finally {
    backfilling.delete(account);
  }
}

/** Hourly USD candles (daily for anything older) per token, for valuing past events. */
const candleCache = new Map(); // "id:resolution:count" -> Promise<candles>

function candles(tokenId, resolution, countBack) {
  const key = `${tokenId}:${resolution}:${countBack}`;
  if (!candleCache.has(key)) candleCache.set(key, fetchOhlc({ tokenId, resolution, countBack }).catch(() => []));
  return candleCache.get(key);
}

export async function loadPriceHistory(tokenIds, sinceMs) {
  const now = Date.now();
  const hours = Math.min(3000, Math.ceil((now - sinceMs) / HOUR) + 4);
  const days = Math.ceil((now - sinceMs) / DAY) + 2;
  const needDaily = now - sinceMs > hours * HOUR;
  const out = {};
  const queue = [...tokenIds];
  // A few requests at a time: a long trade history can touch dozens of tokens.
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const [hourly, daily] = await Promise.all([candles(id, '60', hours), needDaily ? candles(id, '1D', days) : []]);
      const firstHourly = hourly[0]?.time ?? Infinity;
      out[id] = [...daily.filter((c) => c.time < firstHourly), ...hourly].map((c) => [c.time * 1000, c.close]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  return out;
}

/** USD price of a token at `ts` (ms) — last candle at or before it, else the current price. */
export function priceAt(history, prices, id, ts) {
  const series = history[id];
  if (series?.length) {
    let lo = 0;
    let hi = series.length - 1;
    if (ts < series[0][0]) return series[0][1];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (series[mid][0] <= ts) lo = mid;
      else hi = mid - 1;
    }
    return series[lo][1];
  }
  return prices?.get(id)?.price || 0;
}

/**
 * Replays the events into per-position ledgers, plus a daily series of realized
 * PnL and claimed fees (UTC days, oldest first) for the dashboard chart.
 * `meta(id)` gives token decimals; `history` comes from loadPriceHistory.
 */
export function buildHistory(events, meta, history, prices) {
  const ledgers = new Map();
  const days = new Map();
  events.forEach((e) => {
    const [tokenX, tokenY] = e.pool.split('|');
    let l = ledgers.get(e.lpt);
    if (!l) {
      l = {
        lptId: e.lpt,
        poolId: e.pool,
        tokenX,
        tokenY,
        leftPoint: e.left,
        rightPoint: e.right,
        openedAt: null,
        closedAt: null,
        openHash: null, // the transaction that opened the position
        closeHash: null, // the one that removed the last of it
        liquidity: 0,
        costUsd: 0, // basis of the liquidity still in the position
        investedUsd: 0, // everything ever added
        withdrawnUsd: 0, // tokens returned on removals (excluding fees)
        feesUsd: 0, // fees claimed
        realizedUsd: 0, // withdrawals minus the basis they released
        complete: true
      };
      ledgers.set(e.lpt, l);
    }
    const dx = meta(tokenX).decimals;
    const dy = meta(tokenY).decimals;
    const usd = (rx, ry) =>
      toNumber(rx || '0', dx) * priceAt(history, prices, tokenX, e.ts) + toNumber(ry || '0', dy) * priceAt(history, prices, tokenY, e.ts);
    if (e.kind === 'add') {
      if (l.openedAt === null) {
        l.openedAt = e.ts;
        l.openHash = e.hash;
      }
      const value = usd(e.x, e.y);
      l.costUsd += value;
      l.investedUsd += value;
      l.liquidity += big(e.delta);
      l.closedAt = null;
      return;
    }
    if (e.kind === 'append') {
      // More tokens in (new cost) and, at the same moment, the unclaimed fees paid to the wallet.
      if (l.openedAt === null) l.complete = false; // opened before the loaded history
      const value = usd(e.x, e.y);
      const fees = usd(e.feeX, e.feeY);
      l.costUsd += value;
      l.investedUsd += value;
      l.feesUsd += fees;
      l.liquidity = big(e.cur) || l.liquidity + big(e.delta);
      l.closedAt = null;
      const day = Math.floor(e.ts / DAY) * DAY;
      const row = days.get(day) || { time: day / 1000, pnl: 0, fees: 0 };
      if (l.complete) row.pnl += fees;
      row.fees += fees;
      days.set(day, row);
      return;
    }
    // A removal before any add means the position predates the loaded history.
    if (l.openedAt === null) l.complete = false;
    const before = Math.max(l.liquidity, big(e.delta) + big(e.cur));
    const share = before > 0 ? Math.min(1, big(e.delta) / before) : 0;
    const released = l.costUsd * share;
    // liquidity_removed's refund_token_x / _y already include the fees claimed with it (a claim is a
    // removal of 0 whose refund equals claim_fee): the principal coming back is refund − fees.
    const out = usd(minusRaw(e.x, e.feeX), minusRaw(e.y, e.feeY));
    const fees = usd(e.feeX, e.feeY);
    l.costUsd -= released;
    l.withdrawnUsd += out;
    l.realizedUsd += out - released;
    l.feesUsd += fees;
    l.liquidity = big(e.cur);
    if (big(e.cur) === 0 && big(e.delta) > 0) {
      l.closedAt = e.ts;
      l.closeHash = e.hash;
    }

    const day = Math.floor(e.ts / DAY) * DAY;
    const row = days.get(day) || { time: day / 1000, pnl: 0, fees: 0 };
    if (l.complete) row.pnl += out - released + fees;
    row.fees += fees;
    days.set(day, row);
  });
  return { ledgers, days: [...days.values()].sort((a, b) => a.time - b.time) };
}

/**
 * Whether a live position's liquidity matches what its history says (the last event's amount):
 * a deposit or removal the index hasn't delivered yet (e.g. "+" Add liquidity on an existing
 * position) would otherwise price the new tokens as profit. Positions without events count as
 * matching here (they are "not indexed yet" instead).
 */
export function historyMatches(position, events) {
  let last = null;
  (events || []).forEach((e) => {
    if (e.lpt === position.id) last = e;
  });
  if (!last) return true;
  const live = Number(position.liquidity || 0);
  const known = Number(last.cur || 0);
  return Math.abs(live - known) <= Math.max(1, Math.abs(live) * 1e-9);
}

export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}
