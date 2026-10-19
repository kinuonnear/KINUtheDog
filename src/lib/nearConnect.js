// Wallet backend for browsers (lib/wallet.js picks it): NEAR Connect (@hot-labs/near-connect).
// Each wallet's script runs in its own sandboxed iframe and only talks to the page through
// messages; the list of wallets and their scripts is KINU's own (lib/walletManifest.js), not
// fetched at runtime. Sign-in shares the account only: no access key, no gas allowance.
// Nothing here ever handles keys: every transaction is approved in the user's wallet.

import { NearConnector } from '@hot-labs/near-connect';
import { ENDPOINTS, NETWORK_ID } from '../config.js';
import { WALLET_MANIFEST } from './walletManifest.js';
import { mergeTransactions } from './tx.js';
import { assertSafeTransactions } from './txGuard.js';
import { describeFailure, failureOf } from './txErrors.js';

const session = { wallet: null, walletId: null, accountId: null };
const listeners = new Set();
let connector = null;
let ready = null;

function setSession(wallet, accounts) {
  session.wallet = wallet || null;
  session.walletId = wallet?.manifest?.id || null;
  session.accountId = accounts?.[0]?.accountId || null;
  listeners.forEach((fn) => fn(session.accountId));
}

function getConnector() {
  if (!ready) {
    connector = new NearConnector({
      network: NETWORK_ID,
      manifest: WALLET_MANIFEST,
      // The wallets' reads fail over across the same endpoints KINU's wallet calls use.
      providers: { [NETWORK_ID]: ENDPOINTS.walletRpc },
      autoConnect: true
    });
    connector.on('wallet:signIn', ({ wallet, accounts }) => setSession(wallet, accounts));
    connector.on('wallet:signOut', () => setSession(null, []));
    ready = connector.whenManifestLoaded
      .then(() => connector.getConnectedWallet())
      .then(({ wallet, accounts }) => setSession(wallet, accounts))
      // Nobody signed in yet.
      .catch(() => {})
      .then(() => connector);
  }
  return ready;
}

/** Starts the session: { accountId, unsubscribe }, calling onAccount on every change. */
export async function initWallet(onAccount) {
  await getConnector();
  listeners.add(onAccount);
  return { accountId: session.accountId, unsubscribe: () => listeners.delete(onAccount) };
}

/** Id of the connected wallet (e.g. "meteor-wallet"), read synchronously; null if unknown. */
export function currentWalletId() {
  return session.walletId;
}

// Closing the wallet list or declining in the wallet is not an error worth a toast.
const isCancel = (error) => /reject|cancel|closed|user denied|aborted/i.test(String(error?.message || error || ''));

export async function openWalletModal() {
  const c = await getConnector();
  try {
    await c.connect();
  } catch (error) {
    if (!isCancel(error)) throw error;
  }
}

export async function signOut() {
  const c = await getConnector();
  await c.disconnect();
  setSession(null, []);
}

async function connectedWallet() {
  const c = await getConnector();
  if (session.wallet) return session.wallet;
  const wallet = await c.wallet();
  if (!wallet) throw new Error('Connect a wallet first.');
  return wallet;
}

/**
 * Sign and send transaction descriptors built by lib/tx.js (their actions are already in NEAR
 * Connect's { type, params } form). Returns the execution outcomes.
 */
export async function sendTransactions(transactions) {
  const wallet = await connectedWallet();
  const merged = mergeTransactions(transactions);
  if (!merged.length) throw new Error('Nothing to send.');
  assertSafeTransactions(merged, session.accountId);

  const outcomes = await wallet.signAndSendTransactions({
    transactions: merged.map((tx) => ({ receiverId: tx.receiverId, actions: tx.actions }))
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

/**
 * Asks the connected wallet to sign a message (NEP-413). Returns { accountId, publicKey,
 * signature } (signature base64); wallets that can't sign here throw.
 */
export async function signMessage({ message, recipient, nonce }) {
  const wallet = await connectedWallet();
  if (wallet.manifest?.features?.signMessage === false || typeof wallet.signMessage !== 'function') {
    throw new Error('Your wallet can’t sign messages. Use Meteor, Intear or HOT Wallet for this.');
  }
  const signed = await wallet.signMessage({ message, recipient, nonce });
  if (!signed?.signature || !signed?.publicKey) throw new Error('Your wallet didn’t return a signature. Use Meteor, Intear or HOT Wallet for this.');
  return signed;
}
