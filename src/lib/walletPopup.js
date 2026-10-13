// Wallet popups on iPhone / iPad (Safari and home-screen apps).
//
// iOS only lets a page open a window right after a tap. Web wallets (Meteor, Intear,
// MyNearWallet) open their popup once KINU has prepared the transaction, which can take a
// moment (storage checks, routes), so iOS blocks it: "Couldn't open popup window".
// Fix: at the tap, open the wallet's own site in a new window; when the wallet then calls
// window.open for its signing page, that window is reused and moved to that page.
// The window must start on the wallet's site: a window that switches from kinudefi.com to the
// wallet looks closed to the page that opened it on iOS, and the wallet never receives the
// transaction ("Receiving details from Dapp"). Nothing about the transaction changes.

// Wallet-selector module id -> the wallet site its popup uses.
const POPUP_WALLETS = {
  'meteor-wallet': 'https://wallet.meteorwallet.app',
  'intear-wallet': 'https://wallet.intear.tech',
  'my-near-wallet': 'https://app.mynearwallet.com'
};
const WALLET_ORIGINS = new Set(Object.values(POPUP_WALLETS));
const ARM_MS = 90_000;

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
 * Call synchronously inside the tap handler, before anything async. Only acts on iOS, for
 * popup wallets, and not when a browser extension handles signing.
 */
export function armWalletPopup(walletId) {
  const site = POPUP_WALLETS[walletId];
  if (typeof window === 'undefined' || !isIos() || !site || window.meteorCom) return;
  disarmWalletPopup();
  const win = window.open(`${site}/`, '_blank');
  if (!win) return;
  armed = { win, site, timer: setTimeout(disarmWalletPopup, ARM_MS) };
}

// Hand the prepared window to the wallet's next window.open for its own site.
if (typeof window !== 'undefined' && !window.__kinuPopupBridge) {
  window.__kinuPopupBridge = true;
  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    // Only the same wallet's own pages reuse the window (a same-site move keeps it "open").
    if (armed && !armed.win.closed && originOf(url) === armed.site && WALLET_ORIGINS.has(armed.site)) {
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
