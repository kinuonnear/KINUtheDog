// Network fee estimate for a set of transactions.
//
// NEAR refunds unused gas, so the gas *attached* to a call overstates the cost
// several times. The typical gas each call actually burns was measured on real
// mainnet transactions (medians); unknown calls fall back to a share of the
// attached gas. The fee is gas burnt x the current gas price.

import { CONTRACTS, ENDPOINTS } from '../config.js';

const TGAS = 10n ** 12n;
const FALLBACK_GAS_PRICE = 100_000_000n; // yocto per gas (NEAR mainnet minimum)
const UNKNOWN_SHARE = 0.35; // of attached gas, for calls without a measurement

/** Median TGas burnt, measured on mainnet (router swaps include the aggregator's internal calls). */
function typicalTGas(receiverId, methodName, args = {}) {
  if (methodName === 'ft_transfer_call') {
    if (args.receiver_id === CONTRACTS.aggregator) return 77; // SmartRouter swap
    // direct CLMM swap ~32 TGas; a CLMM "Deposit" burns ~260-410 TGas (median ~400)
    if (args.receiver_id === CONTRACTS.dcl) return /Swap/.test(args.msg || '') ? 32 : 400;
    if (args.receiver_id === CONTRACTS.exchange) return 18;
    return null;
  }
  const table = {
    near_deposit: 2.5,
    near_withdraw: 3,
    storage_deposit: 2.5,
    tokens_storage_deposit: 5,
    register_tokens: 4,
    withdraw: receiverId === CONTRACTS.aggregator ? 40 : 20,
    withdraw_asset: 20,
    // liquidity calls (medians measured on mainnet)
    add_liquidity: receiverId === CONTRACTS.dcl ? 15 : 10,
    batch_add_liquidity: 28,
    remove_liquidity: 22,
    batch_remove_liquidity: 27,
    add_stable_liquidity: 7
  };
  return table[methodName] ?? null;
}

let gasPricePromise = null;
let gasPriceAt = 0;

async function gasPrice() {
  if (!gasPricePromise || Date.now() - gasPriceAt > 600_000) {
    gasPriceAt = Date.now();
    gasPricePromise = fetch(ENDPOINTS.rpc[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'kinu', method: 'gas_price', params: [null] })
    })
      .then((r) => r.json())
      .then((j) => BigInt(j?.result?.gas_price || FALLBACK_GAS_PRICE))
      .catch(() => FALLBACK_GAS_PRICE);
  }
  return gasPricePromise;
}

/**
 * { feeNear, maxFeeNear, storageNear } for transactions built by lib/tx.js.
 * feeNear: expected cost; maxFeeNear: if every call used all its attached gas;
 * storageNear: one-time storage deposits included in the transactions.
 */
export async function estimateNetworkFee(transactions) {
  const price = await gasPrice();
  let typical = 0;
  let attached = 0n;
  let storage = 0n;
  transactions.forEach((tx) =>
    tx.actions.forEach((action) => {
      const { methodName, args, gas = '0', deposit = '0' } = action.params || {};
      const attachedGas = BigInt(gas || '0');
      attached += attachedGas;
      const measured = typicalTGas(tx.receiverId, methodName, args);
      const attachedT = Number(attachedGas / TGAS);
      typical += measured !== null ? Math.min(measured, attachedT || measured) : attachedT * UNKNOWN_SHARE;
      if (['storage_deposit', 'tokens_storage_deposit'].includes(methodName)) storage += BigInt(deposit || '0');
    })
  );
  const toNear = (yocto) => Number(yocto) / 1e24;
  return {
    feeNear: toNear(BigInt(Math.round(typical * 1e12)) * price),
    maxFeeNear: toNear(attached * price),
    storageNear: toNear(storage)
  };
}
