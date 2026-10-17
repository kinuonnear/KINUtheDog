// Liquid staking (/stake): stake NEAR for LiNEAR (linear-protocol.near) or stNEAR (meta-pool.near).
// Both are NEAR's longest-running liquid staking contracts, each owned by a Sputnik DAO; their
// tokens grow in NEAR value every epoch and can be used in Rhea pools. KINU never holds anything:
// the user's wallet calls the staking contract directly. Method names and rules are from each
// contract's public source (github.com/linear-protocol/LiNEAR, Meta-Pool/liquid-staking-contract).
//
// Leaving: instantly by selling the token (LiNEAR on Rhea through Swap; stNEAR through Meta Pool's
// own NEAR/stNEAR pool, liquid_unstake), or by a delayed unstake that is withdrawable after
// about four epochs (an epoch is 43,200 blocks, ~7 h: a day or two in all).

import { rpc, view } from './rpc.js';
import { functionCall, transaction } from './tx.js';
import { searchPools } from './rhea.js';

const ONE_NEAR = 10n ** 24n;
const GAS = '100000000000000'; // 100 TGas; staking work is internal to each contract, unused gas is refunded
const ARCHIVAL = 'https://archival-rpc.mainnet.fastnear.com';
// 90 days: LiNEAR books its rewards in steps (some weeks 0%, then a catch-up), so a shorter window
// can over- or understate it.
const APY_DAYS = 90;
const UNSTAKED_DUST = ONE_NEAR / 1000n; // 0.001 NEAR

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

// The public archival node rate-limits bursts: at most two requests at a time, and a failed one
// is retried after a short pause.
const ARCHIVAL_PARALLEL = 2;
let archivalActive = 0;
const archivalQueue = [];
async function archivalSlot(fn) {
  if (archivalActive >= ARCHIVAL_PARALLEL) await new Promise((resolve) => archivalQueue.push(resolve));
  archivalActive += 1;
  try {
    return await fn();
  } finally {
    archivalActive -= 1;
    archivalQueue.shift()?.();
  }
}

async function archival(method, params) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await archivalSlot(async () => {
        const r = await fetch(ARCHIVAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'kinu', method, params }) });
        const j = await r.json();
        if (!r.ok || j.error || j.result?.error) throw new Error(`archival RPC ${r.status}`);
        return j.result;
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** A token's NEAR value (as a float) at `height`; a missing (skipped) block falls back a few blocks. */
async function priceAtBlock(key, height) {
  const s = STAKING[key];
  for (let back = 0; back < 6; back += 1) {
    try {
      const res = await archival('query', { request_type: 'call_function', account_id: s.contract, method_name: s.priceMethod, args_base64: '', block_id: height - back });
      return Number(JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)))) / 1e24;
    } catch {
      // try the block before
    }
  }
  throw new Error('price unavailable');
}

async function headAndPace() {
  const now = await archival('block', { finality: 'final' });
  const height = now.header.height;
  const ref = await archival('block', { block_id: height - 100_000 });
  const secPerBlock = (Number(now.header.timestamp) - Number(ref.header.timestamp)) / 1e9 / 100_000;
  return { height, time: Number(now.header.timestamp) / 1e6, secPerBlock };
}

// Readings that only change slowly are kept in the browser, so a visit doesn't re-read the
// public archival node (it rate-limits): APY for an hour, the weekly history for six.
function stored(name, ttlMs) {
  try {
    const hit = JSON.parse(localStorage.getItem(name) || 'null');
    return hit && Date.now() - hit.at < ttlMs ? hit.value : null;
  } catch {
    return null;
  }
}
function store(name, value) {
  try {
    localStorage.setItem(name, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // storage full or blocked: just don't cache
  }
}
const HISTORY_TTL_MS = 6 * 3600_000;
const APY_TTL_MS = 3600_000;

const historyCache = new Map();
/**
 * The token's yield history over `days` (default 90): its NEAR value every 7 days and the APY of
 * each week ({ points: [{ at, price }], weeks: [{ end, apy }], apy30, apy90 }). Read from archival RPC, cached per session.
 */
export function getApyHistory(key, days = 90) {
  const id = `${key}:${days}`;
  if (!historyCache.has(id)) {
    historyCache.set(
      id,
      (async () => {
        const saved = stored(`kinu.stake.history.${id}`, HISTORY_TTL_MS);
        if (saved) return saved;
        const { height, time, secPerBlock } = await headAndPace();
        const blocksPerDay = 86_400 / secPerBlock;
        const steps = Math.round(days / 7);
        const points = await Promise.all(
          Array.from({ length: steps + 1 }, async (_, i) => {
            const daysAgo = (steps - i) * 7;
            return { at: time - daysAgo * 86_400_000, price: await priceAtBlock(key, height - Math.round(daysAgo * blocksPerDay)) };
          })
        );
        const weeks = points.slice(1).map((p, i) => ({ end: p.at, apy: (Math.pow(p.price / points[i].price, 365 / 7) - 1) * 100 }));
        const last = points[points.length - 1].price;
        const ago = (d) => points[Math.max(0, points.length - 1 - Math.round(d / 7))].price;
        const yearly = (p0, d) => (Math.pow(last / p0, 365 / d) - 1) * 100;
        const result = { key, points, weeks, apy30: yearly(ago(28), 28), apy90: yearly(points[0].price, steps * 7) };
        store(`kinu.stake.history.${id}`, result);
        return result;
      })().catch((e) => {
        historyCache.delete(id);
        throw e;
      })
    );
  }
  return historyCache.get(id);
}

/**
 * What the account's staking has earned: its deposit_and_stake calls to the contract (NearBlocks),
 * each valued at the token price of its block, against today's price. Counts only tokens it staked
 * itself and still holds (tokens bought or sold elsewhere are left out). null when it never staked.
 */
export async function getStakeEarnings(key, accountId, heldShares, priceNow) {
  const s = STAKING[key];
  const params = new URLSearchParams({ to: s.contract, method: 'deposit_and_stake', per_page: '50', order: 'desc' });
  const r = await fetch(`https://api.nearblocks.io/v1/account/${encodeURIComponent(accountId)}/txns?${params}`);
  if (!r.ok) throw new Error(`NearBlocks HTTP ${r.status}`);
  const stakes = ((await r.json()).txns || []).filter(
    (t) => t.outcomes?.status !== false && t.receiver_account_id === s.contract && (t.actions || []).some((a) => a.method === 'deposit_and_stake')
  );
  if (!stakes.length) return null;
  let near = 0;
  let shares = 0;
  let first = Infinity;
  for (const t of stakes) {
    const deposit = (t.actions || []).filter((a) => a.method === 'deposit_and_stake').reduce((sum, a) => sum + Number(a.deposit || 0) / 1e24, 0);
    const height = Number(t.block?.block_height || t.receipt_block?.block_height);
    if (!(deposit > 0) || !height) continue;
    const price = await priceAtBlock(key, height);
    near += deposit;
    shares += deposit / price;
    first = Math.min(first, Number(t.block_timestamp) / 1e6);
  }
  if (!(shares > 0)) return null;
  const held = Math.min(Number(heldShares) / 1e24, shares);
  const earned = held * (Number(priceNow) / 1e24 - near / shares);
  return { earned, since: Number.isFinite(first) ? first : null, stakedNear: near };
}

let apyCache = null;
/**
 * Yearly growth of each token's NEAR value over the last 90 days ({ linear, stnear } in percent).
 * It is what stakers actually earned, after every fee, not a promised rate. null when unavailable.
 */
export function getStakingApy() {
  if (apyCache) return apyCache;
  apyCache = (async () => {
    const saved = stored('kinu.stake.apy', APY_TTL_MS);
    if (saved) return saved;
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
    if (Object.values(out).every((v) => v != null)) store('kinu.stake.apy', out);
    else apyCache = null; // try again on the next read
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
  // Staking leaves rounding dust (often 1 yocto) in the unstaked balance: not worth a withdrawal.
  const unstakedRaw = BigInt(account?.unstaked_balance || '0');
  const unstaked = unstakedRaw >= UNSTAKED_DUST ? unstakedRaw : 0n;
  const canWithdraw = Boolean(account?.can_withdraw);
  return {
    shares,
    valueNear: (shares * price) / ONE_NEAR,
    unstaked,
    canWithdraw,
    // When a delayed unstake unlocks (epoch), only while one is waiting.
    unlockEpoch: unstaked > 0n && !canWithdraw ? await unlockEpoch(key, accountId).catch(() => null) : null
  };
}

/**
 * Where the chain is in its epochs: { epochHeight, epochStart, epochLength, height, secPerBlock }.
 * Used to turn a delayed unstake's unlock epoch into a time.
 */
let clockCache = { at: 0, value: null };
export async function getEpochClock() {
  if (clockCache.value && Date.now() - clockCache.at < 60_000) return clockCache.value;
  const [validators, config, head] = await Promise.all([
    rpc('validators', [null]),
    rpc('EXPERIMENTAL_protocol_config', { finality: 'final' }),
    rpc('block', { finality: 'final' })
  ]);
  const ref = await rpc('block', { block_id: head.header.height - 1000 }).catch(() => null);
  const secPerBlock = ref ? (Number(head.header.timestamp) - Number(ref.header.timestamp)) / 1e9 / 1000 : 0.6;
  const value = {
    epochHeight: Number(validators.epoch_height),
    epochStart: Number(validators.epoch_start_height),
    epochLength: Number(config.epoch_length),
    height: Number(head.header.height),
    secPerBlock
  };
  clockCache = { at: Date.now(), value };
  return value;
}

/** Seconds until `unlockEpoch` starts (0 when already reached). */
export function secondsUntilEpoch(unlockEpoch, clock) {
  const ahead = Number(unlockEpoch) - clock.epochHeight;
  if (!(ahead > 0)) return 0;
  const blocks = clock.epochStart + ahead * clock.epochLength - clock.height;
  return Math.max(0, blocks * clock.secPerBlock);
}

/** The epoch a delayed unstake unlocks at, or null. */
export async function unlockEpoch(key, accountId) {
  if (key === 'linear') return (await view(STAKING.linear.contract, 'get_account_details', { account_id: accountId }, { fresh: true }))?.unstaked_available_epoch_height ?? null;
  return (await view(STAKING.stnear.contract, 'get_account_info', { account_id: accountId }, { fresh: true }))?.unstaked_requested_unlock_epoch ?? null;
}

/** "1 d 4 h" / "5 h 12 m" / "under a minute". */
export function formatWait(seconds) {
  if (!(seconds > 60)) return 'under a minute';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} m` : `${m} m`;
}

/** Rhea's biggest pools pairing each staking token with wNEAR (stable "rated" pools first). */
export async function getLstPools() {
  const lists = await Promise.all(
    Object.values(STAKING).map(async (s) => {
      const { list } = await searchPools({ tokenList: s.contract, sort: 'tvl', limit: 10, hideLow: true });
      return list
        .filter((p) => p.tokenIds.includes('wrap.near') && p.tokenIds.length === 2)
        .slice(0, 1)
        .map((p) => ({ ...p, stakeKey: s.key }));
    })
  );
  return lists.flat();
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
