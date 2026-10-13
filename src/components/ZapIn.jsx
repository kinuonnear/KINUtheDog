// Zap In UI for the CLMM create-position form: one token in, the app swaps
// the right share into the pair and opens the position in one wallet request.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced } from '../hooks.js';
import { quoteZap } from '../lib/zap.js';
import { asWalletToken, priceOf } from '../lib/tokens.js';
import { formatAmount, formatPercent, formatRawAmount, formatUnits, formatUsd, toBigInt, toNumber, tryParseUnits } from '../lib/format.js';
import { CONTRACTS, NATIVE_NEAR, NEAR_GAS_RESERVE } from '../config.js';
import { feeLabel } from '../lib/platformFee.js';
import TokenPicker from './TokenPicker.jsx';
import { Spinner, TokenIcon } from './ui.jsx';

function trimDecimals(text) {
  const [whole, fraction = ''] = String(text).split('.');
  const kept = fraction.slice(0, 8).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

/** Default zap token: native NEAR for wNEAR pools, otherwise the pool's Y token. */
export function defaultZapToken(x, y) {
  if (x.id === CONTRACTS.wrapNear || y.id === CONTRACTS.wrapNear) return NATIVE_NEAR;
  return y;
}

/** Spendable raw balance of one token (native NEAR keeps a gas reserve). */
export function useZapSpendable(token) {
  const { balances, nearBalance } = useApp();
  if (!token) return 0n;
  if (token.native) {
    const rest = toBigInt(nearBalance?.available || '0') - toBigInt(NEAR_GAS_RESERVE);
    return rest > 0n ? rest : 0n;
  }
  return toBigInt(balances[token.id] || '0');
}

/** Debounced zap quote for the current form state. */
export function useZapQuote({ enabled, token, amountRaw, x, y, pool, unitPlan, shapeKey, slippage, accountId }) {
  const debouncedAmount = useDebounced(amountRaw, 450);
  return useAsync(
    () => quoteZap({ inputToken: token, amountIn: debouncedAmount, x, y, pool, unitPlan, slippage, user: accountId || undefined }),
    [token?.id, debouncedAmount, shapeKey, slippage, accountId, pool.current_point],
    { enabled: enabled && toBigInt(debouncedAmount) > 0n }
  );
}

export function ZapInput({ token, setToken, text, setText, spendable, x, y }) {
  const { accountId, prices } = useApp();
  const [picking, setPicking] = useState(false);
  const raw = tryParseUnits(text, token.decimals) || '0';
  const usd = toNumber(raw, token.decimals) * priceOf(prices, token.id);
  const quick = [x, y, ...(x.id === CONTRACTS.wrapNear || y.id === CONTRACTS.wrapNear ? [NATIVE_NEAR] : [])].map(asWalletToken);
  const shown = asWalletToken(token);
  const uniqueQuick = quick.filter((t, i) => quick.findIndex((o) => o.id === t.id) === i);

  return (
    <>
      <div className="amount-row amount-row--zap">
        <button type="button" className="token-select" onClick={() => setPicking(true)}>
          <TokenIcon token={shown} size={24} />
          <strong>{shown.symbol}</strong>
          <span aria-hidden>▾</span>
        </button>
        <div className="amount-row__zapinput">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={text}
            onChange={(e) => {
              const clean = e.target.value.replace(',', '.');
              if (/^\d*\.?\d*$/.test(clean)) setText(clean);
            }}
          />
          <small>{usd > 0 ? formatUsd(usd) : ' '}</small>
        </div>
      </div>
      <div className="zap-tools">
        <div className="zap-tools__tokens">
          {uniqueQuick.map((t) => (
            <button key={t.id} type="button" className={`chip ${t.id === token.id ? 'chip--active' : ''}`} onClick={() => setToken(t)}>
              <TokenIcon token={t} size={16} />
              {t.symbol}
            </button>
          ))}
        </div>
        {accountId && (
          <span className="zap-tools__balance">
            {formatRawAmount(spendable.toString(), token.decimals)}
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setText(trimDecimals(formatUnits(((spendable * BigInt(f * 100)) / 100n).toString(), token.decimals)))}
              >
                {f === 1 ? 'MAX' : `${f * 100}%`}
              </button>
            ))}
          </span>
        )}
      </div>
      {picking && (
        <TokenPicker title="Zap in with" selectedId={token.id} onSelect={(t) => setToken(t)} onClose={() => setPicking(false)} />
      )}
    </>
  );
}

/** Route + deposit breakdown shown in the summary. */
export function ZapBreakdown({ zap, loading, error, token, x, y }) {
  const { prices } = useApp();
  const legs = useMemo(() => {
    if (!zap) return [];
    return [
      [zap.legX, x],
      [zap.legY, y]
    ].filter(([leg]) => leg.kind !== 'none');
  }, [zap, x, y]);

  if (loading && !zap) {
    return (
      <div className="zap-breakdown">
        <Spinner size={14} /> <span className="muted small">Finding the best split…</span>
      </div>
    );
  }
  if (error) return <div className="notice notice--error">{error.message || 'Could not route this zap.'}</div>;
  if (!zap) return null;

  const swapped = legs.filter(([leg]) => leg.kind === 'swap');
  const inUsd = swapped.reduce((s, [leg]) => s + toNumber(leg.amountIn, token.decimals) * priceOf(prices, token.id), 0);
  const outUsd = swapped.reduce((s, [leg, t]) => s + toNumber(leg.out, t.decimals) * priceOf(prices, t.id), 0);
  const impact = inUsd > 0 && outUsd > 0 ? Math.max(0, (1 - outUsd / inUsd) * 100) : null;

  return (
    <div className="zap-breakdown">
      <div className="zap-breakdown__split">
        <span style={{ width: `${zap.shareX * 100}%` }} className="x" />
        <span style={{ width: `${(1 - zap.shareX) * 100}%` }} className="y" />
      </div>
      <div className="zap-breakdown__legend">
        <span>
          {x.symbol} {formatPercent(zap.shareX * 100, 0)}
        </span>
        <span>
          {y.symbol} {formatPercent((1 - zap.shareX) * 100, 0)}
        </span>
      </div>
      <dl className="kv">
        {legs.map(([leg, t]) => (
          <div key={t.id}>
            <dt>{leg.kind === 'swap' ? `Swap → ${t.symbol}` : leg.kind === 'wrap' ? `Wrap → ${t.symbol}` : `Keep ${t.symbol}`}</dt>
            <dd>
              {formatRawAmount(leg.amountIn, token.decimals)} {token.symbol}
              {leg.kind === 'swap' && (
                <small className="muted">
                  {' '}
                  → ≥ {formatRawAmount(leg.minOut, t.decimals)} {t.symbol} · {leg.quote.dexs.join(' + ')}
                  {leg.quote.platformFee && ` · ${feeLabel(leg.quote.platformFee)}`}
                </small>
              )}
            </dd>
          </div>
        ))}
        <div>
          <dt>Deposited</dt>
          <dd>
            {formatAmount(zap.plan.totalX / 10 ** x.decimals)} {x.symbol} + {formatAmount(zap.plan.totalY / 10 ** y.decimals)} {y.symbol}
          </dd>
        </div>
        {impact !== null && (
          <div>
            <dt>Swap price impact (est.)</dt>
            <dd className={impact > 5 ? 'down' : impact > 2 ? 'warn' : ''}>{formatPercent(impact)}</dd>
          </div>
        )}
      </dl>
      <p className="hint">Deposits use each swap&apos;s guaranteed minimum; any surplus stays in your wallet.</p>
    </div>
  );
}
