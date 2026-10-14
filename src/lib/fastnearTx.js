// Transaction bodies from FastNEAR's transactions API, shared by the Portfolio's LP history
// (lib/lpHistory.js) and token PnL (lib/tokenPnl.js). Both read many of the same transactions;
// here each one is fetched once per page load, in batches of 20, at most two requests at a time,
// spaced out, and all of them pause after a rate limit.

const URL = 'https://tx.main.fastnear.com/v0/transactions';
const BATCH = 20; // FastNEAR limit per request
const PARALLEL = 2;
const MAX_KEPT = 4_000;

const bodies = new Map(); // tx hash -> transaction body
const pending = new Map(); // tx hash -> promise of its batch
const SPACING_MS = 350; // between request starts
let active = 0;
const waiting = [];
// After a rate limit every request waits (not just the one that hit it), so the batches behind
// it don't run into the same limit.
let pausedUntil = 0;
let nextStart = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function limited(task) {
  if (active >= PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try {
    const start = Math.max(Date.now(), pausedUntil, nextStart);
    nextStart = start + SPACING_MS;
    await wait(start - Date.now());
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

function rest(attempt) {
  pausedUntil = Math.max(pausedUntil, Date.now() + 3_000 * (attempt + 1));
  return wait(pausedUntil - Date.now());
}

async function postBatch(hashes) {
  for (let attempt = 0; ; attempt += 1) {
    let res = null;
    try {
      res = await fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tx_hashes: hashes })
      });
    } catch (error) {
      // "Failed to fetch": a rate limit answered without CORS headers, or a dropped connection.
      if (attempt < 4) {
        await rest(attempt);
        continue;
      }
      throw new Error('Transaction history is unreachable right now — try again shortly.', { cause: error });
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await rest(attempt);
      continue;
    }
    throw new Error(res.status === 429 ? 'History source is busy — try again in a minute.' : `History HTTP ${res.status}`);
  }
}

/** Transaction bodies for `hashes` (those FastNEAR knows), each fetched at most once. */
export async function getTransactions(hashes) {
  const unique = [...new Set(hashes)];
  const need = unique.filter((h) => !bodies.has(h) && !pending.has(h));
  for (let i = 0; i < need.length; i += BATCH) {
    const batch = need.slice(i, i + BATCH);
    const job = limited(() => postBatch(batch))
      .then((json) => {
        (json.transactions || []).forEach((tx) => {
          const hash = tx.transaction?.hash;
          if (hash) bodies.set(hash, tx);
        });
        if (bodies.size > MAX_KEPT) [...bodies.keys()].slice(0, bodies.size - MAX_KEPT).forEach((h) => bodies.delete(h));
      })
      .finally(() => batch.forEach((h) => pending.get(h) === job && pending.delete(h)));
    batch.forEach((h) => pending.set(h, job));
  }
  await Promise.all(unique.map((h) => pending.get(h)).filter(Boolean));
  return unique.map((h) => bodies.get(h)).filter(Boolean);
}
