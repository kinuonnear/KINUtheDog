import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries } from 'lightweight-charts';
import { useAsync, useLocalStorage } from '../hooks.js';
import { fetchOhlc, fetchTokenInfo, intearTokenId, RESOLUTIONS } from '../lib/intear.js';
import { formatChartPrice, formatPercent, formatUsd, shortAccount } from '../lib/format.js';
import { CONTRACTS, ENDPOINTS, NATIVE_NEAR } from '../config.js';
import { Link } from '../router.jsx';
import { attachDrawings, DrawingToolbar, useDrawingKeys } from './chart/DrawingTools.jsx';
import { CopyButton, Spinner, TokenIcon } from './ui.jsx';

const UP = '#22e283';
const DOWN = '#ff5d6c';
const LIVE_REFRESH_MS = 15_000;

/** The charted token's contract: copy, explorer and KINU token page. Native NEAR has none. */
function TokenContract({ token }) {
  if (!token) return null;
  const native = token.id === NATIVE_NEAR.id;
  return (
    <div className="chart-top__ca">
      <span>{native ? 'Native token' : 'Contract'}</span>
      {native ? (
        <div className="chart-top__ca-row">
          <code>NEAR</code>
          <small className="muted">swaps as {CONTRACTS.wrapNear}</small>
        </div>
      ) : (
        <div className="chart-top__ca-row">
          <code title={token.id}>{shortAccount(token.id, 14, 10)}</code>
          <CopyButton text={token.id} />
          <a href={`${ENDPOINTS.explorer}/address/${token.id}`} target="_blank" rel="noopener noreferrer" title="Open in NearBlocks">
            NearBlocks ↗
          </a>
          <Link to={`/token/${encodeURIComponent(token.id)}`} title="Token page on KINU">
            Info
          </Link>
        </div>
      )}
    </div>
  );
}

/** USD price chart in the style of the Intear DEX terminal. `side` picks which token of the pair is charted. */
export default function PriceChart({ tokenIn, tokenOut, side, onSideChange }) {
  const [resolution, setResolution] = useLocalStorage('kinu.chart.resolution', '60');
  const [mode, setMode] = useState('price');
  const [legend, setLegend] = useState(null);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const paintRef = useRef(null);
  const pendingRef = useRef(null);
  const live = useRef({});

  const token = side === 'in' ? tokenIn : tokenOut;
  const tokenId = intearTokenId(token);

  // Drawing tools (same as the pool chart), saved per token and Price / MCap mode.
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

  const info = useAsync(() => fetchTokenInfo(tokenId), [tokenId], { enabled: Boolean(tokenId), refreshMs: 30_000 });
  const supply = info.data?.circulatingSupply;
  const multiplier = mode === 'mcap' ? supply || 0 : 1;
  const mcapUnavailable = mode === 'mcap' && !supply;

  const candles = useAsync(
    () => fetchOhlc({ tokenId, resolution, countBack: 300 }),
    [tokenId, resolution],
    { enabled: Boolean(tokenId) }
  );

  const scaled = useMemo(() => {
    if (!candles.data || !multiplier) return [];
    return candles.data.map((c) => ({
      ...c,
      open: c.open * multiplier,
      high: c.high * multiplier,
      low: c.low * multiplier,
      close: c.close * multiplier
    }));
  }, [candles.data, multiplier]);

  // Build the chart whenever the data set (token / resolution / mode) changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !scaled.length) return undefined;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: 'rgba(226, 234, 245, 0.5)',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 11,
        attributionLogo: false
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.03)' },
        horzLines: { color: 'rgba(255,255,255,0.03)' }
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false, rightOffset: 4 },
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
      priceFormat: { type: 'custom', formatter: formatChartPrice, minMove }
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    const toVolume = (c) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(34,226,131,0.28)' : 'rgba(255,93,108,0.28)'
    });
    series.setData(scaled.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    volume.setData(scaled.map(toVolume));
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, scaled.length - 120), to: scaled.length + 4 });

    const byTime = new Map(scaled.map((c) => [c.time, c]));
    chart.subscribeCrosshairMove((param) => {
      setLegend(param?.time ? byTime.get(param.time) || null : null);
    });

    const step = RESOLUTIONS.find((r) => r.key === resolution)?.seconds || 3600;
    const drawingLayer = attachDrawings({ chart, series, data: scaled, step, container, canvas: canvasRef.current, live, pendingRef });
    paintRef.current = drawingLayer.paint;

    chartRef.current = { chart, series, volume, toVolume, byTime };
    return () => {
      paintRef.current = null;
      drawingLayer.dispose();
      chartRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaled]);

  // Live updates: merge fresh candles into the existing chart without resetting zoom.
  useEffect(() => {
    if (!tokenId || !multiplier) return undefined;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !chartRef.current) return;
      try {
        const fresh = await fetchOhlc({ tokenId, resolution, countBack: 3 });
        const ref = chartRef.current;
        if (!ref) return;
        fresh.forEach((raw) => {
          const c = {
            ...raw,
            open: raw.open * multiplier,
            high: raw.high * multiplier,
            low: raw.low * multiplier,
            close: raw.close * multiplier
          };
          const last = ref.series.data().at(-1);
          if (last && c.time < last.time) return;
          ref.series.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
          ref.volume.update(ref.toVolume(c));
          ref.byTime.set(c.time, c);
        });
      } catch {
        // transient network error: next tick retries
      }
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [tokenId, resolution, multiplier]);

  const last = scaled[scaled.length - 1];
  const shown = legend || last;
  const shownChange = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : null;
  const resolutionLabel = RESOLUTIONS.find((r) => r.key === resolution)?.label || resolution;
  const price = info.data?.price ?? (candles.data?.length ? candles.data[candles.data.length - 1].close : null);
  const loading = candles.loading && !candles.data;
  const message = mcapUnavailable
    ? 'Market cap unavailable: circulating supply unknown.'
    : candles.error
      ? 'Chart data unavailable right now.'
      : candles.data && !candles.data.length
        ? `No trading history for ${token?.symbol} yet.`
        : null;

  return (
    <div className="chart-card card">
      <div className="chart-top">
        <div className="chart-top__token">
          <TokenIcon token={token} size={36} />
          <div>
            <div className="chart-top__symbol">
              <strong>{token?.symbol}</strong>
              <span className="muted">/ USD</span>
            </div>
            <div className="chart-top__price">
              <strong>{price !== null ? `$${formatChartPrice(price)}` : '—'}</strong>
              {info.data?.change24h != null && (
                <em className={info.data.change24h >= 0 ? 'up' : 'down'}>
                  {info.data.change24h >= 0 ? '+' : ''}
                  {formatPercent(info.data.change24h)} 24h
                </em>
              )}
            </div>
          </div>
        </div>

        <TokenContract token={token} />

        <div className="chart-top__stats">
          <div>
            <span>MCap</span>
            <strong>{supply && price ? formatUsd(supply * price) : '—'}</strong>
          </div>
          <div>
            <span>Liquidity</span>
            <strong>{info.data ? formatUsd(info.data.liquidityUsd) : '—'}</strong>
          </div>
          <div>
            <span>Vol 24h</span>
            <strong>{info.data ? formatUsd(info.data.volume24hUsd) : '—'}</strong>
          </div>
          <div>
            <span>Holders</span>
            <strong>{info.data?.holders ? info.data.holders.toLocaleString() : '—'}</strong>
          </div>
        </div>
      </div>

      <div className="chart-toolbar">
        <div className="segmented">
          {RESOLUTIONS.map((r) => (
            <button key={r.key} type="button" className={resolution === r.key ? 'active' : ''} onClick={() => setResolution(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="chart-toolbar__right">
          {tokenIn && tokenOut && tokenIn.id !== tokenOut.id && (
            <div className="segmented">
              {[
                ['in', tokenIn],
                ['out', tokenOut]
              ].map(([key, t]) => (
                <button key={key} type="button" className={side === key ? 'active' : ''} onClick={() => onSideChange(key)}>
                  {t.symbol}
                </button>
              ))}
            </div>
          )}
          <div className="segmented">
            <button type="button" className={mode === 'price' ? 'active' : ''} onClick={() => setMode('price')}>
              Price
            </button>
            <button type="button" className={mode === 'mcap' ? 'active' : ''} onClick={() => setMode('mcap')}>
              MCap
            </button>
          </div>
        </div>
      </div>

      <div className="chart-legend">
        <span className="chart-legend__title">
          {token?.symbol}/USD · {resolutionLabel} · Intear
        </span>
        {shown && (
          <span className="chart-legend__ohlc">
            O <b>{formatChartPrice(shown.open)}</b> H <b>{formatChartPrice(shown.high)}</b> L{' '}
            <b>{formatChartPrice(shown.low)}</b> C <b>{formatChartPrice(shown.close)}</b>
            {shownChange !== null && (
              <em className={shownChange >= 0 ? 'up' : 'down'}>
                {shownChange >= 0 ? '+' : ''}
                {shownChange.toFixed(2)}%
              </em>
            )}
            <span className="muted"> Vol {formatUsd(shown.volume)}</span>
          </span>
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
        <div className="chart-card__canvas">
          <div ref={containerRef} className="chart-card__container" />
          <canvas ref={canvasRef} className={`draw-canvas ${tool !== 'cursor' ? 'draw-canvas--active' : ''}`} />
          {(loading || message) && (
            <div className="chart-card__overlay">{loading ? <Spinner size={22} /> : <span>{message}</span>}</div>
          )}
        </div>
      </div>
    </div>
  );
}
