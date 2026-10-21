// Quick trade: a floating Buy / Sell panel on the token page, in the spirit of GMGN's instant trade.
// One click on a preset quotes the best route (same pipeline as the Swap page) and opens the wallet;
// KINU is non-custodial, so every trade is still approved in the user's own wallet.
// Buy presets are amounts of NEAR (editable, saved in this browser); sell presets are shares of the
// balance. On wide screens the panel can be dragged by its header; on phones it sits above the tab bar.

import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useLocalStorage } from '../hooks.js';
import { CONTRACTS, FEE_SUMMARY, KINU_TOKEN, NATIVE_NEAR, NEAR_GAS_RESERVE, PLATFORM_FEE } from '../config.js';
import { formatAmount, formatRawAmount, parseUnits, toBigInt, toNumber } from '../lib/format.js';
import { getToken, priceOf } from '../lib/tokens.js';
import { SlippagePicker } from './Slippage.jsx';
import { autoSlippageFor } from '../lib/autoSlippage.js';
import { buildSwapTransactions, getSwapQuote, selectRoute } from '../lib/swap.js';

const DEFAULT_BUYS = [1, 5, 10, 25];
const SELL_SHARES = [25, 50, 75, 100];

const validBuys = (list) => (Array.isArray(list) && list.length === 4 && list.every((n) => Number(n) > 0) ? list.map(Number) : DEFAULT_BUYS);

/** Keeps a dragged panel fully on screen. */
function clamp(pos, el) {
  if (!pos || !el) return pos;
  const { width, height } = el.getBoundingClientRect();
  return {
    x: Math.min(Math.max(8, pos.x), window.innerWidth - width - 8),
    y: Math.min(Math.max(8, pos.y), window.innerHeight - height - 8)
  };
}

/**
 * One quick swap: quote the best route (as the Swap page does) and open the wallet. `run(tokenIn,
 * tokenOut, amountRaw, key, pending)`; `busy` is the key of the trade in progress.
 */
export function useQuickSwap() {
  const { accountId, connect, execute, refreshTokenBalances, slippage: savedSlippage, autoSlippage } = useApp();
  const [busy, setBusy] = useState(null);
  const run = async (tokenIn, tokenOut, amountRaw, key, pending) => {
    if (!accountId) return connect();
    setBusy(key);
    // execute opens the wallet window on this click, then quotes: the quote is fresh when signed.
    await execute(
      async () => {
        // Lists carry light token records; the swap needs the full metadata (decimals).
        const [inToken, outToken] = await Promise.all([tokenIn, tokenOut].map((t) => (t.native || t.decimals ? t : getToken(t.id))));
        const slippage = autoSlippage ? autoSlippageFor(inToken, outToken) : savedSlippage;
        let quote = await getSwapQuote({ tokenIn: inToken, tokenOut: outToken, amountIn: amountRaw, slippage, user: accountId });
        if (quote.hybrid) {
          // Two-step routes need two approvals with a pause between them: the Swap page handles those.
          const direct = quote.routes?.find((r) => !r.quote.hybrid);
          if (!direct) throw new Error(`This pair needs a two-step route. Use the Swap page for this trade.`);
          quote = selectRoute(quote, direct.source);
        }
        return buildSwapTransactions({ tokenIn: inToken, tokenOut: outToken, quote, accountId });
      },
      { pending, success: 'Swap executed' }
    );
    setBusy(null);
    refreshTokenBalances([tokenIn.id, tokenOut.id]);
    return undefined;
  };
  return { run, busy };
}

/** Open / closed, shared by the token page's "Quick trade" button and the panel. */
export const useQuickTradeOpen = () => useLocalStorage('kinu.quick.open', false);

/** The button in the token page header that opens the panel. */
export function QuickTradeButton({ open, setOpen }) {
  return (
    <button type="button" className={`button button--outline qt-open ${open ? 'is-active' : ''}`} onClick={() => setOpen(!open)} aria-pressed={open} title="Buy or sell with one click">
      <span aria-hidden>⚡</span> Quick trade
    </button>
  );
}

export default function QuickTrade({ token, open, setOpen }) {
  const { accountId, balances, prices, slippage: savedSlippage, setSlippage, autoSlippage, setAutoSlippage } = useApp();
  const [tab, setTab] = useState('buy');
  const [slipOpen, setSlipOpen] = useState(false);
  const [storedBuys, setStoredBuys] = useLocalStorage('kinu.quick.buys', DEFAULT_BUYS);
  const buys = validBuys(storedBuys);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(buys.map(String));
  const { run: trade, busy } = useQuickSwap();
  const [pos, setPos] = useLocalStorage('kinu.quick.pos', null);
  const panelRef = useRef(null);
  const drag = useRef(null);

  // A saved position from a bigger window is pulled back on screen.
  useEffect(() => {
    if (open && pos) setPos((p) => clamp(p, panelRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!token || token.id === CONTRACTS.wrapNear || token.id === NATIVE_NEAR.id) return null;

  const nearRaw = accountId ? toBigInt(balances[NATIVE_NEAR.id] || '0') : 0n;
  const spendableNear = nearRaw > toBigInt(NEAR_GAS_RESERVE) ? nearRaw - toBigInt(NEAR_GAS_RESERVE) : 0n;
  const tokenRaw = accountId ? toBigInt(balances[token.id] || '0') : 0n;
  const nearPrice = priceOf(prices, NATIVE_NEAR.id) || priceOf(prices, CONTRACTS.wrapNear);
  const tokenPrice = priceOf(prices, token.id);
  const pairIn = tab === 'buy' ? NATIVE_NEAR : token;
  const pairOut = tab === 'buy' ? token : NATIVE_NEAR;
  const autoValue = autoSlippageFor(pairIn, pairOut);
  const slippageNow = autoSlippage ? autoValue : savedSlippage;
  const feeText = token.id === KINU_TOKEN ? 'No KINU fee on $KINU' : PLATFORM_FEE.enabled ? `KINU fee ${PLATFORM_FEE.bps / 100}%` : 'No KINU fee';

  const buy = (n) => trade(NATIVE_NEAR, token, parseUnits(String(n), NATIVE_NEAR.decimals), `buy-${n}`, `Buying ${token.symbol} with ${n} NEAR`);
  const sell = (share) => {
    const amount = share === 100 ? tokenRaw : (tokenRaw * BigInt(share)) / 100n;
    return trade(token, NATIVE_NEAR, amount.toString(), `sell-${share}`, `Selling ${share}% of your ${token.symbol}`);
  };

  const saveBuys = () => {
    const next = draft.map((v) => Number(String(v).replace(',', '.')));
    if (next.every((n) => Number.isFinite(n) && n > 0)) setStoredBuys(next);
    setEditing(false);
  };

  // Dragging by the header (mouse / pen on wide screens; phones keep the docked layout).
  const onPointerDown = (event) => {
    if (event.pointerType === 'touch' || event.button !== 0 || event.target.closest('button') || window.innerWidth <= 760) return;
    const rect = panelRef.current.getBoundingClientRect();
    drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!drag.current) return;
    setPos(clamp({ x: event.clientX - drag.current.dx, y: event.clientY - drag.current.dy }, panelRef.current));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  if (!open) return null;

  // Not dragged yet: under the navigation and the token header (bar, links and search take one to
  // three rows depending on the width; .topbar itself has no box), so no button is covered.
  const navBottom = Math.max(
    0,
    ...['.topbar__bar', '.topbar > .nav', '.topbar .gsearch', '.token-head'].map((s) => document.querySelector(s)?.getBoundingClientRect().bottom || 0).filter((b) => b < window.innerHeight / 2)
  );
  const wide = window.innerWidth > 760;
  const placed = wide && pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : wide && navBottom > 0 ? { top: navBottom + 10 } : undefined;

  return (
    <section ref={panelRef} className="qt" style={placed} aria-label={`Quick trade ${token.symbol}`}>
      <header className="qt__head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <strong>
          <span aria-hidden>⚡</span> {token.symbol}
        </strong>
        <div className="qt__tabs" role="tablist">
          {['buy', 'sell'].map((key) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={`qt__tab qt__tab--${key} ${tab === key ? 'is-active' : ''}`} onClick={() => setTab(key)}>
              {key === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`qt__slip ${slipOpen ? 'is-active' : ''}`}
          onClick={() => setSlipOpen(!slipOpen)}
          aria-expanded={slipOpen}
          title="Max slippage (also used on the Swap page)"
        >
          <span aria-hidden>⚙</span> {slippageNow}%
        </button>
        <button type="button" className="qt__close" onClick={() => setOpen(false)} aria-label="Close quick trade" title="Close">
          ×
        </button>
      </header>

      {slipOpen && (
        <div className="qt__slippage">
          <span>Max slippage</span>
          <SlippagePicker slippage={savedSlippage} setSlippage={setSlippage} compact auto={autoSlippage} setAuto={setAutoSlippage} autoValue={autoValue} />
        </div>
      )}

      {tab === 'buy' ? (
        <>
          <div className="qt__meta">
            <span>Pay with NEAR</span>
            {accountId && <span>Balance {formatRawAmount(nearRaw.toString(), NATIVE_NEAR.decimals)}</span>}
            {!editing && (
              <button type="button" className="link-button" onClick={() => (setDraft(buys.map(String)), setEditing(true))} title="Change the preset amounts">
                Edit
              </button>
            )}
          </div>
          {editing ? (
            <form
              className="qt__grid"
              onSubmit={(event) => {
                event.preventDefault();
                saveBuys();
              }}
            >
              {draft.map((value, i) => (
                <input key={i} className="qt__edit" inputMode="decimal" value={value} aria-label={`Preset ${i + 1} in NEAR`} onChange={(e) => setDraft(draft.map((v, j) => (j === i ? e.target.value.replace(/[^\d.,]/g, '') : v)))} />
              ))}
              <div className="qt__edit-actions">
                <button type="button" className="button button--outline" onClick={() => setEditing(false)} title="Keep the current amounts">
                  ← Back
                </button>
                <button type="submit" className="button button--primary">
                  Save
                </button>
              </div>
            </form>
          ) : (
            <div className="qt__grid">
              {buys.map((n, i) => {
                const raw = toBigInt(parseUnits(String(n), NATIVE_NEAR.decimals));
                const short = accountId && raw > spendableNear;
                const est = nearPrice && tokenPrice ? (n * nearPrice) / tokenPrice : null;
                return (
                  <button
                    key={i}
                    type="button"
                    className="qt__btn qt__btn--buy"
                    disabled={Boolean(busy) || short}
                    onClick={() => buy(n)}
                    title={short ? 'Not enough NEAR (0.25 NEAR stays for gas)' : `Buy ${token.symbol} with ${n} NEAR`}
                  >
                    <strong>{busy === `buy-${n}` ? '…' : `${formatAmount(n)} NEAR`}</strong>
                    {est ? <small>≈ {formatAmount(Number(est.toPrecision(3)))} {token.symbol}</small> : null}
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="qt__meta">
            <span>Sell for NEAR</span>
            {accountId && (
              <span>
                Balance {formatRawAmount(tokenRaw.toString(), token.decimals)} {token.symbol}
              </span>
            )}
          </div>
          <div className="qt__grid">
            {SELL_SHARES.map((share) => {
              const amount = (tokenRaw * BigInt(share)) / 100n;
              const est = nearPrice && tokenPrice ? (toNumber(amount.toString(), token.decimals) * tokenPrice) / nearPrice : null;
              return (
                <button
                  key={share}
                  type="button"
                  className="qt__btn qt__btn--sell"
                  disabled={Boolean(busy) || (accountId && amount === 0n)}
                  onClick={() => sell(share)}
                  title={accountId && amount === 0n ? `No ${token.symbol} to sell` : `Sell ${share}% of your ${token.symbol}`}
                >
                  <strong>{busy === `sell-${share}` ? '…' : `${share}%`}</strong>
                  {accountId && est ? <small>≈ {formatAmount(Number(est.toPrecision(3)))} NEAR</small> : null}
                </button>
              );
            })}
          </div>
        </>
      )}

      <p className="qt__foot" title={FEE_SUMMARY}>
        {accountId ? 'Best route · approve in your wallet' : 'Connect a wallet to trade'} · {feeText} · slippage {slippageNow}%{autoSlippage ? ' auto' : ''}
      </p>
    </section>
  );
}
