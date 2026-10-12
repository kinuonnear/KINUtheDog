// Global app state: wallet session, token prices, wallet balances, toasts, settings.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  activeAccountId,
  consumeRedirectResult,
  getSelector,
  openWalletModal,
  sendTransactions,
  signOut
} from './lib/wallet.js';
import { getAllBalances, getFtBalance, getPrices } from './lib/tokens.js';
import { clearViewCache } from './lib/rpc.js';
import { explainRecentFailure, GENERIC_RECEIPT_FAILURE } from './lib/txErrors.js';
import { useLocalStorage } from './hooks.js';
import { DEFAULT_SLIPPAGE, ENDPOINTS } from './config.js';

const AppContext = createContext(null);

const PRICE_REFRESH_MS = 60_000;
const BALANCE_REFRESH_MS = 30_000;

export function AppProvider({ children }) {
  /* ---------------- toasts ---------------- */
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  const dismissToast = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (kind, title, message, { link, timeout = 7000 } = {}) => {
      const id = ++toastId.current;
      setToasts((list) => [...list.slice(-3), { id, kind, title, message, link }]);
      if (timeout) setTimeout(() => dismissToast(id), timeout);
      return id;
    },
    [dismissToast]
  );

  /* ---------------- wallet ---------------- */
  const [walletReady, setWalletReady] = useState(false);
  const [accountId, setAccountId] = useState(null);

  useEffect(() => {
    let subscription;
    let cancelled = false;
    getSelector()
      .then((selector) => {
        if (cancelled) return;
        setAccountId(activeAccountId(selector));
        setWalletReady(true);
        subscription = selector.store.observable.subscribe(() => {
          setAccountId(activeAccountId(selector));
        });
      })
      .catch((error) => {
        console.error('[KINU] wallet selector failed', error);
        toast('error', 'Wallet unavailable', error?.message || 'Wallet selector failed to load.');
        setWalletReady(true);
      });

    const redirect = consumeRedirectResult();
    if (redirect?.ok) {
      toast('success', 'Transaction confirmed', `${redirect.hashes.length} transaction(s) sent.`, {
        link: `${ENDPOINTS.explorer}/txns/${redirect.hashes[redirect.hashes.length - 1]}`
      });
    } else if (redirect) {
      toast('error', 'Transaction not completed', redirect.message);
    }

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [toast]);

  const connect = useCallback(() => {
    openWalletModal().catch((error) => toast('error', 'Wallet', error?.message));
  }, [toast]);

  const disconnect = useCallback(async () => {
    try {
      await signOut();
    } catch (error) {
      toast('error', 'Disconnect failed', error?.message);
    }
  }, [toast]);

  /* ---------------- prices ---------------- */
  const [prices, setPrices] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = (fresh) =>
      getPrices({ fresh })
        .then((map) => !cancelled && setPrices(map))
        .catch((error) => console.warn('[KINU] price feed', error));
    load(false);
    const timer = setInterval(() => document.visibilityState === 'visible' && load(true), PRICE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /* ---------------- balances ---------------- */
  const [balances, setBalances] = useState({});
  const [nearBalance, setNearBalance] = useState(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const balanceRun = useRef(0);

  const refreshBalances = useCallback(async () => {
    if (!accountId) return;
    const id = ++balanceRun.current;
    setBalancesLoading(true);
    try {
      const result = await getAllBalances(accountId);
      if (id !== balanceRun.current) return;
      // Replace (not merge): the index omits zero balances, so stale entries must be dropped.
      setBalances(result.balances);
      setNearBalance(result.near);
    } catch (error) {
      console.warn('[KINU] balances', error);
    } finally {
      if (id === balanceRun.current) setBalancesLoading(false);
    }
  }, [accountId]);

  /** Fresh on-chain balance for specific tokens (FastNEAR can lag a few blocks). */
  const refreshTokenBalances = useCallback(
    async (tokenIds) => {
      if (!accountId) return;
      const entries = await Promise.all(
        tokenIds
          .filter((id) => id && id !== 'near')
          .map(async (id) => [id, await getFtBalance(id, accountId).catch(() => null)])
      );
      setBalances((previous) => {
        const next = { ...previous };
        entries.forEach(([id, raw]) => {
          if (raw !== null) next[id] = raw;
        });
        return next;
      });
    },
    [accountId]
  );

  useEffect(() => {
    setBalances({});
    setNearBalance(null);
    if (!accountId) return undefined;
    refreshBalances();
    const timer = setInterval(
      () => document.visibilityState === 'visible' && refreshBalances(),
      BALANCE_REFRESH_MS
    );
    return () => clearInterval(timer);
  }, [accountId, refreshBalances]);

  /* ---------------- transactions ---------------- */
  const execute = useCallback(
    async (buildTransactions, { pending = 'Confirm in your wallet', success = 'Transaction confirmed' } = {}) => {
      if (!accountId) {
        connect();
        return null;
      }
      const pendingId = toast('info', pending, 'Review and approve the request in your wallet.', { timeout: 0 });
      try {
        const txs = await buildTransactions();
        const outcomes = await sendTransactions(txs);
        dismissToast(pendingId);
        const last = outcomes[outcomes.length - 1];
        const hash = last?.transaction?.hash || last?.transaction_outcome?.id;
        toast('success', success, outcomes.length ? `${outcomes.length} transaction(s) executed.` : 'Submitted.', {
          link: hash ? `${ENDPOINTS.explorer}/txns/${hash}` : undefined
        });
        clearViewCache();
        refreshBalances();
        return outcomes;
      } catch (error) {
        dismissToast(pendingId);
        const message = error?.message || String(error);
        if (/reject|cancel|denied|closed/i.test(message) && !GENERIC_RECEIPT_FAILURE.test(message)) {
          toast('warning', 'Request cancelled', 'Nothing was sent.');
        } else if (GENERIC_RECEIPT_FAILURE.test(message) && !/ran out of gas|failed:/.test(message)) {
          // The wallet only says "a receipt failed": read the reason from the chain.
          const checkingId = toast('error', 'Transaction failed', 'One step failed on-chain — checking why…', { timeout: 0 });
          explainRecentFailure(accountId).then((reason) => {
            dismissToast(checkingId);
            toast('error', 'Transaction failed', reason || message, { timeout: 15000 });
            refreshBalances();
          });
        } else {
          toast('error', 'Transaction failed', message, { timeout: 12000 });
        }
        console.error('[KINU] transaction', error);
        return null;
      }
    },
    [accountId, connect, dismissToast, refreshBalances, toast]
  );

  /* ---------------- settings ---------------- */
  const [slippage, setSlippage] = useLocalStorage('kinu.slippage', DEFAULT_SLIPPAGE);

  const value = useMemo(
    () => ({
      walletReady,
      accountId,
      connect,
      disconnect,
      prices,
      balances,
      nearBalance,
      balancesLoading,
      refreshBalances,
      refreshTokenBalances,
      execute,
      toast,
      toasts,
      dismissToast,
      slippage,
      setSlippage
    }),
    [
      walletReady,
      accountId,
      connect,
      disconnect,
      prices,
      balances,
      nearBalance,
      balancesLoading,
      refreshBalances,
      refreshTokenBalances,
      execute,
      toast,
      toasts,
      dismissToast,
      slippage,
      setSlippage
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>');
  return context;
}
