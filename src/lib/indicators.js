// Technical indicators over candle arrays ({ time, open, high, low, close }).
// Each returns lightweight-charts line data: [{ time, value }].

export function sma(candles, period) {
  const out = [];
  let sum = 0;
  candles.forEach((c, i) => {
    sum += c.close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: c.time, value: sum / period });
  });
  return out;
}

export function ema(candles, period) {
  const out = [];
  const k = 2 / (period + 1);
  let prev = null;
  candles.forEach((c, i) => {
    if (i < period - 1) return;
    if (prev === null) {
      // Seed with the SMA of the first `period` closes.
      prev = candles.slice(0, period).reduce((s, x) => s + x.close, 0) / period;
    } else {
      prev = c.close * k + prev * (1 - k);
    }
    out.push({ time: c.time, value: prev });
  });
  return out;
}

/** Bollinger Bands: { upper, middle, lower } line data. */
export function bollinger(candles, period = 20, mult = 2) {
  const upper = [];
  const middle = [];
  const lower = [];
  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1).map((c) => c.close);
    const mean = window.reduce((s, v) => s + v, 0) / period;
    const sd = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    const time = candles[i].time;
    upper.push({ time, value: mean + mult * sd });
    middle.push({ time, value: mean });
    lower.push({ time, value: mean - mult * sd });
  }
  return { upper, middle, lower };
}

export const INDICATORS = [
  { key: 'ma20', label: 'MA 20', color: '#ffb547' },
  { key: 'ma50', label: 'MA 50', color: '#5ec8ff' },
  { key: 'ema20', label: 'EMA 20', color: '#c792ff' },
  { key: 'bb', label: 'Bollinger Bands (20, 2)', color: '#3ddc97' },
  { key: 'volume', label: 'Volume', color: '#8b978f' }
];
