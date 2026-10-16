// Shared helpers for the price charts (pool page, Swap page).

import { useCallback, useEffect, useRef, useState } from 'react';
import { fillGaps } from './intearApi.js';

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

/**
 * History further back than the first load, fetched when a chart's view reaches its first candle.
 * `key` identifies the view (token, pool, timeframe, unit…): a new key starts over.
 * `load(firstTime)` resolves to the candles before `firstTime` (seconds), oldest first; an empty
 * page means there is no more. Returns { older, done, request(firstTime) }.
 */
// One shared empty list: a chart rebuilds when its candles change identity, so "no history yet"
// must stay the same object across renders (a new [] each render would reset the view mid-drag).
const NONE = [];

export function useOlderCandles(key, load) {
  const [state, setState] = useState({ key, candles: NONE, done: false });
  const busy = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const current = state.key === key ? state : { key, candles: NONE, done: false };
  const done = current.done;
  const request = useCallback(
    async (firstTime) => {
      if (busy.current || done || !firstTime) return;
      busy.current = true;
      try {
        const page = ((await loadRef.current(firstTime)) || []).filter((c) => c.time < firstTime);
        setState((s) => {
          const base = s.key === key ? s : { key, candles: NONE, done: false };
          // An empty page only marks the end: the candles keep their identity (no rebuild).
          if (!page.length) return { key, candles: base.candles, done: true };
          return { key, candles: [...page, ...base.candles], done: false };
        });
      } catch {
        // busy source (e.g. GeckoTerminal's rate limit): the next scroll tries again
      } finally {
        busy.current = false;
      }
    },
    [key, done]
  );
  return { older: current.candles, done, request };
}

/**
 * Zooming out stops once all `count` candles fit the chart's width, so the view never shows empty
 * space beside the data (with the left edge fixed it would pile up on the right). Short histories
 * (under 60 candles) keep their usual roomy view. Returns a cleanup function.
 */
export function limitZoomOut(chart, container, count, rightOffset = 6) {
  if (count < 60 || typeof ResizeObserver === 'undefined') return () => {};
  const apply = () => {
    const width = container.clientWidth - (chart.priceScale('right').width() || 64);
    if (width > 0) chart.timeScale().applyOptions({ minBarSpacing: Math.max(0.1, width / (count + rightOffset)) });
  };
  apply();
  const ro = new ResizeObserver(apply);
  ro.observe(container);
  return () => ro.disconnect();
}

/** Older pages in front of the loaded candles, one candle per bucket across the join. */
export function withOlder(older, candles, step) {
  if (!older?.length || !candles?.length) return candles;
  const first = candles[0].time;
  const before = older.filter((c) => c.time < first);
  if (!before.length) return candles;
  const joined = fillGaps([...before, candles[0]], step);
  return [...joined.slice(0, -1), ...candles];
}
