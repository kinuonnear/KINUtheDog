// Small wallet helpers shared by both wallet backends (lib/nearConnect.js, lib/walletSelector.js),
// kept out of them so pages can use them without loading any wallet code.

const PENDING_REDIRECT_KEY = 'kinu.pendingRedirect';

/**
 * Inside the Meteor mobile app's browser, popups are blocked, so the web module can't sign in.
 * The app injects a flag and a React Native bridge; there the in-app module talks to Meteor
 * directly instead.
 */
export const inMeteorApp = () =>
  typeof window !== 'undefined' &&
  Boolean(window.__is_running_in_meteor_wallet_app__ || /meteor/i.test(navigator.userAgent || '') || window.ReactNativeWebView);

/** Marks that KINU sent the user to a redirect-based wallet (see consumeRedirectResult). */
export function markRedirectPending() {
  try {
    sessionStorage.setItem(PENDING_REDIRECT_KEY, String(Date.now()));
  } catch {
    // storage unavailable: the result toast is skipped, the transaction is not
  }
}

/** Read & clear the result of a redirect-based wallet flow from the URL. */
export function consumeRedirectResult() {
  const url = new URL(window.location.href);
  const hashes = url.searchParams.get('transactionHashes');
  const errorCode = url.searchParams.get('errorCode');
  const errorMessage = url.searchParams.get('errorMessage');
  if (!hashes && !errorCode) return null;
  ['transactionHashes', 'errorCode', 'errorMessage'].forEach((k) => url.searchParams.delete(k));
  window.history.replaceState(window.history.state, '', url.toString());

  // Anyone can link to kinudefi.com/?errorMessage=…; without a redirect we started in the
  // last 30 minutes, the parameters are dropped instead of shown as a KINU message.
  let started = 0;
  try {
    started = Number(sessionStorage.getItem(PENDING_REDIRECT_KEY)) || 0;
    sessionStorage.removeItem(PENDING_REDIRECT_KEY);
  } catch {
    // storage unavailable
  }
  if (!started || Date.now() - started > 30 * 60_000) return null;

  if (errorCode) {
    const text = String(errorMessage || errorCode).replace(/https?:\/\/\S+/gi, '').slice(0, 160);
    return { ok: false, message: text || 'The wallet did not complete the transaction.' };
  }
  const list = hashes.split(',').filter((h) => /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(h));
  return list.length ? { ok: true, hashes: list } : null;
}
