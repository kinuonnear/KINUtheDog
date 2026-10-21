// Pro price chart for the CLMM workspace (Meteora / TradingView-style):
//   · drawing tools (trend, horizontal, rectangle, fib, measure) with magnet,
//     hide and delete — stored per pool
//   · indicators (MA 20 / 50, EMA 20, Bollinger, volume), candles / line
//   · Price (token Y) ⇄ USD units, timeframes 1m–1W, OHLC legend, High / Low
//   · draggable Min / Max range lines + optional bin (tick) lines
//   · screenshot and fullscreen

import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts';
import { useAsync, useClickOutside, useLocalStorage } from '../hooks.js';
import { fetchOhlc, fetchPairOhlc, fetchTokenInfo, intearTokenId, RESOLUTIONS } from '../lib/intear.js';
import { fetchMarketCandles, fetchMarketPair, subscribeCandles } from '../lib/intearApi.js';
import { fetchPoolOhlc } from '../lib/gecko.js';
import { CHART_BARS, lastGood, sameCandles, useBarClock, useOlderCandles, withOlder } from '../lib/candles.js';
import { useApp } from '../state.jsx';
import { priceOf } from '../lib/tokens.js';
import { bollinger, ema, INDICATORS, sma } from '../lib/indicators.js';
import { getMarketDepth, pointToPrice } from '../lib/dclLiquidity.js';
import { buildDepth, DEPTH_OVERLAY } from '../lib/poolDepth.js';
import { formatChartPrice, formatPercent, formatUsd } from '../lib/format.js';
import { drawAll, hitTest, TOOLS } from './chart/drawings.js';
import { DrawingToolbar, ToolIcon, useDrawingKeys } from './chart/DrawingTools.jsx';
import ChartFooter, { applyScale, showRange, useAutoScale } from './chart/ChartFooter.jsx';
import { Spinner, TokenIcon } from './ui.jsx';

const UP = '#22e283';
const DOWN = '#ff5d6c';
const MAX_BIN_LINES = 80;
// Market candles load deeper than pool ones (Intear gives up to 5,000 per request).
const MARKET_BARS = 3000;

/** Flat placeholder candles so the range can still be dragged when a pair has no history. */
function placeholderCandles(price, step) {
  const now = Math.floor(Date.now() / 1000 / step) * step;
  return Array.from({ length: 60 }, (_, i) => ({ time: now - (59 - i) * step, open: price, high: price, low: price, close: price, volume: 0 }));
}

const pct = (price, current) => {
  if (!current) return '';
  const p = (price / current - 1) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
};

function IndicatorMenu({ active, toggle }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const count = active.filter((k) => k !== 'volume').length;
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className={`ctool ${count ? 'ctool--on' : ''}`} onClick={() => setOpen((v) => !v)}>
        <i className="fx">fx</i> <span className="ctool__label">Indicators</span> {count > 0 && <b>{count}</b>}
      </button>
      {open && (
        <div className="popover popover--left indicator-menu">
          {INDICATORS.map((ind) => (
            <label key={ind.key}>
              <input type="checkbox" checked={active.includes(ind.key)} onChange={() => toggle(ind.key)} />
              <i style={{ background: ind.color }} />
              {ind.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * @param minPrice / maxPrice  range in pair units (token Y per token X)
 * @param onDrag(side, price)   'min' | 'max', pair units
 * @param bins                  { left, right, pointDelta } points, for bin lines
 */
const SKY = '94,200,255';

/** Your positions: one band per bin (bright when earning), plus dashed min / max lines with labels. */
function paintMine(ctx, mine, toY, width, height, cur, f, ySymbol) {
  const clampY = (v) => Math.min(height, Math.max(0, v));
  ctx.save();
  mine.forEach((m) => {
    const a = toY(m.max);
    const b = toY(m.min);
    if (a === null && b === null) return;
    const top = clampY(Math.min(a ?? 0, b ?? height));
    const bottom = clampY(Math.max(a ?? 0, b ?? height));
    if (bottom - top < 0.5) return;
    ctx.fillStyle = m.inRange ? `rgba(${SKY},0.16)` : `rgba(${SKY},0.06)`;
    ctx.fillRect(0, top, width, bottom - top);
    ctx.strokeStyle = `rgba(${SKY},${m.inRange ? 0.45 : 0.2})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, Math.round(top) + 0.5, width - 1, Math.max(0, Math.round(bottom - top) - 1));
  });
  const lo = Math.min(...mine.map((m) => m.min));
  const hi = Math.max(...mine.map((m) => m.max));
  ctx.font = '600 11px Inter, ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  [
    [hi, 'Your max'],
    [lo, 'Your min']
  ].forEach(([price, label]) => {
    const raw = toY(price);
    const off = raw === null || raw < 0 || raw > height;
    const yy = raw === null ? (price > cur ? 8 : height - 8) : Math.min(height - 8, Math.max(8, raw));
    if (!off) {
      ctx.strokeStyle = `rgb(${SKY})`;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yy) + 0.5);
      ctx.lineTo(width, Math.round(yy) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const change = cur ? `${price >= cur ? '+' : ''}${((price / cur - 1) * 100).toFixed(2)}%` : '';
    // Always in the pool's units (token Y); the USD view adds the dollar price.
    const value = f === 1 ? `${formatChartPrice(price)} ${ySymbol}` : `${formatChartPrice(price)} ${ySymbol} · ${formatChartPrice(price * f)}`;
    const text = `${off ? (price > cur ? '▲ ' : '▼ ') : ''}${label} ${value} (${change})`;
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = `rgba(${SKY},0.92)`;
    // Labels sit in the middle so they clear the legend (top-left) and the Min/Max tags (right).
    // On a narrow (phone) chart there is no middle: they go right, against the price axis.
    const left =
      width < 520 ? Math.round(Math.max(8, width - w - 72)) : Math.round(Math.max(8, Math.min(width * 0.34, width - w - 120)));
    ctx.fillRect(left, yy - 10, w, 20);
    ctx.fillStyle = '#04121a';
    ctx.fillText(text, left + 7, yy);
  });
  ctx.restore();
}

/**
 * mine: the user's own positions to show on the chart, [{ min, max, inRange }] in pair price
 * hideRange: hide the new-position range (lines, band, bin lines) while a position is shown
 * (null to hide). The price scale widens to fit them.
 */
// The price axis: no labels below zero (scale margin under a price near 0) and "0" for dust, not
// "0.0000000000".
const axisPrice = (value) => (value < 0 ? '' : value < 1e-12 ? '0' : formatChartPrice(value));

/**
 * The pool's liquidity by price, as bars against the chart's right edge (like Meteora / Rhea): above
 * the current price in the colour of the base token's side, below it in the quote token's, the same
 * colours as the Price range chart in the position form. Bars are scaled to the largest one on screen.
 */
// The chart's original tones: above the price (resistance) violet, below it (support) cyan.
// Limit orders stack on the pool liquidity in a stronger tint of the same colour.
const DEPTH_FILL = {
  above: { liquidity: 'rgba(139, 124, 246, 0.34)', orders: 'rgba(139, 124, 246, 0.75)' },
  below: { liquidity: 'rgba(56, 198, 224, 0.34)', orders: 'rgba(56, 198, 224, 0.75)' }
};

/** Side overlay: 1% buckets of { lo, hi, liquidity, orders, above } as bars growing from the right edge. */
function paintDepth(ctx, bars, priceToY, width, height) {
  if (!bars?.length || !(width > 0) || !(height > 0)) return;
  const shown = [];
  for (const b of bars) {
    const top = priceToY(b.hi);
    const bottom = priceToY(b.lo);
    if (top === null || bottom === null) continue;
    const y0 = Math.max(0, Math.min(top, bottom));
    const y1 = Math.min(height, Math.max(top, bottom));
    if (y1 <= 0 || y0 >= height || y1 - y0 < 0.5) continue;
    shown.push({ ...b, y0, y1 });
  }
  if (!shown.length) return;
  const max = Math.max(...shown.map((b) => b.liquidity + b.orders)) || 1;
  const reach = width * 0.3;
  ctx.save();
  for (const b of shown) {
    const fill = b.above ? DEPTH_FILL.above : DEPTH_FILL.below;
    const wl = (b.liquidity / max) * reach;
    const wo = (b.orders / max) * reach;
    // Snap to whole pixels: fractional edges leave hairline seams between neighbouring buckets.
    const top = Math.floor(b.y0);
    const h = Math.max(1, Math.ceil(b.y1) - top);
    if (wl > 0) {
      ctx.fillStyle = fill.liquidity;
      ctx.fillRect(width - wl, top, Math.max(1.5, wl), h);
    }
    if (wo > 0) {
      ctx.fillStyle = fill.orders;
      ctx.fillRect(width - wl - wo, top, Math.max(1.5, wo), h);
    }
  }
  ctx.restore();
}

export default function RangeChart({ poolId, x: xPool, y: yPool, currentPrice: currentPool, minPrice: minPool, maxPrice: maxPool, fullRange, onDrag: onDragPool, bins, mine: minePool = null, hideRange = false, flip = false }) {
  // flip: chart the pool's other token. A pool's price is token Y per token X; when X is the quote
  // (USDC / NEAR: USDC/QTC reads in QTC per USDC) that runs against the asset's own price. Flipped,
  // X and Y swap roles (candles, units and labels follow) and every price crossing this component's
  // edge is mirrored: price -> 1/price, the range's min and max trade places.
  const inv = (v) => (v > 0 && Number.isFinite(v) ? 1 / v : v);
  const x = flip ? yPool : xPool;
  const y = flip ? xPool : yPool;
  const currentPrice = flip ? inv(currentPool) : currentPool;
  const minPrice = flip ? inv(maxPool) : minPool;
  const maxPrice = flip ? inv(minPool) : maxPool;
  const onDrag = flip ? (side, price, final) => onDragPool(side === 'min' ? 'max' : 'min', inv(price), final) : onDragPool;
  const mine = useMemo(() => (flip && minePool ? minePool.map((m) => ({ ...m, min: inv(m.max), max: inv(m.min) })) : minePool), [flip, minePool]);
  // A point on the pool's tick grid as a price on this chart's axis.
  const pointAxisPrice = (point) => (flip ? inv(pointToPrice(point, xPool.decimals, yPool.decimals)) : pointToPrice(point, xPool.decimals, yPool.decimals));
  const [resolution, setResolution] = useLocalStorage('kinu.range.resolution', '60');
  const [unit, setUnit] = useLocalStorage('kinu.range.unit', 'pair'); // 'pair' | 'usd'
  const [chartType, setChartType] = useLocalStorage('kinu.range.type', 'candles');
  const [indicators, setIndicators] = useLocalStorage('kinu.range.indicators', ['volume']);
  const [showBins, setShowBins] = useLocalStorage('kinu.range.bins', false);
  const [scale, setScale] = useLocalStorage('kinu.range.scale', 'normal'); // 'normal' | 'log' | 'pct'
  const [tool, setTool] = useState('cursor');
  const [magnet, setMagnet] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState(null);
  const [legend, setLegend] = useState(null);
  const [drawings, setDrawings] = useLocalStorage(`kinu.draw.${poolId}${flip ? '.inv' : ''}.${unit}`, []);

  const cardRef = useRef(null);
  const containerRef = useRef(null);
  const overlayRef = useRef(null);
  const canvasRef = useRef(null);
  const paintRef = useRef(null);
  const pendingRef = useRef(null);
  const chartApi = useRef(null);
  const live = useRef({});

  const step = RESOLUTIONS.find((r) => r.key === resolution)?.seconds || 3600;
  const xId = intearTokenId(x);
  const yId = intearTokenId(y);

  const info = useAsync(() => fetchTokenInfo(xId), [xId], { refreshMs: 30_000 });
  // Dollars per token Y (the app's live prices): the USD view converts the pair price with it.
  const { prices } = useApp();
  const yUsd = priceOf(prices, y.id) || 0;
  const WNEAR = 'wrap.near';
  // Market candles come live from Intear when they are a single series (USD, or priced in NEAR).
  const marketLive = unit === 'usd' || yId === WNEAR;
  // 'pool': this pool's own trades (GeckoTerminal); 'market': the token's price across pools (Intear).
  // A pool with no trades yet falls back to the market candles.
  const [source, setSource] = useLocalStorage('kinu.range.source', 'pool');
  // Intear API first (deeper history); the older price feed if it is down.
  const marketCandles = () =>
    unit === 'usd'
      ? fetchMarketCandles({ tokenId: xId, resolution, quote: 'usd', countBack: MARKET_BARS }).catch(() => fetchOhlc({ tokenId: xId, resolution, countBack: CHART_BARS }))
      : fetchMarketPair({ tokenX: xId, tokenY: yId, resolution, countBack: MARKET_BARS }).catch(() => fetchPairOhlc({ tokenX: xId, tokenY: yId, resolution, countBack: CHART_BARS }));
  const lastGoodRef = useRef(null);
  const viewOf = `${xId}|${yId}|${resolution}|${unit}|${source}|${poolId}`;
  const loaded = useAsync(
    async () => {
      const memo = lastGood(lastGoodRef, viewOf);
      const keep = (value) =>
        memo.keep({ ...value, view: viewOf }, (a, b) => a.from === b.from && a.fallback === b.fallback && sameCandles(a.data, b.data));
      if (source === 'pool' && poolId) {
        const usd = unit === 'usd';
        const [pool, xInfo] = await Promise.all([
          fetchPoolOhlc({ poolId, tokenId: x.id, resolution, usd, countBack: CHART_BARS }).catch(() => null),
          usd ? null : fetchTokenInfo(xId).catch(() => null)
        ]);
        if (pool?.trades > 0) {
          // In pair view Gecko reports volume in the other token: shown in USD at its current price.
          const lastPair = pool.candles[pool.candles.length - 1]?.close;
          const yUsd = !usd && xInfo?.price && lastPair ? xInfo.price / lastPair : null;
          const data = usd ? pool.candles : pool.candles.map((c) => ({ ...c, volume: yUsd ? c.volume * yUsd : 0 }));
          return keep({ from: 'pool', data, volFactor: usd ? 1 : yUsd || 0 });
        }
        // GeckoTerminal busy for a moment: keep this pool's candles rather than switching sources.
        const prev = memo.previous();
        if (!pool && prev?.from === 'pool') return prev;
        return keep({ from: 'market', fallback: pool ? 'empty' : 'error', data: await marketCandles() });
      }
      return keep({ from: 'market', data: await marketCandles() });
    },
    [xId, yId, resolution, unit, source, poolId],
    { refreshMs: 60_000 }
  );
  // Only candles of the pool, unit and timeframe on screen: while another loads (switching pool,
  // Price ⇄ USD or timeframe) the old ones would put the range lines at wrong prices.
  const current = loaded.data?.view === viewOf ? loaded.data : undefined;
  // History before the first candle, loaded as the view reaches it (same source as the candles).
  const history = useOlderCandles(`${viewOf}|${current?.from}`, async (firstTime) => {
    if (!current) return [];
    if (current.from === 'pool') {
      if (resolution === '1W') return [];
      const page = await fetchPoolOhlc({ poolId, tokenId: x.id, resolution, usd: unit === 'usd', countBack: 1000, before: firstTime });
      const f = current.volFactor ?? 1;
      return page.candles.map((c) => ({ ...c, volume: c.volume * f }));
    }
    const toMillis = firstTime * 1000 - 1;
    const page = await (unit === 'usd'
      ? fetchMarketCandles({ tokenId: xId, resolution, quote: 'usd', countBack: MARKET_BARS, toMillis })
      : fetchMarketPair({ tokenX: xId, tokenY: yId, resolution, countBack: MARKET_BARS, toMillis }));
    if (page.length || resolution === '1W' || !poolId) return page;
    // Intear's history starts in August 2026: further back, this pool's own candles carry on.
    const usd = unit === 'usd';
    const older = await fetchPoolOhlc({ poolId, tokenId: x.id, resolution, usd, countBack: 1000, before: firstTime });
    return usd ? older.candles : older.candles.map((c) => ({ ...c, volume: yUsd ? c.volume * yUsd : 0 }));
  });
  const merged = useMemo(() => (current?.data ? withOlder(history.older, current.data, step) : undefined), [current, history.older, step]);
  const candles = { ...loaded, data: merged };
  const fromPool = current?.from === 'pool';
  const noHistory = candles.data && candles.data.length < 2;
  // This pool's price against the market candles' latest close (%), e.g. -2.7 = pool below market.
  // Pair view only: the USD view converts the pool price with that same close.
  const lastClose = !noHistory ? candles.data?.[candles.data.length - 1]?.close : null;
  const poolGap = !fromPool && unit !== 'usd' && lastClose && currentPrice ? (currentPrice / lastClose - 1) * 100 : null;
  // The user's chart view, carried across rebuilds of the same pair / resolution / unit / source.
  const viewRef = useRef(null);
  const viewKey = `${xId}|${yId}|${resolution}|${unit}|${current?.from}`;

  // Pair -> display units. In USD mode the range is shown as token X's USD price.
  const usdFactor = useMemo(() => {
    if (unit !== 'usd' || !currentPrice) return 1;
    if (yUsd > 0) return yUsd;
    const last = candles.data?.[candles.data.length - 1]?.close;
    if (last) return last / currentPrice;
    return info.data?.price ? info.data.price / currentPrice : 1;
  }, [unit, candles.data, currentPrice, info.data, yUsd]);

  const binPrices = useMemo(() => {
    if (!showBins || !bins || fullRange) return [];
    const count = Math.round((bins.right - bins.left) / bins.pointDelta);
    const every = Math.max(1, Math.ceil(count / MAX_BIN_LINES));
    const out = [];
    for (let p = bins.left; p <= bins.right; p += bins.pointDelta * every) out.push(pointAxisPrice(p));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBins, bins, fullRange, xPool.decimals, yPool.decimals, flip]);

  const depth = useAsync(() => getMarketDepth(poolId), [poolId], { refreshMs: 60_000 });
  // 1% price buckets (lib/poolDepth.js): pool liquidity plus open limit orders, valued in token Y so
  // the bar lengths compare with each other. Same source as the pool page's Depth tab.
  const depthBars = useMemo(() => {
    if (!depth.data || !Number.isFinite(depth.data.current)) return [];
    const { rows } = buildDepth({
      depth: depth.data,
      decimalsX: xPool.decimals,
      decimalsY: yPool.decimals,
      valueX: pointToPrice(depth.data.current, xPool.decimals, yPool.decimals),
      valueY: 1,
      view: DEPTH_OVERLAY
    });
    // Flipped, the axis runs the other way: a bucket's low and high trade places, and what sat above
    // the pool's price is now below the chart's.
    return rows
      .filter((r) => r.total > 0)
      .map((r) => ({
        lo: flip ? pointAxisPrice(r.hiPoint) : pointAxisPrice(r.loPoint),
        hi: flip ? pointAxisPrice(r.loPoint) : pointAxisPrice(r.hiPoint),
        liquidity: r.liquidity,
        orders: r.orders,
        above: flip ? r.side === 'support' : r.side === 'resistance'
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth.data, xPool.decimals, yPool.decimals, flip]);
  useEffect(() => {
    requestAnimationFrame(() => paintRef.current?.());
  }, [depthBars]);
  live.current = { depthBars, scale, requestOlder: history.request, ySymbol: y.symbol, minPrice, maxPrice, currentPrice, fullRange, onDrag, usdFactor, drawings, selected, hidden, tool, magnet, binPrices, mine, hideRange, setDrawings, setSelected, setTool };

  useEffect(() => {
    paintRef.current?.();
    // A new live price can move the auto-scaled axis on the chart's next frame: paint once more then.
    const frame = requestAnimationFrame(() => paintRef.current?.());
    return () => cancelAnimationFrame(frame);
  }, [minPrice, maxPrice, fullRange, drawings, selected, hidden, binPrices, currentPrice, hideRange]);

  // Showing / hiding your positions re-fits the price scale around them.
  const mineKey = mine ? mine.map((m) => `${m.min}:${m.max}`).join(',') : '';
  useEffect(() => {
    chartApi.current?.chart.priceScale('right').applyOptions({ autoScale: true });
    paintRef.current?.();
    // The chart applies the re-fitted scale on its next frame; paint again once it has, or the
    // lines stay at the old scale until the pointer moves over the chart.
    let second = null;
    const first = requestAnimationFrame(() => {
      paintRef.current?.();
      second = requestAnimationFrame(() => paintRef.current?.());
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== null) cancelAnimationFrame(second);
    };
  }, [mineKey]);

  // Pool candles: the latest bar follows the pool's on-chain price between refreshes (a pool's
  // price only moves when it trades, so this is the bar the next trade data will confirm).
  const liveBarRef = useRef(null); // { series, volume, bar, line }
  // The latest bar as drawn (live pool price or pushed market candle), for the legend.
  const [tick, setTick] = useState(null);
  useEffect(() => setTick(null), [viewOf]);
  useEffect(() => {
    const bar0 = liveBarRef.current;
    if (!bar0 || !fromPool || unit !== 'pair' || !currentPrice) return;
    const t = Math.floor(Date.now() / 1000 / step) * step;
    const prev = bar0.bar;
    const bar =
      t > prev.time
        ? { time: t, open: prev.close, high: Math.max(prev.close, currentPrice), low: Math.min(prev.close, currentPrice), close: currentPrice }
        : { ...prev, high: Math.max(prev.high, currentPrice), low: Math.min(prev.low, currentPrice), close: currentPrice };
    bar0.series.update(bar0.line ? { time: bar.time, value: bar.close } : { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    bar0.bar = { ...bar, volume: bar.time === prev.time ? prev.volume || 0 : 0 };
    setTick(bar0.bar);
  }, [currentPrice, fromPool, unit, step]);

  // Market candles stay live: Intear pushes the latest candle after every block that moved it.
  const marketOn = Boolean(current) && !fromPool && marketLive;
  const liveQuote = unit === 'usd' ? 'usd' : 'near';
  useEffect(() => {
    if (!marketOn || !xId) return undefined;
    return subscribeCandles(
      { tokenIds: [xId], resolution, quote: liveQuote },
      (byToken) => {
        const bar0 = liveBarRef.current;
        const bars = byToken[xId];
        if (!bar0 || !bars?.length) return;
        bars.forEach((c) => {
          if (c.time < bar0.bar.time) return; // the chart can only update its latest bar
          try {
            bar0.series.update(bar0.line ? { time: c.time, value: c.close } : { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
            bar0.volume?.update({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(34,226,131,0.25)' : 'rgba(255,93,108,0.25)' });
            bar0.bar = c;
            setTick(c);
          } catch {
            // the chart was rebuilt meanwhile
          }
        });
      },
      () => loaded.reload()
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketOn, xId, resolution, liveQuote]);
  // A new bar opens when its time bucket starts, not at the next refresh.
  useBarClock(liveBarRef, step);

  useDrawingKeys(live, pendingRef, paintRef);

  useEffect(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!container || !overlay || !canvas || !candles.data || !live.current.currentPrice) return undefined;
    const startPrice = live.current.currentPrice * live.current.usdFactor;
    // Pool candles price each trade at its execution rate (fee and impact included); the latest
    // bar closes at the pool's actual on-chain price, so candles and the price line agree.
    const withTail = (bars) => {
      if (!(fromPool && unit === 'pair' && !noHistory)) return bars;
      const last = bars[bars.length - 1];
      const now = Math.floor(Date.now() / 1000 / step) * step;
      const cp = live.current.currentPrice;
      const tail =
        now > last.time
          ? [last, { time: now, open: last.close, high: Math.max(last.close, cp), low: Math.min(last.close, cp), close: cp, volume: 0 }]
          : [{ ...last, high: Math.max(last.high, cp), low: Math.min(last.low, cp), close: cp }];
      return [...bars.slice(0, -1), ...tail];
    };
    // `data`, `times` and `lastIdx` change in place when new candles arrive (setDataAll below).
    let data = withTail(noHistory ? placeholderCandles(startPrice, step) : candles.data);

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: 'rgba(226, 234, 245, 0.5)',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 11,
        attributionLogo: false
      },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.1, bottom: indicators.includes('volume') ? 0.2 : 0.08 } },
      // Free zoom and scroll, as on TradingView: scrolling past the first candle loads older history.
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false, rightOffset: 8 },
      crosshair: { mode: 0 },
      localization: { priceFormatter: axisPrice }
    });

    const autoscaleInfoProvider = (original) => {
      const res = original();
      const { minPrice: lo, maxPrice: hi, currentPrice: cur, fullRange: full, usdFactor: f } = live.current;
      if (!res || (full && !live.current.hideRange)) return res;
      const range = !full && !live.current.hideRange;
      let minValue = range && lo > cur / 20 ? Math.min(res.priceRange.minValue, lo * f) : res.priceRange.minValue;
      let maxValue = range && hi < cur * 20 ? Math.max(res.priceRange.maxValue, hi * f) : res.priceRange.maxValue;
      // Your positions (when shown) are kept in view, within a sane distance of the price.
      const own = live.current.mine;
      if (own?.length) {
        const ownLo = Math.min(...own.map((m) => m.min));
        const ownHi = Math.max(...own.map((m) => m.max));
        if (ownLo > cur / 50) minValue = Math.min(minValue, ownLo * f);
        if (ownHi < cur * 50) maxValue = Math.max(maxValue, ownHi * f);
      }
      return { ...res, priceRange: { minValue: Math.max(0, minValue), maxValue } };
    };
    const priceFormat = { type: 'custom', formatter: axisPrice, minMove: 1e-12 };
    const main =
      chartType === 'line'
        ? chart.addSeries(LineSeries, { color: UP, lineWidth: 2, priceLineVisible: true, priceLineStyle: 2, lastValueVisible: true, priceFormat, autoscaleInfoProvider })
        : chart.addSeries(CandlestickSeries, {
            upColor: UP,
            downColor: DOWN,
            borderVisible: false,
            wickUpColor: UP,
            wickDownColor: DOWN,
            priceLineVisible: true,
            priceLineStyle: 2,
            lastValueVisible: true,
            priceFormat,
            autoscaleInfoProvider
          });
    main.setData(
      chartType === 'line'
        ? data.map((c) => ({ time: c.time, value: c.close }))
        : data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }))
    );

    liveBarRef.current = noHistory ? null : { series: main, bar: data[data.length - 1], line: chartType === 'line' };
    // No separate pool-price line: the series' own last-price line runs from the latest candle to
    // its axis label (on pool candles that is the live pool price; on market candles the legend
    // notes how far this pool is from it).

    const volData = (bars) => bars.map((c) => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(34,226,131,0.25)' : 'rgba(255,93,108,0.25)' }));
    let vol = null;
    if (indicators.includes('volume')) {
      vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      vol.setData(volData(data));
      if (liveBarRef.current) liveBarRef.current.volume = vol;
    }
    // Indicators never drive the price scale (e.g. a Bollinger band can go negative after a spike).
    const lineOpts = (color) => ({
      color,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat,
      autoscaleInfoProvider: () => null
    });
    const ind = {};
    if (indicators.includes('ma20')) ind.ma20 = chart.addSeries(LineSeries, lineOpts('#ffb547'));
    if (indicators.includes('ma50')) ind.ma50 = chart.addSeries(LineSeries, lineOpts('#5ec8ff'));
    if (indicators.includes('ema20')) ind.ema20 = chart.addSeries(LineSeries, lineOpts('#c792ff'));
    if (indicators.includes('bb')) {
      ind.bbUpper = chart.addSeries(LineSeries, lineOpts('rgba(61,220,151,0.8)'));
      ind.bbMiddle = chart.addSeries(LineSeries, { ...lineOpts('rgba(61,220,151,0.45)'), lineStyle: 2 });
      ind.bbLower = chart.addSeries(LineSeries, lineOpts('rgba(61,220,151,0.8)'));
    }
    const setIndicators = (bars) => {
      ind.ma20?.setData(sma(bars, 20));
      ind.ma50?.setData(sma(bars, 50));
      ind.ema20?.setData(ema(bars, 20));
      if (ind.bbUpper) {
        const bb = bollinger(bars, 20, 2);
        ind.bbUpper.setData(bb.upper);
        ind.bbMiddle.setData(bb.middle);
        ind.bbLower.setData(bb.lower);
      }
    };
    setIndicators(data);
    // --- time <-> x helpers (drawings live in { time, price } space) -------------
    let times = data.map((c) => c.time);
    let lastIdx = times.length - 1;
    if (!noHistory) {
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range && range.from < 3) live.current.requestOlder?.(times[0]);
      });
    }

    // Candles refresh every minute and rebuild the chart: keep the user's zoom, scroll and
    // price scale. The same bars stay in view; a view that followed the latest bar keeps following.
    const saved = viewRef.current;
    if (saved && saved.key === viewKey && saved.range) {
      const firstAt = times.indexOf(saved.firstTime);
      let shift = firstAt >= 0 ? firstAt : (saved.firstTime - times[0]) / step;
      if (saved.atEnd) shift += lastIdx - (saved.lastIdx + shift);
      const restored = { from: saved.range.from + shift, to: saved.range.to + shift };
      chart.timeScale().setVisibleLogicalRange(restored);
      // autoSize measures the new chart a moment later, which would move a view scrolled far back to
      // the latest candles: set it again once the chart has its size.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          try {
            chart.timeScale().setVisibleLogicalRange(restored);
          } catch {
            // the chart was removed meanwhile
          }
        })
      );
      if (saved.price) {
        chart.priceScale('right').applyOptions({ autoScale: false });
        chart.priceScale('right').setVisibleRange(saved.price);
      }
    } else {
      // At least 60 bar slots, so a short history (e.g. a new pool) doesn't stretch into huge bars.
      chart.timeScale().setVisibleLogicalRange({ from: Math.min(Math.max(0, data.length - 140), data.length - 60), to: data.length + 8 });
    }
    const saveView = () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      const scale = chart.priceScale('right');
      viewRef.current = {
        key: viewKey,
        range: range ? { from: range.from, to: range.to } : null,
        firstTime: times[0],
        lastIdx,
        atEnd: Boolean(range && range.to >= lastIdx),
        price: scale.options().autoScale ? null : scale.getVisibleRange()
      };
    };
    const logicalOf = (t) => {
      if (t <= times[0]) return (t - times[0]) / step;
      if (t >= times[lastIdx]) return lastIdx + (t - times[lastIdx]) / step;
      let lo = 0;
      let hi = lastIdx;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) lo = mid;
        else hi = mid;
      }
      return lo + (t - times[lo]) / Math.max(1, times[hi] - times[lo]);
    };
    const timeOf = (logical) => {
      if (logical <= 0) return times[0] + logical * step;
      if (logical >= lastIdx) return times[lastIdx] + (logical - lastIdx) * step;
      const i = Math.floor(logical);
      return times[i] + (logical - i) * (times[i + 1] - times[i]);
    };
    const geo = {
      width: 0,
      height: 0,
      timeToX: (t) => chart.timeScale().logicalToCoordinate(logicalOf(t)),
      priceToY: (p) => main.priceToCoordinate(p),
      formatPrice: formatChartPrice,
      barsBetween: (a, b) => Math.round(Math.abs(logicalOf(b) - logicalOf(a)))
    };
    const toData = (px, py) => {
      const logical = chart.timeScale().coordinateToLogical(px);
      let price = main.coordinateToPrice(py);
      const time = timeOf(logical ?? lastIdx);
      if (live.current.magnet && logical !== null) {
        const bar = data[Math.min(lastIdx, Math.max(0, Math.round(logical)))];
        const dist = (v) => Math.abs((main.priceToCoordinate(v) ?? Infinity) - py);
        const snap = [bar.open, bar.high, bar.low, bar.close].reduce((best, v) => (dist(v) < dist(best) ? v : best));
        if (dist(snap) < 14) price = snap;
      }
      return { time: Math.round(time), price };
    };

    // The Min / Max lines sit on a layer above the chart so they can be dragged; a wheel over them
    // would scroll the page instead of reaching the chart. Hand it to the chart under the pointer
    // (the same zoom / pan it gives anywhere else on the plot).
    const forwardWheel = (event) => {
      const under = document.elementsFromPoint(event.clientX, event.clientY).find((el) => container.contains(el));
      if (!under) return;
      event.preventDefault();
      event.stopPropagation();
      under.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey
        })
      );
    };
    overlay.addEventListener('wheel', forwardWheel, { passive: false });

    // --- painting -------------------------------------------------------------
    const band = overlay.querySelector('.range-chart__band');
    const lines = { min: overlay.querySelector('[data-side="min"]'), max: overlay.querySelector('[data-side="max"]') };
    const ctx = canvas.getContext('2d');
    let disposed = false; // a queued frame may fire after the chart is removed
    const paint = () => {
      if (disposed) return;
      const { minPrice: lo, maxPrice: hi, currentPrice: cur, fullRange: full, usdFactor: f } = live.current;
      const width = Math.max(0, container.clientWidth - chart.priceScale('right').width());
      const height = Math.max(0, container.clientHeight - chart.timeScale().height());
      overlay.style.width = `${width}px`;
      overlay.style.height = `${height}px`;

      const yMax = main.priceToCoordinate(hi * f);
      const yMin = main.priceToCoordinate(lo * f);
      const off = live.current.hideRange;
      const place = (el, yPos, price, text) => {
        if (yPos === null || full || off) {
          el.style.display = 'none';
          return;
        }
        el.style.display = 'block';
        el.style.top = `${Math.min(height - 1, Math.max(0, yPos))}px`;
        // Always in the form's units (token Y); the USD view adds the dollar price after it.
        const pair = `${formatChartPrice(price)} ${live.current.ySymbol}`;
        el.querySelector('span').textContent =
          f === 1 ? `${text} ${pair} (${pct(price, cur)})` : `${text} ${pair} · $${formatChartPrice(price * f)} (${pct(price, cur)})`;
      };
      place(lines.max, yMax, hi, 'Max');
      place(lines.min, yMin, lo, 'Min');
      if (off) {
        band.style.display = 'none';
      } else if (full) {
        band.style.display = 'block';
        band.style.top = '0px';
        band.style.height = '100%';
      } else if (yMax === null || yMin === null) {
        band.style.display = 'none';
      } else {
        const top = Math.max(0, Math.min(yMax, yMin));
        const bottom = Math.min(height, Math.max(yMax, yMin));
        band.style.display = 'block';
        band.style.top = `${top}px`;
        band.style.height = `${Math.max(0, bottom - top)}px`;
      }

      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      geo.width = width;
      geo.height = height;
      const pending = pendingRef.current ? [pendingRef.current] : [];
      drawAll(ctx, live.current.hidden ? pending : [...live.current.drawings, ...pending], geo, live.current.selected);
      // After drawAll (which clears the canvas): liquidity bars, then the bin lines over them.
      paintDepth(ctx, live.current.depthBars, (p) => main.priceToCoordinate(p * f), width, height);
      if (live.current.binPrices.length && !off) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,138,61,0.22)';
        ctx.lineWidth = 1;
        live.current.binPrices.forEach((p) => {
          const yy = main.priceToCoordinate(p * f);
          if (yy === null) return;
          ctx.beginPath();
          ctx.moveTo(0, Math.round(yy) + 0.5);
          ctx.lineTo(width, Math.round(yy) + 0.5);
          ctx.stroke();
        });
        ctx.restore();
      }
      if (live.current.mine?.length) paintMine(ctx, live.current.mine, (p) => main.priceToCoordinate(p * f), width, height, cur, f, live.current.ySymbol);
    };
    paintRef.current = paint;

    // Repaint on chart changes; every frame only while the pointer is over the chart.
    let frame = null;
    const loop = () => {
      paint();
      frame = requestAnimationFrame(loop);
    };
    const startLoop = () => {
      if (frame === null) frame = requestAnimationFrame(loop);
    };
    const stopLoop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      paint();
    };
    const host = container.parentElement;
    host.addEventListener('pointerenter', startLoop);
    host.addEventListener('pointerleave', stopLoop);
    chart.timeScale().subscribeVisibleLogicalRangeChange(paint);
    const resize = new ResizeObserver(() => requestAnimationFrame(paint));
    resize.observe(container);
    requestAnimationFrame(paint);

    const byTime = new Map(data.map((c) => [c.time, c]));
    chart.subscribeCrosshairMove((param) => setLegend(param?.time ? byTime.get(param.time) || null : null));

    // Cursor mode: click selects a drawing (Delete removes it).
    chart.subscribeClick((param) => {
      if (live.current.tool !== 'cursor' || !param?.point) return;
      const hit = live.current.hidden ? null : hitTest(live.current.drawings, geo, param.point.x, param.point.y);
      live.current.setSelected(hit ? hit.id : null);
    });

    // Drawing tools: the canvas captures pointer events only while a tool is active.
    const pos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    const finish = (d) => {
      live.current.setDrawings((list) => [...list, d]);
      live.current.setSelected(d.id);
      live.current.setTool('cursor');
    };
    const onCanvasDown = (e) => {
      const toolDef = TOOLS.find((t) => t.key === live.current.tool);
      if (!toolDef || toolDef.points === 0) return;
      const point = toData(...pos(e));
      if (toolDef.points === 1) {
        finish({ id: `${Date.now()}`, type: toolDef.key, points: [point] });
        return;
      }
      if (!pendingRef.current) {
        pendingRef.current = { id: `${Date.now()}`, type: toolDef.key, points: [point, point] };
      } else {
        const d = { ...pendingRef.current, points: [pendingRef.current.points[0], point] };
        pendingRef.current = null;
        finish(d);
      }
      paint();
    };
    const onCanvasMove = (e) => {
      if (!pendingRef.current) return;
      pendingRef.current = { ...pendingRef.current, points: [pendingRef.current.points[0], toData(...pos(e))] };
      paint();
    };
    canvas.addEventListener('pointerdown', onCanvasDown);
    canvas.addEventListener('pointermove', onCanvasMove);

    // Dragging a range line converts the pointer position back to a pair price.
    const cleanups = Object.entries(lines).map(([side, el]) => {
      const onDown = (event) => {
        event.preventDefault();
        el.setPointerCapture(event.pointerId);
        el.classList.add('dragging');
        const priceAt = (e) => {
          const rect = container.getBoundingClientRect();
          const p = main.coordinateToPrice(e.clientY - rect.top);
          return p && p > 0 ? p / live.current.usdFactor : null;
        };
        const onMove = (e) => {
          const p = priceAt(e);
          if (p) live.current.onDrag(side, p, false);
        };
        const onUp = (e) => {
          el.classList.remove('dragging');
          el.releasePointerCapture(e.pointerId);
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onUp);
          const p = priceAt(e);
          if (p) live.current.onDrag(side, p, true);
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
      };
      el.addEventListener('pointerdown', onDown);
      return () => el.removeEventListener('pointerdown', onDown);
    });

    // New candles (a refresh, older history) replace the data in place: the chart keeps the user's
    // zoom and scroll, which a rebuild would lose.
    const setDataAll = (bars) => {
      data = withTail(bars);
      main.setData(chartType === 'line' ? data.map((c) => ({ time: c.time, value: c.close })) : data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      vol?.setData(volData(data));
      setIndicators(data);
      times = data.map((c) => c.time);
      lastIdx = times.length - 1;
      if (liveBarRef.current) liveBarRef.current = { ...liveBarRef.current, bar: data[data.length - 1] };
      paint();
      requestAnimationFrame(paint); // again once the chart has re-fitted its scale to the new bars
    };
    chartApi.current = { chart, canvas, setDataAll };
    applyScale(chart, live.current.scale);
    return () => {
      saveView();
      liveBarRef.current = null;
      disposed = true;
      overlay.removeEventListener('wheel', forwardWheel);
      if (frame !== null) cancelAnimationFrame(frame);
      paintRef.current = null;
      chartApi.current = null;
      resize.disconnect();
      host.removeEventListener('pointerenter', startLoop);
      host.removeEventListener('pointerleave', stopLoop);
      canvas.removeEventListener('pointerdown', onCanvasDown);
      canvas.removeEventListener('pointermove', onCanvasMove);
      cleanups.forEach((fn) => fn());
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Rebuilt when the data or the display changes — not on every pool price tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(candles.data), noHistory, Boolean(currentPrice), chartType, indicators.join(','), unit, step, fromPool, viewOf]);

  // Price scale mode (% / log).
  useEffect(() => applyScale(chartApi.current?.chart, scale), [scale]);
  const auto = useAutoScale(() => chartApi.current?.chart || null, containerRef, `${viewOf}|${Boolean(candles.data)}`);

  // Candles that changed under the same chart: replaced in place (keeps zoom and scroll).
  useEffect(() => {
    if (candles.data && !noHistory) chartApi.current?.setDataAll?.(candles.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles.data]);

  const screenshot = () => {
    const api = chartApi.current;
    if (!api) return;
    const shot = api.chart.takeScreenshot();
    const out = document.createElement('canvas');
    out.width = shot.width;
    out.height = shot.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(shot, 0, 0);
    ctx.drawImage(api.canvas, 0, 0);
    const link = document.createElement('a');
    link.download = `${x.symbol}-${y.symbol}-${new Date().toISOString().slice(0, 16).replace(':', '')}.png`;
    link.href = out.toDataURL('image/png');
    link.click();
  };

  /** Toolbar zoom: factor < 1 zooms in, > 1 zooms out (anchored at the latest bar); null resets. */
  const zoom = (factor) => {
    const ts = chartApi.current?.chart.timeScale();
    if (!ts) return;
    if (factor === null) {
      ts.fitContent();
      return;
    }
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    ts.setVisibleLogicalRange({ from: range.to - (range.to - range.from) * factor, to: range.to });
  };

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else cardRef.current?.requestFullscreen?.();
  };

  const toggleIndicator = (key) => setIndicators((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  const activeTool = TOOLS.find((t) => t.key === tool);
  const lastBar = candles.data?.[candles.data.length - 1];
  // The bar the chart draws last: pool candles close at the live pool price, in a new bar once
  // its time bucket has started (see the chart build); pushed market candles replace it.
  const nowBucket = Math.floor(Date.now() / 1000 / step) * step;
  const drawn =
    lastBar && fromPool && unit === 'pair' && currentPrice
      ? nowBucket > lastBar.time
        ? { time: nowBucket, open: lastBar.close, high: Math.max(lastBar.close, currentPrice), low: Math.min(lastBar.close, currentPrice), close: currentPrice, volume: 0 }
        : { ...lastBar, high: Math.max(lastBar.high, currentPrice), low: Math.min(lastBar.low, currentPrice), close: currentPrice }
      : lastBar;
  const last = tick && drawn && tick.time >= drawn.time ? tick : drawn;
  const shown = legend || last;
  const shownChange = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : null;
  const quoteLabel = unit === 'usd' ? 'USD' : y.symbol;
  const loading = candles.loading && !candles.data;

  return (
    <div className="card range-chart pro-chart" ref={cardRef}>
      <div className="pro-chart__info">
        <TokenIcon token={x} size={20} />
        <span>
          {x.symbol} Price (USD): <b>{info.data?.price ? `$${formatChartPrice(info.data.price)}` : '—'}</b>
          {info.data?.change24h != null && (
            <em className={info.data.change24h >= 0 ? 'up' : 'down'}>
              {' '}
              {info.data.change24h >= 0 ? '+' : ''}
              {formatPercent(info.data.change24h)}
            </em>
          )}
        </span>
        <span>
          Market Cap: <b>{info.data?.circulatingSupply && info.data?.price ? formatUsd(info.data.circulatingSupply * info.data.price) : '—'}</b>
        </span>
        <span>
          {x.symbol} 24h vol (all pools): <b>{info.data ? formatUsd(info.data.volume24hUsd) : '—'}</b>
        </span>
        {info.data?.holders ? (
          <span>
            Holders: <b>{info.data.holders.toLocaleString()}</b>
          </span>
        ) : null}
      </div>

      <div className="pro-chart__toolbar">
        <select className="ctool ctool--select" value={resolution} onChange={(e) => setResolution(e.target.value)} aria-label="Timeframe">
          {RESOLUTIONS.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
        <span className="ctool-sep" />
        <IndicatorMenu active={indicators} toggle={toggleIndicator} />
        <button
          type="button"
          className="ctool"
          title={chartType === 'candles' ? 'Switch to line' : 'Switch to candles'}
          onClick={() => setChartType(chartType === 'candles' ? 'line' : 'candles')}
        >
          <ToolIcon kind={chartType === 'candles' ? 'candles' : 'line'} />
        </button>
        <span className="ctool-sep" />
        <div className="segmented segmented--tight" title="Candles from this pool's trades, or the token's market price across pools">
          <button type="button" className={source === 'pool' ? 'active' : ''} onClick={() => setSource('pool')}>
            Pool
          </button>
          <button type="button" className={source === 'market' ? 'active' : ''} onClick={() => setSource('market')}>
            Market
          </button>
        </div>
        <div className="segmented segmented--tight">
          <button type="button" className={unit === 'pair' ? 'active' : ''} onClick={() => setUnit('pair')}>
            Price
          </button>
          <button type="button" className={unit === 'usd' ? 'active' : ''} onClick={() => setUnit('usd')}>
            USD
          </button>
        </div>
        <button type="button" className={`ctool ${showBins ? 'ctool--on' : ''}`} onClick={() => setShowBins(!showBins)} title="Show bin (tick) lines inside your range">
          ☰ Bin Lines
        </button>
        <span className="pro-chart__spacer" />
        <div className="zoom-tools" title="Zoom (or scroll on the chart)">
          <button type="button" className="ctool" onClick={() => zoom(1 / 1.4)} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="ctool" onClick={() => zoom(1.4)} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="ctool" onClick={() => zoom(null)} aria-label="Fit all">
            Fit
          </button>
        </div>
        <span className="ctool-sep" />
        <button type="button" className="ctool" onClick={screenshot} title="Save screenshot">
          <ToolIcon kind="camera" />
        </button>
        {/* iOS browsers and in-app wallets (Meteor, Telegram) can't put a chart fullscreen. */}
        {document.fullscreenEnabled && (
          <button type="button" className="ctool" onClick={fullscreen} title="Fullscreen">
            <ToolIcon kind="expand" />
          </button>
        )}
      </div>

      <div className="pro-chart__body">
        <DrawingToolbar
          tool={tool}
          onTool={(key) => {
            pendingRef.current = null;
            setTool(key);
          }}
          magnet={magnet}
          setMagnet={setMagnet}
          hidden={hidden}
          setHidden={setHidden}
          selected={selected}
          onDelete={() => {
            if (selected) setDrawings((list) => list.filter((d) => d.id !== selected));
            else setDrawings([]);
            setSelected(null);
          }}
        />

        <div className="range-chart__canvas">
          <div ref={containerRef} className="chart-card__container" />
          <canvas ref={canvasRef} className={`draw-canvas ${tool !== 'cursor' ? 'draw-canvas--active' : ''}`} />
          <div ref={overlayRef} className="range-chart__overlay">
            <div className="range-chart__band" />
            <div className="range-chart__line range-chart__line--max" data-side="max">
              <span />
            </div>
            <div className="range-chart__line range-chart__line--min" data-side="min">
              <span />
            </div>
          </div>
          <div className="pro-chart__legend">
            <span>
              {x.symbol}/{quoteLabel} · {RESOLUTIONS.find((r) => r.key === resolution)?.label} ·{' '}
              {current ? (fromPool ? 'this pool (GeckoTerminal)' : `market price (Intear${marketOn ? ' · live' : ''})`) : 'loading…'}
            </span>
            {source === 'pool' && current?.fallback && (
              <span className="pro-chart__gap">
                {current.fallback === 'empty' ? 'No trades in this pool yet' : 'Pool history unavailable right now'} — showing market price
              </span>
            )}
            {poolGap !== null && Math.abs(poolGap) >= 0.5 && (
              <span className="pro-chart__gap" title="Candles show the token's market price across pools; the dashed line is this pool's own price.">
                This pool {Math.abs(poolGap).toFixed(2)}% {poolGap < 0 ? 'below' : 'above'} market
              </span>
            )}
            {shown && (
              <span>
                O <b>{formatChartPrice(shown.open)}</b> H <b>{formatChartPrice(shown.high)}</b> L <b>{formatChartPrice(shown.low)}</b> C{' '}
                <b>{formatChartPrice(shown.close)}</b>
                {shownChange !== null && (
                  <em className={shownChange >= 0 ? 'up' : 'down'}>
                    {' '}
                    {shownChange >= 0 ? '+' : ''}
                    {shownChange.toFixed(2)}%
                  </em>
                )}
              </span>
            )}
            {shown && indicators.includes('volume') && <span className="pro-chart__vol">Volume {formatUsd(shown.volume || 0)}</span>}
          </div>
          {activeTool && activeTool.points > 0 && (
            <div className="pro-chart__hint">
              {activeTool.label}: click {activeTool.points === 2 ? 'two points' : 'a price'} · Esc to cancel
            </div>
          )}
          {(loading || candles.error) && <div className="chart-card__overlay">{candles.error ? 'Price history unavailable.' : <Spinner size={22} />}</div>}
          {noHistory && <div className="range-chart__note">No trading history yet — showing the current price.</div>}
        </div>
      </div>
      <ChartFooter
        onRange={(days) => showRange(chartApi.current?.chart, candles.data?.length || 0, step, days, 8)}
        scale={scale}
        onScale={setScale}
        auto={auto}
      />
    </div>
  );
}
