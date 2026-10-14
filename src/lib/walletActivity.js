// While a wallet request is open, KINU's background refreshes (prices, balances, pool and position
// polling, auto-RPC probes) hold off. Wallets such as Meteor send the signed transactions through
// FastNEAR, whose rate limit is per IP — the visitor's — so the app's own reads would otherwise
// eat into the quota the wallet needs to broadcast them (seen as -429 "Rate limits exceeded").

let open = 0;

/** True while at least one wallet request is in progress. */
export function walletBusy() {
  return open > 0;
}

/** Mark a wallet request as started; call the returned function when it ends. */
export function beginWalletRequest() {
  open += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    open = Math.max(0, open - 1);
  };
}

/** Whether a periodic background refresh should run now: tab visible and no wallet request open. */
export function backgroundRefreshAllowed() {
  return document.visibilityState === 'visible' && !walletBusy();
}
