// Smart LP: wallets that earn from providing liquidity on Rhea CLMM pools.
//
//   Board    — a snapshot of recently active LP wallets with their stats (public/smart-lp/board.json),
//              made by the KINU team with `npm run smart-lp` (scripts/smart-lp.mjs). Visitors only
//              read the file, so the board costs the site one small static download.
//   Profile  — /lp/<account>: one wallet, read live in the visitor's browser (same engine as the
//              Portfolio's LP history: on-chain dcl.ref events, valued at the time of each event).

import { getClassicPositions, getDclPositions } from './rhea.js';
import { asPoolToken, getFtBalance, getTokens, priceOf } from './tokens.js';
import { toNumber } from './format.js';
import { CONTRACTS, KINU_TOKEN } from '../config.js';

export const BOARD_URL = '/smart-lp/board.json';

/**
 * Smart LP is free during launch; it will become a holder feature for wallets with at least this
 * much KINU (in the wallet or in KINU liquidity). The bar is meant to come down step by step.
 */
export const SMART_LP_MIN_KINU = 1_000_000;

/** KINU an account holds: in the wallet and inside its Rhea liquidity (CLMM + classic). */
export async function getKinuHolding(account) {
  const [walletRaw, dcl, classic, tokens] = await Promise.all([
    getFtBalance(KINU_TOKEN, account).catch(() => '0'),
    getDclPositions(account).catch(() => []),
    getClassicPositions(account).catch(() => []),
    getTokens([KINU_TOKEN])
  ]);
  const decimals = tokens[KINU_TOKEN]?.decimals ?? 18;
  const wallet = toNumber(walletRaw, decimals);
  let inLp = 0;
  dcl.forEach((p) => {
    if (p.tokenX === KINU_TOKEN) inLp += p.amountX / 10 ** decimals;
    if (p.tokenY === KINU_TOKEN) inLp += p.amountY / 10 ** decimals;
  });
  classic.forEach((c) => {
    const i = c.pool.tokenIds.indexOf(KINU_TOKEN);
    if (i >= 0) inLp += toNumber(c.amounts[i], decimals);
  });
  return { wallet, inLp, total: wallet + inLp };
}

/**
 * Style badges from a wallet's stats (board card or live profile — same field names):
 * what kind of LP it is, at a glance.
 */
export function lpBadges(s) {
  const out = [];
  if (s.winRate >= 80 && s.closedCount >= 10) out.push({ key: 'sharp', icon: '🎯', label: 'Sharpshooter', hint: 'Win rate of 80%+ over 10+ closed positions' });
  if (s.totalPnl > 0 && s.feeShare >= 60 && s.fees >= 10) out.push({ key: 'farmer', icon: '🌾', label: 'Fee Farmer', hint: 'Most of the profit is LP fees, not price moves' });
  if (s.avgHold !== null && s.avgHold < 6 * 3_600_000 && s.closedCount >= 5) out.push({ key: 'scalper', icon: '⚡', label: 'Scalper', hint: 'Closed positions are held under 6 hours on average' });
  if (s.avgHold !== null && s.avgHold >= 7 * DAY && s.closedCount >= 3) out.push({ key: 'diamond', icon: '💎', label: 'Diamond Hands', hint: 'Positions are held a week or more on average' });
  if (s.avgInvested >= 10_000) out.push({ key: 'whale', icon: '🐋', label: 'Whale', hint: 'Puts $10K+ into a position on average' });
  return out;
}
const NEARBLOCKS = 'https://api.nearblocks.io/v1';
const DAY = 86_400_000;

/** An account's live CLMM positions with their tokens' metadata. */
export async function loadDclPositions(account) {
  const dcl = await getDclPositions(account);
  const tokens = await getTokens([...new Set(dcl.flatMap((p) => [p.tokenX, p.tokenY]))]);
  return { dcl, tokens };
}

/** Live CLMM positions of an account, marked to market (the Portfolio's dclRows). */
export async function dclRowsFor(account, prices) {
  const { dcl, tokens } = await loadDclPositions(account);
  return markDclRows(dcl, tokens, prices);
}

export function markDclRows(dcl, tokens, prices) {
  const meta = (id) => tokens[id] || { id, symbol: id.slice(0, 6), decimals: 0 };
  return dcl
    .map((p) => {
      const x = asPoolToken(meta(p.tokenX));
      const y = asPoolToken(meta(p.tokenY));
      const ax = p.amountX / 10 ** x.decimals;
      const ay = p.amountY / 10 ** y.decimals;
      const px = priceOf(prices, p.tokenX);
      const py = priceOf(prices, p.tokenY);
      const feeUsd = toNumber(p.unclaimedFeeX, x.decimals) * px + toNumber(p.unclaimedFeeY, y.decimals) * py;
      return { ...p, x, y, ax, ay, usd: ax * px + ay * py, feeUsd };
    })
    .sort((a, b) => b.usd - a.usd);
}

/** The board's compact record of one wallet (from lib/lpStats.js buildLpModel). */
export function walletCard(account, model) {
  const s = model.stats;
  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  return {
    account,
    complete: model.complete,
    totalPnl: r2(s.totalPnl),
    fees: r2(s.fees),
    winRate: r2(s.winRate),
    ev: r2(s.ev),
    avgInvested: r2(s.avgInvested),
    avgHold: s.avgHold === null ? null : Math.round(s.avgHold),
    monthlyPnl: r2(s.monthlyPnl),
    feeShare: r2(s.feeShare),
    openValue: r2(s.openValue),
    openCount: s.openCount,
    closedCount: s.closedCount,
    totalPositions: s.totalPositions,
    poolCount: s.poolCount,
    firstActivity: s.firstActivity,
    lastActivity: s.lastActivity,
    periods: s.periods.map((p) => ({ key: p.key, positions: p.positions, pnl: r2(p.pnl) })),
    last7: s.last7.map(r2),
    pairs: model.pools.slice(0, 3).map((p) => [p.x.id, p.y.id])
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Contracts that add liquidity for others (token launchpads seeding pools, liquidity lockers,
// factories) are not LPs to learn from.
const NOT_AN_LP = /(^lock\.|launchpad|launcher|factory)/;
export const isLpCandidate = (account) => !NOT_AN_LP.test(account);

/**
 * Accounts that added CLMM liquidity in the last `days` (newest first), from NearBlocks: the
 * signers of `batch_add_liquidity` calls to the DCL contract.
 */
export async function discoverLpWallets({ days = 90, maxPages = 240, onPage } = {}) {
  const since = Date.now() - days * DAY;
  const wallets = new Map(); // account -> last seen (ms)
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    // NearBlocks' free API serves at most 25 transactions a page.
    const params = new URLSearchParams({ method: 'batch_add_liquidity', per_page: '25', order: 'desc' });
    if (cursor) params.set('cursor', cursor);
    let json = null;
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(`${NEARBLOCKS}/account/${CONTRACTS.dcl}/txns?${params}`);
      if (res.ok) {
        json = await res.json();
        break;
      }
      if (res.status !== 429 || attempt >= 10) break;
      await sleep(30_000); // rate-limited: rest, then ask again
    }
    if (!json) {
      // Still refused: keep the wallets found so far rather than losing the whole run.
      if (!wallets.size) throw new Error('NearBlocks is refusing requests (rate limit) — try again later');
      onPage?.(page + 1, wallets.size, 'stopped early: NearBlocks rate limit');
      break;
    }
    const txns = json.txns || [];
    let older = false;
    for (const t of txns) {
      const ts = Number(t.block_timestamp) / 1e6;
      if (ts < since) {
        older = true;
        break;
      }
      const account = t.predecessor_account_id;
      if (account && isLpCandidate(account) && t.outcomes?.status !== false && !wallets.has(account)) wallets.set(account, ts);
    }
    onPage?.(page + 1, wallets.size);
    if (older || !json.cursor || txns.length < 25) break;
    cursor = json.cursor;
    await sleep(2_000);
  }
  return [...wallets.keys()];
}

/* ------------------------------------------------------------------ */
/* Board filters and sorting                                           */
/* ------------------------------------------------------------------ */

export const ACTIVE_WINDOWS = [
  { key: '24h', label: 'Last 24h', ms: DAY },
  { key: '7d', label: 'Last 7 days', ms: 7 * DAY },
  { key: '30d', label: 'Last 30 days', ms: 30 * DAY },
  { key: '90d', label: 'Last 90 days', ms: 90 * DAY },
  { key: 'any', label: 'Any time', ms: Infinity }
];

export const DEFAULT_FILTERS = {
  active: 'any',
  minWinRate: 0,
  minPnl: '',
  minFees: '',
  feeChecked: true,
  watchOnly: false
};

export const SORTS = [
  { key: 'totalPnl', label: 'All-time PnL' },
  { key: 'pnl7d', label: '🔥 Hot 7D', hint: 'Most PnL realized in the last 7 days' },
  { key: 'winRate', label: 'Win rate' },
  { key: 'totalPositions', label: 'Positions' },
  { key: 'avgInvested', label: 'Avg invested' },
  { key: 'monthlyPnl', label: 'Monthly PnL' },
  { key: 'fees', label: 'Fees' },
  { key: 'lastActivity', label: 'Last active' }
];

/** "Fee-checked": profit that is at least 10% LP fees (else it came from the token's price). */
export const FEE_CHECK_MIN = 10;

/** `now`: the snapshot time, so "active in the last 24h" means the 24h before the snapshot. */
export function filterBoard(wallets, filters, { watched = [], now = Date.now() } = {}) {
  const window = ACTIVE_WINDOWS.find((w) => w.key === filters.active)?.ms ?? Infinity;
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const minPnl = num(filters.minPnl);
  const minFees = num(filters.minFees);
  const watchSet = new Set(watched);
  return wallets.filter(
    (w) =>
      (!filters.watchOnly || watchSet.has(w.account)) &&
      (window === Infinity || (w.lastActivity && now - w.lastActivity <= window)) &&
      (w.winRate ?? 0) >= (Number(filters.minWinRate) || 0) &&
      (minPnl === null || w.totalPnl >= minPnl) &&
      (minFees === null || w.fees >= minFees) &&
      (!filters.feeChecked || !(w.totalPnl > 0) || (w.feeShare ?? 0) >= FEE_CHECK_MIN)
  );
}

/** Sort key value; `pnl7d` is the PnL realized in the last 7 days. */
const sortValue = (w, key) => (key === 'pnl7d' ? w.periods?.find((p) => p.key === '7d')?.pnl : w[key]);

export function sortBoard(wallets, { key, desc }) {
  const v = (w) => (Number.isFinite(sortValue(w, key)) ? sortValue(w, key) : null);
  return [...wallets].sort((a, b) => {
    const va = v(a);
    const vb = v(b);
    if (va === null || vb === null) return va === null ? (vb === null ? 0 : 1) : -1;
    return desc ? vb - va : va - vb;
  });
}
