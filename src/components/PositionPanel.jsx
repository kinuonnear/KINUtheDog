// The pool page's side panel while one of your positions is selected (Meteora-style): add
// liquidity to that position on its own range, rebalance it or remove liquidity. "← New position" goes back to
// the Create position form.

import { useState } from 'react';
import { useApp } from '../state.jsx';
import { pointToPrice } from '../lib/dclLiquidity.js';
import { formatChartPrice } from '../lib/format.js';
import { AddToPositionForm } from './AddToPosition.jsx';
import RebalanceButton from './Rebalance.jsx';
import { DclRemoveForm, depositTitle, summarizeDclGroup } from './DclPositions.jsx';

export default function PositionPanel({ group, x, y, loading, onBack, onDone }) {
  const { prices } = useApp();
  // What the lower part of the panel shows: the add form or the remove form.
  const [view, setView] = useState('add');
  const removing = view === 'remove';
  const { positions } = group;
  const title = depositTitle(group, loading);
  const summary = summarizeDclGroup(positions, x, y, prices);
  const left = Math.min(...positions.map((p) => p.leftPoint));
  const right = Math.max(...positions.map((p) => p.rightPoint));
  const minPrice = pointToPrice(left, x.decimals, y.decimals);
  const maxPrice = pointToPrice(right, x.decimals, y.decimals);
  const earning = positions.filter((p) => p.inRange).length;

  return (
    <div className="pos-panel">
      <div className="pos-panel__head">
        <h3 className="card-title">
          {removing ? 'Remove liquidity' : 'Add liquidity'} <small>· {title}</small>
        </h3>
        <button type="button" className="button button--ghost button--sm" onClick={onBack} title="Back to the Create position form">
          ← New position
        </button>
      </div>

      {/* Adding keeps the position's own range: shown, not editable. */}
      <div className="pos-panel__range">
        <div>
          <span>Range (this position)</span>
          <strong className="mono">
            {summary.fullRange ? 'Full range' : `${formatChartPrice(minPrice)} – ${formatChartPrice(maxPrice)}`}
          </strong>
          <small>
            {y.symbol} per {x.symbol} · {positions.length} bin{positions.length === 1 ? '' : 's'}
          </small>
        </div>
        <span className={`range-badge ${earning ? 'range-badge--in' : ''}`}>
          {earning ? `${earning} of ${positions.length} bins earning` : 'Not earning'}
        </span>
      </div>

      {/* Rebalance / Remove first: they change or close the position; adding below keeps the range. */}
      <div className="pos-panel__rebalance">
        <div className="pos-panel__manage">
          <RebalanceButton positions={positions} x={x} y={y} title={title} onDone={onDone} className="button button--outline button--block" />
          {removing ? (
            <button type="button" className="button button--outline button--block" onClick={() => setView('add')}>
              + Add liquidity
            </button>
          ) : (
            <button type="button" className="button button--danger-outline button--block" onClick={() => setView('remove')}>
              − Remove liquidity
            </button>
          )}
        </div>
        <small className="muted">Rebalance moves it to a new range around the current price; Remove takes some or all of it back.</small>
      </div>

      {removing ? (
        <DclRemoveForm key={group.key} positions={positions} x={x} y={y} onDone={onDone} embedded />
      ) : (
        <AddToPositionForm key={group.key} positions={positions} x={x} y={y} title={title} onDone={onDone} embedded />
      )}
    </div>
  );
}
