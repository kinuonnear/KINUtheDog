// Wallet popups on iPhone / iPad (Safari and home-screen apps).
//
// iOS only lets a page open a window right after a tap. Web wallets (Meteor, Intear,
// MyNearWallet) open their popup once KINU has prepared the transaction, which can take a
// moment (storage checks, routes), so iOS blocks it: "Couldn't open popup window".
// Fix: at the tap, open a small "Opening your wallet…" window; when the wallet then calls
// window.open for its own page, that window is reused and sent to the wallet's URL.
// Nothing about the transaction changes, and the wallet page is still the wallet's own site.

const WALLET_ORIGINS = new Set([
  'https://wallet.meteorwallet.app',
  'https://wallet.intear.tech',
  'https://app.mynearwallet.com'
]);
// Wallet-selector module ids that sign in a popup window.
const POPUP_WALLETS = new Set(['meteor-wallet', 'intear-wallet', 'my-near-wallet']);
const WAIT_PAGE = '/wallet-wait.html';
const ARM_MS = 90_000;

let armed = null; // { win, timer }

const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function walletOrigin(url) {
  try {
    return WALLET_ORIGINS.has(new URL(String(url), window.location.href).origin);
  } catch {
    return false;
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
  if (typeof window === 'undefined' || !isIos() || !POPUP_WALLETS.has(walletId) || window.meteorCom) return;
  disarmWalletPopup();
  const win = window.open(WAIT_PAGE, '_blank');
  if (!win) return;
  armed = { win, timer: setTimeout(disarmWalletPopup, ARM_MS) };
}

// Hand the prepared window to the wallet's next window.open for its own site.
if (typeof window !== 'undefined' && !window.__kinuPopupBridge) {
  window.__kinuPopupBridge = true;
  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    if (armed && !armed.win.closed && walletOrigin(url)) {
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
