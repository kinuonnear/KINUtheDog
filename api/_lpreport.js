// KINU LP Report (NEAR Agent Market): a read-only Markdown health report for one NEAR account's Rhea
// liquidity, or for one Rhea pool. Everything comes from public on-chain data (NEAR RPC) and
// Intear's price list; nothing is signed, nothing is moved. A leading underscore keeps this file
// from being a route on Vercel: api/market-webhook.js calls it.
//
// The brief is data, never instructions: only a NEAR account or a pool id is read out of it.

const RPCS = ['https://near.drpc.org', 'https://free.rpc.fastnear.com'];
const PRICES_API = 'https://prices.intear.tech/list-token-price';
const DCL = 'dclv2.ref-labs.near';
const EXCHANGE = 'v2.ref-finance.near';
const BOOST_FARM = 'boostfarm.ref-labs.near';
const WNEAR = 'wrap.near';
// Rhea keeps 20% of every swap fee (exchange admin_fee_bps 2000, CLMM protocol_fee_rate 2000): LPs get the rest.
const LP_FEE_SHARE = 0.8;
const APP = 'https://kinudefi.com';
const FETCH_TIMEOUT_MS = 8_000;
const MAX_POOLS = 12;

/* ---------------------------------------------------------------- brief */

// Named accounts can have several levels (kinu-3.nearlytrade.near); implicit ones are 64 hex digits.
const ACCOUNT = /(?:^|[^a-z0-9_.-])((?:[a-z0-9]+[-_.])*[a-z0-9]+\.(?:near|tg)|[0-9a-f]{64})(?![a-z0-9_-])/;
// "token <contract>" also names a token contract that doesn't end in .near (e.g. token.sweat).
const TOKEN_HINT = /\btoken\s*:?\s+((?:[a-z0-9]+[-_.])*[a-z0-9]+\.[a-z0-9_-]+)/;
const TOKEN = '(?:(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\\.(?:[a-z0-9]+[-_])*[a-z0-9]+)+|[0-9a-f]{64})';
const DCL_POOL = new RegExp(`\\b(${TOKEN}\\|${TOKEN}\\|\\d{2,5})\\b`);
const CLASSIC_POOL = /(?:\bpool\s*(?:id\s*)?#?\s*|#)(\d{1,6})\b/i;

/** What the brief asks about: { kind: 'dcl-pool' | 'classic-pool' | 'account', id } or null. */
export function parseBrief(text) {
  const s = String(text || '').toLowerCase().slice(0, 4000);
  const dcl = s.match(DCL_POOL);
  if (dcl) return { kind: 'dcl-pool', id: dcl[1] };
  const classic = s.match(CLASSIC_POOL);
  if (classic) return { kind: 'classic-pool', id: classic[1] };
  // Pool links from KINU or Rhea carry the pool id URL-encoded ("%7C" for "|").
  const decoded = s.replace(/%7c/g, '|');
  if (decoded !== s) {
    const again = decoded.match(DCL_POOL);
    if (again) return { kind: 'dcl-pool', id: again[1] };
  }
  const hinted = s.match(TOKEN_HINT);
  if (hinted) return { kind: 'account', id: hinted[1] };
  const account = s.match(ACCOUNT);
  if (account) return { kind: 'account', id: account[1] };
  return null;
}

/* ---------------------------------------------------------------- data */

async function getJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${new URL(url).host} HTTP ${response.status}`);
  return response.json();
}

async function rpc(params) {
  let last;
  for (const url of RPCS) {
    try {
      const json = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }) });
      if (json.error) {
        const cause = JSON.stringify(json.error.cause?.name || json.error.data || json.error.message);
        if (/UNKNOWN_ACCOUNT|does not exist/i.test(cause)) return { missing: true };
        const error = new Error(cause);
        error.final = /MethodNotFound|CodeDoesNotExist|panicked|Smart contract/i.test(cause);
        throw error;
      }
      return json.result;
    } catch (error) {
      if (error.final) throw error;
      last = error;
    }
  }
  throw last;
}

async function view(contract, method, args = {}) {
  const result = await rpc({ request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  if (result.missing) throw Object.assign(new Error(`${contract} not found`), { final: true });
  return JSON.parse(Buffer.from(result.result).toString() || 'null');
}

let priceCache = { at: 0, map: null };
async function prices() {
  if (priceCache.map && Date.now() - priceCache.at < 120_000) return priceCache.map;
  const map = await getJson(PRICES_API);
  priceCache = { at: Date.now(), map };
  return map;
}

const metaCache = new Map();
/** { symbol, decimals } from the price list, else from the token contract. */
async function meta(id, list) {
  if (list?.[id]) return { symbol: list[id].symbol === 'wNEAR' ? 'NEAR' : list[id].symbol, decimals: Number(list[id].decimal) };
  if (metaCache.has(id)) return metaCache.get(id);
  const m = await view(id, 'ft_metadata').then((r) => ({ symbol: r.symbol, decimals: Number(r.decimals) })).catch(() => ({ symbol: id.split('.')[0].slice(0, 10).toUpperCase(), decimals: 18 }));
  metaCache.set(id, m);
  return m;
}

const priceOf = (list, id) => Number(list?.[id]?.price) || 0;

/** The token's transfer tax on the Rhea CLMM contract (e.g. KINU 1% in and out), or null. */
async function taxOf(token) {
  if (token === WNEAR) return null;
  try {
    const tax = (await view(token, 'get_tax'))?.tax;
    const pairs = tax?.pairs || [];
    const buy = Number(tax?.buy_bps) || 0;
    const sell = Number(tax?.sell_bps) || 0;
    if (!(buy || sell) || !pairs.includes(DCL)) return null;
    return { in: sell / 100, out: buy / 100 };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- CLMM math */

const SQRT_RATE = Math.sqrt(1.0001);
const sqrtP = (p) => Math.pow(SQRT_RATE, p);
const amountY = (L, a, b) => (b <= a ? 0 : (L * (sqrtP(b) - sqrtP(a))) / (SQRT_RATE - 1));
const amountX = (L, a, b) => (b <= a ? 0 : (L * (1 / sqrtP(a) - 1 / sqrtP(b)) * SQRT_RATE) / (SQRT_RATE - 1));
const pointPrice = (point, dx, dy) => Math.pow(1.0001, point) * 10 ** (dx - dy);
const LN_POINT = Math.log(1.0001);

/**
 * USD resting within ±pct of the price (CLMM liquidity + limit orders), and on each side the 1% step
 * within ±20% that holds at least twice the side's median step (a "wall"), or null when the
 * liquidity is spread evenly.
 */
function depthOf(depth, cp, dx, dy, px, py) {
  const usdX = (raw) => (raw / 10 ** dx) * px;
  const usdY = (raw) => (raw / 10 ** dy) * py;
  const between = (lo, hi) => {
    let usd = 0;
    for (const s of depth.segments) {
      const a = Math.max(s.left, lo);
      const b = Math.min(s.right, hi);
      if (b <= a) continue;
      usd += usdY(amountY(s.liquidity, a, Math.min(b, cp))) + usdX(amountX(s.liquidity, Math.max(a, cp), b));
    }
    for (const o of depth.orders) if (o.point >= lo && o.point < hi) usd += usdX(o.x) + usdY(o.y);
    return usd;
  };
  const pts = (pct) => Math.log(1 + pct / 100) / LN_POINT;
  const within = (pct) => ({ below: between(cp - pts(pct), cp), above: between(cp, cp + pts(pct)) });
  const step = pts(1);
  const below = [];
  const above = [];
  for (let k = 0; k < 20; k += 1) {
    below.push({ pct: -(k + 0.5), usd: between(cp - (k + 1) * step, cp - k * step) });
    above.push({ pct: k + 0.5, usd: between(cp + k * step, cp + (k + 1) * step) });
  }
  const wall = (side) => {
    const sorted = side.map((b) => b.usd).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const top = side.reduce((m, b) => (b.usd > m.usd ? b : m), side[0]);
    return top.usd > 0 && top.usd >= 2 * median ? top : null;
  };
  return { w2: within(2), w5: within(5), w10: within(10), wallBelow: wall(below), wallAbove: wall(above) };
}

async function marketDepth(poolId) {
  const d = await view(DCL, 'get_marketdepth', { pool_id: poolId, depth: 100 });
  return {
    segments: Object.values(d?.liquidities || {})
      .map((s) => ({ left: s.left_point, right: s.right_point, liquidity: Number(s.amount_l) }))
      .filter((s) => s.right > s.left && s.liquidity > 0),
    orders: Object.values(d?.orders || {})
      .map((o) => ({ point: Number(o.point), x: Number(o.amount_x) || 0, y: Number(o.amount_y) || 0 }))
      .filter((o) => Number.isFinite(o.point))
  };
}

/* ---------------------------------------------------------------- history and volume */

const CANDLES_API = 'https://api.intea.rs/candles';
const GECKO_POOLS = 'https://api.geckoterminal.com/api/v2/networks/near/pools';
const HOUR_MS = 3_600_000;
const DAY_H = 24;
const WEEK_H = 7 * 24;
const MONTH_H = 30 * 24;

// Intear's candles answer empty now and then: one retry.
const getJsonRetry = (url) => getJson(url).catch(() => getJson(url));

/** One token's hourly closes in 'near' or 'usd' over the last `hours`, one per hour (quiet hours carry the last close). */
async function hourly(token, quote, hours) {
  const json = await getJsonRetry(`${CANDLES_API}?tokens=${encodeURIComponent(token)}&resolution=60&quote=${quote === 'near' ? 'near,usd' : 'usd'}&count_back=${hours}`);
  const t = json?.tokens?.[token];
  const series = t?.[quote];
  if (!t?.time?.length || !series?.close) return null;
  const byHour = new Map();
  t.time.forEach((ms, i) => {
    const close = Number(series.close[i]);
    if (close > 0) byHour.set(Math.floor(ms / HOUR_MS), close);
  });
  if (!byHour.size) return null;
  const end = Math.floor(Date.now() / HOUR_MS);
  const first = Math.max(end - hours + 1, Math.min(...byHour.keys()));
  const out = [];
  let last = null;
  for (let h = first; h <= end; h += 1) {
    if (byHour.has(h)) last = byHour.get(h);
    if (last) out.push({ h, c: last });
  }
  return out;
}

/** Hourly price of X in Y (the pool's own direction) over the last `hours`, or null when there's no history. */
async function pairHistory(x, y, hours = MONTH_H) {
  if (y === WNEAR) return hourly(x, 'near', hours);
  if (x === WNEAR) return (await hourly(y, 'near', hours))?.map((p) => ({ h: p.h, c: 1 / p.c })) || null;
  const [a, b] = await Promise.all([hourly(x, 'usd', hours), hourly(y, 'usd', hours)]);
  if (!a || !b) return null;
  const yAt = new Map(b.map((p) => [p.h, p.c]));
  return a.filter((p) => yAt.has(p.h)).map((p) => ({ h: p.h, c: p.c / yAt.get(p.h) }));
}

/** Share of the last `hours` (of those with a price) that the price spent in [lo, hi). */
function timeInRange(history, lo, hi, hours) {
  const s = history?.slice(-hours) || [];
  if (s.length < Math.min(hours, DAY_H)) return null;
  return { share: s.filter((p) => p.c >= lo && p.c < hi).length / s.length, hours: s.length };
}

/** Low, high and the band the price spent 90% of the hours in, over the last `hours`. */
function priceStats(history, hours) {
  const s = (history?.slice(-hours) || []).map((p) => p.c);
  if (s.length < DAY_H) return null;
  const sorted = [...s].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { low: sorted[0], high: sorted[sorted.length - 1], p5: at(0.05), p95: at(0.95), hours: s.length };
}

/** A pool's trading volume over the last 24 h in USD (GeckoTerminal), or null. */
async function volume24(poolId) {
  const id = String(poolId).includes('|') ? `refv2-${poolId.split('|').join(':')}` : `refv1-${poolId}`;
  const v = Number((await getJson(`${GECKO_POOLS}/${encodeURIComponent(id)}`).catch(() => null))?.data?.attributes?.volume_usd?.h24);
  return Number.isFinite(v) ? v : null;
}

/* ---------------------------------------------------------------- formatting */

const usd = (v) => (!Number.isFinite(v) ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : v >= 0.01 ? `$${v.toFixed(2)}` : v > 0 ? '<$0.01' : '$0');
const num = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v >= 1 ? v.toFixed(2) : v > 0 ? v.toPrecision(3) : '0');
const price = (v) => (v >= 1 ? v.toFixed(4) : v > 0 ? v.toFixed(Math.min(20, 3 - Math.floor(Math.log10(v)))) : '0');
const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) >= 10 ? 0 : 1)}%`;
const share = (t) => (t ? `${Math.round(t.share * 100)}%` : '—');
const apr = (perDay, value) => (value > 0 && perDay > 0 ? `${((perDay * 365) / value * 100).toFixed(perDay * 365 >= value ? 0 : 1)}%` : '—');
/** "7d: 0.0000061 – 0.0000102 · 90% of hours in 0.0000068 – 0.0000098 (−17% / +19% from now)". */
const statsLine = (label, s, now) =>
  s ? `${label}: low ${price(s.low)} · high ${price(s.high)} · 90% of hours between ${price(s.p5)} and ${price(s.p95)} (${pct(((s.p5 - now) / now) * 100)} / ${pct(((s.p95 - now) / now) * 100)} from now)${s.hours < (label === '7 days' ? WEEK_H : MONTH_H) ? ` · only ${Math.round(s.hours / 24)} days of history` : ''}` : `${label}: no price history.`;
const md = (s) => String(s).replace(/([\\`*_[\]|<>])/g, '\\$1');
/** "Walls" within ±20%: 1% steps holding at least twice their side's median. */
const wallLine = (d) => {
  const parts = [d.wallBelow && `buy wall at ${pct(d.wallBelow.pct)} (${usd(d.wallBelow.usd)} in that 1%)`, d.wallAbove && `sell wall at ${pct(d.wallAbove.pct)} (${usd(d.wallAbove.usd)} in that 1%)`].filter(Boolean);
  return parts.length ? `Walls within ±20%: ${parts.join(', ')}.` : 'No walls within ±20%: liquidity is spread evenly around the price.';
};
const poolLink = (id) => `${APP}/pools/${encodeURIComponent(id)}`;
const FOOTER = [
  '',
  '---',
  `Read-only report from public on-chain data (NEAR RPC, Rhea contracts) and Intear prices, made by [KINU](${APP}). It is data, not financial advice. Values move with the market.`
];

/* ---------------------------------------------------------------- reports */

/** One CLMM pool's block for an account: positions, range status, time in range, value, fees, depth. */
async function dclPoolSection(poolId, list, plist) {
  const [x, y, fee] = poolId.split('|');
  const [pool, mx, my, depth, tx, ty, history, vol] = await Promise.all([
    view(DCL, 'get_pool', { pool_id: poolId }),
    meta(x, plist),
    meta(y, plist),
    marketDepth(poolId).catch(() => null),
    taxOf(x),
    taxOf(y),
    pairHistory(x, y).catch(() => null),
    volume24(poolId)
  ]);
  const feeRate = Number(fee) / 1e6;
  const activeL = Number(pool.liquidity) || 0;
  const cp = pool.current_point;
  const px = priceOf(plist, x);
  const py = priceOf(plist, y);
  const now = pointPrice(cp, mx.decimals, my.decimals);
  let value = 0;
  let fees = 0;
  let earning = 0;
  let perDay = 0;
  const rows = list
    .sort((a, b) => a.left_point - b.left_point)
    .map((l) => {
      const L = Number(l.amount);
      const split = Math.min(Math.max(cp, l.left_point), l.right_point);
      const ax = amountX(L, split, l.right_point) / 10 ** mx.decimals;
      const ay = amountY(L, l.left_point, split) / 10 ** my.decimals;
      const v = ax * px + ay * py;
      const f = (Number(l.unclaimed_fee_x || 0) / 10 ** mx.decimals) * px + (Number(l.unclaimed_fee_y || 0) / 10 ** my.decimals) * py;
      const lo = pointPrice(l.left_point, mx.decimals, my.decimals);
      const hi = pointPrice(l.right_point, mx.decimals, my.decimals);
      const inRange = cp >= l.left_point && cp < l.right_point;
      if (inRange) earning += 1;
      value += v;
      fees += f;
      const bins = Math.round((l.right_point - l.left_point) / (pool.point_delta || 1));
      // Fees at today's volume: an in-range position earns its share of the active liquidity.
      const day = inRange && vol !== null && activeL > 0 ? vol * feeRate * LP_FEE_SHARE * Math.min(1, L / activeL) : 0;
      perDay += day;
      const t7 = timeInRange(history, lo, hi, WEEK_H);
      const t30 = timeInRange(history, lo, hi, MONTH_H);
      const status = inRange ? `in range (${pct(((lo - now) / now) * 100)} / ${pct(((hi - now) / now) * 100)})` : now < lo ? `**out of range**, price ${pct(((now - lo) / lo) * 100)} below it` : `**out of range**, price ${pct(((now - hi) / hi) * 100)} above it`;
      const id = l.lpt_id.split('#')[1] || l.lpt_id;
      return { text: `| ${md(id)} | ${price(lo)} – ${price(hi)} (${bins} bin${bins === 1 ? '' : 's'}) | ${status} | ${num(ax)} ${md(mx.symbol)} + ${num(ay)} ${md(my.symbol)} | ${usd(v)} | ${usd(f)} | ${share(t7)} / ${share(t30)} | ${inRange && vol !== null ? `${usd(day)} (${apr(day, v)} APR)` : inRange ? '—' : '$0'} |`, inRange, bins, v, id, t7 };
    });
  const notes = [];
  const idle = rows.filter((r) => !r.inRange);
  if (idle.length) notes.push(`${idle.length} of ${rows.length} position${rows.length === 1 ? ' is' : 's are'} out of range and earn no fees (${usd(idle.reduce((s, r) => s + r.v, 0))}).`);
  const narrow = rows.filter((r) => r.bins <= 2);
  if (narrow.length) notes.push(`${narrow.length} position${narrow.length === 1 ? ' is' : 's are'} only 1–2 bins wide: they leave the range on a small move.`);
  for (const [token, m, t] of [[x, mx, tx], [y, my, ty]]) {
    if (t) notes.push(`${md(m.symbol)} is taxed on the Rhea CLMM: ${t.in}% when it goes in (deposit) and ${t.out}% when it comes out (withdraw, claimed fees), so one rebalance costs about ${(t.in + t.out).toFixed(1)}% of the ${md(m.symbol)} side.`);
  }
  const rarely = rows.filter((r) => r.t7 && r.t7.share < 0.5);
  if (rarely.length) notes.push(`${rarely.map((r) => `Position ${md(r.id)} was in range ${share(r.t7)}`).join(', ')} of the last 7 days.`);
  if (fees > 0 && value > 0 && fees / value > 0.02) notes.push(`Unclaimed fees are ${((fees / value) * 100).toFixed(1)}% of the position value.`);

  const lines = [
    `### ${md(mx.symbol)} / ${md(my.symbol)} · CLMM ${Number(fee) / 1e4}% · [open](${poolLink(poolId)})`,
    `Price ${price(now)} ${md(my.symbol)} per ${md(mx.symbol)} · ${earning}/${rows.length} position${rows.length === 1 ? '' : 's'} earning · value **${usd(value)}** · unclaimed fees **${usd(fees)}**${vol !== null ? ` · pool volume 24h ${usd(vol)} · your est. fees **${usd(perDay)}/day** (${apr(perDay, value)} APR)` : ''}`,
    '',
    `| Position | Range (${md(my.symbol)} per ${md(mx.symbol)}) | Status | Holds | Value | Unclaimed fees | In range 7d / 30d | Est. fees/day |`,
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => r.text)
  ];
  if (depth) {
    const d = depthOf(depth, cp, mx.decimals, my.decimals, px, py);
    lines.push('', `Liquidity around the price (whole pool): ±2% ${usd(d.w2.below)} / ${usd(d.w2.above)} · ±5% ${usd(d.w5.below)} / ${usd(d.w5.above)} · ±10% ${usd(d.w10.below)} / ${usd(d.w10.above)} (below / above).`);
    lines.push('', wallLine(d));
  }
  if (history) lines.push('', `Price ${statsLine('7 days', priceStats(history, WEEK_H), now)}`, '', `Price ${statsLine('30 days', priceStats(history, MONTH_H), now)}`);
  if (vol !== null) lines.push('', "_Est. fees/day: the pool's last 24 h volume × its fee × the 80% LPs keep × the position's share of the liquidity at the current price. Volume changes every day._");
  if (notes.length) lines.push('', '**Things to check**', ...notes.map((n) => `- ${n}`));
  return { value, fees, perDay, earning, total: rows.length, idle: idle.length, text: lines.join('\n') };
}

/** Classic / stable pools the account holds shares in (wallet + farm), checked on chain. */
async function classicSections(account, plist) {
  const candidates = new Set();
  const seeds = await view(BOOST_FARM, 'list_farmer_seeds', { farmer_id: account }).catch(() => ({}));
  const staked = {};
  for (const [seedId, seed] of Object.entries(seeds || {})) {
    const [contract, poolId] = seedId.split('@');
    if (contract !== EXCHANGE || !poolId || poolId.includes('|')) continue;
    const total = BigInt(seed.free_amount || 0) + BigInt(seed.locked_amount || 0);
    if (total > 0n) {
      staked[poolId] = total;
      candidates.add(poolId);
    }
  }
  for (const base of ['https://indexer.ref.finance', 'https://api.rhea.finance']) {
    const list = await getJson(`${base}/liquidity-pools/${encodeURIComponent(account)}`).catch(() => []);
    if (Array.isArray(list)) list.forEach((p) => p?.id !== undefined && candidates.add(String(p.id)));
  }
  const out = [];
  for (const poolId of [...candidates].slice(0, MAX_POOLS)) {
    try {
      const [pool, shares, vol] = await Promise.all([view(EXCHANGE, 'get_pool', { pool_id: Number(poolId) }), view(EXCHANGE, 'get_pool_shares', { pool_id: Number(poolId), account_id: account }), volume24(poolId)]);
      const mine = BigInt(shares || 0) + (staked[poolId] || 0n);
      const supply = BigInt(pool.shares_total_supply || 0);
      if (mine === 0n || supply === 0n) continue;
      const share = Number((mine * 1_000_000n) / supply) / 1e6;
      const parts = await Promise.all(pool.token_account_ids.map(async (id, i) => {
        const m = await meta(id, plist);
        const amount = (Number(pool.amounts[i]) / 10 ** m.decimals) * share;
        return { id, symbol: m.symbol, amount, usd: amount * priceOf(plist, id) };
      }));
      const value = parts.reduce((s, p) => s + p.usd, 0);
      // A classic pool's LPs share every trade's fee by pool share (full range, always earning).
      const perDay = vol !== null ? vol * (pool.total_fee / 1e4) * LP_FEE_SHARE * share : null;
      out.push({
        value,
        perDay: perDay || 0,
        text: `| #${poolId} | ${md(pool.pool_kind === 'SIMPLE_POOL' ? 'AMM' : pool.pool_kind === 'DEGEN_SWAP' ? 'ALMM' : 'Stable')} ${(pool.total_fee / 100).toFixed(2)}% | ${parts.map((p) => `${num(p.amount)} ${md(p.symbol)}`).join(' + ')} | ${(share * 100).toFixed(share >= 0.01 ? 2 : 4)}% | ${usd(value)} | ${perDay === null ? '—' : `${usd(perDay)} (${apr(perDay, value)} APR)`} | ${staked[poolId] ? 'yes' : 'no'} | [open](${poolLink(poolId)}) |`
      });
    } catch {
      // A pool that can't be read is left out of the report.
    }
  }
  return out.sort((a, b) => b.value - a.value);
}

async function accountReport(account) {
  const exists = await rpc({ request_type: 'view_account', finality: 'final', account_id: account });
  if (exists.missing) return { ok: false, markdown: `No NEAR account named \`${md(account)}\` exists.` };
  const [plist, liquidities] = await Promise.all([prices().catch(() => ({})), view(DCL, 'list_liquidities', { account_id: account }).catch(() => [])]);
  const byPool = new Map();
  (liquidities || []).forEach((l) => byPool.set(l.pool_id, [...(byPool.get(l.pool_id) || []), l]));
  // Pools are read side by side: a wallet with many pools still answers within the delivery window.
  const dcl = await Promise.all([...byPool].slice(0, MAX_POOLS).map(([poolId, list]) => dclPoolSection(poolId, list, plist).catch(() => null)));
  const dclOk = dcl.filter(Boolean).sort((a, b) => b.value - a.value);
  const classic = await classicSections(account, plist);

  const dclValue = dclOk.reduce((s, p) => s + p.value, 0);
  const dclFees = dclOk.reduce((s, p) => s + p.fees, 0);
  const classicValue = classic.reduce((s, p) => s + p.value, 0);
  const positions = dclOk.reduce((s, p) => s + p.total, 0);
  const idle = dclOk.reduce((s, p) => s + p.idle, 0);
  const perDayAll = dclOk.reduce((s, p) => s + (p.perDay || 0), 0) + classic.reduce((s, p) => s + p.perDay, 0);

  const lines = [
    `# KINU LP Report · ${md(account)}`,
    `_${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · [open the portfolio](${APP}/portfolio?account=${encodeURIComponent(account)})_`,
    '',
    '## Summary',
    `- Liquidity on Rhea: **${usd(dclValue + classicValue)}** (CLMM ${usd(dclValue)} · classic ${usd(classicValue)})`,
    `- CLMM positions: ${positions} in ${dclOk.length} pool${dclOk.length === 1 ? '' : 's'} · **${positions - idle} earning**, ${idle} out of range`,
    `- Unclaimed CLMM fees: **${usd(dclFees)}**`,
    `- Est. fees at today's volume: **${usd(perDayAll)}/day** (${apr(perDayAll, dclValue + classicValue)} APR on the liquidity above)`
  ];
  if (!dclOk.length && !classic.length) lines.push('', 'No Rhea liquidity found for this account (CLMM positions, classic pool shares or farm stakes).');
  if (dclOk.length) lines.push('', '## CLMM positions', ...dclOk.flatMap((p) => ['', p.text]));
  if (byPool.size > MAX_POOLS) lines.push('', `_${byPool.size - MAX_POOLS} more CLMM pools not shown._`);
  if (classic.length) {
    lines.push('', '## Classic, stable and ALMM pools', '', '| Pool | Type · fee | Your share holds | Pool share | Value | Est. fees/day | Farmed | |', '|---|---|---|---|---|---|---|---|', ...classic.map((c) => c.text));
    lines.push('', 'Classic pools cover every price, so they never go out of range, and token taxes that only apply on the Rhea CLMM contract do not apply here.');
  }
  lines.push(...FOOTER);
  return { ok: true, markdown: lines.join('\n') };
}

async function dclPoolReport(poolId) {
  const [x, y, fee] = poolId.split('|');
  const plist = await prices().catch(() => ({}));
  let pool;
  try {
    pool = await view(DCL, 'get_pool', { pool_id: poolId });
  } catch {
    return { ok: false, markdown: `No Rhea CLMM pool \`${md(poolId)}\` was found.` };
  }
  const [mx, my, depth, tx, ty, history, vol] = await Promise.all([meta(x, plist), meta(y, plist), marketDepth(poolId).catch(() => null), taxOf(x), taxOf(y), pairHistory(x, y).catch(() => null), volume24(poolId)]);
  const px = priceOf(plist, x);
  const py = priceOf(plist, y);
  const cp = pool.current_point;
  const now = pointPrice(cp, mx.decimals, my.decimals);
  const tvl = (Number(pool.total_x) / 10 ** mx.decimals) * px + (Number(pool.total_y) / 10 ** my.decimals) * py;
  const lines = [
    `# KINU LP Report · ${md(mx.symbol)} / ${md(my.symbol)} (CLMM ${Number(fee) / 1e4}%)`,
    `_${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · [open the pool](${poolLink(poolId)})_`,
    '',
    '## Summary',
    `- Price: **${price(now)} ${md(my.symbol)} per ${md(mx.symbol)}**${px ? ` (${md(mx.symbol)} ≈ $${price(px)})` : ''}`,
    `- Liquidity held by the pool: **${usd(tvl)}** (${num(Number(pool.total_x) / 10 ** mx.decimals)} ${md(mx.symbol)} + ${num(Number(pool.total_y) / 10 ** my.decimals)} ${md(my.symbol)})`,
    `- Bin width: ${pool.point_delta} points (≈ ${((Math.pow(1.0001, pool.point_delta) - 1) * 100).toFixed(1)}%)`,
    vol !== null ? `- Volume 24 h: **${usd(vol)}** · fees to in-range LPs ≈ **${usd(vol * (Number(fee) / 1e6) * LP_FEE_SHARE)}/day**` : '- Volume 24 h: not available right now'
  ];
  if (history) lines.push('', '## Price history', '', `- ${statsLine('7 days', priceStats(history, WEEK_H), now)}`, `- ${statsLine('30 days', priceStats(history, MONTH_H), now)}`);
  if (depth) {
    const d = depthOf(depth, cp, mx.decimals, my.decimals, px, py);
    lines.push(
      '',
      '## Liquidity around the price',
      '',
      '| Window | Below the price (buyers) | Above the price (sellers) |',
      '|---|---|---|',
      `| ±2% | ${usd(d.w2.below)} | ${usd(d.w2.above)} |`,
      `| ±5% | ${usd(d.w5.below)} | ${usd(d.w5.above)} |`,
      `| ±10% | ${usd(d.w10.below)} | ${usd(d.w10.above)} |`,
      '',
      wallLine(d)
    );
    const thin = d.w5.below < 50 || d.w5.above < 50;
    if (thin) lines.push('', 'Less than $50 rests within 5% on at least one side: a small trade moves this pool a lot.');
  }
  const taxes = [[mx, tx], [my, ty]].filter(([, t]) => t);
  lines.push('', '## Costs to know');
  if (taxes.length) taxes.forEach(([m, t]) => lines.push(`- ${md(m.symbol)} is taxed on the Rhea CLMM: ${t.in}% on deposit, ${t.out}% on withdraw and claimed fees. One rebalance ≈ ${(t.in + t.out).toFixed(1)}% of the ${md(m.symbol)} side.`));
  else lines.push('- Neither token has a transfer tax on the Rhea CLMM.');
  lines.push(`- Swap fee in this pool: ${Number(fee) / 1e4}% per trade, earned by in-range LPs.`);
  lines.push(...FOOTER);
  return { ok: true, markdown: lines.join('\n') };
}

async function classicPoolReport(poolId) {
  const plist = await prices().catch(() => ({}));
  let pool;
  try {
    pool = await view(EXCHANGE, 'get_pool', { pool_id: Number(poolId) });
  } catch {
    return { ok: false, markdown: `No Rhea classic pool #${md(poolId)} was found.` };
  }
  const parts = await Promise.all(pool.token_account_ids.map(async (id, i) => {
    const m = await meta(id, plist);
    const amount = Number(pool.amounts[i]) / 10 ** m.decimals;
    return { id, symbol: m.symbol, amount, usd: amount * priceOf(plist, id), tax: await taxOf(id) };
  }));
  const tvl = parts.reduce((s, p) => s + p.usd, 0);
  const [vol, history] = await Promise.all([volume24(poolId), parts.length === 2 ? pairHistory(parts[0].id, parts[1].id).catch(() => null) : null]);
  const lpDay = vol !== null ? vol * (pool.total_fee / 1e4) * LP_FEE_SHARE : null;
  const kind = pool.pool_kind === 'SIMPLE_POOL' ? 'AMM' : pool.pool_kind === 'DEGEN_SWAP' ? 'ALMM' : 'Stable';
  const lines = [
    `# KINU LP Report · Rhea pool #${md(poolId)} (${parts.map((p) => md(p.symbol)).join(' / ')})`,
    `_${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · [open the pool](${poolLink(poolId)})_`,
    '',
    '## Summary',
    `- Type: ${kind}, fee ${(pool.total_fee / 100).toFixed(2)}% per trade`,
    `- Holds: ${parts.map((p) => `${num(p.amount)} ${md(p.symbol)} (${usd(p.usd)})`).join(' + ')} · **${usd(tvl)}**`
  ];
  if (kind === 'AMM' && parts.length === 2 && parts[0].amount > 0) lines.push(`- Pool price: ${price(parts[1].amount / parts[0].amount)} ${md(parts[1].symbol)} per ${md(parts[0].symbol)}`);
  lines.push(lpDay !== null ? `- Volume 24 h: **${usd(vol)}** · fees to LPs ≈ **${usd(lpDay)}/day** · fee APR at today's volume **${apr(lpDay, tvl)}**` : '- Volume 24 h: not available right now');
  if (history && kind === 'AMM' && parts[0].amount > 0) {
    const now = parts[1].amount / parts[0].amount;
    lines.push('', '## Price history', '', `- ${statsLine('7 days', priceStats(history, WEEK_H), now)}`, `- ${statsLine('30 days', priceStats(history, MONTH_H), now)}`);
  }
  lines.push(
    '',
    '## Costs to know',
    `- ${kind === 'AMM' ? 'An AMM pool covers every price: it never goes out of range, and needs no rebalancing.' : 'This pool prices along a curve and accepts deposits in any ratio.'}`,
    parts.some((p) => p.tax) ? `- ${parts.filter((p) => p.tax).map((p) => md(p.symbol)).join(', ')} ha${parts.filter((p) => p.tax).length === 1 ? 's' : 've'} a transfer tax on the Rhea CLMM only; deposits into this classic pool are not taxed by it.` : '- No token in this pool has a transfer tax.',
    tvl < 1000 ? `- Small pool (${usd(tvl)}): a trade of a few dollars already moves its price.` : `- Depth: a $1,000 buy moves the price about ${((Math.pow(1 + 1000 / (tvl / 2), 2) - 1) * 100).toFixed(2)}% (x·y=k: the price moves with the square of the reserve change).`
  );
  lines.push(...FOOTER);
  return { ok: true, markdown: lines.join('\n') };
}

/* ---------------------------------------------------------------- token report (for token teams) */

const GECKO_TOKENS = 'https://api.geckoterminal.com/api/v2/networks/near/tokens';
const MAX_TOKEN_POOLS = 10;

/** The token's Rhea pools from GeckoTerminal: [{ kind: 'dcl' | 'classic', id, volume, tvl, priceUsd }]. */
async function rheaPoolsOf(token) {
  const json = await getJson(`${GECKO_TOKENS}/${encodeURIComponent(token)}/pools?page=1`);
  const out = [];
  for (const p of json?.data || []) {
    const raw = String(p.id).replace(/^near_/, '');
    const a = p.attributes || {};
    const isBase = p.relationships?.base_token?.data?.id === `near_${token}`;
    const priceUsd = Number(isBase ? a.base_token_price_usd : a.quote_token_price_usd) || null;
    const common = { volume: Number(a.volume_usd?.h24) || 0, tvl: Number(a.reserve_in_usd) || 0, priceUsd };
    if (raw.startsWith('refv2-')) {
      const parts = raw.slice(6).split(':');
      if (parts.length === 3) out.push({ kind: 'dcl', id: parts.join('|'), ...common });
    } else if (/^refv1-\d+$/.test(raw)) out.push({ kind: 'classic', id: raw.slice(6), ...common });
  }
  return out.sort((a, b) => b.tvl - a.tvl).slice(0, MAX_TOKEN_POOLS);
}

/** USD a constant-product pool absorbs before the token's price moves pct% down (bids) or up (asks). */
function ammDepth(tokenUsd, otherUsd, pct) {
  const p = pct / 100;
  return { bids: tokenUsd * (1 / Math.sqrt(1 - p) - 1), asks: otherUsd * (Math.sqrt(1 + p) - 1) };
}

async function tokenReport(token, m) {
  const plist = await prices().catch(() => ({}));
  const [pools, tax, history] = await Promise.all([rheaPoolsOf(token).catch(() => []), taxOf(token), hourly(token, 'usd', MONTH_H).catch(() => null)]);
  const refPrice = priceOf(plist, token) || pools.find((p) => p.priceUsd)?.priceUsd || 0;
  const rows = [];
  const total = { 2: { bids: 0, asks: 0 }, 5: { bids: 0, asks: 0 }, 10: { bids: 0, asks: 0 } };
  for (const p of pools) {
    try {
      if (p.kind === 'dcl') {
        const [x, y, fee] = p.id.split('|');
        const [pool, mx, my, depth] = await Promise.all([view(DCL, 'get_pool', { pool_id: p.id }), meta(x, plist), meta(y, plist), marketDepth(p.id)]);
        const other = x === token ? my : mx;
        const d = depthOf(depth, pool.current_point, mx.decimals, my.decimals, priceOf(plist, x), priceOf(plist, y));
        // Depth is read in X's direction: for a token on the Y side, buyers of the token sit above X's price.
        const side = (w) => (x === token ? { bids: w.below, asks: w.above } : { bids: w.above, asks: w.below });
        const w = { 2: side(d.w2), 5: side(d.w5), 10: side(d.w10) };
        [2, 5, 10].forEach((k) => {
          total[k].bids += w[k].bids;
          total[k].asks += w[k].asks;
        });
        // The token's USD price in this pool, from the pool's own current price and the other token's price.
        const P = pointPrice(pool.current_point, mx.decimals, my.decimals);
        const otherUsd = priceOf(plist, x === token ? y : x);
        const onChain = otherUsd > 0 && P > 0 ? (x === token ? P * otherUsd : otherUsd / P) : null;
        rows.push({ ...p, priceUsd: onChain ?? p.priceUsd, label: `${md(m.symbol)} / ${md(other.symbol)} · CLMM ${Number(fee) / 1e4}%`, w5: w[5] });
      } else {
        const pool = await view(EXCHANGE, 'get_pool', { pool_id: Number(p.id) });
        const parts = await Promise.all(pool.token_account_ids.map(async (id, i) => {
          const mm = await meta(id, plist);
          const amount = Number(pool.amounts[i]) / 10 ** mm.decimals;
          return { id, symbol: mm.symbol, amount, usd: amount * (priceOf(plist, id) || (id === token ? refPrice : 0)) };
        }));
        const kind = pool.pool_kind === 'SIMPLE_POOL' ? 'AMM' : pool.pool_kind === 'DEGEN_SWAP' ? 'ALMM' : 'Stable';
        const mine = parts.find((x) => x.id === token);
        const other = parts.find((x) => x.id !== token);
        let w5 = null;
        if (kind === 'AMM' && mine && other && parts.length === 2) {
          [2, 5, 10].forEach((k) => {
            const a = ammDepth(mine.usd, other.usd, k);
            total[k].bids += a.bids;
            total[k].asks += a.asks;
          });
          w5 = ammDepth(mine.usd, other.usd, 5);
        }
        const otherUsd = other ? priceOf(plist, other.id) : 0;
        const onChain = kind === 'AMM' && mine?.amount > 0 && other && otherUsd > 0 ? (other.amount / mine.amount) * otherUsd : null;
        rows.push({ ...p, priceUsd: onChain ?? p.priceUsd, label: `${parts.map((x) => md(x.symbol)).join(' / ')} · ${kind} ${(pool.total_fee / 100).toFixed(2)}% · #${p.id}`, w5 });
      }
    } catch {
      // A pool that can't be read is left out.
    }
  }
  const tvlAll = rows.reduce((s, r) => s + r.tvl, 0);
  const volAll = rows.reduce((s, r) => s + r.volume, 0);
  const notes = [];
  const top = rows[0];
  if (top && tvlAll > 0 && top.tvl / tvlAll > 0.8 && rows.length > 1) notes.push(`${Math.round((top.tvl / tvlAll) * 100)}% of the liquidity sits in one pool (${top.label}).`);
  if (total[5].bids < 500) notes.push(`Less than $500 of buy-side depth within 5% across all pools: a sell of about ${usd(Math.max(1, Math.round(total[5].bids)))} moves the price 5%.`);
  const gaps = rows.filter((r) => r.tvl >= 20 && r.priceUsd && refPrice && Math.abs(r.priceUsd / refPrice - 1) > 0.02);
  if (gaps.length) notes.push(`Pools priced more than 2% away from the market (an arbitrage trade would pull them in line, paying their LPs fees): ${gaps.map((r) => `${r.label} ${pct((r.priceUsd / refPrice - 1) * 100)}${r.w5 && r.w5.bids + r.w5.asks < 1 ? ' (no liquidity near its price)' : r.volume < 1 ? ' (no trades in 24 h)' : ''}`).join('; ')}.`);
  const idle = rows.filter((r) => r.tvl >= 20 && r.volume < 1);
  if (idle.length) notes.push(`${idle.length} pool${idle.length === 1 ? ' has' : 's have'} liquidity but no trades in 24 h: ${idle.map((r) => r.label).join('; ')}.`);
  if (tax) notes.push(`${md(m.symbol)} is taxed on the Rhea CLMM (${tax.in}% in, ${tax.out}% out) but not in classic pools: classic pools are the cheaper place for traders and LPs.`);
  if (!rows.some((r) => r.label.includes('/ NEAR') || r.label.startsWith('NEAR /'))) notes.push(`No ${md(m.symbol)}/NEAR pool found: most NEAR users buy with NEAR, so their trades take an extra hop.`);

  const lines = [
    `# KINU LP Report · ${md(m.symbol)} (token)`,
    `_${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · \`${md(token)}\` · [chart and swap](${APP}/swap?from=near&to=${encodeURIComponent(token)})_`,
    '',
    '## Summary',
    `- Price: **$${price(refPrice)}**`,
    `- Rhea pools found: **${rows.length}** · liquidity **${usd(tvlAll)}** · volume 24 h **${usd(volAll)}**`,
    `- Depth across all pools, buy side / sell side: ±2% ${usd(total[2].bids)} / ${usd(total[2].asks)} · ±5% ${usd(total[5].bids)} / ${usd(total[5].asks)} · ±10% ${usd(total[10].bids)} / ${usd(total[10].asks)}`
  ];
  if (history) {
    const s7 = priceStats(history, WEEK_H);
    if (s7) lines.push(`- 7 days: low $${price(s7.low)} · high $${price(s7.high)} · 90% of hours between $${price(s7.p5)} and $${price(s7.p95)}`);
  }
  if (rows.length) {
    lines.push(
      '',
      '## Pools',
      '',
      '| Pool | Liquidity | Volume 24h | Price now | vs market | Buy / sell depth within 5% | |',
      '|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.label} | ${usd(r.tvl)} | ${usd(r.volume)} | ${r.priceUsd ? `$${price(r.priceUsd)}` : '—'} | ${r.priceUsd && refPrice ? pct((r.priceUsd / refPrice - 1) * 100) : '—'} | ${r.w5 ? `${usd(r.w5.bids)} / ${usd(r.w5.asks)}` : '—'} | [open](${poolLink(r.id)}) |`)
    );
  } else lines.push('', 'No Rhea pools found for this token.');
  lines.push('', '_Buy side: other assets waiting to buy the token below its price. Sell side: the token waiting to be sold above it. Classic (AMM) pools count by their constant-product curve; stable and ALMM pools are listed without depth._');
  if (notes.length) lines.push('', '**Things to check**', ...notes.map((n) => `- ${n}`));
  lines.push(...FOOTER);
  return { ok: true, markdown: lines.join('\n') };
}

/** The report for a brief: { ok, target, markdown }. ok=false: nothing usable in the brief, or not found. */
export async function buildReport(brief) {
  const target = parseBrief(brief);
  if (!target) {
    return {
      ok: false,
      target: null,
      markdown: 'I need one NEAR account (for example `alice.near`), one token contract (for example `kinu-3.nearlytrade.near`) or one Rhea pool: a CLMM pool id like `kinu-3.nearlytrade.near|wrap.near|10000`, or a classic pool number like `pool 8961`.'
    };
  }
  if (target.kind === 'account') {
    // A token contract gets the token report (its pools and depth); any other account its LP positions.
    const tokenMeta = await view(target.id, 'ft_metadata').catch(() => null);
    if (tokenMeta?.symbol) return { ...(await tokenReport(target.id, { symbol: tokenMeta.symbol, decimals: Number(tokenMeta.decimals) })), target: { kind: 'token', id: target.id } };
  }
  const report = target.kind === 'account' ? await accountReport(target.id) : target.kind === 'dcl-pool' ? await dclPoolReport(target.id) : await classicPoolReport(target.id);
  return { ...report, target };
}
