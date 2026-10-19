// Pool depth chart data: a CLMM pool's liquidity and limit orders grouped into price buckets
// around the current price, as a CEX order book would show them.
//   below the price = support (token Y that buys X), above = resistance (token X for sale).
// Pure functions over getMarketDepth() output; no network, no wallet.

import { dclAmountX, dclAmountY } from './rhea.js';

const LN_POINT = Math.log(1.0001);

/**
 * Chart windows. `window` is the distance covered each way in log price (x1.25 up, /1.25 down),
 * `step` the width of one bucket. Wider windows use wider buckets so the chart stays ~40 rows.
 */
export const DEPTH_VIEWS = [
  { key: '25', label: '±25%', window: 0.25, step: 0.01 },
  { key: '50', label: '±50%', window: 0.5, step: 0.02 },
  { key: '100', label: '×2', window: 1, step: 0.04 },
  { key: '300', label: '×4', window: 3, step: 0.08 }
];

/** Fine 1% buckets over x4 up / 1/4 down: what the price chart's side overlay draws. */
export const DEPTH_OVERLAY = { key: 'overlay', label: 'overlay', window: 3, step: 0.01 };

/**
 * @param {object} p
 * @param {{current:number, segments:Array<{left,right,liquidity}>, orders:Array<{point,x,y}>}} p.depth
 * @param {number} p.decimalsX / p.decimalsY  token decimals
 * @param {number} p.valueX / p.valueY        value of one whole token in the display unit (USD, or token Y)
 * @param {{window:number, step:number}} p.view
 */
export function buildDepth({ depth, decimalsX, decimalsY, valueX, valueY, view }) {
  const cp = depth.current;
  const w = Math.log(1 + view.step) / LN_POINT; // points per bucket
  const n = Math.max(1, Math.round(Math.log(1 + view.window) / Math.log(1 + view.step)));
  const toX = (raw) => (raw / 10 ** decimalsX) * valueX;
  const toY = (raw) => (raw / 10 ** decimalsY) * valueY;

  // Bucket k covers points [cp + k*w, cp + (k+1)*w): k >= 0 is above the price, k < 0 below it.
  const rows = [];
  for (let k = -n; k < n; k += 1) {
    const lo = cp + k * w;
    const hi = lo + w;
    rows.push({
      k,
      side: k >= 0 ? 'resistance' : 'support',
      // % change from the current price at the bucket's far edge from the price
      pct: ((1 + view.step) ** (k >= 0 ? k + 1 : k) - 1) * 100,
      loPoint: lo,
      hiPoint: hi,
      liquidity: 0,
      orders: 0
    });
  }

  for (const s of depth.segments) {
    for (const row of rows) {
      const a = Math.max(s.left, row.loPoint);
      const b = Math.min(s.right, row.hiPoint);
      if (b <= a) continue;
      row.liquidity += row.side === 'resistance' ? toX(dclAmountX(s.liquidity, a, b)) : toY(dclAmountY(s.liquidity, a, b));
    }
  }

  // Orders outside the window are totalled, not drawn.
  let ordersBeyond = { resistance: 0, support: 0 };
  for (const o of depth.orders) {
    const k = Math.floor((o.point - cp) / w);
    const row = rows[k + n];
    const valueOf = o.x > 0 ? toX(o.x) : toY(o.y);
    const side = o.x > 0 ? 'resistance' : 'support';
    if (row && row.side === side) row.orders += valueOf;
    else if (!row) ordersBeyond[side] += valueOf;
  }

  for (const row of rows) row.total = row.liquidity + row.orders;

  const sum = (side, key) => rows.filter((r) => r.side === side).reduce((acc, r) => acc + r[key], 0);
  const support = sum('support', 'total');
  const resistance = sum('resistance', 'total');
  return {
    rows,
    max: Math.max(0, ...rows.map((r) => r.total)),
    support,
    resistance,
    // Share of the visible depth that sits below the price (0-100); 50 = balanced.
    balance: support + resistance > 0 ? (support / (support + resistance)) * 100 : null,
    orders: { support: sum('support', 'orders'), resistance: sum('resistance', 'orders') },
    ordersBeyond,
    ordersTotal: depth.orders.length
  };
}
