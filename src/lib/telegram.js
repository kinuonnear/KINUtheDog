// KINU as a Telegram Mini App (the KINU LP bot's "Open in KINU" buttons). Telegram opens the app
// with its launch data in the URL hash (#tgWebAppData=…); only then is Telegram's own Web App
// script loaded (other visitors never fetch it). HOT Wallet needs it to sign inside Telegram:
// with window.Telegram.WebApp, HOT's module (lib/wallet.js) asks HOT's Telegram app.

const SDK_URL = 'https://telegram.org/js/telegram-web-app.js';
const SESSION_KEY = 'kinu.tg';

/** True when KINU runs inside Telegram (this load or earlier in the same Mini App session). */
export function inTelegram() {
  try {
    if (/tgWebAppData=|tgWebAppPlatform=/.test(window.location.hash)) {
      sessionStorage.setItem(SESSION_KEY, '1');
      return true;
    }
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return /tgWebAppData=/.test(window.location.hash);
  }
}

/**
 * Inside Telegram: load Telegram's Web App script, then tell Telegram the app is ready and let
 * it fill the screen. Resolves either way (KINU still works if the script can't load).
 */
export function startTelegram() {
  if (!inTelegram()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = () => {
      const app = window.Telegram?.WebApp;
      try {
        app?.ready();
        app?.expand();
        app?.setHeaderColor?.('#05080d');
        app?.setBackgroundColor?.('#05080d');
      } catch {
        // older Telegram clients: defaults are fine
      }
      document.documentElement.classList.toggle('in-telegram', Boolean(app));
      resolve(Boolean(app));
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = done;
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    // A slow network never holds KINU back for long.
    setTimeout(() => resolve(Boolean(window.Telegram?.WebApp)), 4000);
  });
}

/**
 * Opened from the KINU LP bot: tell the bot what was signed, so it posts the result in the chat.
 * Telegram's signed launch data (initData) proves which chat it is; the bot checks the
 * transactions on chain before it says anything. Outside Telegram this does nothing.
 */
export function notifyBot(payload) {
  const initData = window.Telegram?.WebApp?.initData;
  if (!initData || !payload?.hashes?.length) return;
  fetch('/api/telegram?notify=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, initData })
  }).catch(() => {});
}
