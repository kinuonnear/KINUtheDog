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
