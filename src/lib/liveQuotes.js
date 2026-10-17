// Live quotes for the Swap form: a WebSocket to the Intear aggregator (router.intear.tech,
// /route/subscribe) that pushes a new set of routes whenever the pools change the result. KINU uses
// it as a "the price moved" signal and re-quotes through its own engine (Rhea SmartRouter, Rhea
// CLMM and the aggregator), so the number on screen follows the market instead of a 20 s timer.
// One socket for the page; it reconnects after drops and closes when nobody listens.

const URL = 'wss://router.intear.tech/route/subscribe';
const DEXES = 'Rhea,RheaDcl,Plach';
const RECONNECT_MS = [1_000, 3_000, 10_000, 30_000];
const IDLE_CLOSE_MS = 30_000;

let socket = null;
let ready = false;
let attempts = 0;
let nextId = 1;
let current = null; // { id, query, onChange, onStatus, seen }
let idleTimer = null;
let reconnectTimer = null;

const assetOf = (token) => (token.native ? 'near' : `nep141:${token.contract || token.id}`);

function send(message) {
  if (socket && ready) socket.send(JSON.stringify(message));
}

function open() {
  if (socket || typeof WebSocket === 'undefined') return;
  try {
    socket = new WebSocket(URL);
  } catch {
    socket = null;
    return;
  }
  socket.onopen = () => {
    ready = true;
    attempts = 0;
    if (current) send({ id: current.id, query: current.query });
    current?.onStatus?.(true);
  };
  socket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    // Only the latest request counts; updates of a replaced one may still arrive.
    if (!current || data.id !== current.id || !Array.isArray(data.routes)) return;
    // The first answer is the routes we already quoted; later ones mean the pools moved.
    if (!current.seen) {
      current.seen = true;
      return;
    }
    current.onChange();
  };
  socket.onclose = () => {
    socket = null;
    ready = false;
    current?.onStatus?.(false);
    if (current) {
      const wait = RECONNECT_MS[Math.min(attempts, RECONNECT_MS.length - 1)];
      attempts += 1;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(open, wait);
    }
  };
  socket.onerror = () => socket?.close();
}

/**
 * Calls `onChange` whenever the pools move the quote for amountIn (raw) of tokenIn → tokenOut, and
 * `onStatus(connected)` as the socket comes and goes. Returns a function that stops listening.
 */
export function watchQuote({ tokenIn, tokenOut, amountIn, onChange, onStatus }) {
  clearTimeout(idleTimer);
  const query = new URLSearchParams({
    token_in: assetOf(tokenIn),
    token_out: assetOf(tokenOut),
    amount_in: String(amountIn),
    max_wait_ms: '2000',
    slippage_type: 'Fixed',
    slippage: '0.005',
    dexes: DEXES
  }).toString();
  const entry = { id: nextId++, query, onChange, onStatus, seen: false };
  current = entry;
  if (socket && ready) {
    send({ id: entry.id, query });
    onStatus?.(true);
  } else open();
  return () => {
    if (current !== entry) return;
    current = null;
    send({ id: nextId++ }); // stop updates without closing the socket
    onStatus?.(false);
    idleTimer = setTimeout(() => {
      if (!current) {
        clearTimeout(reconnectTimer);
        socket?.close();
      }
    }, IDLE_CLOSE_MS);
  };
}
