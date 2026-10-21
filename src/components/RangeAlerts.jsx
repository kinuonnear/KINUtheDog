// Out-of-range alerts: while KINU is open, the connected account's CLMM positions are watched (the
// live pool feed, lib/liveEvents.js, plus a re-read every 2 minutes). When a pool's price leaves
// a position's range — it stops earning fees — a toast says so, with a link to the pool to
// rebalance; another when it is back. With the browser's notification permission granted, the
// alert also shows as a system notification while the tab is in the background.
// KINU has no server: nothing is watched while the site is closed.

import { useEffect, useRef } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { getDclPositions } from '../lib/rhea.js';
import { getTokens } from '../lib/tokens.js';
import { subscribePool } from '../lib/liveEvents.js';
import { poolPath } from '../router.jsx';

const REREAD_MS = 2 * 60_000;
const SETTLE_MS = 60_000; // a range change must hold this long before it is announced
const OUT_COOLDOWN_MS = 30 * 60_000; // at most one out-of-range toast per pool in this time

const inRangeAt = (p, point) => point >= p.leftPoint && point < p.rightPoint;

export default function RangeAlerts() {
  const { accountId, toast, dismissToast } = useApp();
  const positions = useAsync(() => getDclPositions(accountId), [accountId], { enabled: Boolean(accountId), refreshMs: REREAD_MS });
  const status = useRef(new Map()); // poolId -> 'in' | 'out' (any position earning = 'in')
  const symbols = useRef({}); // tokenId -> symbol
  const list = positions.data || [];
  const poolIds = [...new Set(list.map((p) => p.poolId))].sort();
  const poolKey = poolIds.join(',');

  // Forget everything when the account changes.
  useEffect(() => {
    status.current = new Map();
    pending.current = new Map();
    lastOut.current = new Map();
  }, [accountId]);

  // Token symbols for the messages.
  useEffect(() => {
    const ids = [...new Set(poolIds.flatMap((id) => id.split('|').slice(0, 2)))];
    if (!ids.length) return;
    getTokens(ids)
      .then((tokens) => Object.values(tokens).forEach((t) => (symbols.current[t.id] = t.symbol)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey]);

  const listRef = useRef(list);
  listRef.current = list;

  // A price ticking on a range edge (a one-sided position starts right at the price) would flip
  // in / out every few seconds: a change counts only once it has held for SETTLE_MS, a pool
  // warns about leaving its range at most once per OUT_COOLDOWN_MS, and its newest toast replaces
  // the previous one.
  const pending = useRef(new Map()); // poolId -> { state, since }
  const lastOut = useRef(new Map()); // poolId -> time of the last out-of-range toast
  const shown = useRef(new Map()); // poolId -> toast id on screen

  // One check per pool: compare with what was last seen and tell the user about a settled change.
  const checkRef = useRef(null);
  checkRef.current = (poolId, point) => {
    const mine = listRef.current.filter((p) => p.poolId === poolId);
    if (!mine.length || !Number.isFinite(point)) return;
    const now = mine.some((p) => inRangeAt(p, point)) ? 'in' : 'out';
    const before = status.current.get(poolId);
    if (!before) {
      status.current.set(poolId, now); // the first look only records the state
      return;
    }
    if (before === now) {
      pending.current.delete(poolId);
      return;
    }
    const wait = pending.current.get(poolId);
    if (!wait || wait.state !== now) {
      pending.current.set(poolId, { state: now, since: Date.now() });
      return;
    }
    if (Date.now() - wait.since < SETTLE_MS) return;
    pending.current.delete(poolId);
    status.current.set(poolId, now);
    if (now === 'out' && Date.now() - (lastOut.current.get(poolId) || 0) < OUT_COOLDOWN_MS) return;
    const [x, y] = poolId.split('|');
    const pair = `${symbols.current[x] || x.split('.')[0]} / ${symbols.current[y] || y.split('.')[0]}`;
    const action = { label: now === 'out' ? 'Open pool to rebalance' : 'Open pool', to: poolPath(poolId) };
    if (shown.current.has(poolId)) dismissToast(shown.current.get(poolId));
    if (now === 'out') {
      lastOut.current.set(poolId, Date.now());
      const message = 'Not earning fees until the price comes back into your range.';
      shown.current.set(poolId, toast('warning', `${pair} is out of range`, message, { action, timeout: 15000 }));
      if (document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(`KINU · ${pair} is out of range`, { body: message, icon: '/icon-192.png', tag: `range-${poolId}` });
        } catch {
          // some browsers only allow notifications from a service worker
        }
      }
    } else {
      shown.current.set(poolId, toast('success', `${pair} is back in range`, 'Your position is earning fees again.', { action, timeout: 12000 }));
    }
  };

  // Every re-read: check each pool at the price it came with.
  useEffect(() => {
    list.forEach((p) => checkRef.current(p.poolId, p.currentPoint));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions.data]);

  // Live: follow each pool's price pushes.
  useEffect(() => {
    if (!poolIds.length) return undefined;
    const offs = poolIds.map((id) => subscribePool(id, (state) => checkRef.current(id, state.currentPoint)));
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey]);

  return null;
}
