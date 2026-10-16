// Swap page chart, Jupiter-style. By default the token's market price across every pool (Intear
// API): deep history, in USD or NEAR, kept live over a WebSocket after every block. Any of the
// token's pools can be picked instead (GeckoTerminal candles, refreshed every minute). Scrolling
// back to the first candle loads the history before it; the chart never scrolls past it.
// The view (zoom, scroll, price scale) survives refreshes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries } from 'lightweight-charts';
import { useAsync, useLocalStorage } from '../../hooks.js';
import { fetchOhlc, fetchTokenInfo, intearTokenId, RESOLUTIONS } from '../../lib/intear.js';
import { fetchMarketCandles, subscribeCandles } from '../../lib/intearApi.js';
import { fetchPoolOhlc } from '../../lib/gecko.js';
import { CHART_BARS, lastGood, sameCandles, useBarClock, useOlderCandles, withOlder } from '../../lib/candles.js';
import { formatChartPrice, formatUsd } from '../../lib/format.js';
import { attachDrawings, DrawingToolbar, useDrawingKeys } from '../chart/DrawingTools.jsx';
import ChartFooter, { applyScale, showRange, useAutoScale } from '../chart/ChartFooter.jsx';
import { Spinner } from '../ui.jsx';

const UP = '#22e283';
const DOWN = '#ff5d6c';
const REFRESH_MS = 60_000;
// Market candles load deeper than pool ones (Intear gives up to 5,000 per request).
const MARKET_BARS = 3000;
const MARKET = 'market';
const WNEAR = 'wrap.near';

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

export default function SwapChart({ token, counter, pools, height }) {
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
  const supply = info.data?.circulatingSupply;

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
      return keep(await market());
    },
    [viewOf],
    { enabled: Boolean(tokenId), refreshMs: REFRESH_MS }
  );
  // Never show the previous token's candles while the new ones load. Moving from market to pool
  // candles of the same token keeps the market chart up until the pool's arrive.
  const sameToken = loaded.data?.view?.split('|')[0] === tokenId && loaded.data?.view?.split('|').slice(2).join('|') === `${resolution}|${unit}`;
  const base = sameToken ? loaded.data : undefined;

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
      layout: { background: { color: 'transparent' }, textColor: 'rgba(226, 234, 245, 0.55)', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.08, bottom: 0.22 } },
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
    series.applyOptions({ priceFormat: { type: 'custom', formatter: formatChartPrice, minMove } });
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
        <span className="chart-toolbar__spacer" />
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
