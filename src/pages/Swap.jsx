import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useClickOutside, useDebounced, useLocalStorage } from '../hooks.js';
import { Link, navigate, useLocation } from '../router.jsx';
import TokenPicker from '../components/TokenPicker.jsx';
import TokenHeader from '../components/swap/TokenHeader.jsx';
import SwapActivity, { TokenFlow } from '../components/swap/SwapActivity.jsx';
import { getTokenPools } from '../lib/tokenMarket.js';
import { backgroundRefreshAllowed } from '../lib/walletActivity.js';
import { defaultChartSide, intearTokenId } from '../lib/intear.js';
import { AmountInput, Modal, Spinner, TokenIcon } from '../components/ui.jsx';
import { getCachedToken, getToken, getTokens, getWhitelistedTokens, priceOf } from '../lib/tokens.js';
import { buildSwapTransactions, getSwapQuote, quoteHybridSecondLeg, selectRoute } from '../lib/swap.js';
import { estimateNetworkFee } from '../lib/gasEstimate.js';
import { intearNetworkFee } from '../lib/intearRouter.js';
import { feeLabel } from '../lib/platformFee.js';
import { bpsLabel } from '../lib/tokenTax.js';
import { warmDclGraph } from '../lib/dclRouter.js';
import { view } from '../lib/rpc.js';
import { getAggregatorBalances } from '../lib/rhea.js';
import { buildAggregatorWithdrawTransactions } from '../lib/liquidity.js';
import { functionCall, transaction, ensureStorageTx, wrapNearTx } from '../lib/tx.js';
import {
  formatAmount,
  formatPercent,
  formatUnits,
  formatUsd,
  toBigInt,
  toNumber,
  tryParseUnits
} from '../lib/format.js';
import { bpsText, CONTRACTS, DEPOSIT, INTEAR_FEE, INTEAR_REFERRER, KINU_VERIFIED_TOKENS, NATIVE_NEAR, NEAR_GAS_RESERVE, PINNED_TOKENS } from '../config.js';
import { SlippagePicker } from '../components/Slippage.jsx';
import { autoSlippageFor } from '../lib/autoSlippage.js';
import { watchQuote } from '../lib/liveQuotes.js';

const SwapChart = lazy(() => import('../components/swap/SwapChart.jsx'));

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const QUOTE_REFRESH_MS = 20_000;
const QUOTE_MAX_AGE_MS = 15_000;
// Live quotes re-quote at most this often, however fast the pools move.
const LIVE_MIN_GAP_MS = 5_000;
// Chart height on the swap page, set with the divider under it (px).
const CHART_H = { min: 260, max: 820, default: 460 };

/**
 * Tokens the swap router (aggregatedex.near) is holding for the account: a swap whose final
 * transfer to the wallet failed. Shown with a one-click withdraw.
 */
function StuckSwapFunds({ refreshKey }) {
  const { accountId, execute, refreshTokenBalances } = useApp();
  const stuck = useAsync(
    async () => {
      const balances = await getAggregatorBalances(accountId);
      const ids = Object.keys(balances);
      return { balances, tokens: ids.length ? await getTokens(ids) : {} };
    },
    [accountId, refreshKey],
    { enabled: Boolean(accountId), refreshMs: 60_000 }
  );
  const entries = Object.entries(stuck.data?.balances || {});
  if (!entries.length) return null;

  const withdraw = async () => {
    const ids = entries.map(([id]) => id);
    const ok = await execute(() => buildAggregatorWithdrawTransactions({ tokenIds: ids, accountId }), {
      pending: 'Withdrawing from the swap router',
      success: 'Withdrawn to wallet'
    });
    if (ok) {
      stuck.reload();
      refreshTokenBalances(ids);
    }
  };

  return (
    <div className="notice notice--info stuck-funds">
      <span>
        {entries
          .map(([id, raw]) => {
            const t = stuck.data.tokens[id] || { symbol: id.slice(0, 8), decimals: 0 };
            return `${formatAmount(toNumber(raw, t.decimals))} ${id === CONTRACTS.wrapNear ? 'NEAR' : t.symbol}`;
          })
          .join(' + ')}{' '}
        is waiting in the swap router: a swap&apos;s final transfer didn&apos;t reach your wallet.
      </span>
      <button type="button" className="link-button" onClick={withdraw}>
        Withdraw
      </button>
    </div>
  );
}

/**
 * Anyone can deploy a token called "USDC". Warn when a side of the swap isn't on Rhea's
 * whitelist (KINU's pinned and hand-checked tokens, and native NEAR, are trusted).
 */
function UnverifiedTokenWarning({ tokens }) {
  const whitelist = useAsync(() => getWhitelistedTokens(), []);
  if (!whitelist.data) return null;
  const trusted = new Set([...whitelist.data, ...PINNED_TOKENS, ...KINU_VERIFIED_TOKENS, NATIVE_NEAR.id]);
  const unverified = tokens.filter((t) => t && !trusted.has(t.id));
  if (!unverified.length) return null;
  return (
    <div className="notice notice--warn">
      <span>
        {unverified.map((t, i) => (
          <span key={t.id}>
            {i > 0 && ' and '}
            <b>{t.symbol}</b> <code className="mono">{t.id.length > 30 ? `${t.id.slice(0, 14)}…${t.id.slice(-10)}` : t.id}</code>
          </span>
        ))}{' '}
        {unverified.length > 1 ? "aren't" : "isn't"} on Rhea&apos;s verified list. Anyone can create a token with any name — check the
        contract address before you swap.
      </span>
    </div>
  );
}

/**
 * Transactions a quote will need, for the fee estimate when no wallet is connected
 * (storage registrations can't be known without an account).
 */
function sketchSwapTransactions(quote, tokenIn, tokenOut) {
  const call = (receiverId, methodName, args, gas) => ({ receiverId, actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit: '0' } }] });
  const legs = quote.hybrid ? quote.hybrid.legs : [quote];
  const txs = [];
  if (tokenIn.native) txs.push(call(CONTRACTS.wrapNear, 'near_deposit', {}, '10000000000000'));
  legs.forEach((leg) => {
    txs.push(
      leg.dcl
        ? call('token', 'ft_transfer_call', { receiver_id: CONTRACTS.dcl, msg: '{"Swap":{}}' }, '180000000000000')
        : call('token', 'ft_transfer_call', { receiver_id: CONTRACTS.aggregator, msg: '' }, '300000000000000')
    );
  });
  if (tokenOut.native && legs[legs.length - 1].dcl) txs.push(call(CONTRACTS.wrapNear, 'near_withdraw', {}, '50000000000000'));
  return txs;
}

/** Every route that was quoted, its output and the gap to the best one. */
function RoutePicker({ quote, tokenOut, onPick, onClose }) {
  return (
    <Modal title="Select route" subtitle="All routes are quoted live on Rhea and the Intear DEX Aggregator. The best output is selected by default." onClose={onClose}>
      <div className="route-list">
        {quote.compared.map((r) => (
          <button
            key={r.source}
            type="button"
            className={`route-option ${r.chosen ? 'route-option--active' : ''}`}
            onClick={() => {
              onPick(r.source);
              onClose();
            }}
          >
            <span className="route-option__name">
              <strong>{r.source}</strong>
              <small className="muted">{(r.dexs || []).join(' + ')}</small>
            </span>
            <span className="route-option__out">
              <strong>
                {formatAmount(toNumber(r.amountOut, tokenOut.decimals), { compactAbove: 1e12 })} {tokenOut.symbol}
              </strong>
              {r.best ? (
                <em className="badge badge--best">Best</em>
              ) : r.gapPct < 0 ? (
                <em className="badge badge--gap" title="Pays a little more, but needs two wallet confirmations and more gas">
                  +{Math.abs(r.gapPct).toFixed(2)}% · 2 steps
                </em>
              ) : (
                <em className="badge badge--gap">-{r.gapPct < 0.01 ? '<0.01' : r.gapPct.toFixed(2)}%</em>
              )}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

const QUICK_PERCENTS = [25, 50, 80, 100];

function isWrapPair(a, b) {
  return (
    (a?.native && b?.id === CONTRACTS.wrapNear) || (a?.id === CONTRACTS.wrapNear && b?.native)
  );
}

function SlippageSettings({ slippage, setSlippage, auto, setAuto }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);

  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="pill-button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        ⚙ {slippage}%{auto ? ' auto' : ''}
      </button>
      {open && (
        <div className="popover">
          <span className="eyebrow">Max slippage</span>
          <SlippagePicker slippage={slippage} setSlippage={setSlippage} auto={auto} setAuto={setAuto} autoValue={auto ? slippage : null} />
        </div>
      )}
    </div>
  );
}

function TokenField({ label, token, amount, onAmount, onPickToken, balance, usd, readOnly, loading, onMax, onHalf, bonus }) {
  return (
    <div className={`swap-field ${readOnly ? 'swap-field--readonly' : ''}`}>
      <div className="swap-field__top">
        <span>{label}</span>
        {balance !== null && (
          <span className="swap-field__balance">
            Balance {formatAmount(balance)}
            {onHalf && (
              <button type="button" className="mini-button" onClick={onHalf}>
                Half
              </button>
            )}
            {onMax && (
              <button type="button" className="mini-button" onClick={onMax}>
                Max
              </button>
            )}
          </span>
        )}
      </div>
      <div className="swap-field__row">
        <AmountInput
          placeholder="0.0"
          value={amount}
          readOnly={readOnly}
          onChange={(text) => {
            if (/^\d*\.?\d*$/.test(text)) onAmount?.(text);
          }}
          aria-label={`${label} amount`}
        />
        <button type="button" className="token-select" onClick={onPickToken}>
          <TokenIcon token={token} size={26} />
          <strong>{token?.symbol || 'Select'}</strong>
          <span aria-hidden>▾</span>
        </button>
      </div>
      <div className="swap-field__bottom">
        <span>{loading ? <Spinner size={12} /> : usd > 0 ? formatUsd(usd) : ' '}</span>
        {!loading && bonus && (
          <span className="swap-field__bonus" title="TEAR holder discount on Intear DEX fees, already included in the amount">
            ✦ {bonus} bonus
          </span>
        )}
      </div>
    </div>
  );
}

export default function Swap() {
  const { accountId, connect, balances, prices, slippage: savedSlippage, setSlippage, autoSlippage, setAutoSlippage, execute, refreshTokenBalances } = useApp();
  const { search } = useLocation();

  const [tokenIn, setTokenIn] = useState(NATIVE_NEAR);
  const [tokenOut, setTokenOut] = useState(() => getCachedToken(USDC) || { id: USDC, symbol: 'USDC', decimals: 6 });
  // What this swap uses: picked from the pair (Auto, lib/autoSlippage.js) or the user's own value.
  const slippage = autoSlippage ? autoSlippageFor(tokenIn, tokenOut) : savedSlippage;
  // When the quote on screen was fetched (live updates wait LIVE_MIN_GAP_MS between quotes).
  const lastQuoteAt = useRef(0);
  const [live, setLive] = useState(false);
  const [amount, setAmount] = useState('');
  const [picker, setPicker] = useState(null);
  const [showChart, setShowChart] = useLocalStorage('kinu.swap.chart', true);
  // The activity tabs under the chart (Transactions, My history, Holders, …).
  const [showHistory, setShowHistory] = useLocalStorage('kinu.swap.history', true);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [swapCount, setSwapCount] = useState(0); // re-checks the swap router after each swap
  // Route the user picked (null = always the best). Survives quote refreshes for the same pair.
  const [routeSource, setRouteSource] = useState(null);
  const routeSourceRef = useRef(null);
  routeSourceRef.current = routeSource;
  const [showRoutes, setShowRoutes] = useState(false);
  const [invert, setInvert] = useState(false);
  // A new pair starts unflipped.
  useEffect(() => setInvert(false), [tokenIn?.id, tokenOut?.id]);
  // The chart follows the non-quote token of the pair (e.g. NEARLY in NEAR → NEARLY). The rate's ⇄
  // button flips it: the chart (and the token strip above it) then follows the pair's other token.
  const defaultSide = defaultChartSide(tokenIn, tokenOut);
  const side = invert ? (defaultSide === 'in' ? 'out' : 'in') : defaultSide;
  const chartToken = side === 'in' ? tokenIn : tokenOut;
  const counterToken = side === 'in' ? tokenOut : tokenIn;
  // The charted token's pools (GeckoTerminal): chart source, 24h flow, top traders and Pairs.
  const chartTokenId = intearTokenId(chartToken);
  const counterTokenId = intearTokenId(counterToken);
  const poolsQuery = useAsync(() => getTokenPools(chartTokenId, counterTokenId), [chartTokenId, counterTokenId], {
    enabled: Boolean(chartTokenId),
    refreshMs: 120_000
  });
  const pools = poolsQuery.data ?? (poolsQuery.error ? [] : undefined);
  // null = not resized by hand: on desktop the chart then fills the screen under the token
  // header (the trades start below the fold); phones keep the fixed default.
  const [chartHeight, setChartHeight] = useLocalStorage('kinu.swap.chartH2', null);
  const clampChart = (h) => Math.round(Math.min(CHART_H.max, Math.max(CHART_H.min, h)));
  const mainRef = useRef(null);
  const [fitHeight, setFitHeight] = useState(CHART_H.default);
  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof ResizeObserver === 'undefined') return undefined;
    // The left column scrolls on its own (styles.css): the chart and its range bar end at its bottom.
    const fit = () => {
      const body = main.querySelector('.swap-chart .pro-chart__body');
      if (!body || !window.matchMedia('(min-width: 1081px)').matches) return setFitHeight(CHART_H.default);
      const top = body.getBoundingClientRect().top + main.scrollTop;
      const below = body.nextElementSibling?.offsetHeight || 0;
      setFitHeight(clampChart(main.getBoundingClientRect().bottom - top - below - 6));
    };
    // Re-fit when the window, the token header or the toolbar change size, and when the
    // lazy-loaded chart replaces its placeholder.
    const ro = new ResizeObserver(fit);
    const watch = () => {
      ro.disconnect();
      ro.observe(main);
      for (const child of main.children) if (!child.classList.contains('activity')) ro.observe(child);
    };
    const mo = new MutationObserver(watch);
    mo.observe(main, { childList: true });
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  const chartH = chartHeight ?? fitHeight;
  const startChartResize = (event) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startH = chartH;
    const move = (e) => setChartHeight(clampChart(startH + e.clientY - startY));
    const up = (e) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };
  const nudgeChart = (e) => {
    if (e.key === 'ArrowUp') setChartHeight((h) => clampChart((h ?? fitHeight) - 30));
    if (e.key === 'ArrowDown') setChartHeight((h) => clampChart((h ?? fitHeight) + 30));
  };

  // Initial tokens from the URL (?from=…&to=…), e.g. links from pool pages; ?amount= from the
  // Telegram bot's /swap (the user still reviews the quote and signs).
  useEffect(() => {
    const from = search.get('from');
    const to = search.get('to');
    const linkAmount = (search.get('amount') || '').replace(/,/g, '');
    if (Number(linkAmount) > 0 && Number.isFinite(Number(linkAmount))) setAmount(linkAmount);
    if (from) getToken(from).then((t) => t && setTokenIn(t));
    if (to) getToken(to).then((t) => t && setTokenOut(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fill in the default output token's icon — unless the URL picked another token,
  // whose lookup this one could otherwise finish after and overwrite.
  useEffect(() => {
    if (!tokenOut.icon && !search.get('to')) getToken(tokenOut.id).then((t) => t && setTokenOut(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (accountId) refreshTokenBalances([tokenIn.id, tokenOut.id]);
  }, [accountId, tokenIn.id, tokenOut.id, refreshTokenBalances]);

  const debouncedAmount = useDebounced(amount, 400);
  const amountRaw = useMemo(() => tryParseUnits(debouncedAmount, tokenIn.decimals), [debouncedAmount, tokenIn.decimals]);
  const typedRaw = useMemo(() => tryParseUnits(amount, tokenIn.decimals), [amount, tokenIn.decimals]);

  const balanceInRaw = accountId ? balances[tokenIn.id] || '0' : null;
  const balanceOutRaw = accountId ? balances[tokenOut.id] || '0' : null;
  const spendableInRaw = useMemo(() => {
    if (balanceInRaw === null) return null;
    if (!tokenIn.native) return balanceInRaw;
    const rest = toBigInt(balanceInRaw) - toBigInt(NEAR_GAS_RESERVE);
    return (rest > 0n ? rest : 0n).toString();
  }, [balanceInRaw, tokenIn.native]);

  const wrapMode = isWrapPair(tokenIn, tokenOut);

  /* ------------------------------ quoting ------------------------------ */
  const quoteRun = useRef(0);
  const requestQuote = useCallback(
    async ({ silent = false } = {}) => {
      const id = ++quoteRun.current;
      if (!amountRaw || toBigInt(amountRaw) === 0n || tokenIn.id === tokenOut.id) {
        setQuote(null);
        setQuoteError('');
        setQuoting(false);
        return null;
      }
      if (wrapMode) {
        const q = { amountIn: amountRaw, amountOut: amountRaw, minAmountOut: amountRaw, dexs: ['Wrap'], routeTokens: [], wrap: true, user: accountId, fetchedAt: Date.now() };
        setQuote(q);
        setQuoteError('');
        return q;
      }
      if (!silent) setQuoting(true);
      try {
        const q = selectRoute(
          await getSwapQuote({ tokenIn, tokenOut, amountIn: amountRaw, slippage, user: accountId || undefined }),
          routeSourceRef.current
        );
        if (id !== quoteRun.current) return null;
        lastQuoteAt.current = Date.now();
        setQuote(q);
        setQuoteError('');
        return q;
      } catch (error) {
        if (id !== quoteRun.current) return null;
        setQuote(null);
        setQuoteError(error?.message || 'Could not get a quote.');
        return null;
      } finally {
        if (id === quoteRun.current) setQuoting(false);
      }
    },
    [amountRaw, tokenIn, tokenOut, slippage, accountId, wrapMode]
  );

  useEffect(() => {
    setRouteSource(null);
  }, [tokenIn.id, tokenOut.id]);

  // Load the CLMM pool set in the background so the first quote doesn't wait for it.
  useEffect(() => {
    warmDclGraph();
  }, []);

  useEffect(() => {
    requestQuote();
    const timer = setInterval(() => backgroundRefreshAllowed() && requestQuote({ silent: true }), QUOTE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [requestQuote]);

  // Live quotes (lib/liveQuotes.js): re-quote as soon as the pools move the price, at most every
  // LIVE_MIN_GAP_MS; the timer above stays as the fallback.
  useEffect(() => {
    if (!amountRaw || toBigInt(amountRaw) === 0n || tokenIn.id === tokenOut.id || wrapMode) {
      setLive(false);
      return undefined;
    }
    let timer = null;
    const stop = watchQuote({
      tokenIn,
      tokenOut,
      amountIn: amountRaw,
      onStatus: setLive,
      onChange: () => {
        clearTimeout(timer);
        const wait = Math.max(0, LIVE_MIN_GAP_MS - (Date.now() - lastQuoteAt.current));
        timer = setTimeout(() => {
          if (document.visibilityState === 'visible' && backgroundRefreshAllowed()) requestQuote({ silent: true });
        }, wait);
      }
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [amountRaw, tokenIn, tokenOut, wrapMode, requestQuote]);

  /* ------------------------------ derived ------------------------------ */
  const amountInNum = typedRaw ? toNumber(typedRaw, tokenIn.decimals) : 0;
  const amountOutNum = quote ? toNumber(quote.amountOut, tokenOut.decimals) : 0;
  const minOutNum = quote ? toNumber(quote.minAmountOut, tokenOut.decimals) : 0;
  const priceIn = priceOf(prices, tokenIn.id);
  const priceOut = priceOf(prices, tokenOut.id);
  const usdIn = amountInNum * priceIn;
  const usdOut = amountOutNum * priceOut;
  // Intear DEX's fee discount for TEAR holders, shown under the amount (already part of it).
  const tearBonus =
    quote?.intear?.dexId === 'Plach' && toBigInt(quote.intear.discountOut || '0') > 0n
      ? formatAmount(toNumber(quote.intear.discountOut, tokenOut.decimals))
      : null;
  // Measured on the route itself (trade rate vs. a tiny trade's rate); USD prices only as a fallback,
  // since price lists can lag for small tokens.
  const measuredImpact = !wrapMode && Number.isFinite(quote?.priceImpact) ? quote.priceImpact : null;
  const impact =
    measuredImpact ?? (usdIn > 0 && usdOut > 0 && !wrapMode ? Math.max(0, (1 - usdOut / usdIn) * 100) : null);
  const rate = amountInNum > 0 && amountOutNum > 0 ? amountOutNum / amountInNum : null;
  const stale = amount !== debouncedAmount;

  const insufficient =
    accountId && typedRaw && spendableInRaw !== null && toBigInt(typedRaw) > toBigInt(spendableInRaw);

  // The router returns every token touched by the (possibly split) route, not an ordered path.
  const endpoints = new Set([tokenIn.contract || tokenIn.id, tokenOut.contract || tokenOut.id]);
  const viaSymbols = (quote?.routeTokens || [])
    .filter((id) => !endpoints.has(id))
    .map((id) => getCachedToken(id)?.symbol || prices?.get(id)?.symbol || id.slice(0, 6));

  /* ------------------------------ actions ------------------------------ */
  const selectToken = (side, token) => {
    if (side === 'in') {
      if (token.id === tokenOut.id) setTokenOut(tokenIn);
      setTokenIn(token);
    } else {
      if (token.id === tokenIn.id) setTokenIn(tokenOut);
      setTokenOut(token);
    }
    setQuote(null);
  };

  const flip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmount(quote && amountOutNum > 0 ? formatUnits(quote.amountOut, tokenOut.decimals) : '');
    setQuote(null);
  };

  const setFraction = (fraction) => {
    if (spendableInRaw === null) return;
    const raw = (toBigInt(spendableInRaw) * BigInt(Math.round(fraction * 100))) / 100n;
    setAmount(formatUnits(raw.toString(), tokenIn.decimals));
  };

  // Network fee: from the real transactions when a wallet is connected (includes storage),
  // otherwise from the route shape.
  const fee = useAsync(
    async () => {
      if (!quote || quote.wrap) return null;
      // Intear quotes carry the aggregator's own estimate, storage for this account included.
      if (quote.intear) return intearNetworkFee(quote);
      let txs;
      if (accountId && quote.user === accountId) {
        txs = quote.hybrid
          ? [
              ...(await buildSwapTransactions({ tokenIn, tokenOut: { id: quote.hybrid.mid }, quote: quote.hybrid.legs[0], accountId })),
              ...sketchSwapTransactions(quote.hybrid.legs[1], { id: quote.hybrid.mid }, tokenOut)
            ]
          : await buildSwapTransactions({ tokenIn, tokenOut, quote, accountId });
      } else {
        txs = sketchSwapTransactions(quote, tokenIn, tokenOut);
      }
      return estimateNetworkFee(txs);
    },
    [quote?.fetchedAt, quote?.source, accountId],
    { enabled: Boolean(quote) && !wrapMode }
  );

  /**
   * Combined route (e.g. NEAR -> RHEA via the router, RHEA -> DIARHEA via CLMM): two wallet
   * requests. Step 2 spends exactly the bridge tokens step 1 delivered, never tokens the
   * user already held. Each step starts from its own click: popup wallets (Intear, Meteor web,
   * MyNearWallet) may only open a window right after a click, so step 2 waits for "Continue".
   */
  const [step2, setStep2] = useState(null); // { route, bridge, bridgeSymbol, before, tokenIn, tokenOut }
  useEffect(() => setStep2(null), [tokenIn.id, tokenOut.id]);
  const bridgeBalance = async (id) => toBigInt((await view(id, 'ft_balance_of', { account_id: accountId }, { fresh: true })) || '0');

  const runStep2 = async () => {
    const s2 = step2;
    setSubmitting(true);
    const ok = await execute(
      async () => {
        const received = (await bridgeBalance(s2.bridge.id)) - s2.before;
        if (received <= 0n) throw new Error(`No ${s2.bridgeSymbol} arrived from step 1, so step 2 was not sent.`);
        const second = await quoteHybridSecondLeg({ quote: s2.route, tokenOut: s2.tokenOut, amountIn: received.toString(), slippage, user: accountId });
        return buildSwapTransactions({ tokenIn: s2.bridge, tokenOut: s2.tokenOut, quote: second, accountId });
      },
      { pending: `Step 2 of 2: ${s2.bridgeSymbol} → ${s2.tokenOut.symbol}`, success: 'Swap executed' }
    );
    setSubmitting(false);
    setSwapCount((n) => n + 1);
    if (ok) {
      setStep2(null);
      setAmount('');
      setQuote(null);
    }
    refreshTokenBalances([s2.tokenIn.id, s2.tokenOut.id, s2.bridge.id]);
  };

  const submit = async () => {
    if (!accountId) return connect();
    if (step2) return runStep2();
    if (!wrapMode && quote?.hybrid) {
      setSubmitting(true);
      const bridgeLabel = viaSymbols[0] || 'the bridge token';
      // The wallet window opens with this click (execute), before anything is read or quoted.
      const ctx = {};
      const first = await execute(
        async () => {
          // Fresh, user-bound quote before step 1.
          const route =
            quote.user === accountId && Date.now() - quote.fetchedAt <= QUOTE_MAX_AGE_MS && !stale
              ? quote
              : selectRoute(await getSwapQuote({ tokenIn, tokenOut, amountIn: typedRaw, slippage, user: accountId }), routeSource);
          if (!route?.hybrid) {
            // A direct route turned up meanwhile: one swap does it all.
            ctx.direct = true;
            return buildSwapTransactions({ tokenIn, tokenOut, quote: route, accountId });
          }
          ctx.route = route;
          ctx.bridge = { id: route.hybrid.mid };
          ctx.bridgeSymbol = (await getToken(route.hybrid.mid).catch(() => null))?.symbol || bridgeLabel;
          ctx.before = await bridgeBalance(route.hybrid.mid);
          return buildSwapTransactions({ tokenIn, tokenOut: ctx.bridge, quote: route.hybrid.legs[0], accountId });
        },
        { pending: `Step 1 of 2: ${tokenIn.symbol} → ${bridgeLabel}`, success: `Step 1 done — received ${bridgeLabel}` }
      );
      setSubmitting(false);
      setSwapCount((n) => n + 1);
      if (first && ctx.direct) {
        setAmount('');
        setQuote(null);
      } else if (first) {
        setStep2({ route: ctx.route, bridge: ctx.bridge, bridgeSymbol: ctx.bridgeSymbol, before: ctx.before, tokenIn, tokenOut });
      }
      refreshTokenBalances([tokenIn.id, tokenOut.id, quote.hybrid.mid]);
      return undefined;
    }
    setSubmitting(true);
    const result = await execute(
      async () => {
        if (wrapMode) {
          if (tokenIn.native) {
            return [await ensureStorageTx(CONTRACTS.wrapNear, accountId), wrapNearTx(typedRaw)].filter(Boolean);
          }
          return [
            transaction(CONTRACTS.wrapNear, [
              functionCall('near_withdraw', { amount: typedRaw }, '50000000000000', DEPOSIT.oneYocto)
            ])
          ];
        }
        // Always execute a fresh, user-bound quote.
        let executable = quote;
        if (!executable || executable.hybrid || executable.user !== accountId || Date.now() - executable.fetchedAt > QUOTE_MAX_AGE_MS || stale) {
          executable = selectRoute(await getSwapQuote({ tokenIn, tokenOut, amountIn: typedRaw, slippage, user: accountId }), routeSource);
          setQuote(executable);
        }
        return buildSwapTransactions({ tokenIn, tokenOut, quote: executable, accountId });
      },
      {
        pending: wrapMode ? (tokenIn.native ? 'Wrapping NEAR' : 'Unwrapping NEAR') : `Swapping ${tokenIn.symbol} → ${tokenOut.symbol}`,
        success: wrapMode ? 'Done' : 'Swap executed'
      }
    );
    setSubmitting(false);
    setSwapCount((n) => n + 1);
    if (result) {
      setAmount('');
      setQuote(null);
      refreshTokenBalances([tokenIn.id, tokenOut.id]);
    }
  };

  let buttonLabel = 'Swap';
  let buttonDisabled = false;
  if (!accountId) buttonLabel = 'Connect wallet';
  else if (step2) {
    // Step 1 of a combined route landed: step 2 needs its own click (see runStep2).
    buttonLabel = submitting ? 'Confirm in wallet…' : `Continue: step 2 of 2 (${step2.bridgeSymbol} → ${step2.tokenOut.symbol})`;
    buttonDisabled = submitting;
  } else if (!typedRaw || toBigInt(typedRaw) === 0n) {
    buttonLabel = 'Enter an amount';
    buttonDisabled = true;
  } else if (insufficient) {
    buttonLabel = `Insufficient ${tokenIn.symbol}`;
    buttonDisabled = true;
  } else if (quoting || stale) {
    buttonLabel = 'Finding best route…';
    buttonDisabled = true;
  } else if (quoteError || !quote) {
    buttonLabel = 'No route available';
    buttonDisabled = true;
  } else if (submitting) {
    buttonLabel = 'Confirm in wallet…';
    buttonDisabled = true;
  } else if (wrapMode) {
    buttonLabel = tokenIn.native ? 'Wrap NEAR' : 'Unwrap wNEAR';
  } else if (impact !== null && impact > 15) {
    buttonLabel = 'Swap anyway (high impact)';
  }

  return (
    <div className="page page--swap swap-pro">
      {/* Chart hidden: the token header goes with it. Nothing left on the left (no history
          either): the swap card moves to the centre. */}
      <div className={`swap-pro__grid ${!showChart && !showHistory ? 'swap-pro__grid--solo' : ''}`}>
        <div className="swap-pro__main" ref={mainRef}>
          {showChart && <TokenHeader token={chartToken} />}
          {showChart && (
            <>
              <Suspense fallback={<div className="card chart-card chart-card--loading"><Spinner size={22} /></div>}>
                <SwapChart token={chartToken} counter={counterToken} pools={pools} height={chartH} onFlip={() => setInvert((v) => !v)} />
              </Suspense>
              <div
                className="splitter swap-pro__splitter"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize chart"
                tabIndex={0}
                title="Drag to resize · double-click to reset"
                onPointerDown={startChartResize}
                onDoubleClick={() => setChartHeight(null)}
                onKeyDown={nudgeChart}
              >
                <span />
              </div>
            </>
          )}
          {showHistory && <SwapActivity token={chartToken} pools={pools} poolsError={Boolean(poolsQuery.error)} flush={showChart} />}
        </div>

        <div className="swap-column swap-pro__side">
          {/* Pool counts only when the pools loaded: a busy GeckoTerminal shows "—", not zero. */}
          <TokenFlow token={chartToken} pools={poolsQuery.data} />
          <div className="card swap-card">
            <div className="swap-card__head">
              <div>
                <h2>Swap</h2>
                <span className="muted small">
                  Best route across Rhea & Intear DEX ·{' '}
                  <Link to="/bridge" className="swap-deposit-link">
                    Bridge from another chain
                  </Link>
                </span>
              </div>
              <div className="swap-card__tools">
                <button type="button" className="pill-button" onClick={() => setShowChart(!showChart)}>
                  {showChart ? 'Hide chart' : 'Show chart'}
                </button>
                <button type="button" className="pill-button" onClick={() => setShowHistory(!showHistory)}>
                  {showHistory ? 'Hide history' : 'Show history'}
                </button>
                {live && (
                  <span className="live-pill" title="The quote updates as soon as the pools move">
                    <i aria-hidden="true" /> Live
                  </span>
                )}
                <SlippageSettings slippage={slippage} setSlippage={setSlippage} auto={autoSlippage} setAuto={setAutoSlippage} />
              </div>
            </div>

            {accountId && (
              <div className="quick-amounts">
                {QUICK_PERCENTS.map((p) => (
                  <button key={p} type="button" onClick={() => setFraction(p / 100)}>
                    {p}%
                  </button>
                ))}
              </div>
            )}
            <TokenField
              label="You pay"
              token={tokenIn}
              amount={amount}
              onAmount={setAmount}
              onPickToken={() => setPicker('in')}
              balance={balanceInRaw !== null ? toNumber(balanceInRaw, tokenIn.decimals) : null}
              usd={usdIn}
            />

            <div className="swap-flip-wrap">
              <button type="button" className="swap-flip" onClick={flip} aria-label="Switch tokens">
                ↓↑
              </button>
            </div>

            <TokenField
              label="You receive"
              token={tokenOut}
              amount={quote ? formatAmount(amountOutNum, { compactAbove: 1e12 }).replace(/,/g, '') : ''}
              readOnly
              loading={quoting}
              onPickToken={() => setPicker('out')}
              balance={balanceOutRaw !== null ? toNumber(balanceOutRaw, tokenOut.decimals) : null}
              usd={usdOut}
              bonus={tearBonus}
            />

            {quoteError && typedRaw && !quoting && <div className="notice notice--error">{quoteError}</div>}
            <UnverifiedTokenWarning tokens={[tokenIn, tokenOut]} />
            <StuckSwapFunds refreshKey={swapCount} />
            {tokenIn.native && accountId && !wrapMode && (
              <p className="hint">0.25 NEAR stays in your wallet for gas when using Max.</p>
            )}

            <button
              type="button"
              className="button button--primary button--block button--lg"
              disabled={buttonDisabled}
              onClick={submit}
            >
              {submitting && <Spinner size={14} />}
              {buttonLabel}
            </button>

            {/* The rate row (with its ⇄) only exists once there is a quote: a flipped chart keeps a way back. */}
            {!(quote && rate) && invert && (
              <div className="quote-details">
                <button type="button" className="quote-details__rate" onClick={() => setInvert(false)}>
                  Chart flipped to {chartToken.symbol}
                  <span aria-hidden> ⇄</span>
                </button>
              </div>
            )}
            {quote && rate && (
              <div className="quote-details">
                <button type="button" className="quote-details__rate" onClick={() => setInvert((v) => !v)}>
                  {invert
                    ? `1 ${tokenOut.symbol} = ${formatAmount(1 / rate)} ${tokenIn.symbol}`
                    : `1 ${tokenIn.symbol} = ${formatAmount(rate)} ${tokenOut.symbol}`}
                  <span aria-hidden> ⇄</span>
                </button>
                <dl>
                  <div>
                    <dt>Minimum received</dt>
                    <dd>
                      {formatAmount(minOutNum)} {tokenOut.symbol}
                    </dd>
                  </div>
                  {impact !== null && (
                    <div>
                      <dt>{measuredImpact !== null ? 'Price impact' : 'Price impact (est.)'}</dt>
                      <dd className={impact > 5 ? 'down' : impact > 2 ? 'warn' : ''}>{formatPercent(impact)}</dd>
                    </div>
                  )}
                  {quote.tax && (
                    <div>
                      <dt>Token tax</dt>
                      <dd>
                        {[
                          quote.tax.inBps > 0 && `${tokenIn.symbol} ${bpsLabel(quote.tax.inBps)}`,
                          quote.tax.outBps > 0 && `${tokenOut.symbol} ${bpsLabel(quote.tax.outBps)}`
                        ]
                          .filter(Boolean)
                          .join(' + ')}{' '}
                        <small className="muted">set by the token · included above</small>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Max slippage</dt>
                    <dd>
                      {slippage}%{autoSlippage ? <small className="muted"> · auto</small> : null}
                    </dd>
                  </div>
                  <div>
                    <dt>Route</dt>
                    <dd className="route">
                      {tokenIn.symbol} → {tokenOut.symbol}
                      <small>
                        {quote.hybrid
                          ? `Rhea router (${quote.hybrid.legs[0].dexs.join(' + ')}) → ${quote.hybrid.legs[1].dexs.join(' + ')}`
                          : quote.dexs.join(' + ')}
                        {viaSymbols.length > 0 && ` · via ${viaSymbols.join(', ')}`}
                      </small>
                    </dd>
                  </div>
                  {/* Intear DEX pools charge TEAR holders less (10 / 1,000 / 100,000 TEAR: 10% / 25% / 75% off
                      the pool fee); the aggregator already priced it in for the connected wallet. */}
                  {quote.intear?.dexId === 'Plach' &&
                    (toBigInt(quote.intear.discountOut || '0') > 0n ? (
                      <div>
                        <dt>TEAR holder discount</dt>
                        <dd className="up" title="Intear DEX charges TEAR holders a lower pool fee: 10 TEAR = 10%, 1,000 = 25%, 100,000 = 75% off. Already included above.">
                          +{formatAmount(toNumber(quote.intear.discountOut, tokenOut.decimals))} {tokenOut.symbol}
                        </dd>
                      </div>
                    ) : (
                      accountId && (
                        <div>
                          <dt>Fee discount</dt>
                          <dd>
                            <small className="muted">
                              Hold 10+ TEAR for up to 75% off Intear DEX fees ·{' '}
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => getToken('token.intear.near').then((t) => t && selectToken('out', t))}
                              >
                                Get TEAR
                              </button>
                            </small>
                          </dd>
                        </div>
                      )
                    ))}
                  {INTEAR_FEE.live && quote.intear?.feeBps > 0 && (
                    <div>
                      <dt>KINU fee</dt>
                      <dd title={`On Intear routes: 80% to ${INTEAR_REFERRER}, 20% to Intear${INTEAR_FEE.stableBps !== INTEAR_FEE.bps ? `; ${bpsText(INTEAR_FEE.stableBps)} when both tokens are stable` : ''}. Already included in You receive.`}>
                        {bpsText(quote.intear.feeBps)}{' '}
                        <small className="muted">· included</small>
                      </dd>
                    </div>
                  )}
                  {quote.compared?.length > 0 && (
                    <div>
                      <dt>Route provider</dt>
                      <dd>
                        <button
                          type="button"
                          className="route-chip"
                          onClick={() => setShowRoutes(true)}
                          disabled={quote.compared.length < 2}
                          title={quote.compared.length < 2 ? 'Only one route found for this pair' : 'Compare routes'}
                        >
                          {quote.source}
                          {quote.source === quote.bestSource ? <em className="badge badge--best">Best</em> : <em className="badge badge--gap">Not best</em>}
                          {quote.compared.length > 1 && <span aria-hidden>▾</span>}
                        </button>
                        {quote.platformFee && <small className="route-fee">{feeLabel(quote.platformFee)}</small>}
                      </dd>
                    </div>
                  )}
                  {!wrapMode && (
                    <div>
                      <dt>Network fee</dt>
                      <dd title={fee.data ? `Up to ${fee.data.maxFeeNear.toFixed(4)} NEAR if every call used all its gas; unused gas is refunded.` : undefined}>
                        {fee.data ? (
                          <>
                            ≈ {fee.data.feeNear.toFixed(5)} NEAR
                            {fee.data.storageNear > 0 && <small className="muted"> + {formatAmount(fee.data.storageNear)} NEAR storage (one-time)</small>}
                          </>
                        ) : fee.loading ? (
                          <Spinner size={12} />
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                  )}
                </dl>
                {quote.hybrid && (
                  <p className="hint">
                    This pair needs two swaps through {viaSymbols.join(', ') || 'a bridge token'}: you&apos;ll confirm twice in your wallet: after the first
                    one, press Continue for the second. The second swap uses exactly what the first one delivered.
                  </p>
                )}
              </div>
            )}
          </div>

          <p className="fine-print">
            Every swap is quoted on Rhea&apos;s SmartRouter, direct Rhea CLMM pools and the Intear DEX Aggregator; the largest output wins.
            Every transaction is reviewed and signed in your own wallet — KINU never holds your keys or funds.
          </p>

        </div>
      </div>

      {showRoutes && quote?.compared?.length > 1 && (
        <RoutePicker
          quote={quote}
          tokenOut={tokenOut}
          onPick={(src) => {
            setRouteSource(src === quote.bestSource ? null : src);
            setQuote(selectRoute(quote, src));
          }}
          onClose={() => setShowRoutes(false)}
        />
      )}

      {picker && (
        <TokenPicker
          title={picker === 'in' ? 'Select token to pay' : 'Select token to receive'}
          selectedId={picker === 'in' ? tokenIn.id : tokenOut.id}
          onSelect={(token) => selectToken(picker, token)}
          onClose={() => setPicker(null)}
        />
      )}

      {/* keep URL clean if it carried initial tokens */}
      {search.get('from') || search.get('to') || search.get('amount') ? <UrlCleaner /> : null}
    </div>
  );
}

function UrlCleaner() {
  useEffect(() => {
    navigate('/swap', { replace: true });
  }, []);
  return null;
}
