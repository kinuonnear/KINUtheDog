// Classic pool (AMM / Stable / ALMM, v2.ref-finance.near) position history and PnL.
//
// The exchange logs every deposit and withdrawal of a wallet:
//   add_liquidity          "Liquidity added ["<raw> <token>", …], minted <shares> shares"
//   add_stable_liquidity   "Mint <shares> shares for <account>, …"   (amounts from the call's args)
//   remove_liquidity       "<shares> shares of liquidity removed: receive back ["<raw> <token>", …]"
// Replaying them per pool gives what went in and came out; valued with Intear's USD candles at the
// time of each event, that is the position's PnL. AMM fees compound into the shares, so the fees
// earned are how much the pool's value per share (√(x·y) / shares) grew since the deposits.
//
//   NearBlocks -> the wallet's transactions to the exchange      FastNEAR -> their receipts and logs
// Parsed events are cached in localStorage per account; later loads only read what is new.

import { CONTRACTS } from '../config.js';
import { getTransactions } from './fastnearTx.js';
import { loadPriceHistory, priceAt } from './lpHistory.js';
import { toNumber } from './format.js';

const NEARBLOCKS = 'https://api.nearblocks.io/v1';
const PAGE_SIZE = 25; // NearBlocks' free API rejects larger pages
const MAX_PAGES = 8; // 200 most recent transactions to the exchange
const TX_BATCH = 20;
const CACHE_PREFIX = 'kinu.ammhist.v1.';
const METHODS = /^(add_liquidity|add_stable_liquidity|remove_liquidity)$/;

function readCache(account) {
  try {
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
    // quota: the in-memory result is still used
  }
}

/** New successful liquidity transactions to the exchange (newest first) not in `seen`. */
async function listNewTxs(account, seen) {
  const fresh = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ to: CONTRACTS.exchange, per_page: String(PAGE_SIZE) });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(`${NEARBLOCKS}/account/${encodeURIComponent(account)}/txns-only?${params}`);
    if (!response.ok) throw new Error(response.status === 429 ? 'History source is busy — try again in a minute.' : `History HTTP ${response.status}`);
    const json = await response.json();
    const txns = json.txns || [];
    for (const t of txns) {
      if (seen.has(t.transaction_hash)) return { fresh, complete: true };
      const relevant = t.outcomes?.status !== false && (t.actions || []).some((a) => METHODS.test(a.method || ''));
      fresh.push({ hash: t.transaction_hash, relevant });
    }
    if (!json.cursor || txns.length < PAGE_SIZE) return { fresh, complete: true };
    cursor = json.cursor;
  }
  return { fresh, complete: false };
}

/** "["123 a.near", "456 b.near"]" -> { 'a.near': '123', 'b.near': '456' } */
function parseAmounts(text) {
  const out = {};
  for (const m of String(text).matchAll(/"(\d+) ([^"]+)"/g)) out[m[2]] = m[1];
  return out;
}

function decodeArgs(base64) {
  try {
    return JSON.parse(atob(base64));
  } catch {
    return {};
  }
}

/** The account's add / remove events in classic pools, from a batch of transactions. */
async function fetchEvents(account, hashes) {
  const transactions = await getTransactions(hashes);
  const events = [];
  transactions.forEach((tx) => {
    const hash = tx.transaction?.hash;
    (tx.receipts || []).forEach((rc, ri) => {
      if (rc.receipt?.receiver_id !== CONTRACTS.exchange || rc.receipt?.predecessor_id !== account) return;
      const outcome = rc.execution_outcome?.outcome;
      if (!outcome || outcome.status?.Failure) return;
      const ts = Math.floor(Number(rc.execution_outcome.block_timestamp) / 1e6);
      const calls = (rc.receipt.receipt?.Action?.actions || []).map((a) => a.FunctionCall).filter((c) => c && METHODS.test(c.method_name));
      const logs = outcome.logs || [];
      calls.forEach((call, ci) => {
        const args = decodeArgs(call.args);
        const pool = String(args.pool_id);
        const base = { hash, ts, seq: ri * 100 + ci, pool };
        if (call.method_name === 'add_liquidity') {
          const log = logs.map((l) => l.match(/^Liquidity added \[(.*)\], minted (\d+) shares/)).filter(Boolean)[ci] || null;
          if (log) events.push({ ...base, kind: 'add', amounts: parseAmounts(log[1]), shares: log[2] });
        } else if (call.method_name === 'add_stable_liquidity') {
          const log = logs.map((l) => l.match(/^Mint (\d+) shares/)).filter(Boolean)[ci] || null;
          if (log) events.push({ ...base, kind: 'add', amounts: null, rawAmounts: (args.amounts || []).map(String), shares: log[1] });
        } else {
          const log = logs.map((l) => l.match(/^(\d+) shares of liquidity removed: receive back \[(.*)\]/)).filter(Boolean)[ci] || null;
          if (log) events.push({ ...base, kind: 'remove', amounts: parseAmounts(log[2]), shares: log[1] });
        }
      });
    });
  });
  return events;
}

const inflight = new Map();

/** Every classic-pool add / remove of an account, oldest first (cached, incremental). */
export function loadAmmEvents(account) {
  if (inflight.has(account)) return inflight.get(account);
  const job = (async () => {
    const cache = readCache(account);
    let listed;
    try {
      listed = await listNewTxs(account, new Set(cache.seen));
    } catch (error) {
      if (cache.events.length) return { events: cache.events, complete: cache.complete };
      throw error;
    }
    const hashes = listed.fresh.filter((t) => t.relevant).map((t) => t.hash);
    const events = [];
    for (let i = 0; i < hashes.length; i += TX_BATCH) events.push(...(await fetchEvents(account, hashes.slice(i, i + TX_BATCH))));
    const unique = new Map([...cache.events, ...events].map((e) => [`${e.hash}:${e.seq}`, e]));
    const sorted = [...unique.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const complete = cache.complete || listed.complete;
    writeCache(account, { complete, seen: [...new Set([...listed.fresh.map((t) => t.hash), ...cache.seen])], events: sorted });
    return { events: sorted, complete };
  })().finally(() => inflight.delete(account));
  inflight.set(account, job);
  return job;
}

/** Pool value per share in raw units: √(Π reserves)^(1/n) per share, the number only fees grow. */
function perShare(amounts, shares) {
  const n = amounts.length;
  const s = Number(shares);
  if (!n || !(s > 0)) return null;
  const logSum = amounts.reduce((sum, a) => sum + Math.log(Number(a) || 0), 0);
  if (!Number.isFinite(logSum)) return null;
  return Math.exp(logSum / n) / s;
}

/**
 * PnL of one classic pool position. `pool`: getPool(); `tokens`: token metadata in pool order;
 * `userAmounts` / `userShares`: the position now (getClassicPositions). Returns null without history.
 *   deposited / withdrawn: USD at the time of each event; value: USD now
 *   pnl = value + withdrawn − deposited;  vsHold = (value + withdrawn tokens now) − deposited tokens now
 *   feeGrowth: fraction the value per share grew since the (share-weighted) deposits
 */
export async function ammPositionPnl({ events, pool, tokens, userAmounts, userShares, prices }) {
  const mine = events.filter((e) => e.pool === String(pool.id));
  if (!mine.length) return null;
  const ids = pool.tokenIds;
  const history = await loadPriceHistory(ids, mine[0].ts);
  const now = Date.now();
  const amountsOf = (e) => (e.amounts ? ids.map((id) => e.amounts[id] || '0') : e.rawAmounts || ids.map(() => '0'));
  const usdOf = (raws, ts) => raws.reduce((sum, raw, i) => sum + toNumber(raw, tokens[i].decimals) * priceAt(history, prices, ids[i], ts), 0);

  let deposited = 0;
  let withdrawn = 0;
  const tokensIn = ids.map(() => 0);
  const tokensOut = ids.map(() => 0);
  let entryWeight = 0;
  let entrySum = 0;
  mine.forEach((e) => {
    const raws = amountsOf(e);
    if (e.kind === 'add') {
      deposited += usdOf(raws, e.ts);
      raws.forEach((raw, i) => (tokensIn[i] += toNumber(raw, tokens[i].decimals)));
      const ps = perShare(raws, e.shares);
      if (ps) {
        entrySum += ps * Number(e.shares);
        entryWeight += Number(e.shares);
      }
    } else {
      withdrawn += usdOf(raws, e.ts);
      raws.forEach((raw, i) => (tokensOut[i] += toNumber(raw, tokens[i].decimals)));
    }
  });

  const value = usdOf(userAmounts, now);
  const priceNow = ids.map((id) => priceAt(history, prices, id, now));
  const hold = tokensIn.reduce((s, a, i) => s + a * priceNow[i], 0);
  const outNow = tokensOut.reduce((s, a, i) => s + a * priceNow[i], 0);
  // √(x·y) only measures fees in constant-product pools; stable curves differ.
  const constantProduct = pool.kind === 'SIMPLE_POOL';
  const entry = constantProduct && entryWeight > 0 ? entrySum / entryWeight : null;
  const current = constantProduct ? perShare(pool.amounts, pool.sharesTotalSupply) : null;
  return {
    deposited,
    withdrawn,
    value,
    pnl: value + withdrawn - deposited,
    pnlPct: deposited > 0 ? ((value + withdrawn - deposited) / deposited) * 100 : null,
    vsHold: value + outNow - hold,
    feeGrowth: entry && current ? current / entry - 1 : null,
    since: mine[0].ts,
    events: mine.length,
    hasShares: Number(userShares) > 0
  };
}
