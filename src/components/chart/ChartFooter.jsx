// Bottom bar of the price charts, TradingView-style: jump to a time range (1D … All), and the
// price scale's mode (% / log) or a re-fit to the visible candles (auto).

import { useEffect, useState } from 'react';
import { PriceScaleMode } from 'lightweight-charts';

export const CHART_RANGES = [
  ['1D', 1],
  ['7D', 7],
  ['30D', 30],
  ['180D', 180],
  ['All', null]
];

/**
 * Shows the last `days` (every loaded candle when null) of a chart's `count` candles of `step`
 * seconds. A range longer than the history shows the space before it, which loads older candles.
 */
export function showRange(chart, count, step, days, rightOffset = 6) {
  if (!chart || !count) return;
  const bars = days ? Math.max(5, Math.round((days * 86_400) / step)) : count;
  chart.timeScale().setVisibleLogicalRange({ from: count - bars, to: count - 1 + rightOffset });
}

/** 'normal' | 'log' | 'pct' -> the right price scale's mode. */
export function applyScale(chart, scale) {
  if (!chart) return;
  const mode = scale === 'log' ? PriceScaleMode.Logarithmic : scale === 'pct' ? PriceScaleMode.Percentage : PriceScaleMode.Normal;
  chart.priceScale('right').applyOptions({ mode });
}

/**
 * Whether the chart's price scale fits the candles in view by itself (TradingView's "auto"). It
 * turns off when the user drags or zooms the price scale; `toggle()` re-fits (or freezes) it.
 * `getChart()` returns the chart (or null); `container` is the element the chart lives in.
 */
export function useAutoScale(getChart, containerRef, key) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    // Read the scale after any gesture that may have changed it (drag, wheel, double-click reset).
    const read = () =>
      setTimeout(() => {
        const chart = getChart();
        if (chart) setOn(chart.priceScale('right').options().autoScale !== false);
      }, 0);
    read();
    const events = ['pointerup', 'mouseup', 'wheel', 'dblclick', 'touchend'];
    events.forEach((e) => el.addEventListener(e, read, { passive: true }));
    return () => events.forEach((e) => el.removeEventListener(e, read));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const toggle = () => {
    const chart = getChart();
    if (!chart) return;
    const next = !(chart.priceScale('right').options().autoScale !== false);
    chart.priceScale('right').applyOptions({ autoScale: next });
    setOn(next);
  };
  return { on, toggle };
}

export default function ChartFooter({ onRange, scale, onScale, auto }) {
  return (
    <div className="chart-footer">
      <div className="chart-footer__group" role="group" aria-label="Time range">
        {CHART_RANGES.map(([label, days]) => (
          <button key={label} type="button" onClick={() => onRange(days)} title={days ? `Show the last ${label}` : 'Show all loaded history'}>
            {label}
          </button>
        ))}
      </div>
      <div className="chart-footer__group" role="group" aria-label="Price scale">
        <button type="button" className={scale === 'pct' ? 'active' : ''} onClick={() => onScale(scale === 'pct' ? 'normal' : 'pct')} title="Percentage scale" aria-pressed={scale === 'pct'}>
          %
        </button>
        <button type="button" className={scale === 'log' ? 'active' : ''} onClick={() => onScale(scale === 'log' ? 'normal' : 'log')} title="Logarithmic scale" aria-pressed={scale === 'log'}>
          log
        </button>
        <button
          type="button"
          className={auto.on ? 'active' : ''}
          onClick={auto.toggle}
          aria-pressed={auto.on}
          title={auto.on ? 'The price scale follows the candles in view (click to freeze it)' : 'Fit the price scale to the candles in view'}
        >
          auto
        </button>
      </div>
    </div>
  );
}
