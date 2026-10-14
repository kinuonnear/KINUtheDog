// Swap page chart, Jupiter-style: candles of the pool that pairs the charted token with the other
// side of the swap (GeckoTerminal), priced in USD or in that pool's other token, as price or
// market cap. Falls back to Intear's market candles when the pool has no history or GeckoTerminal
// is busy. The view (zoom, scroll, price scale) survives the minute refreshes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries } from 'lightweight-charts';
import { useAsync, useLocalStorage } from '../../hooks.js';
import { fetchOhlc, fetchTokenInfo, intearTokenId, RESOLUTIONS } from '../../lib/intear.js';
import { fetchPoolOhlc } from '../../lib/gecko.js';
import { chartPoolFor } from '../../lib/tokenMarket.js';
import { formatChartPrice, formatUsd } from '../../lib/format.js';
import { attachDrawings, DrawingToolbar, useDrawingKeys } from '../chart/DrawingTools.jsx';
import { Spinner } from '../ui.jsx';

const UP = '#b8ff3d';
const DOWN = '#ff5d6c';
const REFRESH_MS = 60_000;

/** The other token's symbol in a pool named like "QTC / wNEAR". */
function otherSymbol(pool, symbol) {
  const parts = String(pool?.name || '').split(' / ');
  return parts.find((s) => s.toUpperCase() !== String(symbol).toUpperCase()) || parts[1] || '';
}

export default function SwapChart({ token, counter, pools, height }) {
  const tokenId = intearTokenId(token);
  const counterId = counter ? intearTokenId(counter) : null;
  const [resolution, setResolution] = useLocalStorage('kinu.chart.resolution', '60');
  const [unit, setUnit] = useLocalStorage('kinu.swap.unit', 'usd'); // 'usd' | 'quote'
  const [mode, setMode] = useState('price');
  const [poolAddress, setPoolAddress] = useState(null);
  useEffect(() => setPoolAddress(null), [tokenId, counterId]);

  const pool = (pools || []).find((p) => p.address === poolAddress) || chartPoolFor(pools, counterId);
  const quoteSymbol = otherSymbol(pool, token?.symbol);
  const step = RESOLUTIONS.find((r) => r.key === resolution)?.seconds || 3600;

  const info = useAsync(() => fetchTokenInfo(tokenId), [tokenId], { enabled: Boolean(tokenId), refreshMs: 60_000 });
  const supply = info.data?.circulatingSupply;

  const loaded = useAsync(
    async () => {
      if (pool) {
        const usd = unit === 'usd';
        const res = await fetchPoolOhlc({ address: pool.address, tokenId, resolution, usd, countBack: 300 }).catch(() => null);
        if (res?.trades > 0) return { source: 'pool', usd, candles: res.candles };
      }
      return { source: 'market', usd: true, candles: await fetchOhlc({ tokenId, resolution, countBack: 300 }) };
    },
    [tokenId, pool?.address, resolution, unit],
    { enabled: Boolean(tokenId) && pools !== undefined, refreshMs: REFRESH_MS }
  );
  const data = loaded.data;
  const usdView = data ? data.usd : unit === 'usd';
  const multiplier = mode === 'mcap' ? supply || 0 : 1;

  // Volume always reads in USD: pool candles priced in the other token carry volume in it too.
  const scaled = useMemo(() => {
    if (!data?.candles?.length || !multiplier) return [];
    const last = data.candles[data.candles.length - 1].close;
    const volToUsd = data.usd ? 1 : info.data?.price && last ? info.data.price / last : 0;
    return data.candles.map((c) => ({
      time: c.time,
      open: c.open * multiplier,
      high: c.high * multiplier,
      low: c.low * multiplier,
      close: c.close * multiplier,
      volume: (c.volume || 0) * volToUsd
    }));
  }, [data, multiplier, info.data?.price]);

  /* ---- chart ---- */
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const paintRef = useRef(null);
  const pendingRef = useRef(null);
  const live = useRef({});
  const viewRef = useRef(null);
  const [legend, setLegend] = useState(null);
  const [tool, setTool] = useState('cursor');
  const [magnet, setMagnet] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState(null);
  const [drawings, setDrawings] = useLocalStorage(`kinu.draw.swap.${tokenId}.${mode}`, []);
  live.current = { drawings, selected, hidden, tool, magnet, setDrawings, setSelected, setTool };
  useDrawingKeys(live, pendingRef, paintRef);
  useEffect(() => {
    paintRef.current?.();
  }, [drawings, selected, hidden]);

  const viewKey = `${tokenId}|${pool?.address}|${resolution}|${usdView}|${mode}|${data?.source}`;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !scaled.length) return undefined;
    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: 'rgba(226, 234, 245, 0.55)', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: 0 },
      localization: { priceFormatter: formatChartPrice }
    });
    const max = Math.max(...scaled.map((c) => c.high));
    const minMove = max > 0 ? 10 ** (Math.floor(Math.log10(max)) - 5) : 1e-8;
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineStyle: 2,
      priceFormat: { type: 'custom', formatter: formatChartPrice, minMove }
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    series.setData(scaled.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    volume.setData(scaled.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(184,255,61,0.28)' : 'rgba(255,93,108,0.28)' })));

    // High / Low of the loaded range, as on Jupiter.
    const hi = scaled.reduce((m, c) => Math.max(m, c.high), -Infinity);
    const lo = scaled.reduce((m, c) => Math.min(m, c.low), Infinity);
    const mark = { color: 'rgba(79,179,255,0.55)', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, axisLabelColor: '#1b3b55', axisLabelTextColor: '#9fd3ff' };
    series.createPriceLine({ ...mark, price: hi, title: 'High' });
    series.createPriceLine({ ...mark, price: lo, title: 'Low' });

    // Keep the user's view across refreshes of the same chart; a view that followed the latest
    // candle keeps following.
    const times = scaled.map((c) => c.time);
    const lastIdx = times.length - 1;
    const saved = viewRef.current;
    if (saved && saved.key === viewKey && saved.range) {
      const firstAt = times.indexOf(saved.firstTime);
      let shift = firstAt >= 0 ? firstAt : (saved.firstTime - times[0]) / step;
      if (saved.atEnd) shift += lastIdx - (saved.lastIdx + shift);
      chart.timeScale().setVisibleLogicalRange({ from: saved.range.from + shift, to: saved.range.to + shift });
      if (saved.price) {
        chart.priceScale('right').applyOptions({ autoScale: false });
        chart.priceScale('right').setVisibleRange(saved.price);
      }
    } else {
      chart.timeScale().setVisibleLogicalRange({ from: Math.min(Math.max(0, scaled.length - 120), scaled.length - 60), to: scaled.length + 6 });
    }

    const byTime = new Map(scaled.map((c) => [c.time, c]));
    chart.subscribeCrosshairMove((param) => setLegend(param?.time ? byTime.get(param.time) || null : null));
    const drawingLayer = attachDrawings({ chart, series, data: scaled, step, container, canvas: canvasRef.current, live, pendingRef });
    paintRef.current = drawingLayer.paint;

    return () => {
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
      paintRef.current = null;
      drawingLayer.dispose();
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaled]);

  const last = scaled[scaled.length - 1];
  const shown = legend || last;
  const change = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : null;
  const pairLabel = `${token?.symbol}/${usdView ? 'USD' : quoteSymbol}`;
  const sourceLabel = data?.source === 'pool' ? `${pool?.name}${pool?.fee ? ` ${pool.fee}` : ''} · GeckoTerminal` : 'market price · Intear';
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
        {pool && quoteSymbol && (
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
            <select value={pool?.address || ''} onChange={(e) => setPoolAddress(e.target.value)}>
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
    </section>
  );
}
