// Price chart for opening a CLMM position (Meteora-style): candles of token X
// priced in token Y with draggable Min / Max lines and a shaded range band.

import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import { useAsync, useLocalStorage } from '../hooks.js';
import { fetchPairOhlc, intearTokenId } from '../lib/intear.js';
import { formatChartPrice } from '../lib/format.js';
import { Spinner } from './ui.jsx';

const UP = '#b8ff3d';
const DOWN = '#ff5d6c';
const TIMEFRAMES = [
  { key: '15', label: '15m' },
  { key: '60', label: '1h' },
  { key: '240', label: '4h' },
  { key: '1D', label: '1D' }
];

/** Flat placeholder candles so the range can still be dragged when a pair has no history. */
function placeholderCandles(price) {
  const now = Math.floor(Date.now() / 3600000) * 3600;
  return Array.from({ length: 48 }, (_, i) => ({ time: now - (47 - i) * 3600, open: price, high: price, low: price, close: price }));
}

function pct(price, current) {
  if (!current) return '';
  const p = (price / current - 1) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}

/**
 * @param minPrice / maxPrice  current range (token Y per token X)
 * @param onDrag(side, price)   called while a line is dragged ('min' | 'max')
 * @param fullRange             hide the band when the range covers every price
 */
export default function RangeChart({ x, y, currentPrice, minPrice, maxPrice, fullRange, onDrag }) {
  const [resolution, setResolution] = useLocalStorage('kinu.range.resolution', '60');
  const containerRef = useRef(null);
  const overlayRef = useRef(null);
  const paintRef = useRef(null);
  const live = useRef({});
  live.current = { minPrice, maxPrice, currentPrice, fullRange, onDrag };

  const candles = useAsync(
    () => fetchPairOhlc({ tokenX: intearTokenId(x), tokenY: intearTokenId(y), resolution, countBack: 300 }),
    [x.id, y.id, resolution],
    { refreshMs: 60_000 }
  );
  const noHistory = candles.data && candles.data.length < 2;

  useEffect(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay || !candles.data || !currentPrice) return undefined;
    const data = noHistory ? placeholderCandles(currentPrice) : candles.data;

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
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: 0 },
      localization: { priceFormatter: formatChartPrice }
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'custom', formatter: formatChartPrice, minMove: 1e-12 },
      // Keep both range lines on screen (unless the range is effectively unbounded).
      autoscaleInfoProvider: (original) => {
        const res = original();
        const { minPrice: lo, maxPrice: hi, currentPrice: cur, fullRange: full } = live.current;
        if (!res || full) return res;
        const minValue = lo > cur / 20 ? Math.min(res.priceRange.minValue, lo) : res.priceRange.minValue;
        const maxValue = hi < cur * 20 ? Math.max(res.priceRange.maxValue, hi) : res.priceRange.maxValue;
        return { ...res, priceRange: { minValue, maxValue } };
      }
    });
    series.setData(data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    series.createPriceLine({
      price: currentPrice,
      color: 'rgba(255,255,255,0.55)',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'Current'
    });
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - 140), to: data.length + 6 });

    // Overlay: band + two draggable lines, positioned from price coordinates.
    // Repainted on chart/range changes, and every frame only while the pointer is over the chart
    // (covers price-axis drags, which emit no event) — no idle animation loop.
    const band = overlay.querySelector('.range-chart__band');
    const lines = { min: overlay.querySelector('[data-side="min"]'), max: overlay.querySelector('[data-side="max"]') };
    const paint = () => {
      const { minPrice: lo, maxPrice: hi, currentPrice: cur, fullRange: full } = live.current;
      const width = container.clientWidth - chart.priceScale('right').width();
      overlay.style.width = `${Math.max(0, width)}px`;
      const yMax = series.priceToCoordinate(hi);
      const yMin = series.priceToCoordinate(lo);
      const height = container.clientHeight;
      const place = (el, yPos, price, label) => {
        if (yPos === null || full) {
          el.style.display = 'none';
          return;
        }
        el.style.display = 'block';
        el.style.top = `${Math.min(height - 1, Math.max(0, yPos))}px`;
        el.querySelector('span').textContent = `${label} ${formatChartPrice(price)} (${pct(price, cur)})`;
      };
      place(lines.max, yMax, hi, 'Max');
      place(lines.min, yMin, lo, 'Min');
      if (full || yMax === null || yMin === null) {
        band.style.display = full ? 'block' : 'none';
        if (full) {
          band.style.top = '0px';
          band.style.height = '100%';
        }
      } else {
        const top = Math.max(0, Math.min(yMax, yMin));
        const bottom = Math.min(height, Math.max(yMax, yMin));
        band.style.display = 'block';
        band.style.top = `${top}px`;
        band.style.height = `${Math.max(0, bottom - top)}px`;
      }
    };
    paintRef.current = paint;
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
    container.addEventListener('pointerenter', startLoop);
    container.addEventListener('pointerleave', stopLoop);
    chart.timeScale().subscribeVisibleLogicalRangeChange(paint);
    const resize = new ResizeObserver(() => requestAnimationFrame(paint));
    resize.observe(container);
    requestAnimationFrame(paint);

    // Dragging a line converts the pointer position back to a price.
    const cleanups = Object.entries(lines).map(([side, el]) => {
      const onDown = (event) => {
        event.preventDefault();
        el.setPointerCapture(event.pointerId);
        el.classList.add('dragging');
        const onMove = (e) => {
          const rect = container.getBoundingClientRect();
          const price = series.coordinateToPrice(e.clientY - rect.top);
          if (price && price > 0) live.current.onDrag(side, price, false);
        };
        const onUp = (e) => {
          el.classList.remove('dragging');
          el.releasePointerCapture(e.pointerId);
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onUp);
          const rect = container.getBoundingClientRect();
          const price = series.coordinateToPrice(e.clientY - rect.top);
          if (price && price > 0) live.current.onDrag(side, price, true);
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
      };
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointerenter', startLoop);
      return () => el.removeEventListener('pointerdown', onDown);
    });

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      paintRef.current = null;
      resize.disconnect();
      container.removeEventListener('pointerenter', startLoop);
      container.removeEventListener('pointerleave', stopLoop);
      cleanups.forEach((fn) => fn());
      chart.remove();
    };
  }, [candles.data, noHistory, currentPrice]);

  // Range edited from the form (inputs, presets, histogram): repaint the lines.
  useEffect(() => {
    paintRef.current?.();
  }, [minPrice, maxPrice, fullRange]);

  return (
    <div className="card range-chart">
      <div className="range-chart__head">
        <div>
          <span className="eyebrow">Price chart</span>
          <strong>
            {x.symbol} / {y.symbol}
          </strong>
          <span className="muted small">
            Current <b className="mono">{formatChartPrice(currentPrice)}</b> {y.symbol} per {x.symbol}
          </span>
        </div>
        <div className="segmented">
          {TIMEFRAMES.map((t) => (
            <button key={t.key} type="button" className={resolution === t.key ? 'active' : ''} onClick={() => setResolution(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <p className="range-chart__tip">Drag the Min / Max lines to set your range, or type exact prices in the form.</p>
      <div className="range-chart__canvas">
        <div ref={containerRef} className="chart-card__container" />
        <div ref={overlayRef} className="range-chart__overlay">
          <div className="range-chart__band" />
          <div className="range-chart__line range-chart__line--max" data-side="max">
            <span />
          </div>
          <div className="range-chart__line range-chart__line--min" data-side="min">
            <span />
          </div>
        </div>
        {(candles.loading && !candles.data) || candles.error ? (
          <div className="chart-card__overlay">{candles.error ? 'Price history unavailable.' : <Spinner size={22} />}</div>
        ) : null}
        {noHistory && <div className="range-chart__note">No trading history yet — showing the current price.</div>}
      </div>
    </div>
  );
}
