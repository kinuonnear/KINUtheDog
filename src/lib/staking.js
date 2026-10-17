// Liquid staking (/stake): stake NEAR for LiNEAR (linear-protocol.near) or stNEAR (meta-pool.near).
// Both are NEAR's longest-running liquid staking contracts, each owned by a Sputnik DAO; their
// tokens grow in NEAR value every epoch and can be used in Rhea pools. KINU never holds anything:
// the user's wallet calls the staking contract directly. Method names and rules are from each
// contract's public source (github.com/linear-protocol/LiNEAR, Meta-Pool/liquid-staking-contract).
//
// Leaving: instantly by selling the token (LiNEAR on Rhea through Swap; stNEAR through Meta Pool's
// own NEAR/stNEAR pool, liquid_unstake), or by a delayed unstake that is withdrawable after
// about four epochs (~2–3 days).

import { view } from './rpc.js';
import { functionCall, transaction } from './tx.js';

const ONE_NEAR = 10n ** 24n;
const GAS = '100000000000000'; // 100 TGas; staking work is internal to each contract, unused gas is refunded
const ARCHIVAL = 'https://archival-rpc.mainnet.fastnear.com';
const APY_DAYS = 30;

export const STAKING = {
  linear: {
    key: 'linear',
    contract: 'linear-protocol.near',
    symbol: 'LiNEAR',
    name: 'LiNEAR Protocol',
    priceMethod: 'ft_price',
    owner: 'linear.sputnik-dao.near',
    since: 'Mar 2022',
    minStake: 0n,
    withdraw: 'withdraw_all',
    instant: 'swap', // sold on Rhea through the Swap page
    site: 'https://app.linearprotocol.org'
  },
  stnear: {
    key: 'stnear',
    contract: 'meta-pool.near',
    symbol: 'stNEAR',
    name: 'Meta Pool',
    priceMethod: 'get_st_near_price',
    owner: 'stnear.sputnik-dao.near',
    since: 'Aug 2021',
    minStake: ONE_NEAR, // min_deposit_amount on chain
    withdraw: 'withdraw_unstaked',
    instant: 'liquid_unstake', // Meta Pool's NEAR/stNEAR pool
    site: 'https://metapool.app'
  }
};

/** NEAR value of one token (yocto per 1e24). */
export async function priceOf(key) {
  const s = STAKING[key];
  return BigInt(await view(s.contract, s.priceMethod, {}, { fresh: true }));
}

/** Total NEAR staked through the contract. */
export async function totalStaked(key) {
  const s = STAKING[key];
  if (key === 'linear') return BigInt((await view(s.contract, 'get_summary')).total_staked_near_amount);
  return BigInt((await view(s.contract, 'get_contract_state')).total_for_staking);
}

async function archival(method, params) {
  const r = await fetch(ARCHIVAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'kinu', method, params }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error('archival RPC');
  return j.result;
}

let apyCache = null;
/**
 * Yearly growth of each token's NEAR value over the last 30 days ({ linear, stnear } in percent).
 * It is what stakers actually earned, after every fee, not a promised rate. null when unavailable.
 */
export function getStakingApy() {
  if (apyCache) return apyCache;
  apyCache = (async () => {
    const now = await archival('block', { finality: 'final' });
    const height = now.header.height;
    const ref = await archival('block', { block_id: height - 100_000 });
    const secPerBlock = (Number(now.header.timestamp) - Number(ref.header.timestamp)) / 1e9 / 100_000;
    const then = height - Math.round((APY_DAYS * 86_400) / secPerBlock);
    const out = {};
    await Promise.all(
      Object.values(STAKING).map(async (s) => {
        try {
          const read = async (block) => {
            const res = await archival('query', { request_type: 'call_function', account_id: s.contract, method_name: s.priceMethod, args_base64: '', block_id: block });
            return Number(JSON.parse(new TextDecoder().decode(new Uint8Array(res.result))));
          };
          const [p1, p0] = await Promise.all([read(height), read(then)]);
          out[s.key] = (Math.pow(p1 / p0, 365 / APY_DAYS) - 1) * 100;
        } catch {
          out[s.key] = null;
        }
      })
    );
    return out;
  })().catch(() => {
    apyCache = null;
    return {};
  });
  return apyCache;
}

/** The account's position: token balance, its NEAR value, and any delayed unstake. */
export async function getPosition(key, accountId, price) {
  const s = STAKING[key];
  const [balance, account] = await Promise.all([
    view(s.contract, 'ft_balance_of', { account_id: accountId }, { fresh: true }),
    view(s.contract, 'get_account', { account_id: accountId }, { fresh: true })
  ]);
  const shares = BigInt(balance || '0');
  return {
    shares,
    valueNear: (shares * price) / ONE_NEAR,
    unstaked: BigInt(account?.unstaked_balance || '0'),
    canWithdraw: Boolean(account?.can_withdraw)
  };
}

/** NEAR -> tokens at `price` (rounded down). */
export const sharesFor = (near, price) => (price > 0n ? (BigInt(near) * ONE_NEAR) / price : 0n);
/** tokens -> NEAR at `price` (rounded down). */
export const nearFor = (shares, price) => (BigInt(shares) * price) / ONE_NEAR;

/** Meta Pool: NEAR received now for selling `shares` stNEAR in its liquidity pool. */
export async function liquidUnstakeQuote(shares) {
  return BigInt(await view(STAKING.stnear.contract, 'get_near_amount_sell_stnear', { stnear_to_sell: String(shares) }, { fresh: true }));
}

export function stakeTx(key, amountYocto) {
  return transaction(STAKING[key].contract, [functionCall('deposit_and_stake', {}, GAS, String(amountYocto))]);
}

/** Delayed unstake of `nearAmount` (both contracts take the amount in NEAR); `all` unstakes everything. */
export function unstakeTx(key, nearAmount, all = false) {
  return transaction(STAKING[key].contract, [all ? functionCall('unstake_all', {}, GAS) : functionCall('unstake', { amount: String(nearAmount) }, GAS)]);
}

export function withdrawTx(key) {
  return transaction(STAKING[key].contract, [functionCall(STAKING[key].withdraw, {}, GAS)]);
}

/** Meta Pool instant unstake: sell `shares` stNEAR for at least `minNear`. */
export function liquidUnstakeTx(shares, minNear) {
  return transaction(STAKING.stnear.contract, [
    functionCall('liquid_unstake', { st_near_to_burn: String(shares), min_expected_near: String(minNear) }, GAS)
  ]);
}
