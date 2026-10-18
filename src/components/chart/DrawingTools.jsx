// Drawing tools shared by the charts: the left toolbar, its icons, and
// `attachDrawings`, which wires the drawing canvas to a lightweight-charts
// instance (data <-> screen mapping, magnet, selecting, placing and editing points).
// Like TradingView: a two-point tool is placed with two clicks or one press-drag-release; in cursor
// mode a drawing is selected by pressing on it, dragged by its body, and reshaped by its handles.

import { useEffect } from 'react';
import { formatChartPrice } from '../../lib/format.js';
import { drawAll, handleAt, hitTest, TOOLS } from './drawings.js';

export function ToolIcon({ kind }) {
  const paths = {
    cursor: <path d="M9 2v14M2 9h14" />,
    trend: <path d="M3 15 15 3" />,
    hline: <path d="M1 9h16" />,
    rect: <rect x="3" y="4" width="12" height="10" rx="1" />,
    fib: <path d="M2 3h14M2 7h14M2 11h14M2 15h14" />,
    // A ruler
    measure: <path d="M2.5 11.5 11.5 2.5l4 4-9 9zM5 9l1.5 1.5M7 7l2 2M9 5l1.5 1.5M11 3.5 12.5 5" />,
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
  // A drawing being dragged is shown from here until the drag ends (one state update, on release).
  let dragged = null;
  let hoverId = null;
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
    const list = dragged ? live.current.drawings.map((d) => (d.id === dragged.id ? dragged : d)) : live.current.drawings;
    drawAll(ctx, live.current.hidden ? pending : [...list, ...pending], geo, live.current.selected, hoverId);
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

  const pos = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  const inPlot = ([x, y]) => x >= 0 && y >= 0 && x <= geo.width && y <= geo.height;

  // ---- Cursor mode: select, move, reshape. Listens before the chart (capture), and only takes the
  // press when it lands on a drawing, so panning and zooming the chart work everywhere else.
  let edit = null; // { id, mode: 'point' | 'move', index, from: { time, price }, orig }
  let quick = false; // a Shift-drag measurement is on screen (in pendingRef)
  const onQuickMove = (e) => {
    if (!quick || !pendingRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    pendingRef.current = { ...pendingRef.current, points: [pendingRef.current.points[0], toData(...pos(e))] };
    paint();
  };
  const onQuickUp = () => {
    window.removeEventListener('pointermove', onQuickMove, true);
    window.removeEventListener('pointerup', onQuickUp, true);
  };
  const onHostDown = (e) => {
    if (live.current.tool !== 'cursor' || e.button > 0) return;
    const p = pos(e);
    if (!inPlot(p)) return;
    // The last quick measurement goes away with the next press.
    if (quick) {
      quick = false;
      pendingRef.current = null;
      paint();
    }
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const point = toData(...p);
      quick = true;
      pendingRef.current = { id: 'quick-measure', type: 'measure', points: [point, point] };
      window.addEventListener('pointermove', onQuickMove, true);
      window.addEventListener('pointerup', onQuickUp, true);
      paint();
      return;
    }
    if (live.current.hidden) return;
    const grip = handleAt(live.current.drawings, geo, p[0], p[1], live.current.selected);
    const body = grip ? grip.drawing : hitTest(live.current.drawings, geo, p[0], p[1]);
    if (!body) {
      if (live.current.selected) live.current.setSelected(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    live.current.setSelected(body.id);
    edit = { id: body.id, mode: grip ? 'point' : 'move', index: grip?.index ?? 0, from: toData(...p), orig: body };
    window.addEventListener('pointermove', onEditMove, true);
    window.addEventListener('pointerup', onEditUp, true);
  };
  const onEditMove = (e) => {
    if (!edit) return;
    e.preventDefault();
    e.stopPropagation();
    const now = toData(...pos(e));
    const o = edit.orig;
    if (edit.mode === 'point') {
      dragged = { ...o, points: o.points.map((pt, i) => (i === edit.index ? now : pt)) };
    } else {
      const dt = now.time - edit.from.time;
      const dp = now.price - edit.from.price;
      dragged = { ...o, points: o.points.map((pt) => ({ time: Math.round(pt.time + dt), price: pt.price + dp })) };
    }
    paint();
  };
  const onEditUp = (e) => {
    window.removeEventListener('pointermove', onEditMove, true);
    window.removeEventListener('pointerup', onEditUp, true);
    if (dragged) {
      const done = dragged;
      live.current.setDrawings((list) => list.map((d) => (d.id === done.id ? done : d)));
      e.stopPropagation();
    }
    dragged = null;
    edit = null;
    paint();
  };
  // Hover: a drawing lights up and the cursor shows what a press would do.
  const onHostMove = (e) => {
    if (edit || live.current.tool !== 'cursor' || live.current.hidden) return;
    const p = pos(e);
    const grip = inPlot(p) ? handleAt(live.current.drawings, geo, p[0], p[1], live.current.selected) : null;
    const body = grip ? grip.drawing : inPlot(p) ? hitTest(live.current.drawings, geo, p[0], p[1]) : null;
    const next = body?.id ?? null;
    container.style.cursor = grip ? 'grab' : body ? 'move' : '';
    if (next !== hoverId) {
      hoverId = next;
      paint();
    }
  };
  host.addEventListener('pointerdown', onHostDown, true);
  host.addEventListener('pointermove', onHostMove, true);

  // ---- Drawing tools: the canvas takes the pointer only while a tool is active. Two clicks, or one
  // press-drag-release, place a two-point drawing.
  const finish = (d) => {
    live.current.setDrawings((list) => [...list, d]);
    live.current.setSelected(d.id);
    live.current.setTool('cursor');
  };
  let pressAt = null; // where the press that started the pending drawing was
  const onDown = (e) => {
    const toolDef = TOOLS.find((t) => t.key === live.current.tool);
    if (!toolDef || toolDef.points === 0) return;
    e.preventDefault();
    const p = pos(e);
    const point = toData(...p);
    if (toolDef.points === 1) {
      finish({ id: `${Date.now()}`, type: toolDef.key, points: [point] });
      return;
    }
    if (!pendingRef.current) {
      pendingRef.current = { id: `${Date.now()}`, type: toolDef.key, points: [point, point] };
      pressAt = p;
      canvas.setPointerCapture?.(e.pointerId);
    } else {
      const d = { ...pendingRef.current, points: [pendingRef.current.points[0], point] };
      pendingRef.current = null;
      pressAt = null;
      finish(d);
    }
    paint();
  };
  const onMove = (e) => {
    if (!pendingRef.current) return;
    pendingRef.current = { ...pendingRef.current, points: [pendingRef.current.points[0], toData(...pos(e))] };
    paint();
  };
  // Released after dragging: that was the second point.
  const onUp = (e) => {
    if (!pendingRef.current || !pressAt) return;
    const p = pos(e);
    const moved = Math.hypot(p[0] - pressAt[0], p[1] - pressAt[1]) > 6;
    pressAt = null;
    if (!moved) return; // a click: wait for the second one
    const d = { ...pendingRef.current, points: [pendingRef.current.points[0], toData(...p)] };
    pendingRef.current = null;
    finish(d);
    paint();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);

  const dispose = () => {
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    host.removeEventListener('pointerenter', startLoop);
    host.removeEventListener('pointerleave', stopLoop);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    host.removeEventListener('pointerdown', onHostDown, true);
    host.removeEventListener('pointermove', onHostMove, true);
    window.removeEventListener('pointermove', onEditMove, true);
    window.removeEventListener('pointerup', onEditUp, true);
    window.removeEventListener('pointermove', onQuickMove, true);
    window.removeEventListener('pointerup', onQuickUp, true);
    resize.disconnect();
  };
  return { paint, dispose };
}
