// Global app state: wallet session, token prices, wallet balances, toasts, settings.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { consumeRedirectResult, currentWalletId, initWallet, openWalletModal, sendTransactions, signOut } from './lib/wallet.js';
import { armWalletPopup, disarmWalletPopup } from './lib/walletPopup.js';
import { backgroundRefreshAllowed, beginWalletRequest, CHAIN_UPDATED_EVENT } from './lib/walletActivity.js';
import { getAllBalances, getFtBalance, getPrices } from './lib/tokens.js';
import { clearViewCache } from './lib/rpc.js';
import { explainRecentFailure, GENERIC_RECEIPT_FAILURE, landedSince, WALLET_NETWORK_ERROR } from './lib/txErrors.js';
import { mergeTransactions } from './lib/tx.js';
import { useLocalStorage } from './hooks.js';
import { DEFAULT_SLIPPAGE, ENDPOINTS } from './config.js';
import { holderStatus, readQualified, setHolderNow, writeQualified } from './lib/holder.js';

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
    // action: { label, to } — a button that opens a page of the app (e.g. the pool to rebalance).
    (kind, title, message, { link, action, timeout = 7000 } = {}) => {
      const id = ++toastId.current;
      setToasts((list) => [...list.slice(-3), { id, kind, title, message, link, action }]);
      if (timeout) setTimeout(() => dismissToast(id), timeout);
      return id;
    },
    [dismissToast]
  );

  /* ---------------- wallet ---------------- */
  const [walletReady, setWalletReady] = useState(false);
  const [accountId, setAccountId] = useState(null);

  useEffect(() => {
    let session;
    let cancelled = false;
    initWallet((id) => !cancelled && setAccountId(id))
      .then((started) => {
        session = started;
        if (cancelled) return started.unsubscribe();
        setAccountId(started.accountId);
        setWalletReady(true);
      })
      .catch((error) => {
        console.error('[KINU] wallet failed to load', error);
        toast('error', 'Wallet unavailable', error?.message || 'Wallet connection failed to load.');
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
      session?.unsubscribe();
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
    const timer = setInterval(() => backgroundRefreshAllowed() && load(true), PRICE_REFRESH_MS);
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
      () => backgroundRefreshAllowed() && refreshBalances(),
      BALANCE_REFRESH_MS
    );
    return () => clearInterval(timer);
  }, [accountId, refreshBalances]);

  /* ---------------- KINU holder ---------------- */
  const holder = useMemo(() => (accountId ? holderStatus(balances, prices, readQualified(accountId)) : null), [accountId, balances, prices]);
  // Meeting the full bar remembers the KINU held then (the grace keeps it through a price drop).
  // Below the grace, or after selling, the memory is cleared.
  useEffect(() => {
    // Only on a loaded balance (nearBalance is set by a successful read): a failed read is not "sold".
    if (!accountId || !holder?.price || balancesLoading || !nearBalance) return;
    if (holder.full) writeQualified(accountId, holder.amount);
    else if (!holder.grace && readQualified(accountId)) writeQualified(accountId, 0);
  }, [accountId, holder, balancesLoading, nearBalance]);
  // Set during render, so quotes made right after see the same status as the page.
  setHolderNow(holder?.isHolder);

  /* ---------------- transactions ---------------- */
  /**
   * After a wallet reported "closed", "cancelled" or a network error: see on-chain whether it still
   * sent the request (wholly or partly), tell the user, and refresh what the page shows.
   */
  const followUpOnChain = useCallback(
    async ({ accountId: account, startedAt, expected, network, success }) => {
      const landed = await landedSince(account, startedAt, { expected });
      if (!landed) return; // index unavailable: the first message stands
      if (!landed.length) {
        if (network) toast('info', 'Nothing was sent', 'Try again in a few seconds — or use Intear or HOT Wallet for multi-step actions.', { timeout: 12000 });
        return;
      }
      clearViewCache();
      refreshBalances();
      window.dispatchEvent(new Event(CHAIN_UPDATED_EVENT));
      const failed = landed.find((t) => t.failure);
      const last = landed[landed.length - 1];
      const link = last?.hash ? `${ENDPOINTS.explorer}/txns/${last.hash}` : undefined;
      if (!failed && landed.length >= expected) {
        toast('success', success, `Your wallet still completed all ${expected} transaction(s).`, { link, timeout: 15000 });
        return;
      }
      toast(
        'warning',
        `${Math.min(landed.length, expected)} of ${expected} transaction(s) went through`,
        `${failed ? `${failed.failure} ` : ''}Tokens from the steps that ran are in your wallet or your Rhea balance — nothing is lost. Review the page before trying again.`,
        { timeout: 20000, link }
      );
    },
    [refreshBalances, toast]
  );

  const execute = useCallback(
    async (buildTransactions, { pending = 'Confirm in your wallet', success = 'Transaction confirmed' } = {}) => {
      if (!accountId) {
        connect();
        return null;
      }
      // Open the wallet's window now, while the click still counts, so preparing the request can't
      // get its popup blocked (lib/walletPopup.js).
      armWalletPopup(currentWalletId());
      // Background refreshes hold off until the wallet is done (lib/walletActivity.js).
      const endWalletRequest = beginWalletRequest();
      const pendingId = toast('info', pending, 'Review and approve the request in your wallet.', { timeout: 0 });
      const startedAt = Date.now();
      let expected = 0; // transactions handed to the wallet (0 = it never got that far)
      try {
        const built = await buildTransactions();
        // Route fees (Intear routes, lib/intearRouter.js) go out only once the swap has landed, as a
        // request of their own: a swap that fails never pays them (docs.intear.tech, executing routes).
        const txs = built.filter((tx) => !tx?.isFee);
        const fees = built.filter((tx) => tx?.isFee);
        expected = mergeTransactions(txs).length;
        const outcomes = await sendTransactions(txs);
        dismissToast(pendingId);
        const last = outcomes[outcomes.length - 1];
        const hash = last?.transaction?.hash || last?.transaction_outcome?.id;
        toast('success', success, outcomes.length ? `${outcomes.length} transaction(s) executed.` : 'Submitted.', {
          link: hash ? `${ENDPOINTS.explorer}/txns/${hash}` : undefined
        });
        if (fees.length) {
          const feeId = toast('info', 'One more approval: the route fee', 'Your swap is done. This sends the fee already shown in the quote.', { timeout: 0 });
          try {
            armWalletPopup(currentWalletId());
            await sendTransactions(fees);
          } catch (feeError) {
            // Declined or failed: the swap itself is complete either way.
            console.warn('[KINU] route fee not sent', feeError);
          } finally {
            dismissToast(feeId);
          }
        }
        clearViewCache();
        refreshBalances();
        return outcomes;
      } catch (error) {
        dismissToast(pendingId);
        const message = error?.message || String(error);
        // The wallet said "closed", "cancelled" or a network error after getting the request: it may
        // still have sent some or all of it (e.g. Intear finishing a batch in the background).
        // Look at the chain before telling the user anything.
        if (expected > 0 && !error?.onChain && !GENERIC_RECEIPT_FAILURE.test(message)) {
          const network = WALLET_NETWORK_ERROR.test(message);
          const cancelled = !network && /reject|cancel|denied|closed/i.test(message);
          if (cancelled) toast('warning', 'Request cancelled', 'Checking whether your wallet sent anything…');
          else if (network) toast('error', "Your wallet couldn't reach the NEAR network", 'Checking whether anything was sent…', { timeout: 12000 });
          else toast('error', 'Transaction failed', message, { timeout: 12000 });
          console.error('[KINU] transaction', error);
          followUpOnChain({ accountId, startedAt, expected, network, success });
          return null;
        }
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
      } finally {
        endWalletRequest();
        disarmWalletPopup(); // closes it only if the wallet never used it
      }
    },
    [accountId, connect, dismissToast, followUpOnChain, refreshBalances, toast]
  );

  /* ---------------- settings ---------------- */
  const [slippage, setSlippage] = useLocalStorage('kinu.slippage', DEFAULT_SLIPPAGE);
  // Swaps pick their slippage from the pair (lib/autoSlippage.js) unless the user set one.
  const [autoSlippage, setAutoSlippage] = useLocalStorage('kinu.slippage.auto', true);

  const value = useMemo(
    () => ({
      walletReady,
      accountId,
      connect,
      disconnect,
      prices,
      balances,
      holder,
      nearBalance,
      balancesLoading,
      refreshBalances,
      refreshTokenBalances,
      execute,
      toast,
      toasts,
      dismissToast,
      slippage,
      setSlippage,
      autoSlippage,
      setAutoSlippage
    }),
    [
      walletReady,
      accountId,
      connect,
      disconnect,
      prices,
      balances,
      holder,
      nearBalance,
      balancesLoading,
      refreshBalances,
      refreshTokenBalances,
      execute,
      toast,
      toasts,
      dismissToast,
      slippage,
      setSlippage,
      autoSlippage,
      setAutoSlippage
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>');
  return context;
}
