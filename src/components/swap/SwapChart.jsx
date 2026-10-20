// Swap page chart, Jupiter-style. By default the token's market price across every pool (Intear
// API): deep history, in USD or NEAR, kept live over a WebSocket after every block. Any of the
// token's pools can be picked instead (GeckoTerminal candles, refreshed every minute). Scrolling
// back to the first candle loads the history before it; the chart never scrolls past it.
// The view (zoom, scroll, price scale) survives refreshes. With a wallet connected, its own buys
// and sells of the token are marked on the candles they fell in (B / S, as on Jupiter), and so are
// those of the wallets in the Wallet Tracker, in each wallet's colour. Levels: the buy and sell
// walls and thin zones of the token's liquidity across every Rhea pool (lib/liquidityMap.js, the
// Pool Analysis page), drawn as dashed lines at their distance from the last price.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries } from 'lightweight-charts';
import { useApp } from '../../state.jsx';
import { useAsync, useLocalStorage } from '../../hooks.js';
import { fetchOhlc, fetchTokenInfo, fetchTrades, intearTokenId, RESOLUTIONS } from '../../lib/intear.js';
import { fetchMarketCandles, subscribeCandles } from '../../lib/intearApi.js';
import { fetchPoolOhlc } from '../../lib/gecko.js';
import { CHART_BARS, lastGood, sameCandles, useBarClock, useOlderCandles, withOlder } from '../../lib/candles.js';
import { formatAmount, formatChartPrice, formatUsd, toNumber } from '../../lib/format.js';
import { attachDrawings, DrawingToolbar, useDrawingKeys } from '../chart/DrawingTools.jsx';
import ChartFooter, { applyScale, showRange, useAutoScale } from '../chart/ChartFooter.jsx';
import { Spinner } from '../ui.jsx';
import { useTrackedWallets } from '../../lib/walletTracker.js';
import { Link } from '../../router.jsx';
import { getLiquidityMap, keyLevels, MAP_REFRESH_MS, MAP_VIEWS, mapView } from '../../lib/liquidityMap.js';

const UP = '#22e283';
const DOWN = '#ff5d6c';
const REFRESH_MS = 60_000;
// Market candles load deeper than pool ones (Intear gives up to 5,000 per request).
// Phones load a lighter first page (older candles still page in as the chart is scrolled back).
const PHONE = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches;
const MARKET_BARS = PHONE ? 720 : 3000;
const MARKET = 'market';
// The last market candles of a few views, shown at once on the next visit while fresh ones load.
const CACHE_KEY = 'kinu.swapChart.cache';
const CACHE_VIEWS = 4;
const CACHE_BARS = 400;
const CACHE_MAX_AGE_MS = 6 * 3600_000;
function readCache(view) {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]').find((e) => e.view === view);
    return hit && Date.now() - hit.at < CACHE_MAX_AGE_MS && hit.candles?.length ? hit : null;
  } catch {
    return null;
  }
}
function writeCache(value) {
  try {
    const list = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]').filter((e) => e.view !== value.view);
    list.unshift({ ...value, candles: value.candles.slice(-CACHE_BARS), at: Date.now() });
    localStorage.setItem(CACHE_KEY, JSON.stringify(list.slice(0, CACHE_VIEWS)));
  } catch {
    /* storage full or blocked: no cache */
  }
}
const WNEAR = 'wrap.near';
// Liquidity levels on the chart: label and colour by kind and side (above / below the price).
const LEVEL_TITLE = { step: { resistance: 'Sell wall', support: 'Buy wall' }, peak: { resistance: 'Sell wall', support: 'Buy wall' }, thin: { resistance: 'Thin', support: 'Thin' } };
// The levels read the deepest pools only: the small ones barely move the walls.
const LEVEL_POOLS = { maxPools: 5, minTvl: 1000 };
const LEVEL_COLOR = { resistance: '#b3a4c4', support: '#8fb0c4', thin: '#ff8f99' };

/** NEAR and wNEAR are one token here. */
const sameSymbol = (a, b) => {
  const norm = (v) => String(v || '').toUpperCase().replace(/^WNEAR$/, 'NEAR');
  return norm(a) === norm(b);
};

/** The other token's symbol in a pool named like "QTC / wNEAR" (NEAR / wNEAR count as one). */
function otherSymbol(pool, symbol) {
  const parts = String(pool?.name || '').split(' / ');
  return parts.find((s) => !sameSymbol(s, symbol)) || parts[1] || '';
}

// The price axis: no labels below zero and "0" for dust, not "0.0000000000".
const axisPrice = (value) => (value < 0 ? '' : value < 1e-12 ? '0' : formatChartPrice(value));

/** The candle a moment (unix seconds) falls in: the last candle starting at or before it. */
function candleAt(times, sec) {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || sec < times[0]) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= sec) lo = mid;
    else hi = mid - 1;
  }
  return times[lo];
}

/**
 * Trades grouped per candle, wallet and side, as bubbles:
 * { "time|wallet|side" → { time, side, who, label, color, count, usd, amount, last } }
 * (amount in tokens, last in ms). `sources`: [{ who, label, color, trades }], the user first.
 */
function bubblesFor(sources, times, decimals) {
  const out = new Map();
  for (const src of sources) {
    for (const tr of src.trades || []) {
      const time = candleAt(times, Math.floor(tr.time / 1000));
      if (time === null) continue;
      const side = tr.side === 'buy' ? 'buy' : 'sell';
      const key = `${time}|${src.who}|${side}`;
      const s = out.get(key) || { time, side, who: src.who, label: src.label, emoji: src.emoji, color: src.color, count: 0, usd: 0, amount: 0, last: 0 };
      s.count += 1;
      s.usd += tr.usd;
      s.amount += decimals !== undefined ? toNumber(tr.amountRaw, decimals) : 0;
      s.last = Math.max(s.last, tr.time);
      out.set(key, s);
    }
  }
  return out;
}

function timeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
  return `${Math.floor(s / (86400 * 365))}y ago`;
}

/**
 * Places the B / S bubbles over the chart: B under the candle's low, S over its high, a badge with
 * the count when there are several. Runs every frame while there are bubbles, so they follow zoom,
 * scroll and the price scale.
 */
function placeBubbles(layer, api, groups) {
  const { chart, series, byTime } = api;
  const width = layer.clientWidth - chart.priceScale('right').width();
  const html = [];
  const stack = new Map(); // "time|side" → bubbles placed so far
  for (const [key, b] of groups) {
    const x = chart.timeScale().timeToCoordinate(b.time);
    const bar = byTime.get(b.time);
    if (x === null || !bar || x < 0 || x > width) continue;
    const edge = series.priceToCoordinate(b.side === 'buy' ? bar.low : bar.high);
    if (edge === null) continue;
    const n = stack.get(`${b.time}|${b.side}`) || 0;
    stack.set(`${b.time}|${b.side}`, n + 1);
    const y = b.side === 'buy' ? edge + 16 + n * 22 : edge - 16 - n * 22;
    const mine = b.who === 'me';
    const letter = mine ? (b.side === 'buy' ? 'B' : 'S') : b.emoji || b.label[0]?.toUpperCase() || '?';
    const style = `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px${mine ? '' : `;background:${b.color}`}`;
    html.push(
      `<i class="trade-bubble trade-bubble--${b.side}${mine ? '' : ' trade-bubble--tracked'}" data-key="${key}" style="${style}">${letter}${b.count > 1 ? `<b>${b.count}</b>` : ''}</i>`
    );
  }
  const next = html.join('');
  if (layer.dataset.html !== next) {
    layer.innerHTML = next;
    layer.dataset.html = next;
  }
}

export default function SwapChart({ token, counter, pools, height, onFlip }) {
  const tokenId = intearTokenId(token);
  const counterId = counter ? intearTokenId(counter) : null;
  const [resolution, setResolution] = useLocalStorage('kinu.chart.resolution', '60');
  const [unit, setUnit] = useLocalStorage('kinu.swap.unit', 'usd'); // 'usd' | 'quote'
  const [mode, setMode] = useState('price');
  // MARKET (default): every pool, live; or a pool's address.
  const [poolAddress, setPoolAddress] = useState(MARKET);
  useEffect(() => setPoolAddress(MARKET), [tokenId, counterId]);

  const pool = poolAddress === MARKET ? null : (pools || []).find((p) => p.address === poolAddress) || null;
  // Market prices come in USD or NEAR (wNEAR itself: USD only); a pool's in USD or its other token.
  const quoteSymbol = pool ? otherSymbol(pool, token?.symbol) : tokenId === WNEAR ? '' : 'NEAR';
  const marketQuote = unit === 'quote' && tokenId !== WNEAR ? 'near' : 'usd';
  const step = RESOLUTIONS.find((r) => r.key === resolution)?.seconds || 3600;

  const info = useAsync(() => fetchTokenInfo(tokenId), [tokenId], { enabled: Boolean(tokenId), refreshMs: 60_000 });

  // The connected wallet's own trades of this token, for the B / S markers.
  const { accountId, prices } = useApp();
  const [showMine, setShowMine] = useLocalStorage('kinu.swap.myTrades', true);
  const myTrades = useAsync(() => fetchTrades({ tokenId, trader: accountId, limit: 200 }), [tokenId, accountId], {
    enabled: Boolean(tokenId && accountId),
    refreshMs: 20_000
  });
  const { wallets: tracked } = useTrackedWallets();
  const [showTracked, setShowTracked] = useLocalStorage('kinu.swap.tracked', true);
  const trackedOn = showTracked ? tracked.filter((w) => w.onChart).slice(0, 15) : [];
  const trackedIds = trackedOn.map((w) => w.id).join(',');
  // Names, emojis and each group's min value for chart markers: a change redraws the bubbles.
  const trackedSig = trackedOn.map((w) => [w.id, w.label, w.emoji, w.color, w.minUsd].join(':')).join(',');
  const trackedTrades = useAsync(
    () => Promise.all(trackedOn.map((w) => fetchTrades({ tokenId, trader: w.id, limit: 200 }).catch(() => []))),
    [tokenId, trackedIds],
    { enabled: Boolean(tokenId && trackedOn.length), refreshMs: 30_000 }
  );
  const supply = info.data?.circulatingSupply;

  // Buy / sell walls and thin zones within ±50%, two per side at most.
  const [showLevels, setShowLevels] = useLocalStorage('kinu.swap.levels', true);
  const pricesReady = Boolean(prices?.size);
  const liquidity = useAsync(() => getLiquidityMap(tokenId, prices, LEVEL_POOLS), [tokenId, pricesReady], {
    enabled: Boolean(showLevels && tokenId && pricesReady),
    refreshMs: MAP_REFRESH_MS
  });
  const levels = useMemo(
    () => (showLevels && liquidity.data?.tokenId === tokenId ? keyLevels(mapView(liquidity.data, MAP_VIEWS[1]), { perSide: 2 }) : []),
    [showLevels, liquidity.data, tokenId]
  );

  const lastGoodRef = useRef(null);
  const viewOf = `${tokenId}|${pool?.address || MARKET}|${resolution}|${unit}`;
  const market = async () => {
    try {
      const candles = await fetchMarketCandles({ tokenId, resolution, quote: marketQuote, countBack: MARKET_BARS });
      return { source: 'market', usd: marketQuote === 'usd', volumeUsd: true, candles };
    } catch {
      // Intear API down: the older price feed (USD only).
      return { source: 'market', usd: true, volumeUsd: true, candles: await fetchOhlc({ tokenId, resolution, countBack: CHART_BARS }) };
    }
  };
  const loaded = useAsync(
    async () => {
      const memo = lastGood(lastGoodRef, viewOf);
      const keep = (value) => memo.keep({ ...value, view: viewOf }, (a, b) => a.source === b.source && a.usd === b.usd && sameCandles(a.candles, b.candles));
      if (pool) {
        const usd = unit === 'usd';
        const res = await fetchPoolOhlc({ address: pool.address, tokenId, resolution, usd, countBack: CHART_BARS }).catch(() => null);
        if (res?.trades > 0) return keep({ source: 'pool', usd, candles: res.candles });
        // GeckoTerminal busy for a moment: keep the pool's candles rather than switching sources.
        const prev = memo.previous();
        if (!res && prev?.source === 'pool') return prev;
      }
      const fresh = keep(await market());
      if (!pool && fresh.candles?.length) writeCache({ view: viewOf, source: fresh.source, usd: fresh.usd, volumeUsd: fresh.volumeUsd, candles: fresh.candles });
      return fresh;
    },
    [viewOf],
    { enabled: Boolean(tokenId), refreshMs: REFRESH_MS }
  );
  // Never show the previous token's candles while the new ones load. Moving from market to pool
  // candles of the same token keeps the market chart up until the pool's arrive.
  const sameToken = loaded.data?.view?.split('|')[0] === tokenId && loaded.data?.view?.split('|').slice(2).join('|') === `${resolution}|${unit}`;
  // Until the first answer for this view, the market candles cached on the last visit (market views only).
  const cached = useMemo(() => (pool ? null : readCache(viewOf)), [viewOf, pool]);
  const base = sameToken ? loaded.data : cached || undefined;

  // History before the first candle, loaded as the view reaches it.
  const history = useOlderCandles(`${viewOf}|${base?.source}`, async (firstTime) => {
    if (!base) return [];
    if (base.source === 'pool') {
      if (resolution === '1W') return [];
      const res = await fetchPoolOhlc({ address: pool.address, tokenId, resolution, usd: unit === 'usd', countBack: 1000, before: firstTime });
      return res.candles;
    }
    const page = await fetchMarketCandles({ tokenId, resolution, quote: base.usd ? 'usd' : 'near', countBack: MARKET_BARS, toMillis: firstTime * 1000 - 1 });
    if (page.length) return page;
    // Intear's history starts in August 2026: further back, the token's deepest pool (in NEAR, its
    // deepest pool against wNEAR) carries on from GeckoTerminal.
    const deep = base.usd ? pools?.[0] : (pools || []).find((p) => p.baseId === WNEAR || p.quoteId === WNEAR);
    if (!deep || resolution === '1W') return [];
    const res = await fetchPoolOhlc({ address: deep.address, tokenId, resolution, usd: base.usd, countBack: 1000, before: firstTime });
    if (base.usd) return res.candles;
    // Priced in NEAR, the pool's volume is in NEAR too: shown in dollars at NEAR's price.
    const nearUsd = (await fetchTokenInfo(WNEAR).catch(() => null))?.price || 0;
    return res.candles.map((c) => ({ ...c, volume: c.volume * nearUsd }));
  });
  const data = useMemo(
    () => (base ? { ...base, candles: withOlder(history.older, base.candles, step) } : undefined),
    [base, history.older, step]
  );
  const usdView = data ? data.usd : unit === 'usd';
  const multiplier = mode === 'mcap' ? supply || 0 : 1;

  // Volume always reads in USD: pool candles priced in the other token carry volume in it too.
  // Only those need the token price, so a price refresh doesn't rebuild (and reset) other charts.
  const volPrice = data?.usd || data?.volumeUsd ? null : info.data?.price;
  const scaled = useMemo(() => {
    if (!data?.candles?.length || !multiplier) return [];
    const last = data.candles[data.candles.length - 1].close;
    const volToUsd = data.usd || data.volumeUsd ? 1 : volPrice && last ? volPrice / last : 0;
    return data.candles.map((c) => ({
      time: c.time,
      open: c.open * multiplier,
      high: c.high * multiplier,
      low: c.low * multiplier,
      close: c.close * multiplier,
      volume: (c.volume || 0) * volToUsd
    }));
  }, [data, multiplier, volPrice]);

  /* ---- chart ---- */
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const paintRef = useRef(null);
  const pendingRef = useRef(null);
  const live = useRef({});
  const liveBarRef = useRef(null);
  useBarClock(liveBarRef, step);
  const [legend, setLegend] = useState(null);
  const [tool, setTool] = useState('cursor');
  const [magnet, setMagnet] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState(null);
  const [drawings, setDrawings] = useLocalStorage(`kinu.draw.swap.${tokenId}.${mode}`, []);
  live.current = { drawings, selected, hidden, tool, magnet, setDrawings, setSelected, setTool, requestOlder: history.request, multiplier };
  useDrawingKeys(live, pendingRef, paintRef);
  useEffect(() => {
    paintRef.current?.();
  }, [drawings, selected, hidden]);

  const viewKey = `${tokenId}|${pool?.address}|${resolution}|${usdView}|${mode}|${data?.source}`;

  // The chart is built once per view (token, pool, timeframe, unit, price / market cap) and its
  // candles are replaced in place when they change (a refresh, older history). Replacing the data
  // keeps the user's zoom and scroll; rebuilding the chart would move the view.
  const apiRef = useRef(null); // { chart, series, volume, lines, byTime, times, drawingLayer, fresh }
  const [scale, setScale] = useLocalStorage('kinu.swap.scale', 'normal'); // 'normal' | 'log' | 'pct'
  const hasData = scaled.length > 0;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasData) return undefined;
    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: 'rgba(226, 234, 245, 0.55)', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: 0 },
      localization: { priceFormatter: axisPrice }
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineStyle: 2
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    const api = { chart, series, volume, container, lines: [], byTime: new Map(), times: [], drawingLayer: null, fresh: true };
    apiRef.current = api;

    // Reaching the first candle loads the history before it.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && range.from < 3) live.current.requestOlder?.(api.times[0]);
    });
    chart.subscribeCrosshairMove((param) => setLegend(param?.time ? api.byTime.get(param.time) || null : null));

    return () => {
      apiRef.current = null;
      paintRef.current = null;
      liveBarRef.current = null;
      api.drawingLayer?.dispose();
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, hasData]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !scaled.length) return;
    const { chart, series, volume, container } = api;
    const max = Math.max(...scaled.map((c) => c.high));
    const minMove = max > 0 ? 10 ** (Math.floor(Math.log10(max)) - 5) : 1e-8;
    series.applyOptions({ priceFormat: { type: 'custom', formatter: axisPrice, minMove } });
    series.setData(scaled.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    volume.setData(scaled.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(34,226,131,0.28)' : 'rgba(255,93,108,0.28)' })));
    liveBarRef.current = { series, volume, bar: scaled[scaled.length - 1], line: false };
    api.times = scaled.map((c) => c.time);
    api.byTime = new Map(scaled.map((c) => [c.time, c]));

    // High / Low of the loaded range, as on Jupiter.
    api.lines.forEach((line) => series.removePriceLine(line));
    const hi = scaled.reduce((m, c) => Math.max(m, c.high), -Infinity);
    const lo = scaled.reduce((m, c) => Math.min(m, c.low), Infinity);
    const mark = { color: 'rgba(79,179,255,0.55)', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, axisLabelColor: '#1b3b55', axisLabelTextColor: '#9fd3ff' };
    api.lines = [series.createPriceLine({ ...mark, price: hi, title: 'High' }), series.createPriceLine({ ...mark, price: lo, title: 'Low' })];

    // Free zoom and scroll, as on TradingView: scrolling past the first candle loads older history.
    if (api.fresh) {
      api.fresh = false;
      chart.timeScale().setVisibleLogicalRange({ from: Math.min(Math.max(0, scaled.length - 120), scaled.length - 60), to: scaled.length + 6 });
    }

    // Drawings map times to bar positions: re-attach them to the new bars.
    api.drawingLayer?.dispose();
    api.drawingLayer = attachDrawings({ chart, series, data: scaled, step, container, canvas: canvasRef.current, live, pendingRef });
    paintRef.current = api.drawingLayer.paint;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaled, viewKey, hasData]);

  // Liquidity levels at their distance from the last price, so they read the same in USD, NEAR,
  // a pool's own quote or market cap.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !scaled.length) return;
    (api.levelLines || []).forEach((line) => api.series.removePriceLine(line));
    const last = scaled[scaled.length - 1].close;
    api.levelLines = levels.map((l) =>
      api.series.createPriceLine({
        price: last * (1 + l.pct / 100),
        color: LEVEL_COLOR[l.kind === 'thin' ? 'thin' : l.side],
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: LEVEL_TITLE[l.kind][l.side]
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels, scaled, viewKey, hasData]);

  // The wallet's buys and sells on their candles.
  const myGroups = useMemo(() => {
    if (!scaled.length) return new Map();
    const sources = [];
    if (showMine && accountId && myTrades.data?.length) sources.push({ who: 'me', label: 'You', trades: myTrades.data });
    (trackedTrades.data || []).forEach((trades, i) => {
      const w = trackedOn[i];
      const big = (trades || []).filter((tr) => tr.usd >= w?.minUsd);
      if (w && big.length) sources.push({ who: w.id, label: w.label, emoji: w.emoji, color: w.color, trades: big });
    });
    return sources.length ? bubblesFor(sources, scaled.map((c) => c.time), token?.decimals) : new Map();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMine, accountId, myTrades.data, trackedTrades.data, trackedSig, scaled, token?.decimals]);
  const bubblesRef = useRef(null);
  const [tip, setTip] = useState(null); // { key, x, y }
  useEffect(() => setTip(null), [viewKey, showMine, trackedIds]);
  const bubbleAt = (e) => {
    const el = e.target.closest?.('.trade-bubble');
    if (!el) return null;
    return { key: el.dataset.key, x: el.offsetLeft, y: el.offsetTop };
  };
  const tipGroup = tip ? myGroups.get(tip.key) : null;
  useEffect(() => {
    const layer = bubblesRef.current;
    if (!layer) return undefined;
    layer.innerHTML = '';
    layer.dataset.html = '';
    if (!myGroups.size) return undefined;
    let frame;
    const loop = () => {
      if (apiRef.current) placeBubbles(layer, apiRef.current, myGroups);
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frame);
  }, [myGroups, viewKey, hasData]);

  // Price scale mode (% / log), also on a new chart.
  useEffect(() => applyScale(apiRef.current?.chart, scale), [scale, viewKey, hasData]);
  const auto = useAutoScale(() => apiRef.current?.chart || null, containerRef, `${viewKey}|${hasData}`);

  // Market candles stay live: Intear pushes the latest candle after every block that moved it.
  const [tick, setTick] = useState(null);
  const liveSource = data?.source === 'market';
  const liveQuote = data?.usd ? 'usd' : 'near';
  useEffect(() => {
    setTick(null);
    if (!liveSource || !tokenId) return undefined;
    return subscribeCandles(
      { tokenIds: [tokenId], resolution, quote: liveQuote },
      (byToken) => {
        const bars = byToken[tokenId];
        const bar0 = liveBarRef.current;
        if (!bars?.length || !bar0) return;
        const m = live.current.multiplier || 1;
        bars.forEach((c) => {
          if (c.time < bar0.bar.time) return; // the chart can only update its latest bar
          const bar = { time: c.time, open: c.open * m, high: c.high * m, low: c.low * m, close: c.close * m, volume: c.volume };
          try {
            bar0.series.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
            bar0.volume?.update({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? 'rgba(34,226,131,0.28)' : 'rgba(255,93,108,0.28)' });
            bar0.bar = bar;
            setTick(bar);
          } catch {
            // the chart was rebuilt meanwhile
          }
        });
      },
      () => loaded.reload()
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSource, tokenId, resolution, liveQuote]);

  // The latest candle: the live one once the socket has pushed it.
  const lastLoaded = scaled[scaled.length - 1];
  const last = tick && lastLoaded && tick.time >= lastLoaded.time ? tick : lastLoaded;
  const shown = legend || last;
  const change = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : null;
  const pairLabel = `${token?.symbol}/${usdView ? 'USD' : quoteSymbol}`;
  const sourceLabel = data?.source === 'pool' ? `${pool?.name}${pool?.fee ? ` ${pool.fee}` : ''} · GeckoTerminal` : 'all pools · Intear · live';
  const loading = loaded.loading && !data;
  const message =
    mode === 'mcap' && !supply
      ? 'Market cap unavailable: circulating supply unknown.'
      : loaded.error && !data
        ? 'Chart data unavailable right now.'
        : data && !data.candles.length
          ? `No trading history for ${token?.symbol} yet.`
          : null;

  return (
    <section className="card swap-chart" aria-label={`${token?.symbol} chart`}>
      <div className="chart-toolbar swap-chart__toolbar">
        <div className="segmented" role="group" aria-label="Timeframe">
          {RESOLUTIONS.map((r) => (
            <button key={r.key} type="button" className={resolution === r.key ? 'active' : ''} onClick={() => setResolution(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Price or market cap">
          <button type="button" className={mode === 'price' ? 'active' : ''} onClick={() => setMode('price')}>
            Price
          </button>
          <button type="button" className={mode === 'mcap' ? 'active' : ''} onClick={() => setMode('mcap')}>
            MCap
          </button>
        </div>
        {quoteSymbol && (
          <div className="segmented" role="group" aria-label="Quote currency">
            <button type="button" className={unit === 'usd' ? 'active' : ''} onClick={() => setUnit('usd')}>
              USD
            </button>
            <button type="button" className={unit === 'quote' ? 'active' : ''} onClick={() => setUnit('quote')}>
              {quoteSymbol}
            </button>
          </div>
        )}
        <div className="segmented" role="group" aria-label="Trades on the chart">
          {accountId && (
            <button
              type="button"
              className={showMine ? 'active' : ''}
              aria-pressed={showMine}
              title="Show your buys (B) and sells (S) on the chart"
              onClick={() => setShowMine(!showMine)}
            >
              My trades
            </button>
          )}
          {tracked.length ? (
            <button
              type="button"
              className={showTracked ? 'active' : ''}
              aria-pressed={showTracked}
              title="Show the trades of the wallets in your Wallet Tracker"
              onClick={() => setShowTracked(!showTracked)}
            >
              Tracked ({tracked.length})
            </button>
          ) : null}
          <Link className="swap-chart__track" to="/discover?tab=tracker" title={tracked.length ? 'Manage tracked wallets' : 'Track wallets: their trades show on this chart'}>
            {tracked.length ? '⚙' : '+ Track wallets'}
          </Link>
        </div>
        <div className="segmented" role="group" aria-label="Liquidity levels">
          <button
            type="button"
            className={showLevels ? 'active' : ''}
            aria-pressed={showLevels}
            title="Buy and sell walls from the liquidity of every Rhea pool"
            onClick={() => setShowLevels(!showLevels)}
          >
            Levels
          </button>
          <Link className="swap-chart__track swap-chart__analysis" to={`/analysis?token=${encodeURIComponent(tokenId || '')}`} title={`Pool Analysis: ${token?.symbol} liquidity, walls and price impact`}>
            Analysis ↗
          </Link>
        </div>
        <span className="chart-toolbar__spacer" />
        {onFlip && (
          <button type="button" className="swap-chart__flip" onClick={onFlip} title={`Flip chart to ${counter?.symbol}`} aria-label={`Flip chart to ${counter?.symbol}`}>
            ⇄ {counter?.symbol}
          </button>
        )}
        {pools?.length > 0 && (
          <label className="swap-chart__pool">
            <span className="sr-only">Chart pool</span>
            <select value={pool?.address || MARKET} onChange={(e) => setPoolAddress(e.target.value)}>
              <option value={MARKET}>All pools · market price · live</option>
              {pools.map((p) => (
                <option key={p.address} value={p.address}>
                  {p.name}
                  {p.fee ? ` ${p.fee}` : ''} · {p.dex === 'rhea-finance' ? 'Rhea' : p.dex} · TVL {formatUsd(p.tvl)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="chart-legend">
        <span className="chart-legend__title">
          {pairLabel} · {RESOLUTIONS.find((r) => r.key === resolution)?.label} · {sourceLabel}
        </span>
        {shown && (
          <span className="chart-legend__ohlc">
            O <b>{formatChartPrice(shown.open)}</b> H <b>{formatChartPrice(shown.high)}</b> L <b>{formatChartPrice(shown.low)}</b> C{' '}
            <b>{formatChartPrice(shown.close)}</b>
            {change !== null && (
              <em className={change >= 0 ? 'up' : 'down'}>
                {' '}
                {change >= 0 ? '+' : ''}
                {change.toFixed(2)}%
              </em>
            )}
            <span className="muted"> Vol {formatUsd(shown.volume)}</span>
          </span>
        )}
      </div>

      <div className="pro-chart__body" style={height ? { height } : undefined}>
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
        <div className="chart-card__canvas">
          <div ref={containerRef} className="chart-card__container" />
          <div
            ref={bubblesRef}
            className="trade-bubbles"
            onPointerOver={(e) => {
              const b = bubbleAt(e);
              if (b) setTip(b);
            }}
            onPointerOut={(e) => {
              if (e.pointerType === 'mouse' && bubbleAt(e)) setTip(null);
            }}
            onClick={(e) => {
              const b = bubbleAt(e);
              setTip((cur) => (b && !(cur && cur.key === b.key) ? b : null));
            }}
          />
          {tip && tipGroup && (
            <div
              className={`trade-tip ${tip.x > (bubblesRef.current?.clientWidth || 0) / 2 ? 'trade-tip--left' : ''}`}
              style={{ left: tip.x, top: tip.y }}
              role="tooltip"
            >
              <div className="trade-tip__head">
                <strong>
                  {tipGroup.who !== 'me' && <i style={{ background: tipGroup.color }} />}
                  {tipGroup.label}
                </strong>
                <span>{timeAgo(tipGroup.last)}</span>
              </div>
              {tipGroup.who !== 'me' && <div className="trade-tip__wallet">{tipGroup.who}</div>}
              <div className={`trade-tip__side ${tipGroup.side === 'buy' ? 'up' : 'down'}`}>
                {tipGroup.side === 'buy' ? 'Bought' : 'Sold'} ({tipGroup.count})
              </div>
              <dl>
                <dt>Volume</dt>
                <dd>{formatUsd(tipGroup.usd)}</dd>
                <dt>Amount</dt>
                <dd>
                  {formatAmount(tipGroup.amount)} {token?.symbol}
                </dd>
                <dt>Avg price</dt>
                <dd>{tipGroup.amount > 0 ? `$${formatChartPrice(tipGroup.usd / tipGroup.amount)}` : '—'}</dd>
              </dl>
            </div>
          )}
          <canvas ref={canvasRef} className={`draw-canvas ${tool !== 'cursor' ? 'draw-canvas--active' : ''}`} />
          {(loading || message) && <div className="chart-card__overlay">{loading ? <Spinner size={22} /> : <span>{message}</span>}</div>}
        </div>
      </div>
      <ChartFooter
        onRange={(days) => showRange(apiRef.current?.chart, scaled.length, step, days, 6)}
        scale={scale}
        onScale={setScale}
        auto={auto}
      />
    </section>
  );
}
