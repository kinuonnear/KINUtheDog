// Pool depth: the pool's liquidity and open limit orders in price buckets around the current
// price, like a CEX order book. Below the price = support, above = resistance.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { getMarketDepth } from '../lib/dclLiquidity.js';
import { buildDepth, DEPTH_VIEWS, invertDepth } from '../lib/poolDepth.js';
import { quoteRank } from '../lib/intear.js';
import { dclPointToPrice } from '../lib/rhea.js';
import { priceOf } from '../lib/tokens.js';
import { formatAmount, formatChartPrice, formatPercent, formatUsd } from '../lib/format.js';
import { ErrorNotice, Skeleton, Tabs } from './ui.jsx';

/** What one whole token is worth: USD when priced, otherwise everything is shown in token Y. */
function valuation(prices, x, y, priceXY) {
  let pX = priceOf(prices, x.id);
  let pY = priceOf(prices, y.id);
  if (pX > 0 && pY > 0) return { valueX: pX, valueY: pY, usd: true };
  if (pY > 0) return { valueX: pY * priceXY, valueY: pY, usd: true };
  if (pX > 0 && priceXY > 0) return { valueX: pX, valueY: pX / priceXY, usd: true };
  return { valueX: priceXY, valueY: 1, usd: false };
}

export default function PoolDepth({ poolId, x, y }) {
  const { prices } = useApp();
  const [viewKey, setViewKey] = useState('100');
  const depth = useAsync(() => getMarketDepth(poolId), [poolId], { refreshMs: 60_000 });

  const model = useMemo(() => {
    if (!depth.data || !Number.isFinite(depth.data.current)) return null;
    const priceXY = dclPointToPrice(depth.data.current, x.decimals, y.decimals);
    const val = valuation(prices, x, y, priceXY);
    const view = DEPTH_VIEWS.find((v) => v.key === viewKey) || DEPTH_VIEWS[0];
    const built = buildDepth({ depth: depth.data, decimalsX: x.decimals, decimalsY: y.decimals, valueX: val.valueX, valueY: val.valueY, view });
    // The asset is the less quote-like token (same rule as the chart). When that is Y (e.g. USDC/QTC:
    // axis = QTC per USDC) the chart reads against the asset's price, so show it from Y's side.
    const invert = quoteRank(x.id) > quoteRank(y.id);
    return { priceXY, usd: val.usd, invert, data: invert ? invertDepth(built, view) : built };
  }, [depth.data, prices, x, y, viewKey]);

  if (depth.error && !depth.data) return <ErrorNotice error={depth.error} onRetry={depth.reload} />;
  if (!model) return <Skeleton height={220} radius={12} />;

  const { data, usd, priceXY, invert } = model;
  const [asset, quote] = invert ? [y, x] : [x, y];
  const priceShown = invert ? 1 / priceXY : priceXY;
  const money = (v) => (usd ? formatUsd(v, { compactAbove: 1e3 }) : `${formatAmount(v)} ${y.symbol}`);
  const empty = data.max === 0 && data.ordersTotal === 0;
  const ordersBeyond = data.ordersBeyond.support + data.ordersBeyond.resistance;
  // Highest price first, like an order book; the current price is the line between the two halves.
  const rows = [...data.rows].reverse();
  const split = rows.findIndex((r) => r.side === 'support');

  const bar = (row) => {
    const w = (v) => (data.max > 0 ? `${(v / data.max) * 100}%` : '0%');
    return (
      <div
        className={`pdepth__row pdepth__row--${row.side}`}
        key={row.k}
        title={`${row.pct > 0 ? '+' : ''}${formatPercent(row.pct, 1)} · ${money(row.total)}${row.orders > 0 ? ` (limit orders ${money(row.orders)})` : ''}`}
      >
        <span className="pdepth__pct">{`${row.pct > 0 ? '+' : ''}${row.pct.toFixed(Math.abs(row.pct) < 10 ? 1 : 0)}%`}</span>
        <span className="pdepth__track">
          <span className="pdepth__bar" style={{ width: w(row.liquidity) }} />
          {row.orders > 0 && <span className="pdepth__bar pdepth__bar--orders" style={{ width: w(row.orders) }} />}
        </span>
        <span className="pdepth__val">{row.total > 0 ? money(row.total) : ''}</span>
      </div>
    );
  };

  return (
    <div className="pdepth">
      <div className="pdepth__head">
        <div className="pdepth__stats">
          <span className="pdepth__stat pdepth__stat--support">
            <small>Support</small>
            <strong>{money(data.support)}</strong>
          </span>
          <span className="pdepth__stat pdepth__stat--resistance">
            <small>Resistance</small>
            <strong>{money(data.resistance)}</strong>
          </span>
          <span className="pdepth__stat" title="Share of the visible depth that sits below the price. 50 = balanced.">
            <small>Support share</small>
            <strong>{data.balance === null ? '-' : `${data.balance.toFixed(0)}%`}</strong>
          </span>
          <span className="pdepth__stat" title="Open limit orders on this pool. They sit at one price and do not move until filled.">
            <small>Limit orders</small>
            <strong>{data.ordersTotal}</strong>
          </span>
        </div>
        <Tabs size="sm" tabs={DEPTH_VIEWS.map((v) => ({ key: v.key, label: v.label }))} value={viewKey} onChange={setViewKey} />
      </div>

      {empty ? (
        <p className="muted">No liquidity or limit orders in this pool yet.</p>
      ) : (
        <div className="pdepth__chart" role="img" aria-label="Pool depth by price bucket">
          {rows.slice(0, split).map(bar)}
          <div className="pdepth__price">
            <span>
              {formatChartPrice(priceShown)} {quote.symbol}/{asset.symbol}
            </span>
          </div>
          {rows.slice(split).map(bar)}
        </div>
      )}

      <p className="pdepth__note muted">
        <span className="pdepth__key pdepth__key--liquidity" /> Pool liquidity <span className="pdepth__key pdepth__key--orders" /> Limit orders ·
        values at today's price{usd ? '' : ` (no USD price, shown in ${y.symbol})`}
        {ordersBeyond > 0 && ` · ${money(ordersBeyond)} of limit orders sit outside this view`}
      </p>
    </div>
  );
}
