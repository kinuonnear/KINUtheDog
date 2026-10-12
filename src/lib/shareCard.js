// Shareable PnL card: a 1200×675 PNG (X's large-image size) drawn on a canvas in the
// app's theme. Only same-origin or data: images are drawn, so the canvas stays exportable.

import { formatPrice, formatUsd } from './format.js';

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
 * card: {
 *   kicker: 'TOKEN PNL' | 'LP PNL',
 *   title: 'KINU', icon?: data/same-origin url,
 *   value: '+$12.34' | '+48.2%', tone: 'up' | 'down' | '',
 *   sub?: '+48.2%  ·  avg buy $0.0000041',
 *   stats: [[label, value], …] (up to 3)
 * }
 */
export async function drawShareCard(card) {
  await Promise.all([
    document.fonts?.load(`900 120px ${FONT}`),
    document.fonts?.load(`700 20px ${MONO}`)
  ]).catch(() => {});
  const [logo, icon] = await Promise.all([loadImage(LOGO), loadImage(card.icon)]);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const toneColor = card.tone === 'down' ? C.down : card.tone === 'up' ? C.accent : C.text;

  // Background: theme base, a soft glow in the PnL colour, a faint grid and flow lines.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(260, 330, 0, 260, 330, 620);
  glow.addColorStop(0, card.tone === 'down' ? 'rgba(255,93,108,0.13)' : 'rgba(184,255,61,0.13)');
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
  ctx.strokeStyle = 'rgba(184,255,61,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 600);
  ctx.bezierCurveTo(260, 560, 420, 640, 700, 595);
  ctx.bezierCurveTo(900, 565, 1050, 575, W, 600);
  ctx.stroke();

  // Header: KINU logo + wordmark, kicker on the right.
  if (logo) circleImage(ctx, logo, 64, 52, 56);
  ctx.fillStyle = C.text;
  ctx.font = `900 30px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('KINU', 134, 81);
  ctx.fillStyle = C.muted;
  ctx.font = `700 15px ${MONO}`;
  ctx.fillText('× RHEA · DEFI TERMINAL', 222, 82);
  ctx.textAlign = 'right';
  ctx.fillStyle = C.accent;
  ctx.font = `700 18px ${MONO}`;
  ctx.fillText(card.kicker, W - 64, 81);
  ctx.textAlign = 'left';

  // Asset line.
  let x = 64;
  if (icon) {
    circleImage(ctx, icon, x, 168, 64);
    x += 82;
  }
  ctx.fillStyle = C.text;
  fitText(ctx, card.title, 800, 46, W - x - 64);
  ctx.fillText(card.title, x, 201);

  // Headline value.
  ctx.fillStyle = toneColor;
  fitText(ctx, card.value, 900, 132, W - 128);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(card.value, 60, 370);
  if (card.sub) {
    ctx.fillStyle = C.muted;
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText(card.sub, 64, 420);
  }

  // Stat boxes.
  const stats = (card.stats || []).slice(0, 3);
  const boxW = (W - 128 - (stats.length - 1) * 16) / Math.max(stats.length, 1);
  stats.forEach(([label, value], i) => {
    const bx = 64 + i * (boxW + 16);
    roundRect(ctx, bx, 460, boxW, 92, 16);
    ctx.fillStyle = 'rgba(18,24,33,0.92)';
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = C.faint;
    ctx.font = `700 14px ${MONO}`;
    ctx.fillText(label.toUpperCase(), bx + 20, 494);
    ctx.fillStyle = C.text;
    fitText(ctx, value, 800, 28, boxW - 40);
    ctx.fillText(value, bx + 20, 532);
  });

  // Footer.
  ctx.fillStyle = C.muted;
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText('KINU-built Swap & Smart LP on Rhea Finance', 64, 640);
  ctx.textAlign = 'right';
  ctx.fillStyle = C.accent;
  ctx.font = `900 22px ${FONT}`;
  ctx.fillText(SITE_URL, W - 64, 640);
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
    text: `My $${symbol} PnL: ${pct === null ? value : signedPct(pct)} 📈 tracked on the KINU Terminal 🐕🌊`
  };
}

/** The account's total CLMM LP PnL (stats from useLpHistory). */
export function lpShareCard(stats, hideUsd) {
  const win = stats.winRate === null ? '—' : `${stats.winRate.toFixed(0)}%`;
  return {
    kicker: 'LP PNL',
    title: 'Smart LP on Rhea Finance',
    value: hideUsd ? `${win} win rate` : signedUsd(stats.totalPnl),
    tone: hideUsd ? 'up' : toneOf(stats.totalPnl),
    sub: hideUsd ? `${stats.closedCount} closed positions` : 'total LP PnL, fees included',
    stats: [
      hideUsd ? ['Pools', 'Rhea CLMM'] : ['Fees earned', formatUsd(stats.fees)],
      ['Win rate', win],
      ['Closed positions', String(stats.closedCount)]
    ],
    text: `My Smart LP results on Rhea: ${hideUsd ? `${win} win rate` : `${signedUsd(stats.totalPnl)} PnL, fees included`} 💧 via the KINU Terminal 🐕🌊`
  };
}
