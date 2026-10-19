// NEAR wallet connection. Nothing here ever handles keys: every transaction is approved in the
// user's wallet.
//   Browsers: NEAR Connect (lib/nearConnect.js), each wallet in its own sandboxed iframe, the
//             wallet list kept in the app (lib/walletManifest.js).
//   Inside the Meteor app and Telegram: wallet-selector (lib/walletSelector.js), whose in-app
//             Meteor and Telegram HOT flows are already proven there.
// Both load on first use, in their own chunk.

import { inMeteorApp } from './walletEnv.js';
import { inTelegram } from './telegram.js';

export { inMeteorApp, consumeRedirectResult } from './walletEnv.js';

const useLegacy = () => inMeteorApp() || inTelegram();

let backendPromise = null;
let backendRef = null; // the loaded backend, for synchronous reads in tap handlers

function backend() {
  if (!backendPromise) {
    backendPromise = (useLegacy() ? import('./walletSelector.js') : import('./nearConnect.js')).then((m) => (backendRef = m));
    backendPromise.catch(() => {
      backendPromise = null;
    });
  }
  return backendPromise;
}

/**
 * Starts the wallet session: resolves { accountId, unsubscribe } with the signed-in account (or
 * null) and calls onAccount(accountId | null) whenever it changes.
 */
export async function initWallet(onAccount) {
  return (await backend()).initWallet(onAccount);
}

export async function openWalletModal() {
  return (await backend()).openWalletModal();
}

export async function signOut() {
  return (await backend()).signOut();
}

/** Sign and send transaction descriptors built by lib/tx.js; returns the execution outcomes. */
export async function sendTransactions(transactions) {
  return (await backend()).sendTransactions(transactions);
}

/**
 * Asks the connected wallet to sign a message (NEP-413), e.g. an Earn withdrawal intent. Returns
 * { accountId, publicKey, signature } (signature base64); wallets that can't sign here throw.
 */
export async function signMessage(params) {
  return (await backend()).signMessage(params);
}

/** Id of the connected wallet (e.g. "meteor-wallet"), read synchronously; null if unknown. */
export function currentWalletId() {
  return backendRef?.currentWalletId() || null;
}
