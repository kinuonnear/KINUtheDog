// LP performance of one account from its CLMM history (lib/lpHistory.js): per-position ledgers
// marked to market, and the stats shown in the Portfolio and on Smart LP — PnL, fees, win rate,
// average invested, expected value, holding time, fee share, activity by period and by pool.
// Pure: runs in the browser and in the Smart LP snapshot script alike.

import { asPoolToken, getTokens } from './tokens.js';
import { buildHistory, historyMatches, loadDclEvents, loadPriceHistory } from './lpHistory.js';

const DAY = 86_400_000;
const MONTH = 30 * DAY;

/** An account's CLMM events with the token metadata and USD price history to value them. */
export async function loadLpHistory(account) {
  const { events, complete } = await loadDclEvents(account);
  const tokenIds = [...new Set(events.flatMap((e) => e.pool.split('|').slice(0, 2)))];
  const since = events.length ? events[0].ts : Date.now();
  const [tokens, priceHistory] = await Promise.all([getTokens(tokenIds), loadPriceHistory(tokenIds, since)]);
  return { events, complete, tokens, priceHistory };
}

/** Periods for "how did this wallet do lately": positions opened and PnL booked in the window. */
export const PERIODS = [
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 },
  { key: 'all', label: 'All', days: Infinity }
];

/**
 * @param raw      { events, complete, tokens, priceHistory } (loadDclEvents + getTokens + loadPriceHistory)
 * @param dclRows  live positions: { id, poolId, x, y, usd, feeUsd, … } (marked to market)
 * @param prices   Map from getPrices()
 */
export function buildLpModel(raw, dclRows, prices, now = Date.now()) {
  const { events, complete, tokens, priceHistory } = raw;
  const meta = (id) => tokens[id] || { id, symbol: id.slice(0, 6), decimals: 0 };
  const { ledgers, days } = buildHistory(events, meta, priceHistory, prices);

  const openIds = new Set(dclRows.map((r) => r.id));
  const open = new Map();
  dclRows.forEach((r) => {
    const l = ledgers.get(r.id);
    const value = r.usd;
    const unclaimed = r.feeUsd || 0;
    // Unknown too while the history is behind the chain for this position (lpHistory.historyMatches).
    if (!l || !l.complete || !historyMatches({ id: r.id, liquidity: r.liquidity }, events)) {
      open.set(r.id, { position: r, ledger: l || null, value, unclaimed, known: false });
      return;
    }
    const pnl = value + unclaimed - l.costUsd + l.realizedUsd + l.feesUsd;
    open.set(r.id, {
      position: r,
      ledger: l,
      value,
      unclaimed,
      known: true,
      invested: l.costUsd,
      fees: l.feesUsd + unclaimed,
      pnl,
      pnlPct: l.investedUsd > 0 ? (pnl / l.investedUsd) * 100 : null
    });
  });

  const closed = [...ledgers.values()]
    .filter((l) => l.closedAt !== null && !openIds.has(l.lptId) && l.complete)
    .map((l) => {
      const pnl = l.withdrawnUsd + l.feesUsd - l.investedUsd;
      return {
        ...l,
        x: asPoolToken(meta(l.tokenX)),
        y: asPoolToken(meta(l.tokenY)),
        pnl,
        pnlPct: l.investedUsd > 0 ? (pnl / l.investedUsd) * 100 : null
      };
    })
    .sort((a, b) => b.closedAt - a.closedAt);

  const openList = [...open.values()];
  const openKnown = openList.filter((o) => o.known);
  const realized = closed.reduce((s, c) => s + c.pnl, 0);
  const unrealized = openKnown.reduce((s, o) => s + o.pnl, 0);
  const totalPnl = realized + unrealized;
  const fees = closed.reduce((s, c) => s + c.feesUsd, 0) + openList.reduce((s, o) => s + (o.ledger?.feesUsd || 0) + o.unclaimed, 0);
  const invested = [...closed.map((c) => c.investedUsd), ...openKnown.map((o) => o.ledger.investedUsd)];
  const holds = closed.map((c) => c.closedAt - c.openedAt);
  const wins = closed.filter((c) => c.pnl > 0).length;
  // For the share card: what is in the pools now, the return on everything put in, and the pool
  // the account is most in (largest open position, else the largest closed one).
  const grossInvested = closed.reduce((s, c) => s + c.investedUsd, 0) + openKnown.reduce((s, o) => s + o.ledger.investedUsd, 0);
  const biggestOpen = openList.reduce((best, o) => (!best || o.value > best.value ? o : best), null);
  const biggestClosed = closed.reduce((best, c) => (!best || c.investedUsd > best.investedUsd ? c : best), null);
  const mainPair = biggestOpen ? [biggestOpen.position.x, biggestOpen.position.y] : biggestClosed ? [biggestClosed.x, biggestClosed.y] : null;

  // Per pool: positions, money in, fees and PnL (closed + open with a known cost).
  const pools = new Map();
  const poolOf = (poolId, x, y) => {
    if (!pools.has(poolId)) pools.set(poolId, { poolId, x, y, positions: 0, open: 0, invested: 0, fees: 0, pnl: 0 });
    return pools.get(poolId);
  };
  closed.forEach((c) => {
    const p = poolOf(c.poolId, c.x, c.y);
    p.positions += 1;
    p.invested += c.investedUsd;
    p.fees += c.feesUsd;
    p.pnl += c.pnl;
  });
  openList.forEach((o) => {
    const p = poolOf(o.position.poolId, o.position.x, o.position.y);
    p.positions += 1;
    p.open += 1;
    p.fees += (o.ledger?.feesUsd || 0) + o.unclaimed;
    if (o.known) {
      p.invested += o.ledger.investedUsd;
      p.pnl += o.pnl;
    }
  });

  // By period: positions opened and PnL realized (closed out + fees claimed, by day) in the window.
  const ledgerList = [...ledgers.values()];
  const periods = PERIODS.map((period) => {
    const from = Number.isFinite(period.days) ? now - period.days * DAY : -Infinity;
    const booked = days.filter((d) => d.time * 1000 >= from).reduce((s, d) => s + d.pnl, 0);
    return {
      key: period.key,
      positions: ledgerList.filter((l) => l.openedAt !== null && l.openedAt >= from).length,
      pnl: booked
    };
  });
  // The last 7 UTC days of booked PnL, oldest first (the card's bar chart).
  const today = Math.floor(now / DAY) * DAY;
  const byDay = new Map(days.map((d) => [d.time * 1000, d.pnl]));
  const last7 = Array.from({ length: 7 }, (_, i) => byDay.get(today - (6 - i) * DAY) || 0);

  const first = events.length ? events[0].ts : null;
  const last = events.length ? events[events.length - 1].ts : null;
  const months = first ? Math.max(1, (now - first) / MONTH) : 1;

  return {
    complete,
    open,
    closed,
    days,
    pools: [...pools.values()].sort((a, b) => b.pnl - a.pnl),
    stats: {
      totalPnl,
      realized,
      unrealized,
      fees,
      closedCount: closed.length,
      openCount: openList.length,
      totalPositions: closed.length + openList.length,
      winRate: closed.length ? (wins / closed.length) * 100 : null,
      // Expected value per closed position: win rate × average win + loss rate × average loss,
      // which is the average PnL of a closed position.
      ev: closed.length ? realized / closed.length : null,
      avgInvested: invested.length ? invested.reduce((s, v) => s + v, 0) / invested.length : null,
      avgHold: holds.length ? holds.reduce((s, v) => s + v, 0) / holds.length : null,
      // How much of the profit is LP fees (low: the profit came from the token's price, not LPing).
      feeShare: totalPnl > 0 ? Math.min(fees / totalPnl, 9.99) * 100 : null,
      monthlyPnl: first ? totalPnl / months : null,
      totalInvested: openKnown.reduce((s, o) => s + o.invested, 0),
      openValue: openList.reduce((s, o) => s + o.value + o.unclaimed, 0),
      returnPct: grossInvested > 0 ? (totalPnl / grossInvested) * 100 : null,
      firstActivity: first,
      lastActivity: last,
      periods,
      last7,
      mainPair,
      poolCount: pools.size
    }
  };
}
