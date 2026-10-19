// Dev check: runs src/lib/poolDepth.js on live pool data and prints the bucket table.
//   node scripts/probe-buckets.mjs [poolId] [viewKey]
import { buildDepth, DEPTH_VIEWS } from '../src/lib/poolDepth.js';

const pool = process.argv[2] || 'kinu-3.nearlytrade.near|token.rhealab.near|10000';
const view = DEPTH_VIEWS.find((v) => v.key === (process.argv[3] || '100'));
const rpc = async (method, args) => {
  const r = (await (await fetch('https://near.drpc.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: 'dclv2.ref-labs.near', method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) })).json()).result;
  if (r.error) throw new Error(r.error);
  return JSON.parse(Buffer.from(r.result).toString());
};
const raw = await rpc('get_marketdepth', { pool_id: pool, depth: 100 });
const depth = {
  current: raw.current_point,
  segments: Object.values(raw.liquidities).map((s) => ({ left: s.left_point, right: s.right_point, liquidity: Number(s.amount_l) })).filter((s) => s.right > s.left && s.liquidity > 0),
  orders: Object.values(raw.orders).map((o) => ({ point: o.point, x: Number(o.amount_x), y: Number(o.amount_y) }))
};
// value unit = token Y (RHEA): 1 X is worth the pool price in Y
const price = 1.0001 ** depth.current; // decimals equal (18/18) assumed
const out = buildDepth({ depth, decimalsX: 18, decimalsY: 18, valueX: price, valueY: 1, view });
console.log('view', view.label, '| current point', depth.current, '| price Y/X', price.toExponential(3));
for (const r of out.rows) if (r.total > 0) console.log(String(r.k).padStart(4), r.side.padEnd(10), (r.pct.toFixed(1) + '%').padStart(8), 'liq', r.liquidity.toFixed(2).padStart(10), 'orders', r.orders.toFixed(2).padStart(9));
console.log({ support: out.support, resistance: out.resistance, balance: out.balance, orders: out.orders, ordersBeyond: out.ordersBeyond });
process.exit(0);
