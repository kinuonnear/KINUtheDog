// Drawing tools shared by the charts: the left toolbar, its icons, and
// `attachDrawings`, which wires the drawing canvas to a lightweight-charts
// instance (data <-> screen mapping, magnet, click-to-select, placing points).

import { useEffect } from 'react';
import { formatChartPrice } from '../../lib/format.js';
import { drawAll, hitTest, TOOLS } from './drawings.js';

export function ToolIcon({ kind }) {
  const paths = {
    cursor: <path d="M9 2v14M2 9h14" />,
    trend: <path d="M3 15 15 3" />,
    hline: <path d="M1 9h16" />,
    rect: <rect x="3" y="4" width="12" height="10" rx="1" />,
    fib: <path d="M2 3h14M2 7h14M2 11h14M2 15h14" />,
    measure: <path d="M3 15 15 3M3 11v4h4M15 7V3h-4" />,
    magnet: <path d="M4 3v6a5 5 0 0 0 10 0V3M4 6h3M11 6h3" />,
    eye: <path d="M1 9s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5ZM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />,
    trash: <path d="M3 5h12M7 5V3h4v2M5 5l1 10h6l1-10" />,
    camera: <path d="M2 6h3l2-2h4l2 2h3v9H2ZM9 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />,
    expand: <path d="M2 7V2h5M11 2h5v5M16 11v5h-5M7 16H2v-5" />,
    candles: <path d="M5 2v14M3 5h4v7H3ZM13 2v14M11 7h4v5h-4Z" />,
    line: <path d="M2 14 7 8l4 3 5-7" />
  };
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

/** Vertical toolbar: tools, magnet, hide, delete (selected drawing, or all). */
export function DrawingToolbar({ tool, onTool, magnet, setMagnet, hidden, setHidden, selected, onDelete }) {
  return (
    <div className="pro-chart__tools" role="toolbar" aria-label="Drawing tools">
      {TOOLS.map((t) => (
        <button
          key={t.key}
          type="button"
          title={t.label}
          aria-label={t.label}
          className={`dtool ${tool === t.key ? 'dtool--active' : ''}`}
          onClick={() => onTool(t.key)}
        >
          <ToolIcon kind={t.key} />
        </button>
      ))}
      <span className="dtool-sep" />
      <button type="button" title="Magnet: snap to OHLC" aria-label="Magnet" className={`dtool ${magnet ? 'dtool--on' : ''}`} onClick={() => setMagnet(!magnet)}>
        <ToolIcon kind="magnet" />
      </button>
      <button
        type="button"
        title={hidden ? 'Show drawings' : 'Hide drawings'}
        aria-label={hidden ? 'Show drawings' : 'Hide drawings'}
        className={`dtool ${hidden ? 'dtool--on' : ''}`}
        onClick={() => setHidden(!hidden)}
      >
        <ToolIcon kind="eye" />
      </button>
      <button
        type="button"
        title={selected ? 'Delete selected drawing' : 'Remove all drawings'}
        aria-label={selected ? 'Delete selected drawing' : 'Remove all drawings'}
        className="dtool"
        onClick={onDelete}
      >
        <ToolIcon kind="trash" />
      </button>
    </div>
  );
}

/** Delete removes the selected drawing; Esc cancels the active tool. `live` is a ref to current state. */
export function useDrawingKeys(live, pendingRef, paintRef) {
  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && live.current.selected) {
        live.current.setDrawings((list) => list.filter((d) => d.id !== live.current.selected));
        live.current.setSelected(null);
      }
      if (e.key === 'Escape') {
        pendingRef.current = null;
        live.current.setTool('cursor');
        paintRef.current?.();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [live, pendingRef, paintRef]);
}

/**
 * Connects the drawing canvas to a chart. Drawings live in { time, price } space.
 * `live.current` must hold { drawings, selected, hidden, tool, magnet, setDrawings, setSelected, setTool }.
 * Returns { paint, dispose }.
 */
export function attachDrawings({ chart, series, data, step, container, canvas, live, pendingRef }) {
  const times = data.map((c) => c.time);
  const lastIdx = times.length - 1;
  const logicalOf = (t) => {
    if (t <= times[0]) return (t - times[0]) / step;
    if (t >= times[lastIdx]) return lastIdx + (t - times[lastIdx]) / step;
    let lo = 0;
    let hi = lastIdx;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo + (t - times[lo]) / Math.max(1, times[hi] - times[lo]);
  };
  const timeOf = (logical) => {
    if (logical <= 0) return times[0] + logical * step;
    if (logical >= lastIdx) return times[lastIdx] + (logical - lastIdx) * step;
    const i = Math.floor(logical);
    return times[i] + (logical - i) * (times[i + 1] - times[i]);
  };
  const geo = {
    width: 0,
    height: 0,
    timeToX: (t) => chart.timeScale().logicalToCoordinate(logicalOf(t)),
    priceToY: (p) => series.priceToCoordinate(p),
    formatPrice: formatChartPrice,
    barsBetween: (a, b) => Math.round(Math.abs(logicalOf(b) - logicalOf(a)))
  };
  const toData = (px, py) => {
    const logical = chart.timeScale().coordinateToLogical(px);
    let price = series.coordinateToPrice(py);
    const time = timeOf(logical ?? lastIdx);
    if (live.current.magnet && logical !== null) {
      const bar = data[Math.min(lastIdx, Math.max(0, Math.round(logical)))];
      const dist = (v) => Math.abs((series.priceToCoordinate(v) ?? Infinity) - py);
      const snap = [bar.open, bar.high, bar.low, bar.close].reduce((best, v) => (dist(v) < dist(best) ? v : best));
      if (dist(snap) < 14) price = snap;
    }
    return { time: Math.round(time), price };
  };

  const ctx = canvas.getContext('2d');
  let disposed = false;
  const paint = () => {
    if (disposed) return;
    const width = Math.max(0, container.clientWidth - chart.priceScale('right').width());
    const height = Math.max(0, container.clientHeight - chart.timeScale().height());
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    geo.width = width;
    geo.height = height;
    const pending = pendingRef.current ? [pendingRef.current] : [];
    drawAll(ctx, live.current.hidden ? pending : [...live.current.drawings, ...pending], geo, live.current.selected);
  };

  // Repaint on chart changes; every frame only while the pointer is over the chart.
  let frame = null;
  const loop = () => {
    paint();
    frame = requestAnimationFrame(loop);
  };
  const startLoop = () => {
    if (frame === null) frame = requestAnimationFrame(loop);
  };
  const stopLoop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    paint();
  };
  const host = container.parentElement;
  host.addEventListener('pointerenter', startLoop);
  host.addEventListener('pointerleave', stopLoop);
  chart.timeScale().subscribeVisibleLogicalRangeChange(paint);
  const resize = new ResizeObserver(() => requestAnimationFrame(paint));
  resize.observe(container);
  requestAnimationFrame(paint);

  // Cursor mode: click selects a drawing.
  chart.subscribeClick((param) => {
    if (live.current.tool !== 'cursor' || !param?.point) return;
    const hit = live.current.hidden ? null : hitTest(live.current.drawings, geo, param.point.x, param.point.y);
    live.current.setSelected(hit ? hit.id : null);
  });

  // Drawing tools: the canvas captures pointer events only while a tool is active.
  const pos = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  const finish = (d) => {
    live.current.setDrawings((list) => [...list, d]);
    live.current.setSelected(d.id);
    live.current.setTool('cursor');
  };
  const onDown = (e) => {
    const toolDef = TOOLS.find((t) => t.key === live.current.tool);
    if (!toolDef || toolDef.points === 0) return;
    const point = toData(...pos(e));
    if (toolDef.points === 1) {
      finish({ id: `${Date.now()}`, type: toolDef.key, points: [point] });
      return;
    }
    if (!pendingRef.current) {
      pendingRef.current = { id: `${Date.now()}`, type: toolDef.key, points: [point, point] };
    } else {
      const d = { ...pendingRef.current, points: [pendingRef.current.points[0], point] };
      pendingRef.current = null;
      finish(d);
    }
    paint();
  };
  const onMove = (e) => {
    if (!pendingRef.current) return;
    pendingRef.current = { ...pendingRef.current, points: [pendingRef.current.points[0], toData(...pos(e))] };
    paint();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);

  const dispose = () => {
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    host.removeEventListener('pointerenter', startLoop);
    host.removeEventListener('pointerleave', stopLoop);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    resize.disconnect();
  };
  return { paint, dispose };
}
