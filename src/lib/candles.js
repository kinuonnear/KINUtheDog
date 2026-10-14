// Shared helpers for the price charts (pool page, Swap page).

import { useEffect } from 'react';

/** Bars loaded per chart: 1m ≈ 16 h, 1h ≈ 41 days, 1D ≈ 2.7 years (Intear keeps full history). */
export const CHART_BARS = 1000;

/** Same bars (time and OHLC) — a refresh that changed nothing keeps the chart as it is. */
export function sameCandles(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i];
    const q = b[i];
    if (p.time !== q.time || p.open !== q.open || p.high !== q.high || p.low !== q.low || p.close !== q.close) return false;
  }
  return true;
}

/**
 * Keeps a chart's last good result per view `key`: an unchanged refresh returns the previous
 * object (so the chart isn't rebuilt), and `previous()` is what to keep showing when a source
 * fails for a moment instead of switching the chart to another source.
 */
export function lastGood(ref, key) {
  const prev = ref.current?.key === key ? ref.current.value : null;
  return {
    previous: () => prev,
    keep(value, same) {
      const v = prev && same(prev, value) ? prev : value;
      ref.current = { key, value: v };
      return v;
    }
  };
}

/**
 * Opens a new flat bar on the chart as soon as a new time bucket starts (like an exchange
 * terminal), instead of waiting for the next data refresh. `liveBarRef.current` is
 * { series, bar, line } for the chart's main series. Daily and shorter timeframes only
 * (weekly buckets don't line up with every data source).
 */
export function useBarClock(liveBarRef, step) {
  useEffect(() => {
    if (!step || step > 86_400) return undefined;
    let timer;
    const schedule = () => {
      const intoBucket = (Date.now() / 1000) % step;
      timer = setTimeout(tick, (step - intoBucket) * 1000 + 300);
    };
    const tick = () => {
      const live = liveBarRef.current;
      const now = Math.floor(Date.now() / 1000 / step) * step;
      if (live && now > live.bar.time) {
        const c = live.bar.close;
        const bar = { time: now, open: c, high: c, low: c, close: c };
        try {
          live.series.update(live.line ? { time: now, value: c } : bar);
          live.bar = bar;
        } catch {
          // the chart was rebuilt meanwhile: the next data refresh brings the bar
        }
      }
      schedule();
    };
    schedule();
    return () => clearTimeout(timer);
  }, [liveBarRef, step]);
}
