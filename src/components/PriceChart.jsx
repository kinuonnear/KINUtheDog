import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries } from 'lightweight-charts';
import { useAsync, useLocalStorage } from '../hooks.js';
import { fetchOhlc, fetchTokenInfo, intearTokenId, RESOLUTIONS } from '../lib/intear.js';
import { formatChartPrice, formatPercent, formatUsd } from '../lib/format.js';
import { Spinner, TokenIcon } from './ui.jsx';

const UP = '#b8ff3d';
const DOWN = '#ff5d6c';
const LIVE_REFRESH_MS = 15_000;

/** USD price chart in the style of the Intear DEX terminal. `side` picks which token of the pair is charted. */
export default function PriceChart({ tokenIn, tokenOut, side, onSideChange }) {
  const [resolution, setResolution] = useLocalStorage('kinu.chart.resolution', '60');
  const [mode, setMode] = useState('price');
  const [legend, setLegend] = useState(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  const token = side === 'in' ? tokenIn : tokenOut;
  const tokenId = intearTokenId(token);

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
        textColor: 'rgba(231, 240, 233, 0.5)',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
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
      color: c.close >= c.open ? 'rgba(184,255,61,0.28)' : 'rgba(255,93,108,0.28)'
    });
    series.setData(scaled.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    volume.setData(scaled.map(toVolume));
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, scaled.length - 120), to: scaled.length + 4 });

    const byTime = new Map(scaled.map((c) => [c.time, c]));
    chart.subscribeCrosshairMove((param) => {
      setLegend(param?.time ? byTime.get(param.time) || null : null);
    });

    chartRef.current = { chart, series, volume, toVolume, byTime };
    return () => {
      chartRef.current = null;
      chart.remove();
    };
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
          {info.data?.holders ? (
            <div>
              <span>Holders</span>
              <strong>{info.data.holders.toLocaleString()}</strong>
            </div>
          ) : null}
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

      <div className="chart-card__canvas">
        <div ref={containerRef} className="chart-card__container" />
        {(loading || message) && (
          <div className="chart-card__overlay">{loading ? <Spinner size={22} /> : <span>{message}</span>}</div>
        )}
      </div>
    </div>
  );
}
