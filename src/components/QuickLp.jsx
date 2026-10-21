// Quick LP: the Telegram bot's step-by-step CLMM flow (api/telegram.js) as a floating panel on the
// Pools page, signed right there. Single token: pick the token you put in, then strategy, width and
// amount; the range starts at the price now and spreads one way (the pool's 1st token above the
// price, its 2nd below — as the Create position form does for one-sided ranges). The transactions
// come from the same builders the form uses (buildBins → planBins → buildDclBinsTransactions:
// storage, wrap NEAR, token tax and min amounts included), read on the live pool at signing.
// After the position is created: "View pool".

import { useEffect, useState } from 'react';
import { useApp } from '../state.jsx';
import { navigate, poolPath } from '../router.jsx';
import { CONTRACTS, NATIVE_NEAR, NEAR_GAS_RESERVE } from '../config.js';
import { formatAmount, formatChartPrice, formatRawAmount, formatUnits, toBigInt, tryParseUnits } from '../lib/format.js';
import { getToken, priceOf } from '../lib/tokens.js';
import { view } from '../lib/rpc.js';
import { wrapNeededFor } from '../lib/tx.js';
import { alignPoint, buildBins, buildDclBinsTransactions, planBins, pointToPrice, priceToPoint } from '../lib/dclLiquidity.js';
import { refreshDclGraphFor } from '../lib/dclRouter.js';
import TaxNote from './TaxNote.jsx';

const WNEAR = CONTRACTS.wrapNear;
const SIDE_WIDTHS = ['10', '20', '30', '50', '70', '90'];
const USD_AMOUNTS = [50, 100, 150];
const SHARES = [25, 50, 100];
const STRATEGY_NAMES = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-Ask' };
const OPEN_EVENT = 'kinu:quick-lp';

/** Opens the panel for a CLMM pool: { id, tokenIds: [x, y], symbols: [sx, sy] }. */
export function openQuickLp(pool) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: pool }));
}

/**
 * A one-sided range from the price now (the form's useDclRange rule): the 1st token (x) sits above
 * the price, the 2nd (y) below it; points aligned to the pool's spacing.
 */
export function oneSidedRange({ current, delta, dx, dy, side, widthPct }) {
  const price = pointToPrice(current, dx, dy);
  const toPoint = (p, mode) => alignPoint(priceToPoint(p, dx, dy), delta, mode);
  const w = Number(widthPct) / 100;
  if (side === 'y') {
    const right = alignPoint(current, delta, 'floor');
    return { left: Math.min(toPoint(price * (1 - w), 'floor'), right - delta), right };
  }
  const left = alignPoint(current + 1, delta, 'ceil');
  return { left, right: Math.max(toPoint(price * (1 + w), 'ceil'), left + delta) };
}

function strategyOptions(side, sx) {
  if (side === 'y') return [['spot', '▤ Spot', `even buys of ${sx} on the way down`], ['curve', '⛰ Curve', 'most just below the price'], ['bidask', '📐 Bid-Ask', 'ladder: more the deeper it drops']];
  return [['spot', '▤ Spot', `even sells of ${sx} on the way up`], ['curve', '⛰ Curve', 'most just above the price'], ['bidask', '📐 Bid-Ask', 'ladder: more the higher it goes']];
}

function QuickLpPanel({ pool, onClose }) {
  const { accountId, connect, balances, prices, slippage, execute, refreshTokenBalances } = useApp();
  const [x, y] = pool.tokenIds;
  const [sx, sy] = pool.symbols;
  const [side, setSide] = useState(null); // 'x' (1st token, above the price) · 'y' (2nd token, below)
  const [strategy, setStrategy] = useState(null);
  const [width, setWidth] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [meta, setMeta] = useState(null); // [token x, token y] metadata
  const step = done ? 5 : !side ? 1 : !strategy ? 2 : !width ? 3 : 4;

  useEffect(() => {
    let live = true;
    Promise.all([getToken(x), getToken(y)])
      .then((m) => live && setMeta(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [x, y]);

  const back = () => {
    if (step === 4) setWidth(null);
    else if (step === 3) setStrategy(null);
    else if (step === 2) setSide(null);
  };

  const token = side === 'x' ? meta?.[0] : side === 'y' ? meta?.[1] : null;
  const isNear = (side === 'x' ? x : y) === WNEAR;
  const symbol = isNear ? 'NEAR' : side === 'x' ? sx : sy;
  // What can go in: the token's balance; for wNEAR, wallet NEAR (kept 0.25 for gas) plus wNEAR.
  const spendable = (() => {
    if (!accountId || !side) return 0n;
    if (!isNear) return toBigInt(balances[side === 'x' ? x : y] || '0');
    const near = toBigInt(balances[NATIVE_NEAR.id] || '0') - toBigInt(NEAR_GAS_RESERVE);
    return (near > 0n ? near : 0n) + toBigInt(balances[WNEAR] || '0');
  })();
  const usdPrice = side ? priceOf(prices, side === 'x' ? x : y) : 0;
  const raw = token ? tryParseUnits(text, token.decimals) || '0' : '0';
  const tooMuch = accountId && toBigInt(raw) > spendable;

  // Range shown before signing, from market prices (the signed one is computed on the live pool).
  const px = priceOf(prices, x);
  const py = priceOf(prices, y);
  const price = px > 0 && py > 0 ? px / py : null;
  const shownRange = price && width ? (side === 'y' ? [price * (1 - width / 100), price] : [price, price * (1 + width / 100)]) : null;

  const setDollars = (d) => {
    if (!token || !usdPrice) return;
    const amount = d / usdPrice;
    setText(String(Number(amount.toPrecision(6))));
  };
  const setShare = (pct) => {
    if (!token) return;
    const part = (spendable * BigInt(pct)) / 100n;
    setText(formatUnits(part.toString(), token.decimals));
  };

  const submit = async () => {
    if (!accountId) return connect();
    if (!token || toBigInt(raw) === 0n) return undefined;
    setBusy(true);
    const ok = await execute(
      async () => {
        // The live pool and the range on it, right before the wallet opens.
        const fresh = await view(CONTRACTS.dcl, 'get_pool', { pool_id: pool.id }, { fresh: true });
        if (!fresh) throw new Error('Could not read the pool. Try again.');
        const [mx, my] = meta;
        const current = fresh.current_point;
        const range = oneSidedRange({ current, delta: fresh.point_delta, dx: mx.decimals, dy: my.decimals, side, widthPct: width });
        const bins = buildBins({ left: range.left, right: range.right, current, pointDelta: fresh.point_delta, strategy });
        const plan = planBins({ bins, current, from: side, amount: Number(raw) });
        const wrap = isNear ? await wrapNeededFor(accountId, raw, balances[WNEAR]) : '0';
        return buildDclBinsTransactions({
          pool: fresh,
          plan,
          slippage,
          accountId,
          wrapX: side === 'x' && isNear ? wrap : '0',
          wrapY: side === 'y' && isNear ? wrap : '0',
          // Only the entered token, never more than entered (the plan is floating point).
          maxX: side === 'x' ? raw : '0',
          maxY: side === 'y' ? raw : '0'
        });
      },
      { pending: `Adding ${symbol} to ${sx} / ${sy}`, success: 'Liquidity added' }
    );
    setBusy(false);
    if (ok) {
      refreshDclGraphFor(pool.id);
      refreshTokenBalances([x, y, NATIVE_NEAR.id]);
      setDone(true);
    }
    return undefined;
  };

  const navBottom = Math.max(
    0,
    ...['.topbar__bar', '.topbar > .nav', '.topbar .gsearch'].map((s) => document.querySelector(s)?.getBoundingClientRect().bottom || 0).filter((b) => b < window.innerHeight / 2)
  );
  const placed = window.innerWidth > 760 && navBottom > 0 ? { top: navBottom + 10 } : undefined;
  const widthText = width ? `${side === 'y' ? '−' : '+'}${width}%` : '';

  return (
    <section className="qt qlp" style={placed} aria-label={`Quick LP ${sx} / ${sy}`}>
      <header className="qt__head">
        <strong title={`${sx} / ${sy}`}>
          <span aria-hidden>⚡</span> {sx} / {sy}
        </strong>
        {!done && <span className="qlp__step">Step {step}/4</span>}
        {step > 1 && !done && (
          <button type="button" className="qt__slip" onClick={back} disabled={busy} title="Previous step">
            ← Back
          </button>
        )}
        <button type="button" className="qt__close" onClick={onClose} aria-label="Close quick LP" title="Close">
          ×
        </button>
      </header>

      {step > 1 && !done && (
        <p className="qlp__picked">{[`${symbol} only`, strategy && STRATEGY_NAMES[strategy], widthText].filter(Boolean).join(' · ')}</p>
      )}

      {step === 1 && (
        <>
          <p className="qlp__ask">
            Which token do you put in? <small>Single token: the range starts at the price now.</small>
          </p>
          <div className="qlp__opts">
            <button type="button" className="qlp__opt" onClick={() => setSide('y')}>
              <strong>💵 {y === WNEAR ? 'NEAR' : sy} only ↓</strong>
              <small>From the price down: buys {sx} as it falls</small>
            </button>
            <button type="button" className="qlp__opt" onClick={() => setSide('x')}>
              <strong>🎯 {x === WNEAR ? 'NEAR' : sx} only ↑</strong>
              <small>From the price up: sells {sx} as it rises</small>
            </button>
          </div>
          <button type="button" className="link-button qlp__both" onClick={() => (onClose(), navigate(`${poolPath(pool.id)}?tab=add`))}>
            Both tokens or Zap → pool page
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <p className="qlp__ask">Pick a strategy</p>
          <div className="qlp__opts">
            {strategyOptions(side, sx).map(([key, label, hint]) => (
              <button key={key} type="button" className="qlp__opt" onClick={() => setStrategy(key)}>
                <strong>{label}</strong>
                <small>{hint}</small>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <p className="qlp__ask">
            {side === 'y' ? 'How far below the price?' : 'How far above the price?'} <small>Tighter earns more fees but is passed sooner.</small>
          </p>
          <div className="qt__grid qlp__grid">
            {SIDE_WIDTHS.map((w) => (
              <button key={w} type="button" className="qt__btn" onClick={() => setWidth(w)}>
                <strong>{`${side === 'y' ? '−' : '+'}${w}%`}</strong>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 4 && (
        <>
          {shownRange && (
            <p className="qlp__range">
              Range ≈ {formatChartPrice(shownRange[0])} – {formatChartPrice(shownRange[1])} {sy} per {sx} · from the price now
            </p>
          )}
          <div className="qlp__amount">
            <div className="qlp__amount-head">
              <span>Amount</span>
              {accountId && token && (
                <span className="muted">
                  Balance {formatRawAmount(spendable.toString(), token.decimals)} {symbol}
                </span>
              )}
            </div>
            <div className="qlp__field">
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={text}
                aria-label={`Amount of ${symbol}`}
                onChange={(e) => {
                  const v = e.target.value.replace(',', '.');
                  if (/^\d*\.?\d*$/.test(v)) setText(v);
                }}
              />
              <b>{symbol}</b>
            </div>
            <div className="qlp__chips">
              {usdPrice > 0 && USD_AMOUNTS.map((d) => (
                <button key={d} type="button" onClick={() => setDollars(d)}>
                  ${d}
                </button>
              ))}
              {accountId && SHARES.map((p) => (
                <button key={p} type="button" onClick={() => setShare(p)}>
                  {p === 100 ? 'Max' : `${p}%`}
                </button>
              ))}
            </div>
            {usdPrice > 0 && Number(text) > 0 && <small className="muted">≈ ${formatAmount(Number(text) * usdPrice)}</small>}
          </div>
          {meta && <TaxNote tokens={meta} />}
          <button
            type="button"
            className="button button--primary qlp__go"
            onClick={submit}
            disabled={busy || !meta || (accountId && (toBigInt(raw) === 0n || tooMuch))}
          >
            {!accountId ? 'Connect wallet' : busy ? 'Confirm in your wallet…' : tooMuch ? `Not enough ${symbol}` : `Add ${symbol} liquidity`}
          </button>
          <p className="qt__foot">
            Slippage {slippage}% · signed in your wallet. The range is set on the live pool price at signing.
          </p>
        </>
      )}

      {done && (
        <div className="qlp__done">
          <p className="qlp__ask">
            ✅ Position created <small>{`${symbol} only · ${STRATEGY_NAMES[strategy]} · ${widthText}`}</small>
          </p>
          <button type="button" className="button button--primary qlp__go" onClick={() => (onClose(), navigate(poolPath(pool.id)))}>
            View pool →
          </button>
          <button type="button" className="link-button qlp__both" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </section>
  );
}

/** The panel's host on the Pools page: shows the pool a row's ⚡ Quick LP picked. */
export function QuickLpHost() {
  const [pool, setPool] = useState(null);
  useEffect(() => {
    const onOpen = (event) => setPool(event.detail);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  if (!pool) return null;
  return <QuickLpPanel key={pool.id} pool={pool} onClose={() => setPool(null)} />;
}
