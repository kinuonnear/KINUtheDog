// NEAR wallet connection (Meteor, Intear, HOT, MyNearWallet, Nightly, Ledger) via wallet-selector.
// Nothing here ever handles keys: every transaction is approved in the user's wallet.

// Wallet packages are large, so they load in their own chunk after first paint.
import '@near-wallet-selector/modal-ui/styles.css';

import { CONTRACTS, ENDPOINTS, NETWORK_ID } from '../config.js';
import { mergeTransactions } from './tx.js';
import { inTelegram } from './telegram.js';
import { assertSafeTransactions } from './txGuard.js';
import { describeFailure, failureOf } from './txErrors.js';

const PENDING_REDIRECT_KEY = 'kinu.pendingRedirect';

/**
 * Inside the Meteor mobile app's browser, popups are blocked, so the web module can't sign in.
 * The app injects a flag and a React Native bridge; there the in-app module talks to Meteor
 * directly instead.
 */
export const inMeteorApp = () =>
  typeof window !== 'undefined' &&
  Boolean(window.__is_running_in_meteor_wallet_app__ || /meteor/i.test(navigator.userAgent || '') || window.ReactNativeWebView);

// Set when the user presses Connect inside the Meteor app; cleared on Disconnect.
const METEOR_APP_CONNECTED_KEY = 'kinu.meteorAppConnected';

function meteorAppConnected(value) {
  try {
    if (value === true) localStorage.setItem(METEOR_APP_CONNECTED_KEY, '1');
    else if (value === false) localStorage.removeItem(METEOR_APP_CONNECTED_KEY);
    return localStorage.getItem(METEOR_APP_CONNECTED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Instant-link modules (Meteor in-app) sign in by themselves on every page load. The app
 * keeps no session, so that is how a connection survives a refresh — but the user should
 * choose to connect first: it only runs once they pressed Connect, until they disconnect.
 */
const withoutAutoConnect = (factory) => async (...args) => {
  const module = await factory(...args);
  return module && { ...module, metadata: { ...module.metadata, runOnStartup: meteorAppConnected() } };
};

let selectorPromise = null;
let selectorRef = null; // the loaded selector, for synchronous reads in tap handlers
let modal = null;
let toNajAction = null;

async function loadWalletModules() {
  const [core, meteor, intear, here, myNear, nightly, ledger, modalUi] = await Promise.all([
    import('@near-wallet-selector/core'),
    inMeteorApp() ? import('@near-wallet-selector/meteor-wallet-app') : import('@near-wallet-selector/meteor-wallet'),
    import('@near-wallet-selector/intear-wallet'),
    // Inside Telegram (lib/telegram.js): HOT's own module, which asks HOT's Telegram app and waits
    // for its answer while KINU stays open. Elsewhere the HERE module (HOT's web / app flow).
    inTelegram() ? import('@near-wallet-selector/hot-wallet') : import('@near-wallet-selector/here-wallet'),
    import('@near-wallet-selector/my-near-wallet'),
    import('@near-wallet-selector/nightly'),
    // Ledger over WebHID: desktop Chrome / Edge / Brave; the modal marks it unavailable elsewhere.
    import('@near-wallet-selector/ledger'),
    import('@near-wallet-selector/modal-ui')
  ]);
  toNajAction = core.internalActionToNaj;
  return { core, meteor, intear, here, myNear, nightly, ledger, modalUi };
}

export function getSelector() {
  if (!selectorPromise) {
    selectorPromise = loadWalletModules().then(async ({ core, meteor, intear, here, myNear, nightly, ledger, modalUi }) => {
      const selector = await core.setupWalletSelector({
        network: NETWORK_ID,
        // The selector fails over across these, so one rate-limited endpoint no longer fails a
        // transaction; the first one is also what wallet modules (e.g. Meteor) use on their own.
        fallbackRpcUrls: ENDPOINTS.walletRpc,
        modules: [
          meteor.setupMeteorWalletApp
            ? withoutAutoConnect(meteor.setupMeteorWalletApp({ contractId: CONTRACTS.signIn }))
            : meteor.setupMeteorWallet(),
          intear.setupIntearWallet(),
          here.setupHotWallet ? here.setupHotWallet() : here.setupHereWallet(),
          myNear.setupMyNearWallet(),
          nightly.setupNightly(),
          ledger.setupLedger()
        ]
      });
      // No contractId: signing in only shares the account. With one, wallets add a limited access
      // key and show its gas allowance (e.g. Meteor: "Network Fee Allowance 0.25 NEAR"), which
      // reads like a fee. KINU never uses that key: every transaction is approved in the wallet.
      modal = modalUi.setupModal(selector, {
        theme: 'dark',
        description: 'Connect a NEAR wallet to trade and manage liquidity on KINU.'
      });
      selectorRef = selector;
      return selector;
    });
    selectorPromise.catch(() => {
      selectorPromise = null;
    });
  }
  return selectorPromise;
}

/** Id of the connected wallet module (e.g. "meteor-wallet"), read synchronously; null if unknown. */
export function currentWalletId() {
  return selectorRef?.store.getState().selectedWalletId || null;
}

export function activeAccountId(selector) {
  const accounts = selector.store.getState().accounts || [];
  return (accounts.find((a) => a.active) || accounts[0])?.accountId || null;
}

export async function openWalletModal() {
  const selector = await getSelector();
  // The modal hides instant-link wallets, so inside the Meteor app "Connect wallet" asks
  // Meteor to sign in directly (and only when the user presses it).
  if (inMeteorApp() && selector.store.getState().modules.some((m) => m.id === 'meteor-wallet-app')) {
    const wallet = await selector.wallet('meteor-wallet-app');
    await wallet.signIn({ contractId: CONTRACTS.signIn, accounts: [] });
    meteorAppConnected(true);
    return;
  }
  modal?.show();
}

export async function signOut() {
  const selector = await getSelector();
  const wallet = await selector.wallet();
  meteorAppConnected(false);
  await wallet.signOut();
}

/**
 * Sign and send transaction descriptors built by lib/tx.js.
 * Returns the execution outcomes (empty for redirect-based wallets).
 */
export async function sendTransactions(transactions) {
  const selector = await getSelector();
  const wallet = await selector.wallet();
  const merged = mergeTransactions(transactions);
  if (!merged.length) throw new Error('Nothing to send.');
  assertSafeTransactions(merged, activeAccountId(selector));

  // Redirect-based wallets come back with the result in the URL; only a redirect we
  // started may show one (see consumeRedirectResult).
  try {
    sessionStorage.setItem(PENDING_REDIRECT_KEY, String(Date.now()));
  } catch {
    // storage unavailable: the result toast is skipped, the transaction is not
  }
  const outcomes = await wallet.signAndSendTransactions({
    transactions: merged.map((tx) => ({
      receiverId: tx.receiverId,
      actions: tx.actions.map((action) => toNajAction(action))
    })),
    callbackUrl: window.location.href
  });

  const list = Array.isArray(outcomes) ? outcomes : outcomes ? [outcomes] : [];
  // A receipt can fail inside a transaction that reports success (e.g. a refunded deposit).
  for (const outcome of list) {
    const failed = failureOf(outcome);
    if (failed) {
      const error = new Error(describeFailure(failed));
      error.onChain = true; // read from the outcomes: the batch reached the chain
      throw error;
    }
  }
  return list;
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

/**
 * Asks the connected wallet to sign a message (NEP-413), e.g. an Earn withdrawal intent. Returns
 * { accountId, publicKey, signature } (signature base64); wallets that can't sign here throw.
 */
export async function signMessage({ message, recipient, nonce }) {
  const selector = await getSelector();
  const wallet = await selector.wallet();
  if (typeof wallet.signMessage !== 'function') throw new Error('Your wallet can’t sign messages. Use Meteor, Intear or HOT Wallet for this.');
  const signed = await wallet.signMessage({ message, recipient, nonce });
  if (!signed?.signature || !signed?.publicKey) throw new Error('Your wallet didn’t return a signature. Use Meteor, Intear or HOT Wallet for this.');
  return signed;
}
