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
import { bollinger, ema, INDICATORS, sma } from '../lib/indicators.js';
import { pointToPrice } from '../lib/dclLiquidity.js';
import { formatChartPrice, formatPercent, formatUsd } from '../lib/format.js';
import { drawAll, hitTest, TOOLS } from './chart/drawings.js';
import { Spinner, TokenIcon } from './ui.jsx';

const UP = '#b8ff3d';
const DOWN = '#ff5d6c';
const MAX_BIN_LINES = 80;

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

function ToolIcon({ kind }) {
  const paths = {
    cursor: <path d="M9 2v14M2 9h14" />,
    trend: <path d="M3 15 15 3" />,
    hline: <path d="M1 9h16" />,
    rect: <rect x="3" y="4" width="12" height="10" rx="1" />,
    fib: <path d="M2 3h14M2 7h14M2 11h14M2 15h14" />,
    measure: <path d="M3 15 15 3M3 11v4h4M15 7V3h-4" />,
    magnet: <path d="M4 3v6a5 5 0 0 0 10 0V3M4 6h3M11 6h3" />,
    eye: <path d="M1 9s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5ZM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />,
    trash: <path d="M3 5h12M7 5V3h4v2M5 5l1 10h6l1-10" />,
    camera: <path d="M2 6h3l2-2h4l2 2h3v9H2ZM9 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />,
    expand: <path d="M2 7V2h5M11 2h5v5M16 11v5h-5M7 16H2v-5" />,
    candles: <path d="M5 2v14M3 5h4v7H3ZM13 2v14M11 7h4v5h-4Z" />,
    line: <path d="M2 14 7 8l4 3 5-7" />
  };
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

function IndicatorMenu({ active, toggle }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const count = active.filter((k) => k !== 'volume').length;
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className={`ctool ${count ? 'ctool--on' : ''}`} onClick={() => setOpen((v) => !v)}>
        <i className="fx">fx</i> Indicators {count > 0 && <b>{count}</b>}
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
export default function RangeChart({ poolId, x, y, currentPrice, minPrice, maxPrice, fullRange, onDrag, bins }) {
  const [resolution, setResolution] = useLocalStorage('kinu.range.resolution', '60');
  const [unit, setUnit] = useLocalStorage('kinu.range.unit', 'pair'); // 'pair' | 'usd'
  const [chartType, setChartType] = useLocalStorage('kinu.range.type', 'candles');
  const [indicators, setIndicators] = useLocalStorage('kinu.range.indicators', ['volume']);
  const [showBins, setShowBins] = useLocalStorage('kinu.range.bins', false);
  const [tool, setTool] = useState('cursor');
  const [magnet, setMagnet] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState(null);
  const [legend, setLegend] = useState(null);
  const [drawings, setDrawings] = useLocalStorage(`kinu.draw.${poolId}.${unit}`, []);

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
  const candles = useAsync(
    () => (unit === 'usd' ? fetchOhlc({ tokenId: xId, resolution, countBack: 300 }) : fetchPairOhlc({ tokenX: xId, tokenY: yId, resolution, countBack: 300 })),
    [xId, yId, resolution, unit],
    { refreshMs: 60_000 }
  );
  const noHistory = candles.data && candles.data.length < 2;

  // Pair -> display units. In USD mode the range is shown as token X's USD price.
  const usdFactor = useMemo(() => {
    if (unit !== 'usd' || !currentPrice) return 1;
    const last = candles.data?.[candles.data.length - 1]?.close;
    if (last) return last / currentPrice;
    return info.data?.price ? info.data.price / currentPrice : 1;
  }, [unit, candles.data, currentPrice, info.data]);

  const binPrices = useMemo(() => {
    if (!showBins || !bins || fullRange) return [];
    const count = Math.round((bins.right - bins.left) / bins.pointDelta);
    const every = Math.max(1, Math.ceil(count / MAX_BIN_LINES));
    const out = [];
    for (let p = bins.left; p <= bins.right; p += bins.pointDelta * every) out.push(pointToPrice(p, x.decimals, y.decimals));
    return out;
  }, [showBins, bins, fullRange, x.decimals, y.decimals]);

  live.current = { minPrice, maxPrice, currentPrice, fullRange, onDrag, usdFactor, drawings, selected, hidden, tool, magnet, binPrices, setDrawings, setSelected, setTool };

  useEffect(() => {
    paintRef.current?.();
  }, [minPrice, maxPrice, fullRange, drawings, selected, hidden, binPrices]);

  // Delete removes the selected drawing; Esc cancels the active tool.
  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && live.current.selected) {
        live.current.setDrawings((list) => list.filter((d) => d.id !== live.current.selected));
        live.current.setSelected(null);
      }
      if (e.key === 'Escape') {
        pendingRef.current = null;
        live.current.setTool('cursor');
        paintRef.current?.();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    if (!container || !overlay || !canvas || !candles.data || !currentPrice) return undefined;
    const data = noHistory ? placeholderCandles(currentPrice * usdFactor, step) : candles.data;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: 'rgba(231, 240, 233, 0.5)',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: 11,
        attributionLogo: false
      },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.1, bottom: indicators.includes('volume') ? 0.2 : 0.08 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false, rightOffset: 8 },
      crosshair: { mode: 0 },
      localization: { priceFormatter: formatChartPrice }
    });

    const autoscaleInfoProvider = (original) => {
      const res = original();
      const { minPrice: lo, maxPrice: hi, currentPrice: cur, fullRange: full, usdFactor: f } = live.current;
      if (!res || full) return res;
      const minValue = lo > cur / 20 ? Math.min(res.priceRange.minValue, lo * f) : res.priceRange.minValue;
      const maxValue = hi < cur * 20 ? Math.max(res.priceRange.maxValue, hi * f) : res.priceRange.maxValue;
      return { ...res, priceRange: { minValue, maxValue } };
    };
    const priceFormat = { type: 'custom', formatter: formatChartPrice, minMove: 1e-12 };
    const main =
      chartType === 'line'
        ? chart.addSeries(LineSeries, { color: UP, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat, autoscaleInfoProvider })
        : chart.addSeries(CandlestickSeries, {
            upColor: UP,
            downColor: DOWN,
            borderVisible: false,
            wickUpColor: UP,
            wickDownColor: DOWN,
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat,
            autoscaleInfoProvider
          });
    main.setData(
      chartType === 'line'
        ? data.map((c) => ({ time: c.time, value: c.close }))
        : data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }))
    );

    if (!noHistory) {
      const high = Math.max(...data.map((c) => c.high));
      const low = Math.min(...data.map((c) => c.low));
      main.createPriceLine({ price: high, color: 'rgba(231,240,233,0.35)', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'High' });
      main.createPriceLine({ price: low, color: 'rgba(231,240,233,0.35)', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'Low' });
    }
    main.createPriceLine({ price: currentPrice * usdFactor, color: 'rgba(255,255,255,0.55)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });

    if (indicators.includes('volume')) {
      const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      vol.setData(data.map((c) => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(184,255,61,0.25)' : 'rgba(255,93,108,0.25)' })));
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
    if (indicators.includes('ma20')) chart.addSeries(LineSeries, lineOpts('#ffb547')).setData(sma(data, 20));
    if (indicators.includes('ma50')) chart.addSeries(LineSeries, lineOpts('#5ec8ff')).setData(sma(data, 50));
    if (indicators.includes('ema20')) chart.addSeries(LineSeries, lineOpts('#c792ff')).setData(ema(data, 20));
    if (indicators.includes('bb')) {
      const bb = bollinger(data, 20, 2);
      chart.addSeries(LineSeries, lineOpts('rgba(61,220,151,0.8)')).setData(bb.upper);
      chart.addSeries(LineSeries, { ...lineOpts('rgba(61,220,151,0.45)'), lineStyle: 2 }).setData(bb.middle);
      chart.addSeries(LineSeries, lineOpts('rgba(61,220,151,0.8)')).setData(bb.lower);
    }
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - 140), to: data.length + 8 });

    // --- time <-> x helpers (drawings live in { time, price } space) -------------
    const times = data.map((c) => c.time);
    const lastIdx = times.length - 1;
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

    // --- painting -------------------------------------------------------------
    const band = overlay.querySelector('.range-chart__band');
    const lines = { min: overlay.querySelector('[data-side="min"]'), max: overlay.querySelector('[data-side="max"]') };
    const ctx = canvas.getContext('2d');
    const paint = () => {
      const { minPrice: lo, maxPrice: hi, currentPrice: cur, fullRange: full, usdFactor: f } = live.current;
      const width = Math.max(0, container.clientWidth - chart.priceScale('right').width());
      const height = Math.max(0, container.clientHeight - chart.timeScale().height());
      overlay.style.width = `${width}px`;
      overlay.style.height = `${height}px`;

      const yMax = main.priceToCoordinate(hi * f);
      const yMin = main.priceToCoordinate(lo * f);
      const place = (el, yPos, price, text) => {
        if (yPos === null || full) {
          el.style.display = 'none';
          return;
        }
        el.style.display = 'block';
        el.style.top = `${Math.min(height - 1, Math.max(0, yPos))}px`;
        el.querySelector('span').textContent = `${text} ${formatChartPrice(price * f)} (${pct(price, cur)})`;
      };
      place(lines.max, yMax, hi, 'Max');
      place(lines.min, yMin, lo, 'Min');
      if (full) {
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
      if (live.current.binPrices.length) {
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

    chartApi.current = { chart, canvas };
    return () => {
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
  }, [candles.data, noHistory, currentPrice, chartType, indicators.join(','), usdFactor, step]);

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

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else cardRef.current?.requestFullscreen?.();
  };

  const toggleIndicator = (key) => setIndicators((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  const activeTool = TOOLS.find((t) => t.key === tool);
  const last = candles.data?.[candles.data.length - 1];
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
          24h Vol: <b>{info.data ? formatUsd(info.data.volume24hUsd) : '—'}</b>
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
        <button type="button" className="ctool" onClick={screenshot} title="Save screenshot">
          <ToolIcon kind="camera" />
        </button>
        <button type="button" className="ctool" onClick={fullscreen} title="Fullscreen">
          <ToolIcon kind="expand" />
        </button>
      </div>

      <div className="pro-chart__body">
        <div className="pro-chart__tools" role="toolbar" aria-label="Drawing tools">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              type="button"
              title={t.label}
              aria-label={t.label}
              className={`dtool ${tool === t.key ? 'dtool--active' : ''}`}
              onClick={() => {
                pendingRef.current = null;
                setTool(t.key);
              }}
            >
              <ToolIcon kind={t.key} />
            </button>
          ))}
          <span className="dtool-sep" />
          <button type="button" title="Magnet: snap to OHLC" aria-label="Magnet" className={`dtool ${magnet ? 'dtool--on' : ''}`} onClick={() => setMagnet(!magnet)}>
            <ToolIcon kind="magnet" />
          </button>
          <button
            type="button"
            title={hidden ? 'Show drawings' : 'Hide drawings'}
            aria-label={hidden ? 'Show drawings' : 'Hide drawings'}
            className={`dtool ${hidden ? 'dtool--on' : ''}`}
            onClick={() => setHidden(!hidden)}
          >
            <ToolIcon kind="eye" />
          </button>
          <button
            type="button"
            title={selected ? 'Delete selected drawing' : 'Remove all drawings'}
            aria-label={selected ? 'Delete selected drawing' : 'Remove all drawings'}
            className="dtool"
            onClick={() => {
              if (selected) setDrawings((list) => list.filter((d) => d.id !== selected));
              else setDrawings([]);
              setSelected(null);
            }}
          >
            <ToolIcon kind="trash" />
          </button>
        </div>

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
              {x.symbol}/{quoteLabel} · {RESOLUTIONS.find((r) => r.key === resolution)?.label} · Intear
            </span>
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
            {shown && indicators.includes('volume') && <span>Volume {formatUsd(shown.volume || 0)}</span>}
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
    </div>
  );
}
