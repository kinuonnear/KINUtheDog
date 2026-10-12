import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useClickOutside, useDebounced, useLocalStorage } from '../hooks.js';
import { navigate, useLocation } from '../router.jsx';
import TokenPicker from '../components/TokenPicker.jsx';
import RecentTrades from '../components/RecentTrades.jsx';
import { defaultChartSide } from '../lib/intear.js';
import { Modal, Spinner, TokenIcon } from '../components/ui.jsx';
import { getCachedToken, getToken, getTokens, getWhitelistedTokens, priceOf } from '../lib/tokens.js';
import { buildSwapTransactions, getSwapQuote, quoteHybridSecondLeg, selectRoute } from '../lib/swap.js';
import { estimateNetworkFee } from '../lib/gasEstimate.js';
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
import { CONTRACTS, DEPOSIT, NATIVE_NEAR, NEAR_GAS_RESERVE, PINNED_TOKENS } from '../config.js';

const PriceChart = lazy(() => import('../components/PriceChart.jsx'));

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const QUOTE_REFRESH_MS = 20_000;
const QUOTE_MAX_AGE_MS = 15_000;

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
 * whitelist (KINU's pinned tokens and native NEAR are trusted).
 */
function UnverifiedTokenWarning({ tokens }) {
  const whitelist = useAsync(() => getWhitelistedTokens(), []);
  if (!whitelist.data) return null;
  const trusted = new Set([...whitelist.data, ...PINNED_TOKENS, NATIVE_NEAR.id]);
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
    <Modal title="Select route" subtitle="All routes are quoted live on Rhea. The best output is selected by default." onClose={onClose}>
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

function SlippageSettings({ slippage, setSlippage }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);

  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="pill-button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        ⚙ {slippage}%
      </button>
      {open && (
        <div className="popover">
          <span className="eyebrow">Max slippage</span>
          <div className="segmented segmented--full">
            {[0.1, 0.5, 1, 3].map((value) => (
              <button
                key={value}
                type="button"
                className={Number(slippage) === value ? 'active' : ''}
                onClick={() => {
                  setSlippage(value);
                  setCustom('');
                }}
              >
                {value}%
              </button>
            ))}
          </div>
          <label className="input-inline">
            <input
              inputMode="decimal"
              placeholder="Custom"
              value={custom}
              onChange={(event) => {
                const text = event.target.value.replace(',', '.');
                if (!/^\d*\.?\d*$/.test(text)) return;
                setCustom(text);
                const n = Number(text);
                if (n > 0 && n <= 50) setSlippage(n);
              }}
            />
            <span>%</span>
          </label>
          {Number(slippage) > 5 && <p className="warning-text">High slippage: you may receive much less.</p>}
        </div>
      )}
    </div>
  );
}

function TokenField({ label, token, amount, onAmount, onPickToken, balance, usd, readOnly, loading, onMax, onHalf }) {
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
        <input
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          readOnly={readOnly}
          onChange={(event) => {
            const text = event.target.value.replace(',', '.');
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
      <div className="swap-field__bottom">{loading ? <Spinner size={12} /> : usd > 0 ? formatUsd(usd) : ' '}</div>
    </div>
  );
}

export default function Swap() {
  const { accountId, connect, balances, prices, slippage, setSlippage, execute, refreshTokenBalances } = useApp();
  const { search } = useLocation();

  const [tokenIn, setTokenIn] = useState(NATIVE_NEAR);
  const [tokenOut, setTokenOut] = useState(() => getCachedToken(USDC) || { id: USDC, symbol: 'USDC', decimals: 6 });
  const [amount, setAmount] = useState('');
  const [picker, setPicker] = useState(null);
  const [showChart, setShowChart] = useLocalStorage('kinu.swap.chart', true);
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
  const [chartSide, setChartSide] = useState(null);

  // The chart follows the non-quote token of the pair unless the user picks a side.
  useEffect(() => setChartSide(null), [tokenIn.id, tokenOut.id]);
  const side = chartSide || defaultChartSide(tokenIn, tokenOut);
  const chartToken = side === 'in' ? tokenIn : tokenOut;

  // Initial tokens from the URL (?from=…&to=…), e.g. links from pool pages.
  useEffect(() => {
    const from = search.get('from');
    const to = search.get('to');
    if (from) getToken(from).then((t) => t && setTokenIn(t));
    if (to) getToken(to).then((t) => t && setTokenOut(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!tokenOut.icon) getToken(tokenOut.id).then((t) => t && setTokenOut(t));
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
    const timer = setInterval(() => document.visibilityState === 'visible' && requestQuote({ silent: true }), QUOTE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [requestQuote]);

  /* ------------------------------ derived ------------------------------ */
  const amountInNum = typedRaw ? toNumber(typedRaw, tokenIn.decimals) : 0;
  const amountOutNum = quote ? toNumber(quote.amountOut, tokenOut.decimals) : 0;
  const minOutNum = quote ? toNumber(quote.minAmountOut, tokenOut.decimals) : 0;
  const priceIn = priceOf(prices, tokenIn.id);
  const priceOut = priceOf(prices, tokenOut.id);
  const usdIn = amountInNum * priceIn;
  const usdOut = amountOutNum * priceOut;
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
   * user already held.
   */
  const submitHybrid = async (route) => {
    const bridge = { id: route.hybrid.mid };
    const bridgeSymbol = (await getToken(route.hybrid.mid).catch(() => null))?.symbol || route.hybrid.mid;
    const balanceOf = async () => toBigInt((await view(route.hybrid.mid, 'ft_balance_of', { account_id: accountId }, { fresh: true })) || '0');
    const before = await balanceOf();
    const first = await execute(() => buildSwapTransactions({ tokenIn, tokenOut: bridge, quote: route.hybrid.legs[0], accountId }), {
      pending: `Step 1 of 2: ${tokenIn.symbol} → ${bridgeSymbol}`,
      success: `Step 1 done — received ${bridgeSymbol}`
    });
    if (!first) return false;
    return execute(
      async () => {
        const received = (await balanceOf()) - before;
        if (received <= 0n) throw new Error(`No ${bridgeSymbol} arrived from step 1, so step 2 was not sent.`);
        const second = await quoteHybridSecondLeg({ quote: route, tokenOut, amountIn: received.toString(), slippage, user: accountId });
        return buildSwapTransactions({ tokenIn: bridge, tokenOut, quote: second, accountId });
      },
      { pending: `Step 2 of 2: ${bridgeSymbol} → ${tokenOut.symbol}`, success: 'Swap executed' }
    );
  };

  const submit = async () => {
    if (!accountId) return connect();
    if (!wrapMode && quote?.hybrid) {
      setSubmitting(true);
      // Fresh, user-bound quote before step 1.
      const route =
        quote.user === accountId && Date.now() - quote.fetchedAt <= QUOTE_MAX_AGE_MS && !stale
          ? quote
          : await getSwapQuote({ tokenIn, tokenOut, amountIn: typedRaw, slippage, user: accountId })
              .then((q) => selectRoute(q, routeSource))
              .catch(() => null);
      if (route?.hybrid) {
        const ok = await submitHybrid(route);
        setSubmitting(false);
        setSwapCount((n) => n + 1);
        if (ok) {
          setAmount('');
          setQuote(null);
        }
        refreshTokenBalances([tokenIn.id, tokenOut.id, route.hybrid.mid]);
        return undefined;
      }
      // A direct route turned up meanwhile: use the normal one-step swap below.
      if (route) setQuote(route);
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
  else if (!typedRaw || toBigInt(typedRaw) === 0n) {
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
    <div className="page page--swap">
      <div className={`swap-layout ${showChart ? '' : 'swap-layout--solo'}`}>
        {showChart && (
          <Suspense fallback={<div className="card chart-card chart-card--loading"><Spinner size={22} /></div>}>
            <PriceChart tokenIn={tokenIn} tokenOut={tokenOut} side={side} onSideChange={setChartSide} />
          </Suspense>
        )}

        <div className="swap-column">
          <div className="card swap-card">
            <div className="swap-card__head">
              <div>
                <h2>Swap</h2>
                <span className="muted small">Best route across Rhea AMM, stable & CLMM pools</span>
              </div>
              <div className="swap-card__tools">
                <button type="button" className="pill-button" onClick={() => setShowChart(!showChart)}>
                  {showChart ? 'Hide chart' : 'Chart'}
                </button>
                <SlippageSettings slippage={slippage} setSlippage={setSlippage} />
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
                  <div>
                    <dt>Max slippage</dt>
                    <dd>{slippage}%</dd>
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
                    This pair needs two swaps through {viaSymbols.join(', ') || 'a bridge token'}: you&apos;ll confirm twice in your wallet. The
                    second swap uses exactly what the first one delivered.
                  </p>
                )}
              </div>
            )}
          </div>

          <p className="fine-print">
            Every swap is quoted on Rhea&apos;s SmartRouter and on direct Rhea CLMM pools; the larger output wins.
            Every transaction is reviewed and signed in your own wallet — KINU never holds your keys or funds.
          </p>

          <RecentTrades token={chartToken} />
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
      {search.get('from') || search.get('to') ? <UrlCleaner /> : null}
    </div>
  );
}

function UrlCleaner() {
  useEffect(() => {
    navigate('/swap', { replace: true });
  }, []);
  return null;
}
