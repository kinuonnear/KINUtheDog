import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import { setupModal } from '@near-wallet-selector/modal-ui';

let selectorInstance = null;
let walletModal = null;
let subscription = null;

function syncAccount(onAccountChange) {
  if (!selectorInstance) return;
  const state = selectorInstance.store.getState();
  const active = state.accounts?.find((a) => a.active) ?? state.accounts?.[0];
  onAccountChange?.(active?.accountId ?? null);
}

export async function initMeteorWallet(onAccountChange, onError) {
  try {
    const meteor = setupMeteorWallet();
    const intear = setupIntearWallet();

    selectorInstance = await setupWalletSelector({
      network: 'mainnet',
      modules: [
        meteor,
        intear
      ]
    });

    walletModal = setupModal(selectorInstance, {
      contractId: 'kinu.nearlytrade.near',
      theme: 'dark',
      description: 'Connect your NEAR wallet to KINU.'
    });

    syncAccount(onAccountChange);

    subscription = selectorInstance.store.observable.subscribe(() => {
      syncAccount(onAccountChange);
    });

    return selectorInstance;
  } catch (error) {
    console.error('[KINU] Wallet initialization failed', error);
    onError?.(error);
    return null;
  }
}
export async function connectWallet() {
  if (!selectorInstance) {
    throw new Error('Wallet Selector is not ready yet.');
  }

  if (!walletModal) {
    throw new Error('Wallet Selector modal is not ready.');
  }

  walletModal.show();
}

export async function connectMeteor() {
  if (!selectorInstance) throw new Error('Meteor Wallet is not ready yet.');

  const wallet = await selectorInstance.wallet();
  if (!wallet?.signIn) {
    throw new Error('Meteor Wallet sign-in is not available.');
  }

  await wallet.signIn({
    contractId: 'kinu.nearlytrade.near'
  });
}

export async function disconnectMeteor() {
  if (!selectorInstance) return;
  const wallet = await selectorInstance.wallet();
  if (wallet?.signOut) await wallet.signOut();
}

export async function getNearAccountBalance(accountId) {
  if (!accountId) return null;
  const response = await fetch('/near-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'kinu',
      method: 'query',
      params: {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId
      }
    })
  });

  const json = await response.json();
  if (json.error) throw new Error(json.error.data || json.error.message || 'NEAR RPC error');
  return json.result?.amount ?? null;
}

export function destroyMeteor() {
  subscription?.unsubscribe?.();
  subscription = null;
}





