// Direct routing through Rhea concentrated-liquidity (DCL) pools.
// Rhea's SmartRouter skips many community CLMM pools (e.g. KINU/NINU), while
// app.rhea.finance can still swap them directly on dclv2.ref-labs.near.
// This module finds 1- and 2-hop DCL paths, quotes them on-chain and builds
// the same ft_transfer_call { Swap: { pool_ids, … } } the Rhea app sends.

import { CONTRACTS, DEPOSIT, GAS } from '../config.js';
import { view } from './rpc.js';
import { searchPools } from './rhea.js';
import { ensureStorageTx, ftTransferCallTx, functionCall, transaction, wrapNearTx } from './tx.js';
import { applySlippage, toBigInt } from './format.js';

const MAX_CANDIDATES = 8;

const contractOf = (token) => token.contract || token.id;

function otherToken(pool, token) {
  return pool.tokenIds[0] === token ? pool.tokenIds[1] : pool.tokenIds[0];
}

async function dclPoolsWith(token) {
  const { list } = await searchPools({ type: 'dcl', tokenList: token, hideLow: false, limit: 60 });
  return list.filter((p) => p.isDcl && p.tokenIds.includes(token));
}

/** Tokens paired with `token` in CLMM pools that hold liquidity, deepest first. */
export async function dclNeighbors(token, limit = 3) {
  const pools = (await dclPoolsWith(token)).filter((p) => p.tvl > 0).sort((a, b) => b.tvl - a.tvl);
  return [...new Set(pools.map((p) => otherToken(p, token)))].slice(0, limit);
}

/** Candidate paths (arrays of pool ids), deepest liquidity first. */
async function findPaths(tokenIn, tokenOut) {
  const [poolsIn, poolsOut] = await Promise.all([dclPoolsWith(tokenIn), dclPoolsWith(tokenOut)]);
  const candidates = [];

  poolsIn
    .filter((p) => p.tokenIds.includes(tokenOut))
    .forEach((p) => candidates.push({ poolIds: [p.id], tokens: [tokenIn, tokenOut], depth: p.tvl }));

  poolsIn.forEach((a) => {
    const mid = otherToken(a, tokenIn);
    if (mid === tokenOut) return;
    poolsOut
      .filter((b) => b.tokenIds.includes(mid))
      .forEach((b) =>
        candidates.push({ poolIds: [a.id, b.id], tokens: [tokenIn, mid, tokenOut], depth: Math.min(a.tvl, b.tvl) })
      );
  });

  return candidates.sort((x, y) => y.depth - x.depth).slice(0, MAX_CANDIDATES);
}

/** Best DCL route for amountIn (raw); returns a quote object or throws. */
export async function getDclQuote({ tokenIn, tokenOut, amountIn, slippage, user }) {
  const inId = contractOf(tokenIn);
  const outId = contractOf(tokenOut);
  const paths = await findPaths(inId, outId);
  if (!paths.length) throw new Error('No liquidity route found for this pair.');

  const quotes = await Promise.all(
    paths.map(async (path) => {
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
    })
  );

  const best = quotes.reduce((a, b) => (toBigInt(b.amountOut) > toBigInt(a.amountOut) ? b : a));
  if (toBigInt(best.amountOut) === 0n) throw new Error('No liquidity route found for this pair.');

  return {
    amountIn,
    amountOut: best.amountOut,
    minAmountOut: applySlippage(best.amountOut, slippage),
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
        Swap: { pool_ids: quote.dcl.poolIds, output_token: outId, min_output_amount: quote.minAmountOut }
      }),
      GAS.ftTransferCall
    )
  );

  // DCL pays out wNEAR; unwrap the guaranteed minimum when native NEAR was requested.
  if (tokenOut.native) {
    txs.push(
      transaction(CONTRACTS.wrapNear, [
        functionCall('near_withdraw', { amount: quote.minAmountOut }, GAS.nearDeposit, DEPOSIT.oneYocto)
      ])
    );
  }

  return txs.filter(Boolean);
}
