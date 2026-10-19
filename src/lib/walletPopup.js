// Wallet popups (every browser; iPhone / iPad were the first to need it).
//
// Browsers only let a page open a window shortly after a click or tap (iOS right away, Chrome
// for about five seconds, some browsers for one). Web wallets (Meteor, Intear, MyNearWallet)
// open their popup once KINU has prepared the transaction, which can take a moment (storage
// checks, wrapping, routes), so the browser blocks it: "Couldn't open popup window" (iOS),
// "Popup was blocked" (Intear on desktop).
// Fix: at the click, open the wallet's own site in a new window; when the wallet then calls
// window.open for its signing page, that window is reused and moved to that page.
// The window must start on the wallet's site: a window that switches from kinudefi.com to the
// wallet looks closed to the page that opened it on iOS, and the wallet never receives the
// transaction ("Receiving details from Dapp"). Nothing about the transaction changes.

// Wallet id (wallet-selector module or NEAR Connect manifest) -> the wallet site its popup uses.
const POPUP_WALLETS = {
  'meteor-wallet': 'https://wallet.meteorwallet.app',
  'intear-wallet': 'https://wallet.intear.tech',
  'my-near-wallet': 'https://app.mynearwallet.com',
  // NEAR Connect's id for MyNearWallet (lib/walletManifest.js).
  mynearwallet: 'https://app.mynearwallet.com'
};
const ARM_MS = 90_000;
// Intear opens its popup on the wallet site the user connected with (saved by its module), which
// is not always wallet.intear.tech: the prepared window must start on that same site.
const INTEAR_SAVED = '_intear_wallet_connected_account';

/** The wallet site the wallet will open its popup on (https only), or null. */
function siteFor(walletId) {
  if (walletId === 'intear-wallet') {
    try {
      const saved = JSON.parse(window.localStorage.getItem(INTEAR_SAVED) || 'null');
      const origin = saved?.walletUrl ? new URL(saved.walletUrl).origin : null;
      if (origin && origin.startsWith('https://')) return origin;
    } catch {
      // no saved session or storage blocked: the default site
    }
  }
  return POPUP_WALLETS[walletId] || null;
}
// On desktop the prepared window has the wallet's own popup size (Intear opens 400 x 700).
const DESKTOP_FEATURES = 'popup,width=400,height=700';

let armed = null; // { win, site, timer }

const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function originOf(url) {
  try {
    return new URL(String(url), window.location.href).origin;
  } catch {
    return null;
  }
}

/** Closes the prepared window if the wallet never used it (error, or nothing was sent). */
export function disarmWalletPopup() {
  if (!armed) return;
  clearTimeout(armed.timer);
  try {
    armed.win.close();
  } catch {
    // already closed
  }
  armed = null;
}

/**
 * Call synchronously inside the click / tap handler, before anything async. Acts for popup
 * wallets only, and not when Meteor's browser extension handles Meteor's signing. (The extension
 * being installed says nothing about other wallets: Intear still needs its window prepared.)
 */
export function armWalletPopup(walletId) {
  const site = siteFor(walletId);
  if (typeof window === 'undefined' || !site || (walletId === 'meteor-wallet' && window.meteorCom)) return;
  disarmWalletPopup();
  const win = isIos() ? window.open(`${site}/`, '_blank') : window.open(`${site}/`, '_blank', DESKTOP_FEATURES);
  if (!win) return;
  armed = { win, site, timer: setTimeout(disarmWalletPopup, ARM_MS) };
}

// Hand the prepared window to the wallet's next window.open for its own site.
if (typeof window !== 'undefined' && !window.__kinuPopupBridge) {
  window.__kinuPopupBridge = true;
  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    // Only the same wallet's own pages reuse the window (a same-site move keeps it "open").
    if (armed && !armed.win.closed && originOf(url) === armed.site) {
      const { win, timer } = armed;
      clearTimeout(timer);
      armed = null;
      try {
        win.location.href = String(url);
        win.focus?.();
        return win;
      } catch {
        // fall through to a normal open
      }
    }
    return nativeOpen(url, target, features);
  };
}
