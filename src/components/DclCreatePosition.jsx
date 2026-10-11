// Meteora-style "Create position" for Rhea CLMM pools:
//   amounts with auto-fill · strategy (Spot / Curve / Bid-Ask) · draggable
//   liquidity-depth histogram · min / max inputs with % and tick steppers.
// The range lives in useDclRange() so the page's RangeChart can drag it too.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import {
  alignPoint,
  buildBins,
  buildDclBinsTransactions,
  fullRange,
  getMarketDepth,
  planBins,
  pointToPrice,
  priceToPoint,
  rangeSide,
  STRATEGIES
} from '../lib/dclLiquidity.js';
import { view } from '../lib/rpc.js';
import { formatChartPrice, formatPercent, formatRawAmount, formatUnits, maxBig, toBigInt, tryParseUnits } from '../lib/format.js';
import { CONTRACTS, NEAR_GAS_RESERVE } from '../config.js';
import { Spinner, TokenIcon } from './ui.jsx';
import { buildZapTransactions, quoteZap } from '../lib/zap.js';
import { defaultZapToken, useZapQuote, useZapSpendable, ZapBreakdown, ZapInput } from './ZapIn.jsx';

const PRESETS = [
  { key: '5', label: '±5%' },
  { key: '10', label: '±10%' },
  { key: '25', label: '±25%' },
  { key: '50', label: '±50%' },
  { key: 'full', label: 'Full' }
];

function trimDecimals(text) {
  const [whole, fraction = ''] = String(text).split('.');
  const kept = fraction.slice(0, 8).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

/* ------------------------------------------------------------------ */
/* Range state (shared by chart and form)                              */
/* ------------------------------------------------------------------ */

export function useDclRange(pool, x, y) {
  const delta = pool.point_delta;
  const current = pool.current_point;
  const currentPrice = pointToPrice(current, x.decimals, y.decimals);
  const toPoint = useCallback((price, mode) => alignPoint(priceToPoint(price, x.decimals, y.decimals), delta, mode), [x.decimals, y.decimals, delta]);

  const presetRange = useCallback(
    (key) => {
      if (key === 'full') return fullRange(delta);
      const pctv = Number(key) / 100;
      const left = toPoint(currentPrice * (1 - pctv), 'floor');
      let right = toPoint(currentPrice * (1 + pctv), 'ceil');
      if (right <= left) right = left + delta;
      return { left, right };
    },
    [currentPrice, delta, toPoint]
  );

  const [preset, setPresetKey] = useState('10');
  const [range, setRangeState] = useState(() => presetRange('10'));

  const setPreset = (key) => {
    setPresetKey(key);
    setRangeState(presetRange(key));
  };

  /** Move one edge to a price (or point); keeps left < right. */
  const setEdge = useCallback(
    (side, { price, point }) => {
      const p = point ?? toPoint(price, side === 'min' ? 'floor' : 'ceil');
      setPresetKey('custom');
      setRangeState((r) => {
        if (side === 'min') return { left: Math.min(p, r.right - delta), right: r.right };
        return { left: r.left, right: Math.max(p, r.left + delta) };
      });
    },
    [toPoint, delta]
  );

  const nudge = (side, steps) => setEdge(side, { point: (side === 'min' ? range.left : range.right) + steps * delta });

  const full = range.left <= fullRange(delta).left && range.right >= fullRange(delta).right;
  return {
    preset,
    setPreset,
    range,
    setEdge,
    nudge,
    full,
    current,
    currentPrice,
    minPrice: pointToPrice(range.left, x.decimals, y.decimals),
    maxPrice: pointToPrice(range.right, x.decimals, y.decimals)
  };
}

/* ------------------------------------------------------------------ */
/* Liquidity depth histogram with draggable handles                    */
/* ------------------------------------------------------------------ */

const BARS = 64;

function DepthHistogram({ pool, x, y, rangeState, plan }) {
  const depth = useAsync(() => getMarketDepth(pool.pool_id), [pool.pool_id], { refreshMs: 60_000 });
  const svgRef = useRef(null);
  const { range, current, full, setEdge } = rangeState;

  // Visible window in points: the range plus padding (bounded for full-range positions).
  const windowPts = useMemo(() => {
    let lo = Math.min(range.left, current);
    let hi = Math.max(range.right, current);
    if (full || hi - lo > 120000) {
      const segs = depth.data?.segments || [];
      lo = segs.length ? Math.min(segs[0].left, current - 4000) : current - 20000;
      hi = segs.length ? Math.max(segs[segs.length - 1].right, current + 4000) : current + 20000;
    }
    const pad = Math.max((hi - lo) * 0.3, pool.point_delta * 6);
    return { lo: lo - pad, hi: hi + pad };
  }, [range.left, range.right, current, full, depth.data, pool.point_delta]);

  const span = windowPts.hi - windowPts.lo;
  const toX = (pt) => ((pt - windowPts.lo) / span) * 100;

  const bars = useMemo(() => {
    const segs = depth.data?.segments || [];
    const values = Array.from({ length: BARS }, (_, i) => {
      const mid = windowPts.lo + ((i + 0.5) / BARS) * span;
      const seg = segs.find((s) => mid >= s.left && mid < s.right);
      return { mid, value: seg ? seg.liquidity : 0 };
    });
    const max = Math.max(...values.map((v) => v.value), 1);
    return values.map((v) => ({ ...v, h: v.value / max }));
  }, [depth.data, windowPts, span]);

  const preview = useMemo(() => {
    if (!plan?.bins?.length) return [];
    const densities = plan.bins.map((b) => b.weight);
    const max = Math.max(...densities, 1e-9);
    return plan.bins.map((b) => ({ ...b, h: b.weight / max }));
  }, [plan]);

  const drag = (side) => (event) => {
    event.preventDefault();
    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);
    const move = (e) => {
      const rect = svgRef.current.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const point = alignPoint(windowPts.lo + ratio * span, pool.point_delta, 'round');
      setEdge(side, { point });
    };
    const up = (e) => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const leftX = Math.max(0, toX(range.left));
  const rightX = Math.min(100, toX(range.right));
  const curX = toX(current);

  return (
    <div className="depth">
      <div className="depth__chart" ref={svgRef}>
        {bars.map((b, i) => {
          const inRange = b.mid >= range.left && b.mid < range.right;
          return (
            <span
              key={i}
              className={`depth__bar ${b.mid < current ? 'depth__bar--y' : 'depth__bar--x'} ${inRange ? 'depth__bar--in' : ''}`}
              style={{ left: `${(i / BARS) * 100}%`, width: `${100 / BARS}%`, height: `${Math.max(2, b.h * 100)}%` }}
            />
          );
        })}
        <span className="depth__band" style={{ left: `${leftX}%`, width: `${Math.max(0, rightX - leftX)}%` }} />
        <span className="depth__current" style={{ left: `${curX}%` }}>
          <em>Current</em>
        </span>
        {!full && (
          <>
            <button type="button" className="depth__handle" style={{ left: `${leftX}%` }} onPointerDown={drag('min')} aria-label="Drag min price" />
            <button type="button" className="depth__handle" style={{ left: `${rightX}%` }} onPointerDown={drag('max')} aria-label="Drag max price" />
          </>
        )}
        {depth.loading && !depth.data && (
          <span className="depth__loading">
            <Spinner size={14} />
          </span>
        )}
      </div>
      {preview.length > 0 && (
        <div className="depth__preview" title="Your liquidity shape">
          {preview.map((b, i) => (
            <span
              key={i}
              className={`depth__pbar ${b.amountX > 0 && b.amountY > 0 ? 'both' : b.amountX > 0 ? 'x' : 'y'}`}
              style={{ left: `${Math.max(0, toX(b.left))}%`, width: `${Math.max(0.4, Math.min(100, toX(b.right)) - Math.max(0, toX(b.left)))}%`, height: `${Math.max(8, b.h * 100)}%` }}
            />
          ))}
        </div>
      )}
      <div className="depth__axis">
        <span>{formatChartPrice(pointToPrice(windowPts.lo, x.decimals, y.decimals))}</span>
        <span>{formatChartPrice(pointToPrice(current, x.decimals, y.decimals))}</span>
        <span>{formatChartPrice(pointToPrice(windowPts.hi, x.decimals, y.decimals))}</span>
      </div>
      <div className="depth__legend">
        <span>
          <i className="y" /> {y.symbol} side
        </span>
        <span>
          <i className="x" /> {x.symbol} side
        </span>
        <span className="muted">Bars: pool liquidity · strip: your shape</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Min / max price inputs                                              */
/* ------------------------------------------------------------------ */

function PriceEdge({ label, side, price, current, onCommit, onNudge, disabled }) {
  const [text, setText] = useState(null);
  const shown = text ?? (disabled ? (side === 'min' ? '0' : '∞') : formatChartPrice(price));
  const change = current ? (price / current - 1) * 100 : 0;
  const commit = () => {
    if (text === null) return;
    const n = Number(text.replace(',', '.'));
    if (n > 0) onCommit(n);
    setText(null);
  };
  return (
    <div className="price-edge">
      <span className="price-edge__label">{label}</span>
      <div className="price-edge__row">
        <input
          inputMode="decimal"
          value={shown}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {!disabled && <span className={`price-edge__pct ${change >= 0 ? 'up' : 'down'}`}>{`${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</span>}
        <div className="price-edge__steps">
          <button type="button" disabled={disabled} onClick={() => onNudge(1)} aria-label={`Raise ${label}`}>
            +
          </button>
          <button type="button" disabled={disabled} onClick={() => onNudge(-1)} aria-label={`Lower ${label}`}>
            −
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Form                                                                */
/* ------------------------------------------------------------------ */

function useSpendable(tokenIds) {
  const { balances, nearBalance } = useApp();
  return useMemo(() => {
    let native = 0n;
    if (nearBalance) {
      const rest = toBigInt(nearBalance.available) - toBigInt(NEAR_GAS_RESERVE);
      native = rest > 0n ? rest : 0n;
    }
    return tokenIds.map((id) => toBigInt(balances[id] || '0') + (id === CONTRACTS.wrapNear ? native : 0n));
  }, [tokenIds, balances, nearBalance]);
}

export default function DclCreatePosition({ pool, x, y, rangeState, onDone }) {
  const { accountId, connect, slippage, execute, balances } = useApp();
  const [strategy, setStrategy] = useState('spot');
  const [inputs, setInputs] = useState({ x: '', y: '' });
  const [lastEdited, setLastEdited] = useState('x');
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState('dual'); // 'dual' | 'zap'
  const [zapToken, setZapToken] = useState(() => defaultZapToken(x, y));
  const [zapText, setZapText] = useState('');
  const { range, current, full } = rangeState;

  const tokenIds = useMemo(() => [pool.token_x, pool.token_y], [pool.token_x, pool.token_y]);
  const spendable = useSpendable(tokenIds);
  const side = rangeSide(range.left, range.right, current);
  // If the range is one-sided, only that token can be entered.
  const source = side === 'x' ? 'x' : side === 'y' ? 'y' : lastEdited;
  useEffect(() => {
    if (side !== 'both') setLastEdited(side);
  }, [side]);

  const bins = useMemo(
    () => buildBins({ left: range.left, right: range.right, current, pointDelta: pool.point_delta, strategy }),
    [range.left, range.right, current, pool.point_delta, strategy]
  );
  const sourceToken = source === 'x' ? x : y;
  const sourceRaw = tryParseUnits(inputs[source], sourceToken.decimals) || '0';
  const plan = useMemo(() => planBins({ bins, current, from: source, amount: Number(sourceRaw) }), [bins, current, source, sourceRaw]);

  // Zap In: the unit shape (amount-independent) decides how the single input is split.
  const unitPlan = useMemo(() => planBins({ bins, current, from: 'x', amount: 0 }), [bins, current]);
  const zapRaw = tryParseUnits(zapText, zapToken.decimals) || '0';
  const zapSpendable = useZapSpendable(zapToken);
  const shapeKey = `${range.left}:${range.right}:${strategy}`;
  const zapQuote = useZapQuote({
    enabled: mode === 'zap',
    token: zapToken,
    amountRaw: zapRaw,
    x,
    y,
    pool,
    unitPlan,
    shapeKey,
    slippage,
    accountId
  });
  const zapStale = mode === 'zap' && (zapQuote.loading || (zapQuote.data && zapQuote.data.legX && toBigInt(zapRaw) !== toBigInt(zapQuote.data.legX.amountIn) + toBigInt(zapQuote.data.legY.amountIn)));

  const rawX = source === 'x' ? sourceRaw : plan.bins.reduce((s, b) => s + BigInt(Math.floor(b.amountX)), 0n).toString();
  const rawY = source === 'y' ? sourceRaw : plan.bins.reduce((s, b) => s + BigInt(Math.floor(b.amountY)), 0n).toString();
  const shownX = source === 'x' ? inputs.x : toBigInt(rawX) > 0n ? trimDecimals(formatUnits(rawX, x.decimals)) : '';
  const shownY = source === 'y' ? inputs.y : toBigInt(rawY) > 0n ? trimDecimals(formatUnits(rawY, y.decimals)) : '';

  const wrapFor = (tokenId, raw) =>
    tokenId === CONTRACTS.wrapNear ? maxBig(0n, toBigInt(raw) - toBigInt(balances[CONTRACTS.wrapNear] || '0')).toString() : '0';
  const wrapX = wrapFor(pool.token_x, rawX);
  const wrapY = wrapFor(pool.token_y, rawY);

  const storage = useAsync(() => view(CONTRACTS.dcl, 'get_user_storage_detail', { user_id: accountId }), [accountId], {
    enabled: Boolean(accountId)
  });
  const zapMode = mode === 'zap';
  const activePlan = zapMode && zapQuote.data ? zapQuote.data.plan : plan;
  const positionsCount = activePlan.bins.filter((b) => b.amountX >= 1 || b.amountY >= 1).length || bins.length;
  const hasAmount = zapMode ? toBigInt(zapRaw) > 0n : toBigInt(rawX) > 0n || toBigInt(rawY) > 0n;
  const short = zapMode
    ? toBigInt(zapRaw) > zapSpendable
      ? `Insufficient ${zapToken.symbol}`
      : null
    : toBigInt(rawX) > spendable[0]
      ? `Insufficient ${x.symbol}`
      : toBigInt(rawY) > spendable[1]
        ? `Insufficient ${y.symbol}`
        : null;

  const setAmount = (which, text) => {
    const clean = text.replace(',', '.');
    if (!/^\d*\.?\d*$/.test(clean)) return;
    setLastEdited(which);
    setInputs((v) => ({ ...v, [which]: clean }));
  };
  const setFraction = (which, fraction) => {
    const index = which === 'x' ? 0 : 1;
    const token = which === 'x' ? x : y;
    const raw = (spendable[index] * BigInt(Math.round(fraction * 100))) / 100n;
    setAmount(which, trimDecimals(formatUnits(raw.toString(), token.decimals)));
  };

  const submit = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const ok = zapMode
      ? await execute(
          async () => {
            // Always execute a fresh, user-bound quote.
            const zap = await quoteZap({ inputToken: zapToken, amountIn: zapRaw, x, y, pool, unitPlan, slippage, user: accountId });
            return buildZapTransactions({ zap, inputToken: zapToken, x, y, pool, slippage, accountId });
          },
          { pending: `Zapping ${zapToken.symbol} into ${x.symbol}/${y.symbol}`, success: 'Zap complete — position created' }
        )
      : await execute(() => buildDclBinsTransactions({ pool, plan, slippage, accountId, wrapX, wrapY }), {
          pending: `Creating ${positionsCount} position${positionsCount === 1 ? '' : 's'}`,
          success: 'Liquidity added'
        });
    setSubmitting(false);
    if (ok) {
      setInputs({ x: '', y: '' });
      setZapText('');
      onDone?.();
    }
  };

  const amountRow = (which, token, value, index) => {
    const disabled = (which === 'x' && side === 'y') || (which === 'y' && side === 'x');
    return (
      <div className={`amount-row ${disabled ? 'amount-row--disabled' : ''}`}>
        <div className="amount-row__token">
          <TokenIcon token={token} size={26} />
          <div>
            <strong>{token.symbol}</strong>
            {accountId && (
              <small>
                {formatRawAmount(spendable[index].toString(), token.decimals)}
                {!disabled && (
                  <>
                    <button type="button" onClick={() => setFraction(which, 0.5)}>
                      50%
                    </button>
                    <button type="button" onClick={() => setFraction(which, 1)}>
                      MAX
                    </button>
                  </>
                )}
              </small>
            )}
          </div>
        </div>
        <input
          inputMode="decimal"
          placeholder={disabled ? 'Not needed' : '0.0'}
          disabled={disabled}
          value={disabled ? '' : value}
          onChange={(e) => setAmount(which, e.target.value)}
        />
      </div>
    );
  };

  const strategyInfo = STRATEGIES.find((s) => s.key === strategy);
  let label = 'Create position';
  if (!accountId) label = 'Connect wallet';
  else if (!hasAmount) label = 'Enter an amount';
  else if (short) label = short;
  else if (zapMode && zapQuote.error) label = 'No route for this zap';
  else if (zapMode && zapStale) label = 'Finding best split…';
  else if (zapMode) label = `Zap in ${zapToken.symbol}`;
  const blocked = zapMode && (Boolean(zapQuote.error) || zapStale || !zapQuote.data);

  return (
    <div className="create-pos">
      <section>
        <div className="create-pos__head">
          <h3>Amount</h3>
          <div className="segmented">
            <button type="button" className={!zapMode ? 'active' : ''} onClick={() => setMode('dual')}>
              Dual tokens
            </button>
            <button type="button" className={zapMode ? 'active' : ''} onClick={() => setMode('zap')}>
              ⚡ Zap in
            </button>
          </div>
        </div>
        {zapMode ? (
          <>
            <ZapInput token={zapToken} setToken={setZapToken} text={zapText} setText={setZapText} spendable={zapSpendable} x={x} y={y} />
            <p className="liq-hint">
              Deposit a single token — KINU swaps the right share into {x.symbol}/{y.symbol} and opens the position in one
              wallet request.
            </p>
          </>
        ) : (
          <>
            {amountRow('x', x, shownX, 0)}
            {amountRow('y', y, shownY, 1)}
            <p className="liq-hint">Auto-fill keeps both sides in the right ratio.</p>
          </>
        )}
      </section>

      <section>
        <div className="create-pos__head">
          <h3>Strategy</h3>
        </div>
        <div className="strategy">
          {STRATEGIES.map((s) => (
            <button key={s.key} type="button" className={strategy === s.key ? 'active' : ''} onClick={() => setStrategy(s.key)}>
              <StrategyIcon kind={s.key} />
              {s.label}
            </button>
          ))}
        </div>
        <p className="liq-hint">{strategyInfo.hint}</p>
      </section>

      <section>
        <div className="create-pos__head">
          <h3>Price range</h3>
          <span className="muted small">
            {y.symbol} per {x.symbol}
          </span>
        </div>
        <DepthHistogram pool={pool} x={x} y={y} rangeState={rangeState} plan={hasAmount ? activePlan : { bins: activePlan.bins }} />
        <div className="segmented segmented--full">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className={rangeState.preset === p.key ? 'active' : ''} onClick={() => rangeState.setPreset(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="price-edges">
          <PriceEdge
            label="Min price"
            side="min"
            price={rangeState.minPrice}
            current={rangeState.currentPrice}
            disabled={full}
            onCommit={(price) => rangeState.setEdge('min', { price })}
            onNudge={(n) => rangeState.nudge('min', n)}
          />
          <PriceEdge
            label="Max price"
            side="max"
            price={rangeState.maxPrice}
            current={rangeState.currentPrice}
            disabled={full}
            onCommit={(price) => rangeState.setEdge('max', { price })}
            onNudge={(n) => rangeState.nudge('max', n)}
          />
        </div>
        {side !== 'both' && (
          <p className="liq-hint warn">
            Range is {side === 'x' ? 'above' : 'below'} the current price — only {side === 'x' ? x.symbol : y.symbol} is deposited. It
            starts earning once the price enters the range.
          </p>
        )}
      </section>

      {zapMode && hasAmount && (
        <ZapBreakdown zap={zapQuote.data} loading={zapQuote.loading} error={zapQuote.error} token={zapToken} x={x} y={y} />
      )}

      <dl className="kv create-pos__summary">
        <div>
          <dt>Positions created</dt>
          <dd>
            {positionsCount} · {Math.round((range.right - range.left) / pool.point_delta)} ticks
          </dd>
        </div>
        <div>
          <dt>Range width</dt>
          <dd>
            {full ? 'Full range' : `${formatPercent((rangeState.maxPrice / rangeState.minPrice - 1) * 100, 1)}`}
          </dd>
        </div>
        <div>
          <dt>Fee tier</dt>
          <dd>{formatPercent(pool.fee / 10000, 2)}</dd>
        </div>
        {!zapMode && accountId && toBigInt(wrapX) + toBigInt(wrapY) > 0n && (
          <div>
            <dt>NEAR to wrap</dt>
            <dd>{formatRawAmount((toBigInt(wrapX) + toBigInt(wrapY)).toString(), 24)} NEAR</dd>
          </div>
        )}
        {accountId && storage.data === null && (
          <div>
            <dt>One-time CLMM registration</dt>
            <dd>0.5 NEAR</dd>
          </div>
        )}
        <div>
          <dt>Max slippage</dt>
          <dd>{slippage}%</dd>
        </div>
      </dl>

      <button
        type="button"
        className="button button--primary button--block button--lg"
        disabled={(accountId && (!hasAmount || Boolean(short) || blocked)) || submitting}
        onClick={submit}
      >
        {submitting && <Spinner size={14} />}
        {submitting ? 'Confirm in wallet…' : label}
      </button>
    </div>
  );
}

function StrategyIcon({ kind }) {
  const heights = kind === 'curve' ? [3, 6, 10, 14, 10, 6, 3] : kind === 'bidask' ? [14, 10, 6, 3, 6, 10, 14] : [9, 9, 9, 9, 9, 9, 9];
  return (
    <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden="true">
      {heights.map((h, i) => (
        <rect key={i} x={i * 4} y={14 - h} width="3" height={h} rx="0.5" fill="currentColor" />
      ))}
    </svg>
  );
}
