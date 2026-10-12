// NEAR wallet connection (Meteor, Intear, HOT, MyNearWallet) via wallet-selector.
// Nothing here ever handles keys: every transaction is approved in the user's wallet.

// Wallet packages are large, so they load in their own chunk after first paint.
import '@near-wallet-selector/modal-ui/styles.css';

import { CONTRACTS, NETWORK_ID } from '../config.js';
import { mergeTransactions } from './tx.js';
import { assertSafeTransactions } from './txGuard.js';
import { describeFailure, failureOf } from './txErrors.js';

let selectorPromise = null;
let modal = null;
let toNajAction = null;

async function loadWalletModules() {
  const [core, meteor, intear, here, myNear, modalUi] = await Promise.all([
    import('@near-wallet-selector/core'),
    import('@near-wallet-selector/meteor-wallet'),
    import('@near-wallet-selector/intear-wallet'),
    import('@near-wallet-selector/here-wallet'),
    import('@near-wallet-selector/my-near-wallet'),
    import('@near-wallet-selector/modal-ui')
  ]);
  toNajAction = core.internalActionToNaj;
  return { core, meteor, intear, here, myNear, modalUi };
}

export function getSelector() {
  if (!selectorPromise) {
    selectorPromise = loadWalletModules().then(async ({ core, meteor, intear, here, myNear, modalUi }) => {
      const selector = await core.setupWalletSelector({
        network: NETWORK_ID,
        modules: [
          meteor.setupMeteorWallet(),
          intear.setupIntearWallet(),
          here.setupHereWallet(),
          myNear.setupMyNearWallet()
        ]
      });
      modal = modalUi.setupModal(selector, {
        contractId: CONTRACTS.signIn,
        theme: 'dark',
        description: 'Connect a NEAR wallet to trade and manage liquidity on KINU.'
      });
      return selector;
    });
    selectorPromise.catch(() => {
      selectorPromise = null;
    });
  }
  return selectorPromise;
}

export function activeAccountId(selector) {
  const accounts = selector.store.getState().accounts || [];
  return (accounts.find((a) => a.active) || accounts[0])?.accountId || null;
}

export async function openWalletModal() {
  await getSelector();
  modal?.show();
}

export async function signOut() {
  const selector = await getSelector();
  const wallet = await selector.wallet();
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
    if (failed) throw new Error(describeFailure(failed));
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
  if (errorCode) {
    return { ok: false, message: decodeURIComponent(errorMessage || errorCode) };
  }
  return { ok: true, hashes: hashes.split(',') };
}
