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
import { buildDclSwapTransactions, getDclQuote } from './dclRouter.js';

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
      throw routerError;
    }
  }
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
