// Meteora-style positions: a pool's CLMM bins grouped by the deposit that opened them.
//
// Rhea shows every bin of a pair on one board. Here each deposit (Create position,
// Zap In, Rebalance) is its own position: the bins it opened, found through the
// `liquidity_added` events of lib/lpHistory.js. A deposit with many bins is split
// over several batch transactions signed back to back, so opening transactions in
// the same pool that land within SAME_DEPOSIT_MS of each other count as one deposit.
// Adding to a position (append_liquidity) and compounding keep the bins, so the
// position stays the same.

import { useEffect, useMemo, useState } from 'react';
import { loadDclEvents } from './lpHistory.js';

const SAME_DEPOSIT_MS = 60_000;
const RETRY_MS = 15_000; // a fresh deposit can take a moment to reach the indexer
const MAX_RETRIES = 4;

/** lpt_id -> { hash, ts } of the transaction that opened each bin. */
function openingTxs(events) {
  const opened = new Map();
  events.forEach((e) => {
    if (e.kind === 'add' && !opened.has(e.lpt)) opened.set(e.lpt, { hash: e.hash, ts: e.ts });
  });
  return opened;
}

/**
 * Splits live positions (rhea.getDclPositions items, any pools) into deposits.
 * Returns groups, newest first per pool: { key, poolId, number, openedAt, positions }.
 * `number` counts a pool's deposits from the oldest (1). Bins with no known opening
 * (older than the loaded history, or not indexed yet) share one group with openedAt null
 * ("Other bins").
 */
export function groupDeposits(positions, events) {
  const opened = openingTxs(events || []);
  const byPool = new Map();
  positions.forEach((p) => {
    if (!byPool.has(p.poolId)) byPool.set(p.poolId, []);
    byPool.get(p.poolId).push(p);
  });

  const groups = [];
  byPool.forEach((list, poolId) => {
    const known = list.filter((p) => opened.has(p.id)).sort((a, b) => opened.get(a.id).ts - opened.get(b.id).ts);
    const unknown = list.filter((p) => !opened.has(p.id));
    const deposits = [];
    let last = null;
    known.forEach((p) => {
      const { hash, ts } = opened.get(p.id);
      const current = deposits[deposits.length - 1];
      if (current && (current.hashes.has(hash) || ts - last <= SAME_DEPOSIT_MS)) {
        current.hashes.add(hash);
        current.positions.push(p);
      } else {
        deposits.push({ hashes: new Set([hash]), openedAt: ts, positions: [p] });
      }
      last = ts;
    });
    const pool = deposits.map((d, i) => ({
      key: `${poolId}:${[...d.hashes][0]}`,
      poolId,
      number: i + 1,
      openedAt: d.openedAt,
      positions: d.positions
    }));
    pool.reverse();
    if (unknown.length) pool.push({ key: `${poolId}:earlier`, poolId, number: null, openedAt: null, positions: unknown });
    groups.push(...pool);
  });
  return groups;
}

/**
 * Deposit groups for one account's positions, loading the event history on demand.
 * While the history loads (or if it fails) every bin sits in one group.
 */
export function useDepositGroups(accountId, positions) {
  const [history, setHistory] = useState({ events: null, error: null });
  const [retry, setRetry] = useState({ ids: '', count: 0 });
  const ids = (positions || []).map((p) => p.id).join(',');
  const tries = retry.ids === ids ? retry.count : 0;

  useEffect(() => {
    if (!accountId || !ids) return undefined;
    let alive = true;
    loadDclEvents(accountId).then(
      ({ events }) => alive && setHistory({ events, error: null }),
      (error) => alive && setHistory((h) => ({ events: h.events, error }))
    );
    return () => {
      alive = false;
    };
  }, [accountId, ids, tries]);

  const groups = useMemo(() => (positions?.length ? groupDeposits(positions, history.events) : []), [positions, history.events]);

  // Bins opened moments ago may not be indexed yet: look again a few times.
  const missing = Boolean(history.events) && groups.some((g) => g.openedAt === null);
  useEffect(() => {
    if (!missing || tries >= MAX_RETRIES) return undefined;
    const timer = setTimeout(() => setRetry({ ids, count: tries + 1 }), RETRY_MS);
    return () => clearTimeout(timer);
  }, [missing, tries, ids]);

  return { groups, events: history.events, loading: !history.events && !history.error, error: history.error };
}
