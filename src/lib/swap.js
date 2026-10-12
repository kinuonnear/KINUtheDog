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
import { buildDclSwapTransactions, dclNeighbors, getDclQuote } from './dclRouter.js';

const QUOTE_TIMEOUT_MS = 8_000;

const contractOf = (token) => token.contract || token.id;

/**
 * Best quote for `amountIn` (raw units) of tokenIn -> tokenOut.
 * Uses Rhea's SmartRouter first and falls back to direct DCL routing for
 * pairs the router doesn't cover (community CLMM pools such as KINU/NINU).
 * Pass `user` to get an executable, user-bound quote.
 */
export async function getSwapQuote(params) {
  try {
    return await getSmartRouterQuote(params);
  } catch (routerError) {
    if (params.signal?.aborted) throw routerError;
    try {
      return await getDclQuote(params);
    } catch {
      try {
        return await getHybridQuote(params);
      } catch {
        throw routerError;
      }
    }
  }
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
  const [bridgesToOut, bridgesFromIn] = await Promise.all([dclNeighbors(outId), dclNeighbors(inId)]);

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
    const response = await fetch(`${ENDPOINTS.smartRouter}/swapMultiDexPath?${params}`, {
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`SmartRouter HTTP ${response.status}`);
    const json = await response.json();
    if (json?.result_code !== 0 || !json.result_data) {
      throw new Error(json?.result_message || 'No route found for this pair.');
    }
    const data = json.result_data;
    if (toBigInt(data.amount_out) === 0n) throw new Error('No liquidity route found for this pair.');
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
