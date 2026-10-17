// "Install KINU" banner on phones: Android / Chrome use the browser's install prompt; iPhone
// and iPad get the Share → "Add to Home Screen" steps (Safari has no prompt). Hidden once the
// app is installed, inside wallet in-app browsers and Telegram's Mini App, and for 14 days after
// "Not now".

import { useEffect, useState } from 'react';
import { inMeteorApp } from '../lib/wallet.js';
import { inTelegram } from '../lib/telegram.js';

const DISMISS_KEY = 'kinu.install.dismissedAt';
const DISMISS_MS = 14 * 86_400_000;

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isPhone = () => window.matchMedia?.('(max-width: 720px)').matches;

function dismissedRecently() {
  try {
    return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < DISMISS_MS;
  } catch {
    return false;
  }
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
    </svg>
  );
}

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [hidden, setHidden] = useState(() => isStandalone() || inMeteorApp() || inTelegram() || dismissedRecently());
  const [steps, setSteps] = useState(false);
  const ios = isIos();

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault(); // shown from our own button instead of the browser's mini-bar
      setDeferred(e);
    };
    const onInstalled = () => setHidden(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (hidden || !isPhone() || (!deferred && !ios)) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // storage blocked: hide for this visit only
    }
    setHidden(true);
  };

  const install = async () => {
    if (!deferred) {
      setSteps((v) => !v);
      return;
    }
    deferred.prompt();
    const { outcome } = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
    setDeferred(null);
    if (outcome === 'accepted') setHidden(true);
  };

  return (
    <aside className="install-prompt" role="dialog" aria-label="Install KINU">
      <div className="install-prompt__row">
        <img src="/icon-192.png" alt="" width="40" height="40" />
        <div className="install-prompt__text">
          <strong>Install KINU</strong>
          <span>Open it from your home screen, full screen like an app.</span>
        </div>
        <button type="button" className="button button--primary button--sm" onClick={install}>
          {deferred ? 'Install' : 'How?'}
        </button>
        <button type="button" className="install-prompt__close" onClick={dismiss} aria-label="Not now" title="Not now">
          ×
        </button>
      </div>
      {steps && (
        <ol className="install-prompt__steps">
          <li>
            Tap <b className="install-prompt__share">
              <ShareIcon /> Share
            </b>{' '}
            in Safari&apos;s toolbar.
          </li>
          <li>
            Choose <b>Add to Home Screen</b>, then <b>Add</b>.
          </li>
        </ol>
      )}
    </aside>
  );
}
