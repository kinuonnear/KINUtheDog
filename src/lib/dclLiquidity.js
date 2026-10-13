// Concentrated liquidity (Rhea DCL, dclv2.ref-labs.near) — add / remove positions.
// Call shapes follow app.rhea.finance:
//   storage_deposit on the DCL contract (position slots)
//   ft_transfer_call(token -> DCL, msg: "Deposit") for each token
//   add_liquidity { pool_id, left_point, right_point, amount_x, amount_y, min_amount_x, min_amount_y }
//   batch_remove_liquidity { remove_liquidity_infos: [{ lpt_id, amount, min_amount_x, min_amount_y }] }
//   claim fees = remove_liquidity { lpt_id, amount: "0" } (fees are paid straight to the wallet)
//
// Prices: a DCL "point" p corresponds to a raw price of 1.0001^p (raw token Y per raw token X).

import { CONTRACTS, GAS } from '../config.js';
import { view } from './rpc.js';
import { dclAmountX, dclAmountY, dclPositionAmounts } from './rhea.js';
import { ensureStorageTx, ftTransferCallTx, functionCall, transaction, wrapNearTx } from './tx.js';
import { toBigInt } from './format.js';

export const POINT_MIN = -800000;
export const POINT_MAX = 800000;

const DCL = CONTRACTS.dcl;
const DCL_REGISTER_DEPOSIT = '500000000000000000000000'; // 0.5 NEAR, as app.rhea.finance
const DCL_ADD_GAS = '300000000000000';
const DCL_REMOVE_GAS = '150000000000000';
const DCL_BATCH_REMOVE_GAS = '300000000000000';
const BATCH_SIZE = 10;
const DCL_BATCH_ADD_GAS = '600000000000000'; // as app.rhea.finance
const DCL_WITHDRAW_GAS = '100000000000000';

const LOG_BASE = Math.log(1.0001);

/** Human price (token Y per token X) -> fractional point. */
export function priceToPoint(price, decimalsX, decimalsY) {
  const raw = Number(price) * 10 ** (decimalsY - decimalsX);
  return Math.log(raw) / LOG_BASE;
}

/** Point -> human price (token Y per token X). */
export function pointToPrice(point, decimalsX, decimalsY) {
  return Math.pow(1.0001, point) * 10 ** (decimalsX - decimalsY);
}

/** Snap a point onto the pool's tick grid, inside the contract bounds. */
export function alignPoint(point, pointDelta, mode = 'round') {
  const fn = mode === 'floor' ? Math.floor : mode === 'ceil' ? Math.ceil : Math.round;
  const snapped = fn(point / pointDelta) * pointDelta;
  const min = Math.ceil(POINT_MIN / pointDelta) * pointDelta;
  const max = Math.floor(POINT_MAX / pointDelta) * pointDelta;
  return Math.min(max, Math.max(min, snapped));
}

export function fullRange(pointDelta) {
  return {
    left: Math.ceil(POINT_MIN / pointDelta) * pointDelta,
    right: Math.floor(POINT_MAX / pointDelta) * pointDelta
  };
}

/**
 * Which tokens a range needs relative to the current point:
 *   'x'    – range entirely above the price: only token X
 *   'y'    – range entirely below the price: only token Y
 *   'both' – price inside the range
 */
export function rangeSide(left, right, current) {
  if (current < left) return 'x';
  if (current >= right) return 'y';
  return 'both';
}

/** Float -> integer string (rounded down), safe for very large values. */
export function floatToRaw(value) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return BigInt(Math.floor(value)).toString();
}

/** Points the price may move up / down within a slippage tolerance (in %). A 1% drop spans
 * slightly more points than a 1% rise, so the two sides are sized separately. */
function slippageBand(slippage) {
  const sl = Math.min(Number(slippage) / 100, 0.5);
  return {
    up: Math.max(1, Math.ceil(Math.log(1 + sl) / LOG_BASE)),
    down: Math.max(1, Math.ceil(-Math.log(1 - sl) / LOG_BASE))
  };
}

/**
 * Minimum amounts for add_liquidity that tolerate price moves within the slippage band.
 *
 * The contract adds the most liquidity both deposited amounts allow at the price it sees
 * when the transaction lands, then checks min_amount_x / min_amount_y against what it used.
 * In a concentrated range a small price move shifts the X/Y mix a lot, so "amount minus
 * slippage" per token fails on ordinary moves (worst in narrow ranges). Instead, the minimums
 * are what the position would use anywhere within ±slippage of the current price: it still
 * fails when the price really moved past the tolerance, but not on small drifts.
 */
export function minAmountsInBand({ left, right, current, amountX, amountY, slippage }) {
  const ax = Number(amountX);
  const ay = Number(amountY);
  const UNIT = 1e24; // reference liquidity; only ratios matter
  const used = (point) => {
    const split = Math.min(Math.max(point, left), right);
    const ux = dclAmountX(UNIT, split, right);
    const uy = dclAmountY(UNIT, left, split);
    const lx = ux > 0 ? ax / ux : Infinity;
    const ly = uy > 0 ? ay / uy : Infinity;
    const l = Math.min(lx, ly);
    return Number.isFinite(l) ? { x: l * ux, y: l * uy } : { x: 0, y: 0 };
  };
  const { up, down } = slippageBand(slippage);
  // Used amounts are monotonic in the price, so the band's ends (plus the middle) bound them.
  const samples = [-down, -down / 2, 0, up / 2, up].map((k) => used(Math.round(current + k)));
  const margin = 0.999; // rounding headroom between this math and the contract's integer math
  return {
    minX: floatToRaw(Math.min(...samples.map((s) => s.x)) * margin),
    minY: floatToRaw(Math.min(...samples.map((s) => s.y)) * margin)
  };
}

/**
 * Minimum amounts for removing `liquidity` from a position: the least of each token it returns
 * anywhere within ±slippage of the current price (the X/Y mix shifts with the price).
 */
export function removeMinsInBand({ left, right, current, liquidity, slippage }) {
  const L = Number(liquidity);
  const { up, down } = slippageBand(slippage);
  const samples = [-down, -down / 2, 0, up / 2, up].map((k) => {
    const split = Math.min(Math.max(Math.round(current + k), left), right);
    return { x: dclAmountX(L, split, right), y: dclAmountY(L, left, split) };
  });
  const margin = 0.999;
  return {
    minX: floatToRaw(Math.min(...samples.map((s) => s.x)) * margin),
    minY: floatToRaw(Math.min(...samples.map((s) => s.y)) * margin)
  };
}

/** Storage-deposit action needed on the DCL contract before adding a position. */
async function dclStorageAction(accountId, newSlots) {
  const detail = await view(DCL, 'get_user_storage_detail', { user_id: accountId }, { fresh: true }).catch(() => null);
  if (!detail) {
    return functionCall('storage_deposit', { account_id: accountId, registration_only: true }, GAS.storageDeposit, DCL_REGISTER_DEPOSIT);
  }
  const used = Number(detail.cur_liquidity_slots || 0) + Number(detail.cur_order_slots || 0);
  const needed = used + newSlots - Number(detail.max_slots || 0);
  if (needed <= 0) return null;
  let amount = toBigInt(detail.slot_price) * BigInt(Math.max(needed, 10));
  if (detail.sponsor_id && detail.sponsor_id !== accountId) amount += toBigInt(detail.locked_near);
  return functionCall('storage_deposit', { account_id: accountId, registration_only: false }, GAS.storageDeposit, amount.toString());
}

/**
 * @param pool       raw DCL get_pool() result
 * @param amountX/Y  raw amounts (strings); either may be "0" for single-sided ranges
 * @param wrapX/Y    raw yocto to wrap first when the token is wNEAR and the wallet holds native NEAR
 */
export async function buildDclAddTransactions({
  pool,
  left,
  right,
  amountX,
  amountY,
  slippage,
  accountId,
  wrapX = '0',
  wrapY = '0'
}) {
  if (!(left < right)) throw new Error('Min price must be lower than max price.');
  if (toBigInt(amountX) <= 0n && toBigInt(amountY) <= 0n) throw new Error('Enter an amount.');

  const txs = [];
  const storage = await dclStorageAction(accountId, 1);
  if (storage) txs.push(transaction(DCL, [storage]));

  for (const token of [pool.token_x, pool.token_y]) {
    txs.push(await ensureStorageTx(token, accountId));
  }

  const wrapTotal = toBigInt(wrapX) + toBigInt(wrapY);
  if (wrapTotal > 0n) {
    txs.push(await ensureStorageTx(CONTRACTS.wrapNear, accountId));
    txs.push(wrapNearTx(wrapTotal.toString()));
  }

  if (toBigInt(amountX) > 0n) txs.push(ftTransferCallTx(pool.token_x, DCL, amountX, '"Deposit"', GAS.dclDeposit));
  if (toBigInt(amountY) > 0n) txs.push(ftTransferCallTx(pool.token_y, DCL, amountY, '"Deposit"', GAS.dclDeposit));

  const { minX, minY } = minAmountsInBand({ left, right, current: pool.current_point, amountX, amountY, slippage });
  txs.push(
    transaction(DCL, [
      functionCall(
        'add_liquidity',
        {
          pool_id: pool.pool_id,
          left_point: left,
          right_point: right,
          amount_x: amountX,
          amount_y: amountY,
          min_amount_x: minX,
          min_amount_y: minY
        },
        DCL_ADD_GAS
      )
    ])
  );

  return txs.filter(Boolean);
}

async function tokenStorageTxs(position, accountId) {
  const txs = [];
  for (const token of [position.tokenX, position.tokenY]) txs.push(await ensureStorageTx(token, accountId));
  return txs;
}

/**
 * Remove `percent` of every position in `positions` (one pool), as the
 * Remove button on app.rhea.finance/poolV2 does. Tokens go straight to the wallet.
 * @param positions  items from rhea.getDclPositions() (same pool)
 */
export async function buildDclRemoveTransactions({ positions, percent, slippage, accountId }) {
  if (!positions.length) throw new Error('Nothing to remove.');
  const infos = positions
    .map((p) => {
      const amount = ((toBigInt(p.liquidity) * BigInt(percent)) / 100n).toString();
      const { minX, minY } = removeMinsInBand({ left: p.leftPoint, right: p.rightPoint, current: p.currentPoint, liquidity: amount, slippage });
      return { lpt_id: p.id, amount, min_amount_x: minX, min_amount_y: minY };
    })
    .filter((info) => toBigInt(info.amount) > 0n);
  if (!infos.length) throw new Error('Nothing to remove.');

  const txs = await tokenStorageTxs(positions[0], accountId);
  for (let i = 0; i < infos.length; i += BATCH_SIZE) {
    txs.push(
      transaction(DCL, [
        functionCall('batch_remove_liquidity', { remove_liquidity_infos: infos.slice(i, i + BATCH_SIZE) }, DCL_BATCH_REMOVE_GAS)
      ])
    );
  }
  return txs.filter(Boolean);
}

/** Claim unclaimed fees of the given positions (same pool) to the wallet. */
export async function buildDclClaimTransactions({ positions, accountId }) {
  const withFees = positions.filter((p) => toBigInt(p.unclaimedFeeX) > 0n || toBigInt(p.unclaimedFeeY) > 0n);
  if (!withFees.length) throw new Error('No fees to claim.');
  const txs = await tokenStorageTxs(withFees[0], accountId);
  withFees.forEach((p) => {
    txs.push(
      transaction(DCL, [
        functionCall('remove_liquidity', { lpt_id: p.id, amount: '0', min_amount_x: '0', min_amount_y: '0' }, DCL_REMOVE_GAS)
      ])
    );
  });
  return txs.filter(Boolean);
}

/** Tokens sitting in the user's DCL balance (e.g. leftovers from a deposit). */
export async function getDclAssets(accountId) {
  const assets = (await view(DCL, 'list_user_assets', { account_id: accountId }, { fresh: true }).catch(() => ({}))) || {};
  return Object.fromEntries(Object.entries(assets).filter(([, amount]) => toBigInt(amount) > 0n));
}

export async function buildDclWithdrawTransactions({ tokenIds, accountId }) {
  const txs = [];
  for (const token of tokenIds) {
    txs.push(await ensureStorageTx(token, accountId));
    txs.push(transaction(DCL, [functionCall('withdraw_asset', { token_id: token }, DCL_WITHDRAW_GAS)]));
  }
  return txs.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Market depth & multi-bin strategies (Spot / Curve / Bid-Ask)        */
/* ------------------------------------------------------------------ */

/** Pool liquidity by point segment: { current, segments: [{ left, right, liquidity }] }. */
export async function getMarketDepth(poolId) {
  const depth = await view(DCL, 'get_marketdepth', { pool_id: poolId, depth: 100 });
  const segments = Object.values(depth?.liquidities || {})
    .map((s) => ({ left: s.left_point, right: s.right_point, liquidity: Number(s.amount_l) }))
    .filter((s) => s.right > s.left && s.liquidity > 0)
    .sort((a, b) => a.left - b.left);
  return { current: depth?.current_point, segments };
}

export const STRATEGIES = [
  { key: 'spot', label: 'Spot', hint: 'Even liquidity across the range. Simple and works for any market.' },
  { key: 'curve', label: 'Curve', hint: 'Concentrated around the current price. Highest fees while the price is calm.' },
  { key: 'bidask', label: 'Bid-Ask', hint: 'More liquidity at the edges. Captures volatility and DCA-style entries/exits.' }
];

const MAX_BINS = 9; // one DCL position per bin; matches app.rhea.finance batch size

/**
 * Split [left, right) into positions shaped by the strategy.
 * Spot is a single position; Curve / Bid-Ask use up to 9 weighted positions.
 */
export function buildBins({ left, right, current, pointDelta, strategy }) {
  if (!(right > left)) return [];
  if (strategy === 'spot') return [{ left, right, weight: 1 }];
  const ticks = Math.round((right - left) / pointDelta);
  const count = Math.max(1, Math.min(MAX_BINS, ticks));
  const bins = [];
  let start = left;
  for (let i = 0; i < count; i += 1) {
    const remaining = count - i;
    const width = Math.max(1, Math.round((right - start) / pointDelta / remaining)) * pointDelta;
    const end = i === count - 1 ? right : Math.min(right, start + width);
    if (end > start) bins.push({ left: start, right: end });
    start = end;
  }
  const reach = Math.max(current - left, right - current, 1);
  return bins.map((b) => {
    const d = Math.min(1, Math.abs((b.left + b.right) / 2 - current) / reach);
    const weight = strategy === 'curve' ? Math.exp(-(d * d) / (2 * 0.38 * 0.38)) : 0.2 + d * d;
    return { ...b, weight };
  });
}

/**
 * Size every bin from one known token amount so the whole shape is funded.
 * Returns raw float amounts per bin plus totals; `from` is 'x' or 'y'.
 */
export function planBins({ bins, current, from, amount }) {
  const withUnits = bins.map((b) => {
    const split = Math.min(Math.max(current, b.left), b.right);
    return { ...b, xPerL: dclAmountX(b.weight, split, b.right), yPerL: dclAmountY(b.weight, b.left, split) };
  });
  const unitX = withUnits.reduce((s, b) => s + b.xPerL, 0);
  const unitY = withUnits.reduce((s, b) => s + b.yPerL, 0);
  const a = Number(amount);
  const unit = from === 'x' ? unitX : unitY;
  const k = a > 0 && unit > 0 ? a / unit : 0;
  const planned = withUnits.map((b) => ({ ...b, amountX: b.xPerL * k, amountY: b.yPerL * k }));
  return {
    bins: planned,
    totalX: planned.reduce((s, b) => s + b.amountX, 0),
    totalY: planned.reduce((s, b) => s + b.amountY, 0),
    needsX: unitX > 0,
    needsY: unitY > 0
  };
}

/** Deposit and open every planned bin as its own position (batch_add_liquidity). */
export async function buildDclBinsTransactions({ pool, plan, slippage, accountId, wrapX = '0', wrapY = '0' }) {
  const infos = plan.bins
    .map((b) => {
      const amountX = floatToRaw(b.amountX);
      const amountY = floatToRaw(b.amountY);
      const { minX, minY } = minAmountsInBand({ left: b.left, right: b.right, current: pool.current_point, amountX, amountY, slippage });
      return {
        pool_id: pool.pool_id,
        left_point: b.left,
        right_point: b.right,
        amount_x: amountX,
        amount_y: amountY,
        min_amount_x: minX,
        min_amount_y: minY
      };
    })
    .filter((i) => toBigInt(i.amount_x) > 0n || toBigInt(i.amount_y) > 0n);
  if (!infos.length) throw new Error('Enter an amount.');
  if (infos.length === 1) {
    const [only] = infos;
    return buildDclAddTransactions({
      pool,
      left: only.left_point,
      right: only.right_point,
      amountX: only.amount_x,
      amountY: only.amount_y,
      slippage,
      accountId,
      wrapX,
      wrapY
    });
  }

  const totalX = infos.reduce((s, i) => s + toBigInt(i.amount_x), 0n).toString();
  const totalY = infos.reduce((s, i) => s + toBigInt(i.amount_y), 0n).toString();
  const txs = [];
  const storage = await dclStorageAction(accountId, infos.length);
  if (storage) txs.push(transaction(DCL, [storage]));
  for (const token of [pool.token_x, pool.token_y]) txs.push(await ensureStorageTx(token, accountId));
  const wrapTotal = toBigInt(wrapX) + toBigInt(wrapY);
  if (wrapTotal > 0n) {
    txs.push(await ensureStorageTx(CONTRACTS.wrapNear, accountId));
    txs.push(wrapNearTx(wrapTotal.toString()));
  }
  if (toBigInt(totalX) > 0n) txs.push(ftTransferCallTx(pool.token_x, DCL, totalX, '"Deposit"', GAS.dclDeposit));
  if (toBigInt(totalY) > 0n) txs.push(ftTransferCallTx(pool.token_y, DCL, totalY, '"Deposit"', GAS.dclDeposit));
  for (let i = 0; i < infos.length; i += BATCH_SIZE) {
    txs.push(
      transaction(DCL, [
        functionCall('batch_add_liquidity', { add_liquidity_infos: infos.slice(i, i + BATCH_SIZE) }, DCL_BATCH_ADD_GAS)
      ])
    );
  }
  return txs.filter(Boolean);
}

/**
 * Size a planned shape to fit token budgets (raw floats): the scarcer side
 * decides. Used by Zap In, where budgets are the swaps' minimum outputs.
 * @param bins  planned bins carrying xPerL / yPerL (from planBins)
 */
export function planBinsByBudget({ bins, budgetX, budgetY }) {
  const unitX = bins.reduce((s, b) => s + b.xPerL, 0);
  const unitY = bins.reduce((s, b) => s + b.yPerL, 0);
  const limits = [];
  if (unitX > 0) limits.push(Number(budgetX) / unitX);
  if (unitY > 0) limits.push(Number(budgetY) / unitY);
  // Stay a hair under the budget so float rounding can never overspend.
  const k = limits.length ? Math.max(0, Math.min(...limits)) * (1 - 1e-9) : 0;
  const planned = bins.map((b) => ({ ...b, amountX: b.xPerL * k, amountY: b.yPerL * k }));
  return {
    bins: planned,
    totalX: planned.reduce((s, b) => s + b.amountX, 0),
    totalY: planned.reduce((s, b) => s + b.amountY, 0),
    needsX: unitX > 0,
    needsY: unitY > 0
  };
}

/* ------------------------------------------------------------------ */
/* Auto-compound                                                       */
/* ------------------------------------------------------------------ */

const raw = (n) => (n > 0 ? BigInt(Math.floor(n)) : 0n);
const isFull = (p) => p.leftPoint <= POINT_MIN + 10000 && p.rightPoint >= POINT_MAX - 10000;
const MIN_SHARE = 0.002; // skip appends below 0.2% of a token's pool of fees (saves gas)

/**
 * How the pool's claimable fees go back into the positions. All fees are pooled first, then:
 *   1. positions in range take both tokens in their own X/Y ratio, in proportion to liquidity;
 *   2. mode 'shape': leftover X goes to positions above the price, leftover Y to positions below,
 *      in proportion to liquidity — the user's range shape is kept;
 *      mode 'earning': only step 1; the rest stays in the wallet.
 * Returns { items: [{ position, amountX, amountY }], totalX, totalY, feeX, feeY } (raw BigInt).
 */
export function planCompound(positions, { mode = 'shape' } = {}) {
  const feeX = positions.reduce((s, p) => s + toBigInt(p.unclaimedFeeX), 0n);
  const feeY = positions.reduce((s, p) => s + toBigInt(p.unclaimedFeeY), 0n);
  const alloc = new Map(); // id -> { position, x, y } (floats)
  const add = (p, x, y) => {
    const a = alloc.get(p.id) || { position: p, x: 0, y: 0 };
    a.x += x;
    a.y += y;
    alloc.set(p.id, a);
  };
  const ranged = positions.filter((p) => !isFull(p) && Number(p.liquidity) > 0);
  let leftX = Number(feeX);
  let leftY = Number(feeY);

  // 1. In range: both tokens in each position's ratio, weighted by its liquidity.
  const inRange = ranged.filter((p) => p.currentPoint >= p.leftPoint && p.currentPoint < p.rightPoint);
  const units = inRange.map((p) => {
    const L = Number(p.liquidity);
    return { p, x: dclAmountX(L, p.currentPoint, p.rightPoint), y: dclAmountY(L, p.leftPoint, p.currentPoint) };
  });
  const sumX = units.reduce((s, u) => s + u.x, 0);
  const sumY = units.reduce((s, u) => s + u.y, 0);
  const k = Math.min(sumX > 0 ? leftX / sumX : Infinity, sumY > 0 ? leftY / sumY : Infinity);
  if (Number.isFinite(k) && k > 0) {
    units.forEach((u) => add(u.p, u.x * k, u.y * k));
    leftX -= sumX * k;
    leftY -= sumY * k;
  }

  // 2. Keep the shape: the rest of X above the price, the rest of Y below it.
  if (mode === 'shape') {
    const spread = (list, amount, key) => {
      const total = list.reduce((s, p) => s + Number(p.liquidity), 0);
      if (!(total > 0) || !(amount > 0)) return 0;
      list.forEach((p) => add(p, key === 'x' ? (amount * Number(p.liquidity)) / total : 0, key === 'y' ? (amount * Number(p.liquidity)) / total : 0));
      return amount;
    };
    leftX -= spread(ranged.filter((p) => p.currentPoint < p.leftPoint), leftX, 'x');
    leftY -= spread(ranged.filter((p) => p.currentPoint >= p.rightPoint), leftY, 'y');
  }

  // Integer amounts, never above the fees, dust appends dropped.
  const items = [];
  let totalX = 0n;
  let totalY = 0n;
  alloc.forEach(({ position, x, y }) => {
    let ax = raw(x * 0.9999);
    let ay = raw(y * 0.9999);
    if (Number(ax) < Number(feeX) * MIN_SHARE) ax = 0n;
    if (Number(ay) < Number(feeY) * MIN_SHARE) ay = 0n;
    if (ax <= 0n && ay <= 0n) return;
    items.push({ position, amountX: ax, amountY: ay });
    totalX += ax;
    totalY += ay;
  });
  // Rounding can never push the deposit above what is claimed.
  if (totalX > feeX || totalY > feeY) return { items: [], totalX: 0n, totalY: 0n, feeX, feeY };
  return { items, totalX, totalY, feeX, feeY };
}

/* ------------------------------------------------------------------ */
/* Add to a position                                                   */
/* ------------------------------------------------------------------ */

/** The positions re-priced at a pool point: token amounts, in-range flag and current point. */
export function positionsAtPoint(positions, currentPoint) {
  if (!Number.isFinite(currentPoint)) return positions;
  return positions.map((p) => {
    const { x, y } = dclPositionAmounts({ liquidity: p.liquidity, leftPoint: p.leftPoint, rightPoint: p.rightPoint, currentPoint });
    return { ...p, currentPoint, inRange: currentPoint >= p.leftPoint && currentPoint < p.rightPoint, amountX: x, amountY: y };
  });
}

/** Live pool state straight from the contract (no cache), for the moment of signing. */
export async function freshPool(poolId) {
  const pool = await view(DCL, 'get_pool', { pool_id: poolId }, { fresh: true });
  if (!pool) throw new Error('Pool could not be loaded. Try again.');
  return pool;
}

/**
 * Add to an existing position (a deposit's bins) and keep its shape: every bin grows by
 * the same factor k, so it takes k × the tokens it holds now. `inX` / `inY` (raw) is what
 * the user offers of each token; the scarcer side decides k.
 * Returns { items: [{ position, amountX, amountY }], totalX, totalY } (raw BigInt).
 */
export function planAppend(positions, { inX = 0n, inY = 0n }) {
  const live = positions.filter((p) => Number(p.liquidity) > 0);
  const holdX = live.reduce((s, p) => s + p.amountX, 0);
  const holdY = live.reduce((s, p) => s + p.amountY, 0);
  const limits = [];
  if (holdX > 0) limits.push(Number(inX) / holdX);
  if (holdY > 0) limits.push(Number(inY) / holdY);
  const k = limits.length ? Math.max(0, Math.min(...limits)) : 0;
  const items = [];
  let totalX = 0n;
  let totalY = 0n;
  live.forEach((p) => {
    const ax = raw(p.amountX * k * 0.9999);
    const ay = raw(p.amountY * k * 0.9999);
    if (ax <= 0n && ay <= 0n) return;
    items.push({ position: p, amountX: ax, amountY: ay });
    totalX += ax;
    totalY += ay;
  });
  if (totalX > toBigInt(inX) || totalY > toBigInt(inY)) return { items: [], totalX: 0n, totalY: 0n };
  return { items, totalX, totalY };
}

/** The other token's amount (raw) that keeps the shape when adding `amount` of `side`. */
export function appendCounterpart(positions, side, amount) {
  const holdX = positions.reduce((s, p) => s + p.amountX, 0);
  const holdY = positions.reduce((s, p) => s + p.amountY, 0);
  const [from, to] = side === 'x' ? [holdX, holdY] : [holdY, holdX];
  if (!(from > 0)) return 0n;
  return raw((Number(amount) * to) / from);
}

function appendTx(p, amountX, amountY, slippage) {
  const { minX, minY } = minAmountsInBand({
    left: p.leftPoint,
    right: p.rightPoint,
    current: p.currentPoint,
    amountX: amountX.toString(),
    amountY: amountY.toString(),
    slippage
  });
  return transaction(DCL, [
    functionCall(
      'append_liquidity',
      { lpt_id: p.id, amount_x: amountX.toString(), amount_y: amountY.toString(), min_amount_x: minX, min_amount_y: minY },
      DCL_ADD_GAS
    )
  ]);
}

/**
 * One wallet request: deposit the planned amounts (wrapping NEAR first if needed) and
 * append them to the position's bins. The bins keep their ids, so it stays one position.
 */
export async function buildDclAppendTransactions({ positions, inX, inY, slippage, accountId, wrapX = '0', wrapY = '0' }) {
  const plan = planAppend(positions, { inX: toBigInt(inX), inY: toBigInt(inY) });
  if (!plan.items.length) throw new Error('Enter an amount.');
  const { tokenX, tokenY } = positions[0];
  const txs = await tokenStorageTxs(positions[0], accountId);
  const wrapTotal = (plan.totalX > 0n ? toBigInt(wrapX) : 0n) + (plan.totalY > 0n ? toBigInt(wrapY) : 0n);
  if (wrapTotal > 0n) {
    txs.push(await ensureStorageTx(CONTRACTS.wrapNear, accountId));
    txs.push(wrapNearTx(wrapTotal.toString()));
  }
  if (plan.totalX > 0n) txs.push(ftTransferCallTx(tokenX, DCL, plan.totalX.toString(), '"Deposit"', GAS.dclDeposit));
  if (plan.totalY > 0n) txs.push(ftTransferCallTx(tokenY, DCL, plan.totalY.toString(), '"Deposit"', GAS.dclDeposit));
  plan.items.forEach(({ position, amountX, amountY }) => txs.push(appendTx(position, amountX, amountY, slippage)));
  return txs.filter(Boolean);
}

/**
 * One wallet request: claim every position's fees (they arrive in the wallet), deposit the
 * part that fits back into the CLMM contract, and append it to the same positions.
 */
export async function buildDclCompoundTransactions({ positions, slippage, accountId, mode = 'shape' }) {
  const withFees = positions.filter((p) => toBigInt(p.unclaimedFeeX) > 0n || toBigInt(p.unclaimedFeeY) > 0n);
  const plan = planCompound(positions, { mode });
  if (!plan.items.length) throw new Error('No fees can be compounded into these positions right now.');
  const { tokenX, tokenY } = withFees[0];

  const txs = await tokenStorageTxs(withFees[0], accountId);
  withFees.forEach((p) => {
    txs.push(transaction(DCL, [functionCall('remove_liquidity', { lpt_id: p.id, amount: '0', min_amount_x: '0', min_amount_y: '0' }, DCL_REMOVE_GAS)]));
  });
  if (plan.totalX > 0n) txs.push(ftTransferCallTx(tokenX, DCL, plan.totalX.toString(), '"Deposit"', GAS.dclDeposit));
  if (plan.totalY > 0n) txs.push(ftTransferCallTx(tokenY, DCL, plan.totalY.toString(), '"Deposit"', GAS.dclDeposit));
  plan.items.forEach(({ position, amountX, amountY }) => txs.push(appendTx(position, amountX, amountY, slippage)));
  return txs.filter(Boolean);
}
