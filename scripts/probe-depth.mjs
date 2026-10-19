// Probe: prints the raw get_marketdepth response of a Rhea CLMM pool (liquidity + limit orders).
// Read-only, no wallet, no writes. Usage:
//   node scripts/probe-depth.mjs [poolId] [depth]
// Example pool id: kinu-3.nearlytrade.near|token.rhealab.near|10000

const DCL = 'dclv2.ref-labs.near';
const RPC = ['https://near.drpc.org', 'https://rpc.intea.rs', 'https://free.rpc.fastnear.com'];
const poolId = process.argv[2] || 'kinu-3.nearlytrade.near|token.rhealab.near|10000';
const depth = Number(process.argv[3] || 100);

async function view(method, args) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: DCL,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64')
    }
  };
  let lastErr;
  for (const url of RPC) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const r = (await res.json()).result;
      if (r?.error) throw new Error(String(r.error).slice(0, 200));
      return JSON.parse(Buffer.from(r.result).toString());
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Rhea/Ref DCL: price(point) = 1.0001^point (token_y per token_x, raw units)
const pointToPrice = (p) => Math.pow(1.0001, p);

const d = await view('get_marketdepth', { pool_id: poolId, depth });
const pool = await view('get_pool', { pool_id: poolId });

console.log('pool        :', poolId);
console.log('keys        :', Object.keys(d).join(', '));
console.log('current_point:', d.current_point, '(raw price', pointToPrice(d.current_point).toExponential(4) + ')');
console.log('pool keys   :', Object.keys(pool).join(', '));
console.log('point_delta :', pool.point_delta, '| fee:', pool.fee, '| state:', pool.state);

const liq = Object.values(d.liquidities || {});
console.log('\nliquidities :', liq.length, 'segments');
for (const s of liq.slice(0, 40)) {
  console.log(`  [${s.left_point}, ${s.right_point})  L=${s.amount_l}  ` + `x=${s.amount_x ?? '-'} y=${s.amount_y ?? '-'}`);
}
if (liq.length) console.log('  first raw segment:', JSON.stringify(liq[0]));

const orders = d.orders || {};
const oKeys = Object.keys(orders);
console.log('\norders      :', oKeys.length, 'points with limit orders');
for (const k of oKeys.slice(0, 40)) console.log('  point', k, JSON.stringify(orders[k]));
