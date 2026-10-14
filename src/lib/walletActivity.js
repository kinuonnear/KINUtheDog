// While a wallet request is open, KINU's background refreshes (prices, balances, pool and position
// polling, auto-RPC probes) hold off — in this tab and in the visitor's other KINU tabs. Wallets
// such as Meteor send the signed transactions through FastNEAR, whose rate limit is per IP — the
// visitor's — so the app's own reads would otherwise eat into the quota the wallet needs to
// broadcast them (seen as -429 "Rate limits exceeded").

let open = 0;

// Other tabs of the same site (BroadcastChannel reaches same-origin tabs only). Each open request
// is held for at most REMOTE_MAX_MS, so a tab closed mid-request can't pause the others forever.
const REMOTE_MAX_MS = 3 * 60_000;
const remote = new Map(); // request id -> opened at
const myId = Math.random().toString(36).slice(2);
let seq = 0;
let channel = null;
try {
  channel = new BroadcastChannel('kinu-wallet-activity');
  channel.onmessage = ({ data }) => {
    if (!data || data.tab === myId) return;
    if (data.type === 'open') remote.set(data.id, Date.now());
    else if (data.type === 'close') remote.delete(data.id);
  };
} catch {
  // BroadcastChannel unavailable: this tab still pauses itself
}

function remoteBusy() {
  const now = Date.now();
  for (const [id, at] of remote) {
    if (now - at > REMOTE_MAX_MS) remote.delete(id);
  }
  return remote.size > 0;
}

/** True while a wallet request is in progress in this tab or another KINU tab. */
export function walletBusy() {
  return open > 0 || remoteBusy();
}

/** Mark a wallet request as started; call the returned function when it ends. */
export function beginWalletRequest() {
  open += 1;
  const id = `${myId}:${(seq += 1)}`;
  channel?.postMessage({ type: 'open', id, tab: myId });
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    open = Math.max(0, open - 1);
    channel?.postMessage({ type: 'close', id, tab: myId });
  };
}

/** Whether a periodic background refresh should run now: tab visible and no wallet request open. */
export function backgroundRefreshAllowed() {
  return document.visibilityState === 'visible' && !walletBusy();
}

/**
 * Fired on window when transactions turned out to have landed after the wallet reported otherwise:
 * views showing balances or positions reload on it (hooks.js → useChainUpdates).
 */
export const CHAIN_UPDATED_EVENT = 'kinu:chain-updated';
