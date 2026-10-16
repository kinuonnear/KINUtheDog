// Direct routing through Rhea concentrated-liquidity (DCL) pools.
// Rhea's SmartRouter skips many community CLMM pools (e.g. KINU/NINU), while
// they can still be swapped directly on dclv2.ref-labs.near.
//
// The whole pool set is loaded from the contract (list_pools, cached), and
// 1-, 2- and 3-hop paths are searched locally over pools that have liquidity
// at the current price — e.g. NEAR -> QTC -> RHEA -> DIARHEA. Candidates are
// quoted on-chain; the ranking per pair is cached so quote refreshes only
// re-check the leaders. Execution is the same ft_transfer_call
// { Swap: { pool_ids, … } } the Rhea app sends.

import { CONTRACTS, GAS } from '../config.js';
import { view } from './rpc.js';
import { searchPools } from './rhea.js';
import { ensureStorageTx, ftTransferCallTx, wrapNearTx } from './tx.js';
import { applySlippage, toBigInt } from './format.js';
import { afterTax, swapTax } from './tokenTax.js';

const POOL_PAGE = 500;
const POOLS_TTL_MS = 10 * 60_000; // after this the pool set is refreshed (in the background)
const POOLS_MAX_AGE_MS = 2 * 60 * 60_000; // a saved pool set older than this isn't used at all
const PAGES_AT_ONCE = 6; // list_pools pages read in parallel (the RPC client runs 6 at a time)
const MAX_TWO_HOP = 24; // multi-hop candidates quoted on a fresh search (best-connected tokens first)
const MAX_THREE_HOP = 24;
const RANK_TTL_MS = 180_000;
const RANK_KEEP = 5; // leaders re-quoted on refresh

const contractOf = (token) => token.contract || token.id;

let graphPromise = null;
let graphAt = 0;

// The routable pool set changes slowly, and loading it is the heaviest read KINU makes (every CLMM
// pool, ~11 large list_pools pages, ~4 MB). It is kept as compact pool ids in localStorage: a saved
// set up to 2 hours old is used at once (a quote never waits for it), and one older than 10 minutes
// is refreshed in the background. A pool that emptied meanwhile simply quotes 0 and drops out; a new
// pool gets in through refreshDclGraphFor() or the next refresh.
const GRAPH_KEY = 'kinu.dclGraph.v2';

function readGraphCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(GRAPH_KEY) || 'null');
    if (saved && Date.now() - saved.at < POOLS_MAX_AGE_MS && Array.isArray(saved.ids)) return saved;
  } catch {
    // ignore
  }
  return null;
}

function writeGraphCache(at, ids) {
  try {
    localStorage.setItem(GRAPH_KEY, JSON.stringify({ at, ids }));
  } catch {
    // storage full or unavailable: the in-memory copy still serves this page
  }
}

/** Running pools with liquidity at the current price (no whitelist), as pool ids. */
async function fetchRoutablePoolIds() {
  const ids = [];
  // Pages are read PAGES_AT_ONCE at a time (the pool count isn't known up front) until one comes
  // back short: ~1 s instead of ~5 s one page after another.
  for (let start = 0; ; start += POOL_PAGE * PAGES_AT_ONCE) {
    const pages = await Promise.all(
      Array.from({ length: PAGES_AT_ONCE }, (_, i) =>
        view(CONTRACTS.dcl, 'list_pools', { from_index: start + i * POOL_PAGE, limit: POOL_PAGE }).then((page) => page || [])
      )
    );
    let done = false;
    for (const page of pages) {
      page
        // Whitelist-only pools (e.g. NEAR Intents solver pools) quote like any pool — quotes are
        // view calls — but reject swaps from other accounts (E407), so they never join a route.
        .filter((p) => p.state === 'Running' && p.liquidity !== '0' && !(Array.isArray(p.whitelist) && p.whitelist.length > 0))
        .forEach((p) => ids.push(p.pool_id));
      if (page.length < POOL_PAGE) {
        done = true;
        break;
      }
    }
    if (done) return ids;
  }
}

/**
 * After liquidity goes into a pool: if the cached pool set doesn't route through it yet (e.g. the
 * first liquidity of a new pool), drop the cache so the next quote picks it up.
 */
export async function refreshDclGraphFor(poolId) {
  const graph = graphPromise ? await graphPromise.catch(() => null) : null;
  const [tokenX] = String(poolId).split('|');
  if (graph && graph.get(tokenX)?.some((p) => p.pool_id === poolId)) return;
  graphPromise = null;
  try {
    localStorage.removeItem(GRAPH_KEY);
  } catch {
    // ignore
  }
}

function graphOf(ids) {
  const byToken = new Map();
  ids.forEach((pool_id) => {
    const [token_x, token_y] = pool_id.split('|');
    const p = { pool_id, token_x, token_y };
    [token_x, token_y].forEach((t) => {
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t).push(p);
    });
  });
  return byToken;
}

let refreshing = null;

/** Read the pool set from the chain, save it, and swap it in. */
function refreshGraph() {
  if (!refreshing) {
    refreshing = fetchRoutablePoolIds()
      .then((ids) => {
        graphAt = Date.now();
        writeGraphCache(graphAt, ids);
        const graph = graphOf(ids);
        graphPromise = Promise.resolve(graph);
        return graph;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/** Map<token, pool[]> over routable pools; a pool is { pool_id, token_x, token_y }. */
function loadGraph() {
  if (!graphPromise) {
    const cached = readGraphCache();
    if (cached) {
      // A saved set serves at once; a stale one is refreshed behind it.
      graphAt = cached.at;
      graphPromise = Promise.resolve(graphOf(cached.ids));
    } else {
      graphPromise = refreshGraph().catch((error) => {
        graphPromise = null;
        throw error;
      });
    }
  }
  if (Date.now() - graphAt > POOLS_TTL_MS && !refreshing) refreshGraph().catch(() => {});
  return graphPromise;
}

/** Start loading the pool set early (e.g. when the swap page opens) so the first quote is fast. */
export function warmDclGraph() {
  loadGraph().catch(() => {});
}

const other = (pool, token) => (pool.token_x === token ? pool.token_y : pool.token_x);

/**
 * Bridge candidates: tokens paired with `token` in CLMM pools that are live right now,
 * deepest pool (USD TVL from Rhea's API) first.
 */
export async function dclNeighbors(token, limit = 1) {
  const [byToken, { list }] = await Promise.all([loadGraph(), searchPools({ type: 'dcl', tokenList: token, hideLow: false, limit: 60 })]);
  const live = new Set((byToken.get(token) || []).map((p) => p.pool_id));
  const mids = list
    .filter((p) => live.has(p.id) && p.tvl > 0)
    .sort((a, b) => b.tvl - a.tvl)
    .map((p) => (p.tokenIds[0] === token ? p.tokenIds[1] : p.tokenIds[0]));
  return [...new Set(mids)].slice(0, limit);
}

/** Candidate paths: all 1- and 2-hop paths, plus 3-hop paths through the best-connected tokens. */
async function findPaths(tokenIn, tokenOut) {
  const byToken = await loadGraph();
  const degree = (t) => byToken.get(t)?.length || 0;
  const poolsIn = byToken.get(tokenIn) || [];
  const outNeighbors = new Map(); // mid -> pools(mid, tokenOut)
  (byToken.get(tokenOut) || []).forEach((p) => {
    const mid = other(p, tokenOut);
    if (!outNeighbors.has(mid)) outNeighbors.set(mid, []);
    outNeighbors.get(mid).push(p);
  });

  const paths = [];
  const twoHop = [];
  const threeHop = [];
  poolsIn.forEach((a) => {
    const m1 = other(a, tokenIn);
    if (m1 === tokenOut) {
      paths.push({ poolIds: [a.pool_id], tokens: [tokenIn, tokenOut] });
      return;
    }
    (outNeighbors.get(m1) || []).forEach((b) => twoHop.push({ poolIds: [a.pool_id, b.pool_id], tokens: [tokenIn, m1, tokenOut], hub: degree(m1) }));
    (byToken.get(m1) || []).forEach((b) => {
      const m2 = other(b, m1);
      if (m2 === tokenIn || m2 === tokenOut || b === a) return;
      (outNeighbors.get(m2) || []).forEach((c) =>
        threeHop.push({ poolIds: [a.pool_id, b.pool_id, c.pool_id], tokens: [tokenIn, m1, m2, tokenOut], hub: degree(m1) + degree(m2) })
      );
    });
  });
  twoHop.sort((x, y) => y.hub - x.hub);
  threeHop.sort((x, y) => y.hub - x.hub);
  return [...paths, ...twoHop.slice(0, MAX_TWO_HOP), ...threeHop.slice(0, MAX_THREE_HOP)];
}

const rankings = new Map(); // "in|out" -> { at, paths }

async function quotePath(path, inId, outId, amountIn) {
  try {
    const result = await view(CONTRACTS.dcl, 'quote', {
      pool_ids: path.poolIds,
      input_token: inId,
      output_token: outId,
      input_amount: amountIn,
      tag: 'kinu'
    });
    return { ...path, amountOut: String(result?.amount ?? '0') };
  } catch {
    return { ...path, amountOut: '0' };
  }
}

/** Working paths for a pair, best first: cached leaders, or a full search when stale / dried up. */
async function rankedQuotes(inId, outId, amountIn, exclude = null) {
  const key = `${inId}|${outId}`;
  const ranked = rankings.get(key);
  const byOut = (a, b) => (toBigInt(b.amountOut) > toBigInt(a.amountOut) ? 1 : -1);
  // Routes that must avoid some pools search afresh and leave the shared ranking alone.
  if (exclude?.size) {
    const paths = (await findPaths(inId, outId)).filter((p) => !p.poolIds.some((id) => exclude.has(id)));
    return (await Promise.all(paths.map((p) => quotePath(p, inId, outId, amountIn)))).filter((q) => toBigInt(q.amountOut) > 0n).sort(byOut);
  }
  if (ranked && Date.now() - ranked.at <= RANK_TTL_MS) {
    const quotes = (await Promise.all(ranked.paths.map((p) => quotePath(p, inId, outId, amountIn)))).filter((q) => toBigInt(q.amountOut) > 0n);
    if (quotes.length) return quotes.sort(byOut);
  }
  const paths = await findPaths(inId, outId);
  const quotes = (await Promise.all(paths.map((p) => quotePath(p, inId, outId, amountIn)))).filter((q) => toBigInt(q.amountOut) > 0n).sort(byOut);
  if (quotes.length) rankings.set(key, { at: Date.now(), paths: quotes.slice(0, RANK_KEEP) });
  else rankings.delete(key);
  return quotes;
}

/**
 * Best DCL route for amountIn (raw); returns a quote object or throws.
 * Taxed tokens (lib/tokenTax.js): the pools only receive the input after its tax, and the output
 * loses its tax on the way out. The route is quoted on what arrives; `amountOut` / `minAmountOut`
 * are what reaches the wallet, `contractMinOut` is the limit the contract checks before the tax.
 */
export async function getDclQuote({ tokenIn, tokenOut, amountIn, slippage, user, excludePools = null }) {
  const inId = contractOf(tokenIn);
  const outId = contractOf(tokenOut);
  const { inBps, outBps } = await swapTax(inId, outId);
  const enters = afterTax(amountIn, inBps).toString();
  const working = await rankedQuotes(inId, outId, enters, excludePools ? new Set(excludePools) : null);
  if (!working.length) throw new Error('No liquidity route found for this pair.');
  const best = working[0];
  const contractMinOut = applySlippage(best.amountOut, slippage);

  return {
    amountIn,
    amountOut: afterTax(best.amountOut, outBps).toString(),
    minAmountOut: afterTax(contractMinOut, outBps).toString(),
    contractMinOut,
    tax: inBps || outBps ? { inBps, outBps, grossOut: best.amountOut, netIn: enters } : null,
    dexs: ['RheaCLMM'],
    routeTokens: best.tokens,
    dcl: { poolIds: best.poolIds },
    user: user || null,
    fetchedAt: Date.now()
  };
}

export async function buildDclSwapTransactions({ tokenIn, tokenOut, quote, accountId }) {
  const outId = contractOf(tokenOut);
  const txs = [];

  if (tokenIn.native) {
    txs.push(await ensureStorageTx(CONTRACTS.wrapNear, accountId));
    txs.push(wrapNearTx(quote.amountIn));
  }
  txs.push(await ensureStorageTx(outId, accountId));

  txs.push(
    ftTransferCallTx(
      contractOf(tokenIn),
      CONTRACTS.dcl,
      quote.amountIn,
      JSON.stringify({
        // Since its 2026-10-01 upgrade the contract pays a wNEAR output as native NEAR unless told
        // not to. Native NEAR asked for: let it — the whole output arrives as NEAR (unwrapping only
        // the guaranteed minimum ourselves left the rest behind as wNEAR). wNEAR asked for (Zap,
        // Rebalance, deposits that follow): keep it as wNEAR.
        Swap: {
          pool_ids: quote.dcl.poolIds,
          output_token: outId,
          min_output_amount: quote.contractMinOut ?? quote.minAmountOut,
          skip_unwrap_near: !tokenOut.native
        }
      }),
      GAS.ftTransferCall
    )
  );

  return txs.filter(Boolean);
}
