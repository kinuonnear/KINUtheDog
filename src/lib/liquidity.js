// Add / remove liquidity for Rhea classic pools (SIMPLE_POOL) on v2.ref-finance.near.
// Call shapes follow app.rhea.finance: deposit tokens with ft_transfer_call,
// then add_liquidity; remove_liquidity followed by withdraw (amount "0" = all).

import { CONTRACTS, DEPOSIT, GAS } from '../config.js';
import { getExchangeStorage } from './rhea.js';
import { ensureStorageTx, ftTransferCallTx, functionCall, transaction, wrapNearTx } from './tx.js';
import { applySlippage, toBigInt } from './format.js';

const exchange = CONTRACTS.exchange;

/** Amount of token `toIndex` that matches `amount` of token `fromIndex` at the pool ratio. */
export function pairedAmount(pool, fromIndex, toIndex, amount) {
  const from = toBigInt(pool.amounts[fromIndex]);
  const to = toBigInt(pool.amounts[toIndex]);
  if (from === 0n) return '0';
  return ((toBigInt(amount) * to) / from).toString();
}

/** LP shares minted for depositing `amounts` (min over all tokens, like the contract). */
export function expectedShares(pool, amounts) {
  const supply = toBigInt(pool.sharesTotalSupply);
  if (supply === 0n) return '0';
  let shares = null;
  pool.amounts.forEach((reserve, i) => {
    const r = toBigInt(reserve);
    if (r === 0n) return;
    const s = (toBigInt(amounts[i]) * supply) / r;
    shares = shares === null || s < shares ? s : shares;
  });
  return (shares ?? 0n).toString();
}

/** Token amounts returned for burning `shares`. */
export function amountsForShares(pool, shares) {
  const supply = toBigInt(pool.sharesTotalSupply);
  if (supply === 0n) return pool.amounts.map(() => '0');
  return pool.amounts.map((reserve) => ((toBigInt(reserve) * toBigInt(shares)) / supply).toString());
}

async function exchangeStorageTx(accountId) {
  const state = await getExchangeStorage(accountId).catch(() => null);
  let deposit = null;
  if (!state) {
    deposit = DEPOSIT.exchangeRegister;
  } else if (toBigInt(state.deposit) - toBigInt(state.usage) < toBigInt(DEPOSIT.exchangeMinFree)) {
    deposit = DEPOSIT.exchangeTopUp;
  }
  if (!deposit) return null;
  return functionCall('storage_deposit', { account_id: accountId, registration_only: false }, GAS.storageDeposit, deposit);
}

/**
 * @param pool         on-chain pool from getPool()
 * @param amounts      raw amounts aligned with pool.tokenIds
 * @param wrapAmount   raw yocto of native NEAR to wrap first (when wNEAR balance is short)
 */
export async function buildAddLiquidityTransactions({ pool, amounts, accountId, slippage, wrapAmount = '0' }) {
  if (pool.kind !== 'SIMPLE_POOL') throw new Error('Only classic pools are supported here.');
  if (amounts.some((a) => toBigInt(a) <= 0n)) throw new Error('Enter an amount for every token.');

  const txs = [];

  const storageAction = await exchangeStorageTx(accountId);
  txs.push(
    transaction(exchange, [
      ...(storageAction ? [storageAction] : []),
      functionCall('register_tokens', { token_ids: pool.tokenIds }, GAS.registerTokens, DEPOSIT.oneYocto)
    ])
  );

  if (toBigInt(wrapAmount) > 0n) {
    txs.push(await ensureStorageTx(CONTRACTS.wrapNear, accountId));
    txs.push(wrapNearTx(wrapAmount));
  }

  pool.tokenIds.forEach((tokenId, i) => {
    txs.push(ftTransferCallTx(tokenId, exchange, amounts[i], ''));
  });

  txs.push(
    transaction(exchange, [
      functionCall(
        'add_liquidity',
        {
          pool_id: Number(pool.id),
          amounts,
          min_amounts: amounts.map((a) => applySlippage(a, slippage))
        },
        GAS.addLiquidity,
        DEPOSIT.lpStorage
      )
    ])
  );

  return txs.filter(Boolean);
}

export async function buildRemoveLiquidityTransactions({ pool, shares, accountId, slippage }) {
  if (toBigInt(shares) <= 0n) throw new Error('Enter an amount of shares to remove.');
  const expected = amountsForShares(pool, shares);
  const txs = [];

  // The user must be registered on each token to receive the withdrawal.
  for (const tokenId of pool.tokenIds) {
    txs.push(await ensureStorageTx(tokenId, accountId));
  }

  txs.push(
    transaction(exchange, [
      functionCall(
        'remove_liquidity',
        {
          pool_id: Number(pool.id),
          shares,
          min_amounts: expected.map((a) => applySlippage(a, slippage))
        },
        GAS.removeLiquidity,
        DEPOSIT.oneYocto
      ),
      ...pool.tokenIds.map((tokenId) =>
        functionCall(
          'withdraw',
          { token_id: tokenId, amount: '0', unregister: false, skip_unwrap_near: false },
          GAS.withdraw,
          DEPOSIT.oneYocto
        )
      )
    ])
  );

  return txs.filter(Boolean);
}

/** Withdraw every token held inside the Rhea exchange back to the wallet. */
export async function buildWithdrawDepositsTransactions({ tokenIds, accountId }) {
  const txs = [];
  for (const tokenId of tokenIds) {
    txs.push(await ensureStorageTx(tokenId, accountId));
  }
  // Keep each transaction well under the gas limit (5 withdrawals x 55 TGas).
  for (let i = 0; i < tokenIds.length; i += 5) {
    txs.push(
      transaction(
        exchange,
        tokenIds.slice(i, i + 5).map((tokenId) =>
          functionCall(
            'withdraw',
            { token_id: tokenId, amount: '0', unregister: false, skip_unwrap_near: false },
            GAS.withdraw,
            DEPOSIT.oneYocto
          )
        )
      )
    );
  }
  return txs.filter(Boolean);
}
