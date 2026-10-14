// Shareable PnL card: a 1200×675 PNG (X's large-image size) drawn on a canvas in the
// app's theme. Only same-origin or data: images are drawn, so the canvas stays exportable.

import { formatPrice, formatUsd } from './format.js';
import { isQuoteToken } from './intear.js';

const W = 1200;
const H = 675;
const C = {
  bg: '#0b0e14',
  surface: '#121821',
  border: '#1f2733',
  text: '#e6edf5',
  muted: '#8a96a8',
  faint: '#5b6678',
  accent: '#b8ff3d',
  down: '#ff5d6c'
};
const FONT = "'Inter', ui-sans-serif, system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const LOGO = '/site/kinu-logo-256.png';
export const SITE_URL = 'kinudefi.com';

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src || !(src.startsWith('data:') || src.startsWith('/'))) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function circleImage(ctx, img, x, y, size) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, x, y, size, size);
  ctx.restore();
}

/** Shrinks the font until `text` fits in `maxWidth`. */
function fitText(ctx, text, weight, size, maxWidth, family = FONT) {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px ${family}`;
    s -= 4;
  } while (ctx.measureText(text).width > maxWidth && s > 24);
}

/**
 * Backgrounds a user can pick for their card: the KINU theme (Classic), plain black (Minimal) or a
 * picture. An uploaded picture is passed as a data: URL (read in the browser, never uploaded).
 */
export const CARD_BACKGROUNDS = [
  { key: 'classic', label: 'Classic', src: null },
  { key: 'minimal', label: 'Minimal', src: null },
  { key: 'candles', label: 'Candle Rise', src: null, art: true },
  { key: 'constellation', label: 'Constellation', src: null, art: true },
  { key: 'jungle', label: 'Jungle', src: '/site/discover-hero.webp' }
];

/** Draws `img` to cover the whole card (centre-cropped). */
function coverImage(ctx, img) {
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

function themeBackground(ctx, tone) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(260, 330, 0, 260, 330, 620);
  glow.addColorStop(0, tone === 'down' ? 'rgba(255,93,108,0.13)' : 'rgba(184,255,61,0.13)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
}

/* ------------------------------------------------------------------ */
/* Drawn backgrounds ("art"): no image files, sharp at any size        */
/* ------------------------------------------------------------------ */
// Each is drawn from a seed taken from the card's content, so a card always gets the same picture
// (a stable preview) while different cards look different. Colours follow the result: lime for a
// gain, red for a loss. The art sits on the right / bottom; the left stays dark for the numbers.

function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let s = h >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const toneRgb = (tone) => (tone === 'down' ? '255,93,108' : '184,255,61');

/** Darkens the left of the card so the headline numbers read over any art. */
function shadeLeft(ctx, strength = 0.9) {
  const side = ctx.createLinearGradient(0, 0, W, 0);
  side.addColorStop(0, `rgba(8,11,16,${strength})`);
  side.addColorStop(0.5, `rgba(8,11,16,${strength * 0.55})`);
  side.addColorStop(1, 'rgba(8,11,16,0)');
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, W, H);
}

const ART = {
  /** Candlesticks climbing (or sliding, for a loss) on the right. */
  candles(ctx, rgb, rand, card) {
    const down = card.tone === 'down';
    const n = 26;
    const x0 = 560;
    const step = (W - x0 - 30) / n;
    let price = down ? 190 : 470;
    for (let i = 0; i < n; i += 1) {
      const drift = (down ? 1 : -1) * (6 + rand() * 9);
      const open = price;
      const close = price + drift + (rand() - 0.5) * 30;
      const high = Math.min(open, close) - rand() * 26;
      const low = Math.max(open, close) + rand() * 26;
      const fade = 0.15 + (i / n) * 0.6;
      const rising = close < open;
      const color = rising ? '184,255,61' : '255,93,108';
      const cx = x0 + i * step + step / 2;
      ctx.strokeStyle = `rgba(${color},${fade})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, high);
      ctx.lineTo(cx, low);
      ctx.stroke();
      ctx.fillStyle = `rgba(${color},${fade})`;
      ctx.fillRect(cx - step * 0.3, Math.min(open, close), step * 0.6, Math.max(3, Math.abs(close - open)));
      price = close;
    }
    // Trend line.
    ctx.strokeStyle = `rgba(${rgb},0.7)`;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(x0, down ? 170 : 500);
    ctx.lineTo(W - 20, price);
    ctx.stroke();
    ctx.setLineDash([]);
  },

  /** Points of a network joined by faint lines, gathered on the right. */
  constellation(ctx, rgb, rand) {
    const pts = Array.from({ length: 70 }, () => [460 + rand() ** 0.7 * 740, 20 + rand() * (H - 40), 1 + rand() * 2.6]);
    ctx.lineWidth = 1;
    pts.forEach(([ax, ay], i) => {
      for (let j = i + 1; j < pts.length; j += 1) {
        const [bx, by] = pts[j];
        const d = Math.hypot(ax - bx, ay - by);
        if (d < 150) {
          ctx.strokeStyle = `rgba(${rgb},${0.32 * (1 - d / 150)})`;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
      }
    });
    pts.forEach(([x, y, r]) => {
      ctx.fillStyle = `rgba(${rgb},0.95)`;
      ctx.shadowColor = `rgba(${rgb},0.9)`;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.shadowBlur = 0;
  }
};

/** Background `key` from ART drawn for `card` (base colour, art, then the left shade). */
function artBackground(ctx, key, card) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ART[key](ctx, toneRgb(card.tone), seeded(`${key}|${card.title}|${card.value}`), card);
  shadeLeft(ctx);
}

/** A small preview of a drawn background, for the picker (data: URL). */
export function backgroundThumb(key, tone = 'up') {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 135;
  const ctx = canvas.getContext('2d');
  ctx.scale(240 / W, 135 / H);
  artBackground(ctx, key, { tone, title: 'preview', value: key });
  return canvas.toDataURL('image/png');
}

/** A small area chart of `values` (e.g. cumulative PnL) inside box { x, y, w, h }. */
function drawSpark(ctx, values, box, color) {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const px = (i) => box.x + (i / (values.length - 1)) * box.w;
  const py = (v) => box.y + box.h - ((v - min) / span) * box.h;
  ctx.save();
  // Zero line.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(box.x, py(0));
  ctx.lineTo(box.x + box.w, py(0));
  ctx.stroke();
  ctx.setLineDash([]);
  // Area and line.
  const fill = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
  fill.addColorStop(0, color === C.down ? 'rgba(255,93,108,0.28)' : 'rgba(184,255,61,0.28)');
  fill.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.lineTo(px(values.length - 1), box.y + box.h);
  ctx.lineTo(px(0), box.y + box.h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px(values.length - 1), py(values[values.length - 1]), 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A picture background, darkened on the left and bottom so the numbers stay readable. */
function pictureBackground(ctx, img) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  coverImage(ctx, img);
  const side = ctx.createLinearGradient(0, 0, W, 0);
  side.addColorStop(0, 'rgba(8,11,16,0.94)');
  side.addColorStop(0.55, 'rgba(8,11,16,0.78)');
  side.addColorStop(1, 'rgba(8,11,16,0.35)');
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, W, H);
  const bottom = ctx.createLinearGradient(0, H - 200, 0, H);
  bottom.addColorStop(0, 'rgba(8,11,16,0)');
  bottom.addColorStop(1, 'rgba(8,11,16,0.9)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, H - 200, W, 200);
}

/**
 * card: {
 *   kicker: 'TOKEN PNL' | 'LP PNL' | 'LP POSITION',
 *   title: 'KINU', icon?: url, icons?: [url, url] (a pair),
 *   value: '+$12.34' | '+48.2%', tone: 'up' | 'down' | '',
 *   sub?: '+48.2%  ·  avg buy $0.0000041',
 *   stats: [[label, value], …] (up to 4)
 * }
 * background: { key, src } from CARD_BACKGROUNDS (or an upload: src is a data: URL); null = Classic.
 */
export async function drawShareCard(card, background = null) {
  await Promise.all([
    document.fonts?.load(`900 120px ${FONT}`),
    document.fonts?.load(`700 20px ${MONO}`)
  ]).catch(() => {});
  const iconSrcs = card.icons || (card.icon ? [card.icon] : []);
  const [logo, bg, ...icons] = await Promise.all([loadImage(LOGO), loadImage(background?.src), ...iconSrcs.map(loadImage)]);
  const minimal = background?.key === 'minimal';

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const toneColor = card.tone === 'down' ? C.down : card.tone === 'up' ? C.accent : C.text;

  const art = ART[background?.key] ? background.key : null;
  if (bg) pictureBackground(ctx, bg);
  else if (art) artBackground(ctx, art, card);
  else if (minimal) {
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, W, H);
  } else themeBackground(ctx, card.tone);
  if (!minimal && !art) {
    // The KINU flow line.
    ctx.strokeStyle = 'rgba(184,255,61,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 596);
    ctx.bezierCurveTo(260, 556, 420, 636, 700, 591);
    ctx.bezierCurveTo(900, 561, 1050, 571, W, 596);
    ctx.stroke();
  }

  // Header: the KINU brand, large — every shared card advertises KINU.
  if (logo) circleImage(ctx, logo, 60, 40, 72);
  ctx.fillStyle = C.text;
  ctx.font = `900 40px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('KINU', 148, 66);
  ctx.fillStyle = C.muted;
  ctx.font = `800 16px ${MONO}`;
  ctx.fillText('× RHEA FINANCE', 150, 100);
  // Kicker as a pill on the right.
  ctx.font = `800 17px ${MONO}`;
  const kw = ctx.measureText(card.kicker).width + 32;
  roundRect(ctx, W - 64 - kw, 58, kw, 38, 19);
  ctx.fillStyle = 'rgba(184,255,61,0.14)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(184,255,61,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = C.accent;
  ctx.textAlign = 'center';
  ctx.fillText(card.kicker, W - 64 - kw / 2, 78);
  ctx.textAlign = 'left';

  // Asset line: one icon, or two overlapping for a pair.
  let x = 64;
  const shown = icons.filter(Boolean);
  shown.forEach((img, i) => {
    if (i > 0) {
      ctx.beginPath();
      ctx.arc(x + i * 42 + 32, 200, 35, 0, Math.PI * 2);
      ctx.fillStyle = C.bg;
      ctx.fill();
    }
    circleImage(ctx, img, x + i * 42, 168, 64);
  });
  if (shown.length) x += 82 + (shown.length - 1) * 42;
  ctx.fillStyle = C.text;
  fitText(ctx, card.title, 800, 46, W - x - 64);
  ctx.fillText(card.title, x, 201);

  // Headline value, with a small trend chart on the right when there is history.
  const spark = (card.spark || []).filter(Number.isFinite);
  // Candle Rise already draws a chart on the right: no second one on top.
  const hasSpark = spark.length >= 2 && art !== 'candles';
  // A card without detail boxes (e.g. a single position) gives the result the room: bigger, lower.
  const solo = !(card.stats || []).length;
  ctx.fillStyle = toneColor;
  fitText(ctx, card.value, 900, solo ? 170 : 132, W - 128 - (hasSpark ? 360 : 0));
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(card.value, 58, solo ? 430 : 370);
  if (card.sub) {
    ctx.fillStyle = C.muted;
    fitText(ctx, card.sub, 700, solo ? 30 : 26, W - 128);
    ctx.fillText(card.sub, 64, solo ? 492 : 418);
  }
  if (hasSpark) drawSpark(ctx, spark, { x: W - 64 - 320, y: 258, w: 320, h: 120 }, toneColor);

  // Stat boxes: [label, value, icon?]. Each box is as wide as what it holds; when they would not
  // fit side by side, they share the width equally (and long values shrink to fit).
  const stats = (card.stats || []).slice(0, 4);
  const statIcons = await Promise.all(stats.map((s) => loadImage(s[2])));
  const GAP = 16;
  const ICON = 30;
  const widthOf = ([label, value], icon) => {
    ctx.font = `700 14px ${MONO}`;
    const lw = ctx.measureText(label.toUpperCase()).width;
    ctx.font = `800 28px ${FONT}`;
    const vw = ctx.measureText(value).width + (icon ? ICON + 10 : 0);
    return Math.max(lw, vw) + 44;
  };
  let widths = stats.map((s, i) => widthOf(s, statIcons[i]));
  const room = W - 128 - GAP * Math.max(0, stats.length - 1);
  if (widths.reduce((a, b) => a + b, 0) > room) widths = widths.map(() => room / stats.length);
  let bx = 64;
  stats.forEach(([label, value], i) => {
    const boxW = widths[i];
    const icon = statIcons[i];
    roundRect(ctx, bx, 456, boxW, 92, 16);
    ctx.fillStyle = 'rgba(18,24,33,0.9)';
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = C.faint;
    ctx.font = `700 14px ${MONO}`;
    ctx.fillText(label.toUpperCase(), bx + 20, 490);
    let vx = bx + 20;
    if (icon) {
      circleImage(ctx, icon, vx, 506, ICON);
      vx += ICON + 10;
    }
    ctx.fillStyle = C.text;
    fitText(ctx, value, 800, 28, boxW - (vx - bx) - 20);
    ctx.fillText(value, vx, 530);
    bx += boxW + GAP;
  });

  // Footer: the tagline and the address, as a bright button.
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.text;
  ctx.font = `800 24px ${FONT}`;
  ctx.fillText('Manage Liquidity, Made Simple.', 64, 632);
  ctx.font = `900 26px ${FONT}`;
  const uw = ctx.measureText(SITE_URL).width + 44;
  roundRect(ctx, W - 64 - uw, 608, uw, 48, 24);
  ctx.fillStyle = C.accent;
  ctx.fill();
  ctx.fillStyle = '#0b0e14';
  ctx.textAlign = 'center';
  ctx.fillText(SITE_URL, W - 64 - uw / 2, 633);
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))), 'image/png');
  });
}

/* ------------------------------------------------------------------ */
/* Card content                                                        */
/* ------------------------------------------------------------------ */

const signedUsd = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatUsd(Math.abs(v))}`;
const signedPct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
const toneOf = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

/** A held token's PnL (row from the portfolio, info from rowPnl). */
export function tokenShareCard(row, info, hideUsd) {
  const symbol = row.token.symbol;
  const pct = Number.isFinite(info.pct) ? info.pct : null;
  const value = hideUsd || pct === null ? (pct === null ? '—' : signedPct(pct)) : signedUsd(info.pnl);
  return {
    kicker: 'TOKEN PNL',
    title: `$${symbol}`,
    icon: row.token.icon,
    value,
    tone: toneOf(info.pnl),
    sub: hideUsd ? 'unrealized return' : pct === null ? 'unrealized PnL' : `${signedPct(pct)} unrealized`,
    stats: [
      ['Avg buy', formatPrice(info.avg)],
      ['Price now', formatPrice(row.price)],
      hideUsd ? ['Return', pct === null ? '—' : signedPct(pct)] : ['Realized', signedUsd(info.realized || 0)]
    ],
    text: `My $${symbol} PnL: ${pct === null ? value : signedPct(pct)} 📈\n\nTracked with @KINUonNEAR — Manage Liquidity, Made Simple 🐕`
  };
}

const pairLabel = (x, y) => (x && y ? `${x.symbol} / ${y.symbol}` : '—');
const updatedAt = () =>
  new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

/** Cumulative realized LP PnL per day (useLpHistory days), for the card's small chart. */
function cumulative(days) {
  let sum = 0;
  return (days || []).map((d) => (sum += d.pnl));
}

/**
 * The account's total CLMM LP PnL (stats from useLpHistory). Total PnL = position value change +
 * realized withdrawals + trading fees earned, over every position the history covers.
 */
export function lpShareCard(stats, hideUsd, { days, hidePool = false } = {}) {
  const ret = Number.isFinite(stats.returnPct) ? signedPct(stats.returnPct) : '—';
  const pool = stats.mainPair ? pairLabel(...stats.mainPair) : '—';
  // Just the main pair (the largest position): a pool count reads as part of the name.
  const pools = pool;
  // The pair's base token (not NEAR or a stablecoin) gives the Pool box its icon.
  const baseIcon = (stats.mainPair?.find((t) => !isQuoteToken(t.id)) || stats.mainPair?.[0])?.icon;
  return {
    kicker: 'LP PnL',
    title: 'Total LP Profit & Loss',
    value: hideUsd ? ret : signedUsd(stats.totalPnl),
    tone: toneOf(stats.totalPnl),
    sub: hideUsd ? 'Return on liquidity provided' : 'Fees included',
    updated: updatedAt(),
    spark: cumulative(days),
    stats: hideUsd
      ? [
          ['Return', ret],
          ['Positions', String(stats.closedCount + (stats.openValue > 0 ? 1 : 0))],
          ...(hidePool ? [] : [['Pool', pools, baseIcon]])
        ]
      : [
          ['Trading fees', formatUsd(stats.fees)],
          ['LP position value', stats.openValue > 0 ? formatUsd(stats.openValue) : '$0'],
          ['Return', ret],
          ...(hidePool ? [] : [['Pool', pools, baseIcon]])
        ],
    text: hideUsd
      ? `💧 My liquidity on Rhea Finance: ${ret} return, trading fees included.\n\nManage Liquidity, Made Simple — @KINUonNEAR 🐕`
      : `💧 My liquidity on Rhea Finance: ${signedUsd(stats.totalPnl)} total LP PnL (${ret}), incl. ${formatUsd(stats.fees)} in trading fees.\n\nManage Liquidity, Made Simple — @KINUonNEAR 🐕`
  };
}

/**
 * One LP position (or a pool's positions): p = { known, pnl, pnlPct, fees } (Liquidity table's
 * perf() or the pool page's usePoolPnl), summary from summarizeDclGroup. PnL = value now + fees
 * earned + withdrawn − invested. The card shows just the result: PnL (or the return with
 * amounts hidden); while the PnL isn't known yet, the position's value.
 */
export function positionShareCard({ x, y, poolId, summary, p, age }, hideUsd, { hidePool = false } = {}) {
  const fee = poolId ? `${Number(poolId.split('|')[2]) / 10000}% fee` : '';
  const known = p?.known;
  const ret = known && Number.isFinite(p.pnlPct) ? signedPct(p.pnlPct) : null;
  const range = summary.fullRange ? 'Full range' : summary.inRange ? 'In range' : 'Out of range';
  const value = known ? (hideUsd ? ret || '—' : signedUsd(p.pnl)) : hideUsd ? range : formatUsd(summary.usd);
  const sub = known
    ? hideUsd
      ? 'Return · fees included'
      : `Position PnL${ret ? ` · ${ret}` : ''} · fees included`
    : p === null
      ? 'Position value · calculating PnL…' // the pool page is still reading the history
      : 'Position value';
  return {
    kicker: 'LP POSITION',
    // hidePool: the card and the post don't say which pool it is.
    title: hidePool ? 'My LP position' : `${pairLabel(x, y)}${fee ? ` · ${fee}` : ''}`,
    icons: hidePool ? [] : [x.icon, y.icon],
    value,
    tone: known ? toneOf(p.pnl) : 'up',
    sub,
    updated: updatedAt(),
    stats: [],
    text: `💧 My ${hidePool ? '' : `${pairLabel(x, y)} `}liquidity on Rhea Finance: ${
      known ? `${hideUsd ? ret || '—' : `${signedUsd(p.pnl)}${ret ? ` (${ret})` : ''}`} PnL, fees included` : hideUsd ? range.toLowerCase() : `${formatUsd(summary.usd)} position, ${range.toLowerCase()}`
    }${age ? ` · held ${age}` : ''}.\n\nManage Liquidity, Made Simple — @KINUonNEAR 🐕`
  };
}
