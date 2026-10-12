// Swap aggregation through Rhea's SmartRouter (smartx.rhea.finance).
// The router searches Rhea AMM, stable and CLMM pools and returns a signed
// route message that is executed by the aggregator contract — the same
// flow app.rhea.finance uses.

import { CONTRACTS, DEPOSIT, ENDPOINTS, GAS } from '../config.js';
import { view } from './rpc.js';
import {
  ensureStorageTx,
  ftTransferCallTx,
  functionCall,
  transaction,
  wrapNearTx
} from './tx.js';
import { toBigInt } from './format.js';
import { getWhitelistedTokens } from './tokens.js';
import { buildDclSwapTransactions, dclNeighbors, getDclQuote } from './dclRouter.js';

const QUOTE_TIMEOUT_MS = 8_000;

const contractOf = (token) => token.contract || token.id;

/**
 * Best quote for `amountIn` (raw units) of tokenIn -> tokenOut.
 * Rhea's SmartRouter and direct CLMM routing are quoted side by side and the
 * larger output wins: on the same CLMM pools the direct route skips the
 * aggregator's protocol fee, while the router also reaches AMM / stable pools
 * and can split large trades. If neither has a path, a two-step route through
 * a bridge token is tried. Pass `user` to get an executable, user-bound quote.
 */
export async function getSwapQuote(params) {
  const [router, clmm, bridge] = await Promise.allSettled([getSmartRouterQuote(params), getDclQuote(params), getHybridQuote(params)]);
  if (params.signal?.aborted) throw router.reason || new DOMException('Aborted', 'AbortError');

  const direct = [
    router.status === 'fulfilled' && { source: 'SmartRouter', quote: router.value },
    clmm.status === 'fulfilled' && { source: 'Rhea CLMM (direct)', quote: clmm.value }
  ].filter(Boolean);
  const candidates = [...direct];
  if (bridge.status === 'fulfilled') candidates.push({ source: 'Bridge route (2 steps)', quote: bridge.value });
  if (!candidates.length) throw router.status === 'rejected' ? router.reason : new Error('No route found for this pair.');

  // Every candidate stays executable so the user can pick one.
  const top = (list) => list.reduce((a, b) => (toBigInt(b.quote.amountOut) > toBigInt(a.quote.amountOut) ? b : a));
  let best = direct.length ? top(direct) : candidates[0];
  // A two-step route needs a second signature and more gas: it only wins by a clear margin.
  const twoStep = candidates.find((c) => c.quote.hybrid);
  if (twoStep && twoStep !== best && Number(twoStep.quote.amountOut) > Number(best.quote.amountOut) * (1 + BRIDGE_MIN_GAIN)) best = twoStep;
  // Impact is measured for the chosen route only (keeps router requests within its rate limit);
  // other routes are measured if the user picks them.
  best.quote.priceImpact = await measurePriceImpact(best.quote, params).catch(() => null);
  return selectRoute({ ...best.quote, routes: candidates, bestSource: best.source }, best.source);
}

/** Extra output a two-step route must offer over the best one-step route to be chosen. */
const BRIDGE_MIN_GAIN = 0.005;

/**
 * The quote for one route of a multi-route result (falls back to the best one), carrying the
 * full route list along. `compared` marks the selected route; `gapPct` is how far each route
 * is below the best.
 */
export function selectRoute(quote, source) {
  if (!quote?.routes) return quote;
  const pick = quote.routes.find((r) => r.source === source) || quote.routes.find((r) => r.source === quote.bestSource);
  const bestOut = Number(quote.routes.find((r) => r.source === quote.bestSource).quote.amountOut);
  return {
    ...pick.quote,
    routes: quote.routes,
    bestSource: quote.bestSource,
    source: pick.source,
    compared: quote.routes.map((r) => ({
      source: r.source,
      amountOut: r.quote.amountOut,
      chosen: r.source === pick.source,
      best: r.source === quote.bestSource,
      gapPct: bestOut > 0 ? (1 - Number(r.quote.amountOut) / bestOut) * 100 : 0,
      dexs: r.quote.dexs,
      routeTokens: r.quote.routeTokens
    }))
  };
}

/**
 * Price impact of this trade size on its own route: the rate for amountIn against the
 * rate the same route gives for a tiny amount. Independent of (possibly stale) USD prices.
 */
async function measurePriceImpact(quote, { tokenIn, tokenOut, amountIn }) {
  if (quote.hybrid) {
    // Two swaps: impacts compound.
    const bridge = { id: quote.hybrid.mid };
    const [first, second] = quote.hybrid.legs;
    const [a, b] = await Promise.all([
      measurePriceImpact(first, { tokenIn, tokenOut: bridge, amountIn: first.amountIn }),
      measurePriceImpact(second, { tokenIn: bridge, tokenOut, amountIn: second.amountIn })
    ]);
    return a === null || b === null ? null : (1 - (1 - a / 100) * (1 - b / 100)) * 100;
  }
  const small = toBigInt(amountIn) / 1000n;
  if (small === 0n) return null;
  let refOut = null;
  if (quote.dcl) {
    const result = await view(CONTRACTS.dcl, 'quote', {
      pool_ids: quote.dcl.poolIds,
      input_token: contractOf(tokenIn),
      output_token: contractOf(tokenOut),
      input_amount: small.toString(),
      tag: 'kinu'
    });
    refOut = result?.amount;
  } else if (quote.msg) {
    refOut = (await getSmartRouterQuote({ tokenIn, tokenOut, amountIn: small.toString(), slippage: 0.5 })).amountOut;
  }
  if (!refOut || toBigInt(refOut) === 0n) return null;
  const spot = Number(refOut) / Number(small);
  const executed = Number(quote.amountOut) / Number(amountIn);
  return Math.max(0, (1 - executed / spot) * 100);
}

/**
 * Two swaps through a bridge token, for tokens that only trade in CLMM pools the
 * SmartRouter skips while the other side only has liquidity the router does see.
 * E.g. NEAR -> DIARHEA: SmartRouter NEAR -> RHEA, then CLMM RHEA -> DIARHEA.
 * Leg 2 is quoted on leg 1's guaranteed minimum; it is re-quoted on the amount
 * actually received before it is signed (see quoteHybridSecondLeg).
 */
async function getHybridQuote({ tokenIn, tokenOut, amountIn, slippage, user, signal }) {
  const inId = contractOf(tokenIn);
  const outId = contractOf(tokenOut);
  // The bridge's other leg goes through the SmartRouter, so the bridge must be a token the
  // router trades (Rhea-whitelisted); the deepest such CLMM partner is used — one per side,
  // which keeps router requests within its rate limit.
  const [listed, nearOut, nearIn] = await Promise.all([getWhitelistedTokens().catch(() => []), dclNeighbors(outId, 6), dclNeighbors(inId, 6)]);
  const routable = new Set([...listed, CONTRACTS.wrapNear]);
  const bridgesToOut = nearOut.filter((m) => routable.has(m)).slice(0, 1);
  const bridgesFromIn = nearIn.filter((m) => routable.has(m)).slice(0, 1);

  const attempts = [
    // router tokenIn -> bridge, CLMM bridge -> tokenOut
    ...bridgesToOut
      .filter((mid) => mid !== inId)
      .map(async (mid) => {
        const bridge = { id: mid };
        const first = await getSmartRouterQuote({ tokenIn, tokenOut: bridge, amountIn, slippage, user, signal });
        const second = await getDclQuote({ tokenIn: bridge, tokenOut, amountIn: first.minAmountOut, slippage, user });
        return { mid, legs: [first, second] };
      }),
    // CLMM tokenIn -> bridge, router bridge -> tokenOut
    ...bridgesFromIn
      .filter((mid) => mid !== outId)
      .map(async (mid) => {
        const bridge = { id: mid };
        const first = await getDclQuote({ tokenIn, tokenOut: bridge, amountIn, slippage, user });
        const second = await getSmartRouterQuote({ tokenIn: bridge, tokenOut, amountIn: first.minAmountOut, slippage, user, signal });
        return { mid, legs: [first, second] };
      })
  ];
  const routes = (await Promise.allSettled(attempts)).filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!routes.length) throw new Error('No route found for this pair.');
  const best = routes.reduce((a, b) => (toBigInt(b.legs[1].amountOut) > toBigInt(a.legs[1].amountOut) ? b : a));
  const [first, second] = best.legs;
  return {
    amountIn,
    amountOut: second.amountOut,
    minAmountOut: second.minAmountOut,
    dexs: [...new Set([...first.dexs, ...second.dexs])],
    routeTokens: [inId, best.mid, outId],
    hybrid: { mid: best.mid, legs: [first, second] },
    user: user || null,
    fetchedAt: Date.now()
  };
}

/** Re-quote a combined route's second swap for the bridge amount actually received. */
export async function quoteHybridSecondLeg({ quote, tokenOut, amountIn, slippage, user }) {
  const bridge = { id: quote.hybrid.mid };
  const viaRouter = Boolean(quote.hybrid.legs[1].msg);
  return viaRouter
    ? getSmartRouterQuote({ tokenIn: bridge, tokenOut, amountIn, slippage, user })
    : getDclQuote({ tokenIn: bridge, tokenOut, amountIn, slippage, user });
}

// The SmartRouter rate-limits after a handful of quick requests (it then answers with an
// HTML page), so identical requests within a few seconds share one response.
const ROUTER_CACHE_MS = 5_000;
const routerCache = new Map(); // url -> { at, promise }

function fetchRouter(url, signal) {
  const hit = routerCache.get(url);
  if (hit && Date.now() - hit.at < ROUTER_CACHE_MS) return hit.promise;
  const promise = fetch(url, { signal }).then(async (response) => {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(response.status === 429 || text.includes('<html') ? 'SmartRouter is busy — retrying shortly.' : `SmartRouter HTTP ${response.status}`);
    }
  });
  routerCache.set(url, { at: Date.now(), promise });
  promise.catch(() => routerCache.delete(url));
  return promise;
}

async function getSmartRouterQuote({ tokenIn, tokenOut, amountIn, slippage, user, signal }) {
  const params = new URLSearchParams({
    amountIn,
    tokenIn: contractOf(tokenIn),
    tokenOut: contractOf(tokenOut),
    slippage: String(Number(slippage) / 100),
    pathDeep: '3',
    chainId: '0',
    // Only unwrap to native NEAR when the user actually wants native NEAR out.
    skipUnwrapNativeToken: tokenOut.native ? 'false' : 'true'
  });
  if (user) params.append('user', user);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort());

  try {
    const json = await fetchRouter(`${ENDPOINTS.smartRouter}/swapMultiDexPath?${params}`, controller.signal);
    if (json?.result_code !== 0 || !json.result_data) {
      throw new Error(json?.result_message || 'No route found for this pair.');
    }
    const data = json.result_data;
    if (toBigInt(data.amount_out) === 0n) throw new Error('No liquidity route found for this pair.');
    // The quote is executed as-is, so it must spend exactly what the user typed, on this pair.
    const path = data.tokens || [];
    if (
      String(data.amount_in) !== String(amountIn) ||
      (path.length && (path[0] !== contractOf(tokenIn) || path[path.length - 1] !== contractOf(tokenOut)))
    ) {
      throw new Error('SmartRouter returned a quote that does not match your swap. Refresh the quote.');
    }
    return {
      amountIn: String(data.amount_in),
      amountOut: String(data.amount_out),
      minAmountOut: String(data.min_amount_out),
      dexs: data.dexs || [],
      routeTokens: data.tokens || [contractOf(tokenIn), contractOf(tokenOut)],
      msg: data.msg,
      signature: data.signature,
      user: user || null,
      fetchedAt: Date.now()
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      if (signal?.aborted) throw error;
      throw new Error('SmartRouter timed out. Try again.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the transactions needed to execute a user-bound quote.
 * Mirrors app.rhea.finance: wrap NEAR if needed, make sure every token on
 * the route is registered for the user and the aggregator, then
 * ft_transfer_call the input token to the aggregator with the signed route.
 */
export async function buildSwapTransactions({ tokenIn, tokenOut, quote, accountId }) {
  if (quote?.user !== accountId) throw new Error('Quote was created for another account. Refresh the quote.');
  if (quote.hybrid) throw new Error('Combined routes are executed one leg at a time.');
  if (quote.dcl) return buildDclSwapTransactions({ tokenIn, tokenOut, quote, accountId });
  if (!quote.msg || !quote.signature) throw new Error('Quote is not executable. Refresh the quote.');

  const aggregator = CONTRACTS.aggregator;
  const routeTokens = [...new Set(quote.routeTokens)];
  const txs = [];

  if (tokenIn.native) {
    txs.push(await ensureStorageTx(CONTRACTS.wrapNear, accountId));
    txs.push(wrapNearTx(quote.amountIn));
  }

  // The user must be able to receive the output (and intermediate) tokens.
  const userTokens = quote.dexs.length > 1 ? routeTokens : [contractOf(tokenOut)];
  for (const token of userTokens) {
    txs.push(await ensureStorageTx(token, accountId));
  }

  // The aggregator contract must be registered on every route token.
  for (const token of routeTokens) {
    txs.push(await ensureStorageTx(token, aggregator));
  }

  // Per-user token storage inside the aggregator.
  const registered = (await view(aggregator, 'query_user_tokens_registered', {
    user: accountId,
    tokens: routeTokens
  }, { fresh: true }).catch(() => routeTokens.map(() => false))) || [];
  const missing = routeTokens.filter((_, i) => !registered[i]);
  if (missing.length) {
    txs.push(
      transaction(aggregator, [
        functionCall(
          'tokens_storage_deposit',
          { user: accountId, tokens: missing },
          GAS.aggregatorTokenStorage,
          (toBigInt(DEPOSIT.aggregatorTokenStorage) * BigInt(missing.length)).toString()
        )
      ])
    );
  }

  txs.push(
    ftTransferCallTx(
      contractOf(tokenIn),
      aggregator,
      quote.amountIn,
      JSON.stringify({ msg: quote.msg, signature: quote.signature }),
      GAS.aggregatorSwap
    )
  );

  return txs.filter(Boolean);
}
