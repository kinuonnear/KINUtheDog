import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries } from 'lightweight-charts';
import { useAsync } from '../hooks.js';
import { fetchCandles, findRheaPair, TIMEFRAMES } from '../lib/market.js';
import { formatUsd } from '../lib/format.js';
import { Spinner } from './ui.jsx';

const UP = '#b8ff3d';
const DOWN = '#ff5d6c';

function precisionFor(candles) {
  const max = Math.max(...candles.map((c) => c.high).filter((n) => n > 0), 0);
  if (!max) return 4;
  return Math.min(12, Math.max(2, Math.ceil(-Math.log10(max)) + 4));
}

export default function PriceChart({ base, quote }) {
  const [timeframe, setTimeframe] = useState('1h');
  const containerRef = useRef(null);
  const baseAddress = base?.contract || base?.id;
  const quoteAddress = quote?.contract || quote?.id;

  const pair = useAsync(() => findRheaPair(baseAddress, quoteAddress), [baseAddress, quoteAddress], {
    enabled: Boolean(baseAddress && quoteAddress && baseAddress !== quoteAddress)
  });

  const candles = useAsync(
    () => fetchCandles({ pair: pair.data, baseAddress, timeframe }),
    [pair.data?.pairAddress, baseAddress, timeframe],
    { enabled: Boolean(pair.data), refreshMs: 60_000 }
  );

  useEffect(() => {
    const container = containerRef.current;
    const data = candles.data;
    if (!container || !data?.length) return undefined;

    const precision = precisionFor(data);
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
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: 'price', precision, minMove: 10 ** -precision }
    });
    series.setData(data.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume'
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(
      data.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(184,255,61,0.25)' : 'rgba(255,93,108,0.25)'
      }))
    );

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles.data]);

  const last = candles.data?.[candles.data.length - 1];
  const first = candles.data?.[0];
  const change = last && first?.open ? ((last.close - first.open) / first.open) * 100 : null;
  const loading = pair.loading || candles.loading;
  const message = pair.error
    ? 'Market data unavailable right now.'
    : !pair.loading && !pair.data
      ? `No Rhea market chart for ${base?.symbol}/${quote?.symbol} yet.`
      : candles.error
        ? 'Could not load candles.'
        : null;

  return (
    <div className="chart-card card">
      <div className="chart-card__head">
        <div className="chart-card__title">
          <span className="eyebrow">Market</span>
          <strong>
            {base?.symbol} / {quote?.symbol}
          </strong>
          {last && (
            <span className="chart-card__price">
              {last.close.toPrecision(6)}
              {change !== null && (
                <em className={change >= 0 ? 'up' : 'down'}>
                  {change >= 0 ? '+' : ''}
                  {change.toFixed(2)}%
                </em>
              )}
            </span>
          )}
          {pair.data?.liquidity?.usd > 0 && (
            <span className="muted small">Pool liquidity {formatUsd(pair.data.liquidity.usd)}</span>
          )}
        </div>
        <div className="segmented">
          {Object.entries(TIMEFRAMES).map(([key, tf]) => (
            <button
              key={key}
              type="button"
              className={timeframe === key ? 'active' : ''}
              onClick={() => setTimeframe(key)}
            >
              {tf.label}
            </button>
          ))}
        </div>
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
