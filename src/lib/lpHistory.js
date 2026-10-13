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
//   FastNEAR    -> the receipts (and event logs) of those transactions
//
// Parsed events are cached in localStorage per account: transactions never
// change, so later loads only fetch what is new.

import { CONTRACTS } from '../config.js';
import { fetchOhlc } from './intear.js';
import { toNumber } from './format.js';

const NEARBLOCKS = 'https://api.nearblocks.io/v1';
const FASTNEAR_TX = 'https://tx.main.fastnear.com/v0/transactions';
const PAGE_SIZE = 250;
const MAX_PAGES = 8; // 2,000 most recent DCL transactions
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
  return { complete: false, seen: [], events: [] };
}

function writeCache(account, cache) {
  try {
    localStorage.setItem(CACHE_PREFIX + account, JSON.stringify(cache));
  } catch {
    // quota: the in-memory result is still returned
  }
}

const LIQUIDITY_METHOD = /liquidity/;

/** New successful liquidity transactions (newest first) not in `seen`. */
async function listNewTxs(account, cache) {
  const seen = new Set(cache.seen);
  const fresh = [];
  let cursor = '';
  let reachedEnd = false;
  let caughtUp = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      to: CONTRACTS.dcl,
      per_page: String(PAGE_SIZE)
    });
    if (cursor) params.set('cursor', cursor);
    const json = await fetchJson(`${NEARBLOCKS}/account/${encodeURIComponent(account)}/txns-only?${params}`);
    const txns = json.txns || [];
    for (const t of txns) {
      if (seen.has(t.transaction_hash)) {
        caughtUp = cache.complete;
        if (caughtUp) break;
        continue;
      }
      const relevant = t.outcomes?.status !== false && (t.actions || []).some((a) => LIQUIDITY_METHOD.test(a.method || ''));
      fresh.push({ hash: t.transaction_hash, relevant });
    }
    if (caughtUp) break;
    if (!json.cursor || txns.length < PAGE_SIZE) {
      reachedEnd = true;
      break;
    }
    cursor = json.cursor;
  }
  return { fresh, complete: cache.complete || reachedEnd };
}

const big = (v) => Number(v || 0);

/** dcl.ref events owned by `account` from a batch of transactions. */
async function fetchEvents(account, hashes) {
  const json = await fetchJson(FASTNEAR_TX, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx_hashes: hashes })
  });
  const events = [];
  (json.transactions || []).forEach((tx) => {
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
      seen: [...new Set([...fresh.map((t) => t.hash), ...cache.seen])],
      events: sorted
    };
    writeCache(account, next);
    return { events: sorted, complete };
  })().finally(() => inflight.delete(account));
  inflight.set(account, job);
  return job;
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
      if (l.openedAt === null) l.openedAt = e.ts;
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
    const out = usd(e.x, e.y);
    const fees = usd(e.feeX, e.feeY);
    l.costUsd -= released;
    l.withdrawnUsd += out;
    l.realizedUsd += out - released;
    l.feesUsd += fees;
    l.liquidity = big(e.cur);
    if (big(e.cur) === 0 && big(e.delta) > 0) l.closedAt = e.ts;

    const day = Math.floor(e.ts / DAY) * DAY;
    const row = days.get(day) || { time: day / 1000, pnl: 0, fees: 0 };
    if (l.complete) row.pnl += out - released + fees;
    row.fees += fees;
    days.set(day, row);
  });
  return { ledgers, days: [...days.values()].sort((a, b) => a.time - b.time) };
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
