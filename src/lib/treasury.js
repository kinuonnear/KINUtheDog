// KINU treasury (/treasury): where $KINU's creator fee goes, shown in public.
// The creator fee comes from KINU's Nearly launch position (KINU/RHEA CLMM) and is received in
// RHEA by the creator account. It pays for operations first; the rest goes to liquidity.
// Allocations are recorded by hand in LEDGER below (each with its transaction), so every number
// on the page can be checked on-chain.

import { KINU_TOKEN } from '../config.js';
import { fetchMarketCandles } from './intearApi.js';

export const TREASURY = {
  // Receives the creator fee and holds the public LP positions.
  creator: 'kinuonnear.near',
  lpWallet: 'kinuonnear.near',
  // How each creator-fee payment is split (percent).
  split: [
    { key: 'ops', label: 'Operations', pct: 40, text: 'Servers, RPC and data APIs, domain, tools and maintenance.' },
    { key: 'audit', label: 'Audit reserve', pct: 20, text: 'Saved until an independent security audit is paid for.' },
    {
      key: 'lp',
      label: 'Liquidity',
      pct: 40,
      text: 'Provided to pools with real trading volume, on any pair. Fees are rolled back in, and used to support $KINU when its own volume slows.'
    }
  ]
};

/**
 * Allocations made so far, newest first, written as they happened (any token):
 * { date: 'YYYY-MM-DD' (UTC), source, ops, audit, lp, note, txs: [{ label, hash }] }
 * A bucket nothing went to is null.
 */
export const LEDGER = [
  {
    date: '2026-10-17',
    source: '299 USDC from creator fees',
    ops: '299 USDC → DEX Screener Enhanced Token Info (logo, header, links for $KINU)',
    audit: null,
    lp: null,
    note: 'Operations spend: listing info on DEX Screener.',
    txs: []
  },
  {
    date: '2026-10-16',
    source: '921.86 RHEA creator fee → ≈13 NEAR',
    ops: '≈6 NEAR kept as operations reserve (kinuonnear.near)',
    audit: null,
    lp: '6.944 NEAR + 761,982 KINU → KINU/NEAR AMM #8961',
    note: 'KINU side from the initial KINU buy. Audit share not set aside this time.',
    txs: [
      { label: 'Swap', hash: '12uuJbeiJcQjorKDu5CHi3JDPMgCLAMEXoqV6ugSX2jE' },
      { label: 'Pool', hash: 'DprkS4mu4PJ666M9bCGAbKAdC2wEpZ8c7wAzEwYfSgyE' },
      { label: 'LP', hash: 'A12AT8L4xpMw7wQ27mexTQWEejVk35sMNM6pPy9FMhVo' }
    ]
  }
];

const NEARLY_API = 'https://nearly.trade/api';

/** KINU's launch record on Nearly: creator, fee mode and share, and the launch position's fees. */
export async function getCreatorFeeInfo() {
  const response = await fetch(`${NEARLY_API}/launch/${encodeURIComponent(KINU_TOKEN)}`);
  if (!response.ok) throw new Error(`Nearly API ${response.status}`);
  const raw = await response.json();
  return {
    creator: raw.creator,
    feeMode: raw.fee_mode,
    shareBps: Number(raw.share_bps) || 0,
    claims: Number(raw.claims) || 0,
    quote: raw.quote, // RHEA
    feesQuoteRaw: String(raw.fees_quote_total || '0'),
    feesTokenRaw: String(raw.fees_token_total || '0'),
    poolId: raw.pool_id,
    positionId: raw.lpt_id
  };
}

/* ------------------------------------------------------------------ */
/* KINU health: the trigger for moving LP profits into $KINU support   */
/* ------------------------------------------------------------------ */

/**
 * When the LP strategy's profits go to $KINU (deeper KINU liquidity, new KINU pairs, buybacks
 * from profit). Support turns on when KINU's last 7 days of volume fall this far below its
 * baseline (the 30-day average; with less history, every full day since `minDaysForTrend`),
 * or when a $100 buy moves the price more than `impactSupportPct`.
 */
export const HEALTH_RULES = {
  volumeDropPct: 40,
  impactWatchPct: 2,
  impactSupportPct: 5,
  minDaysForTrend: 14,
  probesUsd: [100, 1000]
};

const DAY_S = 86_400;

/** Daily USD volume of $KINU across every pool (Intear market candles), oldest first. */
export async function getKinuDailyVolume(days = 60) {
  const candles = await fetchMarketCandles({ tokenId: KINU_TOKEN, resolution: '1D', countBack: days });
  return candles.map((c) => ({ time: c.time, volume: c.volume }));
}

/** Average of the last `n` full days (today's partial day left out), or null without enough days. */
export function averageVolume(daily, n) {
  const today = Math.floor(Date.now() / 1000 / DAY_S) * DAY_S;
  const full = daily.filter((d) => d.time < today);
  if (full.length < n) return null;
  return full.slice(-n).reduce((s, d) => s + d.volume, 0) / n;
}

/** Days of full history and the baseline daily volume the last 7 days are compared with. */
export function baselineVolume(daily) {
  const today = Math.floor(Date.now() / 1000 / DAY_S) * DAY_S;
  const days = daily.filter((d) => d.time < today).length;
  if (days < HEALTH_RULES.minDaysForTrend) return { days, avg: null };
  const n = Math.min(30, days);
  return { days: n, avg: averageVolume(daily, n) };
}

/** Healthy / watch / support, with the reasons. */
export function healthStatus({ avg7, avg30, impact100 }) {
  const reasons = [];
  let level = 'healthy';
  const dropPct = avg7 !== null && avg30 ? (1 - avg7 / avg30) * 100 : null;
  if (dropPct !== null && dropPct >= HEALTH_RULES.volumeDropPct) {
    level = 'support';
    reasons.push(`7-day volume is ${dropPct.toFixed(0)}% below its baseline`);
  }
  if (Number.isFinite(impact100) && impact100 >= HEALTH_RULES.impactSupportPct) {
    level = 'support';
    reasons.push(`a $100 buy moves the price ${impact100.toFixed(1)}%`);
  } else if (Number.isFinite(impact100) && impact100 >= HEALTH_RULES.impactWatchPct) {
    if (level === 'healthy') level = 'watch';
    reasons.push(`a $100 buy moves the price ${impact100.toFixed(1)}%`);
  }
  return { level, reasons, dropPct };
}
