// Chart drawing tools rendered on a canvas above lightweight-charts.
// Drawings are stored in data space ({ time, price }) and converted through a
// `geo` adapter each paint, so they stay anchored while panning / zooming:
//   geo = { timeToX, priceToY, width, height, formatPrice }

export const TOOLS = [
  { key: 'cursor', label: 'Crosshair', points: 0 },
  { key: 'trend', label: 'Trend line', points: 2 },
  { key: 'hline', label: 'Horizontal line', points: 1 },
  { key: 'rect', label: 'Rectangle', points: 2 },
  { key: 'fib', label: 'Fib retracement', points: 2 },
  { key: 'measure', label: 'Measure: price, % and time (or hold Shift and drag)', points: 2 }
];

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ['#8a96a8', '#ff5d6c', '#ffb547', '#3ddc97', '#5ec8ff', '#c792ff', '#8a96a8'];

const LINE = '#5ec8ff';
const SELECTED = '#f2f3ee';

function label(ctx, text, x, y, { bg = 'rgba(13,18,16,0.92)', fg = '#e6edf5', align = 'left' } = {}) {
  ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
  const w = ctx.measureText(text).width + 10;
  const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.fillStyle = bg;
  ctx.fillRect(left, y - 9, w, 18);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 5, y);
}

/** "3d 4h", "5h 20m", "45m" for a span of seconds. */
function span(seconds) {
  const s = Math.abs(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.round((s % 3600) / 60);
  if (d) return `${d}d${h ? ` ${h}h` : ''}`;
  if (h) return `${h}h${m ? ` ${m}m` : ''}`;
  return `${m}m`;
}

function handle(ctx, x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#121821';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = SELECTED;
  ctx.stroke();
}

/** Screen coordinates of a drawing's points (null when off the time axis). */
function project(d, geo) {
  return d.points.map((p) => ({ x: geo.timeToX(p.time), y: geo.priceToY(p.price), price: p.price, time: p.time }));
}

export function drawAll(ctx, drawings, geo, selectedId, hoverId = null) {
  ctx.clearRect(0, 0, geo.width, geo.height);
  drawings.forEach((d) => {
    const pts = project(d, geo);
    if (pts.some((p) => p.x === null || p.y === null)) return;
    const selected = d.id === selectedId;
    const color = selected ? SELECTED : d.color || LINE;
    ctx.save();
    ctx.lineWidth = selected ? 2 : d.id === hoverId ? 2.4 : 1.5;
    ctx.strokeStyle = color;

    if (d.type === 'trend') {
      const [a, b] = pts;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x ?? a.x, b.y ?? a.y);
      ctx.stroke();
      if (selected) [a, b].forEach((p) => handle(ctx, p.x, p.y));
    }

    if (d.type === 'hline') {
      const [a] = pts;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, a.y);
      ctx.lineTo(geo.width, a.y);
      ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, geo.formatPrice(a.price), geo.width - 4, a.y, { bg: color, fg: '#0b1204', align: 'right' });
      if (selected) handle(ctx, Math.min(geo.width - 90, Math.max(12, a.x)), a.y);
    }

    if (d.type === 'rect' || d.type === 'measure') {
      const [a, b] = pts;
      const up = b.price >= a.price;
      const fill = d.type === 'measure' ? (up ? 'rgba(34,226,131,0.12)' : 'rgba(255,93,108,0.12)') : 'rgba(94,200,255,0.10)';
      ctx.fillStyle = fill;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeStyle = d.type === 'measure' ? (up ? '#22e283' : '#ff5d6c') : color;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      if (d.type === 'measure') {
        const diff = b.price - a.price;
        const pct = a.price ? (diff / a.price) * 100 : 0;
        const bars = geo.barsBetween ? geo.barsBetween(a.time, b.time) : null;
        const text = `${diff >= 0 ? '+' : ''}${geo.formatPrice(diff)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
        const sub = `${bars !== null ? `${bars} bars · ` : ''}${span(b.time - a.time)}`;
        // Above the box when rising, below it when falling (like TradingView's price range).
        const y = up ? Math.min(a.y, b.y) - 28 : Math.max(a.y, b.y) + 14;
        const bg = up ? '#22e283' : '#ff5d6c';
        label(ctx, text, (a.x + b.x) / 2, y, { align: 'center', bg, fg: '#0b1204' });
        label(ctx, sub, (a.x + b.x) / 2, y + 17, { align: 'center', bg, fg: '#0b1204' });
        // Arrows along the middle: the direction of the move.
        const mx = (a.x + b.x) / 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(mx, a.y);
        ctx.lineTo(mx, b.y);
        ctx.moveTo(a.x, (a.y + b.y) / 2);
        ctx.lineTo(b.x, (a.y + b.y) / 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (selected) [a, b].forEach((p) => handle(ctx, p.x, p.y));
    }

    if (d.type === 'fib') {
      const [a, b] = pts;
      const left = Math.min(a.x, b.x);
      FIB_LEVELS.forEach((level, i) => {
        const price = b.price + (a.price - b.price) * level;
        const y = geo.priceToY(price);
        if (y === null) return;
        ctx.strokeStyle = selected ? SELECTED : FIB_COLORS[i];
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(geo.width, y);
        ctx.stroke();
        label(ctx, `${level} (${geo.formatPrice(price)})`, left + 4, y - 10, { fg: FIB_COLORS[i], bg: 'transparent' });
      });
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (selected) [a, b].forEach((p) => handle(ctx, p.x, p.y));
    }
    ctx.restore();
  });
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/**
 * The point handle of a drawing under (x, y): { drawing, index }, or null. The selected drawing's
 * handles win, then any drawing's (topmost first).
 */
export function handleAt(drawings, geo, x, y, selectedId, tolerance = 10) {
  const order = [...drawings].reverse().sort((a, b) => (b.id === selectedId) - (a.id === selectedId));
  for (const d of order) {
    if (d.type === 'hline') continue; // a horizontal line moves as a whole
    const pts = project(d, geo);
    const index = pts.findIndex((p) => p.x !== null && p.y !== null && Math.hypot(p.x - x, p.y - y) <= tolerance);
    if (index >= 0) return { drawing: d, index };
  }
  return null;
}

/** Topmost drawing within `tolerance` px of (x, y), or null. */
export function hitTest(drawings, geo, x, y, tolerance = 8) {
  for (let i = drawings.length - 1; i >= 0; i -= 1) {
    const d = drawings[i];
    const pts = project(d, geo);
    if (pts.some((p) => p.x === null || p.y === null)) continue;
    const [a, b] = pts;
    if (d.type === 'hline' && Math.abs(y - a.y) <= tolerance) return d;
    if (d.type === 'trend' && distToSegment(x, y, a, b) <= tolerance) return d;
    if ((d.type === 'rect' || d.type === 'measure') && x >= Math.min(a.x, b.x) - tolerance && x <= Math.max(a.x, b.x) + tolerance && y >= Math.min(a.y, b.y) - tolerance && y <= Math.max(a.y, b.y) + tolerance) {
      return d;
    }
    if (d.type === 'fib' && x >= Math.min(a.x, b.x) - tolerance) {
      const hit = FIB_LEVELS.some((level) => {
        const ly = geo.priceToY(b.price + (a.price - b.price) * level);
        return ly !== null && Math.abs(y - ly) <= tolerance;
      });
      if (hit) return d;
    }
  }
  return null;
}
