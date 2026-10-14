// Token PnL from the account's own trades.
//
// Every transaction that moved one of the account's tokens is read from
// FastNEAR and reduced to "legs" (asset, signed amount):
//   - NEP-141 `ft_transfer` / `ft_mint` / `ft_burn` events (all modern tokens)
//   - wrap.near's plain-text "Transfer X from A to B" logs (wNEAR has no events)
//   - native NEAR sent with the transaction or received from a contract
// NEAR and wNEAR are one asset here; wrapping / unwrapping is not a trade.
//
// Legs are replayed in time order with an average-cost basis:
//   tokens out + tokens in in one tx -> a swap: what you got is bought at the
//                                       USD value of what you gave (and vice versa)
//   only in                            -> received (transfer, LP withdrawal, airdrop):
//                                       basis = market value at that time
//   only out                           -> sent away (transfer, LP deposit): leaves at
//                                       average cost, no profit or loss
// USD values use Intear hourly candles at the time of each transaction.

import { CONTRACTS } from '../config.js';
import { loadPriceHistory, priceAt } from './lpHistory.js';
import { toNumber } from './format.js';
import { getTransactions } from './fastnearTx.js';

const FASTNEAR = 'https://tx.main.fastnear.com/v0';
const MAX_PAGES = 15; // 3,000 most recent transactions
const TX_BATCH = 20; // FastNEAR limit per request
const PARALLEL = 2;
const CACHE_PREFIX = 'kinu.tokpnl.v2.';
const MIN_NEAR = 10n ** 22n; // 0.01 NEAR: smaller attached deposits are fees, not trades
const NOT_A_TRADE = new Set(['near_deposit', 'near_withdraw', 'storage_deposit', 'register_tokens', 'storage_withdraw']);
const NEAR_ASSET = CONTRACTS.wrapNear;
const WRAP_TRANSFER = /^Transfer (\d+) from (\S+) to (\S+)$/;
// Assets with dependable price history; a swap against one of them is valued by it.
const ANCHORS = new Set([
  NEAR_ASSET,
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // USDC
  'usdt.tether-token.near',
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near', // USDC.e
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near' // USDT.e
]);
const SUSPECT_RATIO = 3; // two sides of one swap differing more than this -> distrust the larger

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  for (let attempt = 0; ; attempt += 1) {
    let res = null;
    try {
      res = await fetch(`${FASTNEAR}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (error) {
      // "Failed to fetch": a rate limit answered without CORS headers, or a dropped connection.
      if (attempt < 4) {
        await wait(3_000 * (attempt + 1));
        continue;
      }
      throw new Error('Trade history is unreachable right now — try again shortly.', { cause: error });
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await wait(3_000 * (attempt + 1));
      continue;
    }
    throw new Error(`Trade history HTTP ${res.status}`);
  }
}

function readCache(account) {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_PREFIX + account) || 'null');
    if (raw && Array.isArray(raw.txs) && Array.isArray(raw.seen)) return raw;
  } catch {
    // ignore
  }
  return { complete: false, seen: [], txs: [] };
}

function writeCache(account, cache) {
  try {
    localStorage.setItem(CACHE_PREFIX + account, JSON.stringify(cache));
  } catch {
    // quota: the in-memory result is still returned
  }
}

/** Successful transactions of the account, newest first, not yet cached. */
async function listNewTxs(account, cache) {
  const seen = new Set(cache.seen);
  const fresh = [];
  let resume = null;
  let reachedEnd = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const json = await post('/account', { account_id: account, resume_token: resume });
    const list = json.account_txs || [];
    let caughtUp = false;
    for (const t of list) {
      if (seen.has(t.transaction_hash)) {
        if (cache.complete) {
          caughtUp = true;
          break;
        }
        continue;
      }
      // Every successful tx: NEAR / wNEAR moves only show up as plain-text logs, not events.
      if (t.is_success) fresh.push(t.transaction_hash);
    }
    if (caughtUp) break;
    if (!json.resume_token || !list.length) {
      reachedEnd = true;
      break;
    }
    resume = json.resume_token;
  }
  return { fresh, complete: cache.complete || reachedEnd };
}

/** Net token movements of `account` in one transaction: { ts, legs: { [asset]: rawString } }. */
function legsOf(account, tx) {
  const net = new Map();
  const add = (asset, amount) => net.set(asset, (net.get(asset) || 0n) + amount);
  const signer = tx.transaction?.signer_id;

  (tx.receipts || []).forEach((rc) => {
    const outcome = rc.execution_outcome?.outcome;
    if (!outcome || outcome.status?.Failure) return;
    const executor = rc.receipt?.receiver_id;
    const predecessor = rc.receipt?.predecessor_id;

    // Native NEAR received from a contract or another account (not gas refunds, not unwrapping).
    if (executor === account && predecessor !== 'system' && predecessor !== NEAR_ASSET && predecessor !== account) {
      (rc.receipt?.receipt?.Action?.actions || []).forEach((a) => {
        if (a.Transfer) add(NEAR_ASSET, BigInt(a.Transfer.deposit || 0));
      });
    }

    (outcome.logs || []).forEach((log) => {
      if (executor === NEAR_ASSET) {
        const m = WRAP_TRANSFER.exec(log);
        if (m) {
          if (m[2] === account) add(NEAR_ASSET, -BigInt(m[1]));
          if (m[3] === account) add(NEAR_ASSET, BigInt(m[1]));
        }
        return;
      }
      if (!log.startsWith('EVENT_JSON:')) return;
      let e;
      try {
        e = JSON.parse(log.slice(11));
      } catch {
        return;
      }
      if (e.standard !== 'nep141') return;
      (e.data || []).forEach((d) => {
        const amount = BigInt(d.amount || 0);
        if (e.event === 'ft_transfer') {
          if (d.old_owner_id === account) add(executor, -amount);
          if (d.new_owner_id === account) add(executor, amount);
        } else if (e.event === 'ft_mint' && d.owner_id === account) add(executor, amount);
        else if (e.event === 'ft_burn' && d.owner_id === account) add(executor, -amount);
      });
    });
  });

  // Native NEAR the account attached to its own transaction (e.g. a DEX's deposit_near).
  if (signer === account) {
    (tx.transaction.actions || []).forEach((a) => {
      if (a.Transfer && tx.transaction.receiver_id !== account) add(NEAR_ASSET, -BigInt(a.Transfer.deposit || 0));
      const call = a.FunctionCall;
      if (call && !NOT_A_TRADE.has(call.method_name) && BigInt(call.deposit || 0) >= MIN_NEAR) add(NEAR_ASSET, -BigInt(call.deposit));
    });
  }

  const legs = {};
  net.forEach((v, k) => {
    if (v !== 0n) legs[k] = v.toString();
  });
  return {
    hash: tx.transaction?.hash,
    ts: Math.floor(Number(tx.execution_outcome?.block_timestamp || 0) / 1e6),
    legs
  };
}

const inflight = new Map();

/** Token movements of an account, oldest first (cached + incremental). */
export function loadTokenMoves(account) {
  if (inflight.has(account)) return inflight.get(account);
  const job = (async () => {
    const cache = readCache(account);
    const { fresh, complete } = await listNewTxs(account, cache);
    const batches = [];
    for (let i = 0; i < fresh.length; i += TX_BATCH) batches.push(fresh.slice(i, i + TX_BATCH));
    const moves = [];
    const done = [];
    const merged = () => [...new Map([...cache.txs, ...moves].map((m) => [m.hash, m])).values()].sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < batches.length; i += PARALLEL) {
      const round = batches.slice(i, i + PARALLEL);
      // Shared with the LP history, which reads many of the same transactions (lib/fastnearTx.js).
      const results = await Promise.all(round.map(async (hashes) => ({ transactions: await getTransactions(hashes) })));
      results.forEach((json) =>
        (json.transactions || []).forEach((tx) => {
          const m = legsOf(account, tx);
          if (Object.keys(m.legs).length) moves.push(m);
        })
      );
      done.push(...round.flat());
      // Save progress: if a later request fails, the next load resumes from here.
      writeCache(account, { complete: false, seen: [...new Set([...done, ...cache.seen])], txs: merged() });
    }
    const txs = merged();
    writeCache(account, { complete, seen: [...new Set([...fresh, ...cache.seen])], txs });
    return { txs, complete };
  })().finally(() => inflight.delete(account));
  inflight.set(account, job);
  return job;
}

/**
 * Average-cost replay. `meta(id)` gives decimals; `history` comes from
 * loadPriceHistory; `prices` are current prices (fallback).
 * Returns Map<asset, { qty, cost, realized, bought, sold, trades }>.
 */
export function replayTrades(txs, meta, history, prices) {
  const book = new Map();
  const state = (id) => {
    if (!book.has(id)) book.set(id, { qty: 0, cost: 0, realized: 0, bought: 0, sold: 0, trades: 0 });
    return book.get(id);
  };
  const removeAtCost = (s, qty) => {
    const part = Math.min(qty, s.qty);
    const basis = s.qty > 0 ? (s.cost * part) / s.qty : 0;
    s.qty -= part;
    s.cost -= basis;
    if (s.qty < 1e-12) {
      s.qty = 0;
      s.cost = 0;
    }
    return { part, basis };
  };

  txs.forEach((t) => {
    const legs = Object.entries(t.legs).map(([id, raw]) => {
      const amount = toNumber(raw.replace('-', ''), meta(id).decimals) * (raw.startsWith('-') ? -1 : 1);
      const price = priceAt(history, prices, id, t.ts);
      return { id, amount, usd: Math.abs(amount) * price, priced: price > 0 };
    });
    const ins = legs.filter((l) => l.amount > 0);
    const outs = legs.filter((l) => l.amount < 0);
    const inUsd = ins.reduce((s, l) => s + l.usd, 0);
    const outUsd = outs.reduce((s, l) => s + l.usd, 0);

    if (ins.length && outs.length) {
      // A swap: each side is valued by the other. Anchor on NEAR / stablecoins when one side
      // is made of them; otherwise, when the sides disagree wildly, a broken candle is far
      // likelier than a 3x trade, so the smaller value wins.
      const anchorOut = outs.every((l) => ANCHORS.has(l.id) && l.priced);
      const anchorIn = ins.every((l) => ANCHORS.has(l.id) && l.priced);
      let paid = outUsd > 0 ? outUsd : inUsd;
      let got = inUsd > 0 ? inUsd : outUsd;
      if (anchorOut || anchorIn) {
        paid = anchorOut ? outUsd : inUsd;
        got = paid;
      } else if (outUsd > 0 && inUsd > 0 && Math.max(outUsd, inUsd) / Math.min(outUsd, inUsd) > SUSPECT_RATIO) {
        paid = Math.min(outUsd, inUsd);
        got = paid;
      }
      ins.forEach((l) => {
        const s = state(l.id);
        const share = inUsd > 0 ? l.usd / inUsd : 1 / ins.length;
        s.qty += l.amount;
        s.cost += paid * share;
        s.bought += paid * share;
        s.trades += 1;
      });
      outs.forEach((l) => {
        const s = state(l.id);
        const qty = -l.amount;
        const share = outUsd > 0 ? l.usd / outUsd : 1 / outs.length;
        const proceeds = got * share;
        const { part, basis } = removeAtCost(s, qty);
        // Only the part with a known basis produces realized PnL.
        if (part > 0) s.realized += (proceeds * part) / qty - basis;
        s.sold += proceeds;
        s.trades += 1;
      });
      return;
    }
    ins.forEach((l) => {
      // Received without paying: basis = market value at the time, capped at today's price
      // when the historical candle looks broken.
      const now = prices?.get(l.id)?.price || 0;
      const s = state(l.id);
      s.qty += l.amount;
      s.cost += now > 0 && l.usd > l.amount * now * 20 ? l.amount * now : l.usd;
    });
    outs.forEach((l) => removeAtCost(state(l.id), -l.amount));
  });
  return book;
}

/**
 * nearly.trade's own PnL for the tokens traded there (its launchpad tokens):
 * Map<tokenId, { bought, bag, basis_usd, realized_usd, unrealized_usd, pnl_usd, roi, buys, sells, ... }>.
 */
export async function loadNearlyPnl(account) {
  const res = await fetch(`https://nearly.trade/api/pnl/${encodeURIComponent(account)}`);
  if (!res.ok) throw new Error(`nearly.trade HTTP ${res.status}`);
  const json = await res.json();
  return new Map((json.tokens || []).map((t) => [t.token, t]));
}

/** Everything the Tokens tab needs: price candles for every traded asset, then the replay. */
export async function loadTokenPnl(account, getMeta) {
  const { txs, complete } = await loadTokenMoves(account);
  const ids = [...new Set(txs.flatMap((t) => Object.keys(t.legs)))];
  const since = txs.length ? txs[0].ts : Date.now();
  const [tokens, history] = await Promise.all([getMeta(ids), loadPriceHistory(ids, since)]);
  return { txs, complete, tokens, history };
}
