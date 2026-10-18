// What a token transfer into a DEX (ft_transfer_call's msg) asks that DEX to do, checked so that
// the output of every swap comes back to the signer. Used when a quote arrives (lib/swap.js) and
// again just before the wallet opens (lib/txGuard.js), so a tampered or compromised quote API can't
// redirect a swap's output even though KINU signs the route as the API built it.

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Rhea's SmartRouter route message (executed by aggregatedex.near): base64 with every byte shifted
 * by 7. The JSON inside names the trader (`user`), who receives the output (`receive_user`, null =
 * the trader) and the calls it makes. null when it can't be read.
 */
export function decodeSmartRouterMsg(msg) {
  try {
    const bytes = Uint8Array.from(atob(String(msg)), (c) => (c.charCodeAt(0) + 249) % 256);
    const route = JSON.parse(new TextDecoder().decode(bytes));
    return route && typeof route === 'object' ? route : null;
  } catch {
    return null;
  }
}

/** A Rhea swap message (DCL `{ Swap }`, exchange `{ actions }` …) must not name another receiver. */
function checkNoOtherReceiver(msg, user) {
  if (!msg || typeof msg !== 'object') return;
  const receivers = [msg.receiver_id, msg.Swap?.receiver_id, msg.SwapByOutput?.receiver_id, msg.receive_user];
  const other = receivers.find((r) => r != null && r !== user);
  if (other) throw new Error(`the output would go to "${other}"`);
}

/** Throws unless a SmartRouter route is this user's and pays out to them. */
export function checkSmartRouterRoute(msg, user) {
  const route = decodeSmartRouterMsg(msg);
  if (!route) throw new Error('unreadable Rhea route');
  if (route.user !== user) throw new Error(`the route is for "${route.user}"`);
  checkNoOtherReceiver(route, user);
  for (const call of Array.isArray(route.msgs) ? route.msgs : []) {
    const inner = typeof call === 'string' ? parseJson(call) : call;
    checkNoOtherReceiver(typeof inner?.msg === 'string' ? parseJson(inner.msg) : inner?.msg, user);
  }
}

/**
 * The msg of an ft_transfer_call into one of Rhea's contracts, as signed: the aggregator gets a
 * signed SmartRouter route, the exchange and CLMM get a plain "" / "Deposit" or a swap that must
 * not pay anyone else.
 */
export function checkRheaTransferMsg(receiverId, msg, user, aggregator) {
  const parsed = typeof msg === 'string' ? parseJson(msg) : null;
  if (receiverId === aggregator) {
    if (!parsed?.msg) throw new Error('a Rhea route without its message');
    checkSmartRouterRoute(parsed.msg, user);
    return;
  }
  checkNoOtherReceiver(parsed, user);
}
