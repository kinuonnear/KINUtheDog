import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useClickOutside, useDebounced, useLocalStorage } from '../hooks.js';
import { navigate, useLocation } from '../router.jsx';
import TokenPicker from '../components/TokenPicker.jsx';
import RecentTrades from '../components/RecentTrades.jsx';
import { defaultChartSide } from '../lib/intear.js';
import { Spinner, TokenIcon } from '../components/ui.jsx';
import { getCachedToken, getToken, getTokens, priceOf } from '../lib/tokens.js';
import { buildSwapTransactions, getSwapQuote } from '../lib/swap.js';
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
import { CONTRACTS, DEPOSIT, NATIVE_NEAR, NEAR_GAS_RESERVE } from '../config.js';

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
        const q = await getSwapQuote({ tokenIn, tokenOut, amountIn: amountRaw, slippage, user: accountId || undefined });
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
  const impact = usdIn > 0 && usdOut > 0 && !wrapMode ? Math.max(0, (1 - usdOut / usdIn) * 100) : null;
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

  const submit = async () => {
    if (!accountId) return connect();
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
        if (!executable || executable.user !== accountId || Date.now() - executable.fetchedAt > QUOTE_MAX_AGE_MS || stale) {
          executable = await getSwapQuote({ tokenIn, tokenOut, amountIn: typedRaw, slippage, user: accountId });
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

            <TokenField
              label="You pay"
              token={tokenIn}
              amount={amount}
              onAmount={setAmount}
              onPickToken={() => setPicker('in')}
              balance={balanceInRaw !== null ? toNumber(balanceInRaw, tokenIn.decimals) : null}
              usd={usdIn}
              onHalf={accountId ? () => setFraction(0.5) : undefined}
              onMax={accountId ? () => setFraction(1) : undefined}
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
                      <dt>Price impact (est.)</dt>
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
                        {quote.dexs.join(' + ')}
                        {viaSymbols.length > 0 && ` · via ${viaSymbols.join(', ')}`}
                      </small>
                    </dd>
                  </div>
                </dl>
              </div>
            )}
          </div>

          <p className="fine-print">
            Quotes come from Rhea&apos;s SmartRouter, with direct Rhea CLMM routing for pairs it doesn&apos;t cover.
            Every transaction is reviewed and signed in your own wallet — KINU never holds your keys or funds.
          </p>

          <RecentTrades token={chartToken} />
        </div>
      </div>

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
