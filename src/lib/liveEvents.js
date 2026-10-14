// Live pool updates from Intear's public Events API (wss://ws-events-v3.intear.tech): every time
// a Rhea CLMM pool changes (a trade, liquidity added or removed) the server pushes its new state,
// so pool pages move within seconds without polling the RPC. One socket serves every subscribed
// pool; the filter is updated as pages subscribe and unsubscribe.
//
// Events only drive what the page shows. Anything that builds a transaction still reads the pool
// fresh from the chain. When the socket is down, pages fall back to polling (usePoolEvents.live).

import { useEffect, useRef, useState } from 'react';
import { useAsync } from '../hooks.js';
import { CONTRACTS } from '../config.js';
import { view } from './rpc.js';

const EVENTS_URL = 'wss://ws-events-v3.intear.tech/events/trade_pool_change';
const RETRY_MS = [1_000, 3_000, 10_000, 30_000];
const IDLE_CLOSE_MS = 30_000; // keep the socket a little after the last page leaves (navigation)

const listeners = new Map(); // Intear pool id ("REFDCL-x|y|fee") -> Set<fn(state)>
const statusListeners = new Set();
let socket = null;
let open = false;
let retries = 0;
let retryTimer = null;
let idleTimer = null;

const intearPoolId = (poolId) => `REFDCL-${poolId}`;

function setOpen(value) {
  if (open === value) return;
  open = value;
  statusListeners.forEach((fn) => fn(value));
}

function sendFilter() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const ids = [...listeners.keys()];
  socket.send(JSON.stringify({ Or: ids.map((id) => ({ path: 'pool_id', operator: { Equals: id } })) }));
}

function dispatch(event) {
  const set = listeners.get(event?.pool_id);
  const dcl = event?.pool?.RefDcl;
  if (!set || !dcl || !Number.isFinite(Number(dcl.current_point))) return;
  const state = {
    currentPoint: Number(dcl.current_point),
    liquidity: dcl.liquidity,
    liquidityX: dcl.liquidity_x,
    blockHeight: event.block_height,
    at: Date.now()
  };
  set.forEach((fn) => fn(state));
}

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (socket || !listeners.size || typeof WebSocket === 'undefined') return;
  let ws;
  try {
    ws = new WebSocket(EVENTS_URL);
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    retries = 0;
    sendFilter();
    setOpen(true);
  };
  ws.onmessage = (message) => {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    // Events arrive grouped by block.
    (Array.isArray(data) ? data : [data]).flat().forEach(dispatch);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    setOpen(false);
    scheduleRetry();
  };
  ws.onerror = () => ws.close();
}

function scheduleRetry() {
  if (retryTimer || !listeners.size) return;
  const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
  retries += 1;
  retryTimer = setTimeout(connect, wait);
}

if (typeof document !== 'undefined') {
  // Phones drop sockets in background tabs: reconnect at once when the visitor comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket && listeners.size) {
      retries = 0;
      connect();
    }
  });
}

/** Follow a Rhea CLMM pool ("x|y|fee"). Returns an unsubscribe function. */
export function subscribePool(poolId, fn) {
  const id = intearPoolId(poolId);
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(fn);
  clearTimeout(idleTimer);
  if (socket) sendFilter();
  else connect();
  return () => {
    const set = listeners.get(id);
    set?.delete(fn);
    if (set && !set.size) listeners.delete(id);
    if (listeners.size) {
      sendFilter();
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!listeners.size && socket) socket.close();
    }, IDLE_CLOSE_MS);
  };
}

export function subscribeStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/**
 * Live state of a CLMM pool: { live, last } where `live` is whether the event stream is
 * connected and `last` the latest pushed state ({ currentPoint, liquidity, liquidityX, at }).
 * `onChange(state)` runs on every change (e.g. to reload the full pool once).
 */
export function usePoolEvents(poolId, onChange) {
  const [live, setLive] = useState(open);
  const [last, setLast] = useState(null);
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => subscribeStatus(setLive), []);
  useEffect(() => {
    setLast(null);
    if (!poolId) return undefined;
    setLive(open);
    return subscribePool(poolId, (state) => {
      setLast(state);
      ref.current?.(state);
    });
  }, [poolId]);
  return { live, last };
}

/* ------------------------------------------------------------------ */
/* A CLMM pool's on-chain state, kept live                              */
/* ------------------------------------------------------------------ */

const POLL_MS = 8_000; // without the event stream
const STREAM_POLL_MS = 45_000; // with it: a safety read now and then
const AFTER_EVENT_MS = 2_500; // let the RPC's final block catch up with the event
const shared = new Map(); // poolId -> { at, data }: one read serves every view of the same pool

/**
 * mode: null (interval: reuse a recent read by any view of this pool), 'event' (fresh, but one
 * read serves every view that heard the same event) or 'force' (always fresh, e.g. after a
 * transaction).
 */
async function readPool(poolId, mode, maxAge) {
  const hit = shared.get(poolId);
  const age = hit ? Date.now() - hit.at : Infinity;
  if ((mode === null && age < maxAge) || (mode === 'event' && age < AFTER_EVENT_MS)) return hit.data;
  const data = await view(CONTRACTS.dcl, 'get_pool', { pool_id: poolId }, { fresh: mode !== null });
  shared.set(poolId, { at: Date.now(), data });
  return data;
}

/**
 * `get_pool` of a Rhea CLMM pool for display, kept live: pushed price changes show at once and
 * trigger one fresh read; polling runs every 8 s only while the event stream is down (every 45 s
 * otherwise). Returns the useAsync state with `data` merged with the latest event, plus `live`.
 * `reload()` always reads fresh.
 */
export function useLiveDclPool(poolId) {
  const modeNext = useRef(null);
  const liveRef = useRef(false);
  const timer = useRef(null);
  const reloadRef = useRef(null);
  const { live, last } = usePoolEvents(poolId, () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      modeNext.current = 'event';
      reloadRef.current?.();
    }, AFTER_EVENT_MS);
  });
  liveRef.current = live;
  useEffect(() => () => clearTimeout(timer.current), []);

  const query = useAsync(
    () => {
      const mode = modeNext.current;
      modeNext.current = null;
      // Streaming: the interval read only runs as an occasional safety check.
      return readPool(poolId, mode, liveRef.current ? STREAM_POLL_MS : POLL_MS - 500);
    },
    [poolId],
    { enabled: Boolean(poolId), refreshMs: POLL_MS }
  );
  reloadRef.current = query.reload;
  const reload = () => {
    modeNext.current = 'force';
    return query.reload();
  };

  const pushed = last && query.data && last.at > (query.updatedAt || 0);
  const data = pushed ? { ...query.data, current_point: last.currentPoint, liquidity: last.liquidity, liquidity_x: last.liquidityX } : query.data;
  return { ...query, data, live, reload, updatedAt: pushed ? last.at : query.updatedAt };
}
