// Liquidity map of one token across every Rhea pool that holds it: CLMM ranges and limit orders
// (dclv2.ref-labs.near get_marketdepth) and classic AMM curves (x·y=k, from the pool's reserves),
// merged into one book of USD per 1% price step around each pool's own price.
//   below the price = support (the other token, waiting to buy this one)
//   above the price = resistance (this token, waiting to be sold)
// From the book: the price levels where liquidity piles up (walls), where it runs out (thin
// zones), and how far a buy or sell of a given size moves the price. Stable and ALMM pools are
// listed but not mapped (their curves are not x·y=k or a CLMM range).

import { searchPools, parseDclPoolId, dclPointToPrice } from './rhea.js';
import { getMarketDepth } from './dclLiquidity.js';
import { buildDepth, invertDepth } from './poolDepth.js';
import { getTokens, priceOf } from './tokens.js';

/** Map windows: 1% steps, x1.25 / x1.5 / x2 each way (log scale, as on the pool Depth tab). */
export const MAP_VIEWS = [
  { key: '25', label: '±25%', window: 0.25, step: 0.01 },
  { key: '50', label: '±50%', window: 0.5, step: 0.01 },
  { key: '100', label: '×2', window: 1, step: 0.01 }
];
const WIDEST = MAP_VIEWS[MAP_VIEWS.length - 1];
const MAX_POOLS = 12;
// Liquidity moves slowly next to price: the map is read every 5 minutes, and a map that fresh is
// reused, so the swap chart's levels and the Pool Analysis page share one read.
export const MAP_REFRESH_MS = 5 * 60_000;
const FRESH_MS = MAP_REFRESH_MS - 10_000;
const cache = new Map(); // token → { at, maxPools, minTvl, promise }
const WNEAR = 'wrap.near';

/** Price change (%) at a bucket's edge furthest from the price, and at its middle (the edge nearest is `inner`). */
const edgePct = (k, step) => ((1 + step) ** (k >= 0 ? k + 1 : k) - 1) * 100;
const midPct = (k, step) => ((1 + step) ** (k + 0.5) - 1) * 100;

/** Bucket rows k = -n..n-1 for a view (k >= 0 above the price). */
function emptyRows(view) {
  const n = Math.max(1, Math.round(Math.log(1 + view.window) / Math.log(1 + view.step)));
  const rows = [];
  for (let k = -n; k < n; k += 1) rows.push({ k, side: k >= 0 ? 'resistance' : 'support', pct: edgePct(k, view.step), inner: ((1 + view.step) ** (k >= 0 ? k : k + 1) - 1) * 100, mid: midPct(k, view.step), clmm: 0, amm: 0, orders: 0, total: 0, byPool: {} });
  return rows;
}

/**
 * A classic pool's x·y=k curve in buckets. Token T (reserve rt, USD value vt each) against O
 * (reserve ro, vo). T held at price P is rt·sqrt(P0/P), O is ro·sqrt(P/P0): between two prices
 * above P0 the pool sells the difference in T, below P0 it pays the difference in O.
 */
function ammRows({ rt, ro, vt, vo, view }) {
  const s = 1 + view.step;
  return emptyRows(view).map((r) =>
    r.k >= 0
      ? rt * (s ** (-r.k / 2) - s ** (-(r.k + 1) / 2)) * vt
      : ro * (s ** ((r.k + 1) / 2) - s ** (r.k / 2)) * vo
  );
}

/** USD value of one whole token: its own price, or the other token's through the pool price. */
function usdPair(prices, tokenId, otherId, priceInOther) {
  let vt = priceOf(prices, tokenId === 'near' ? WNEAR : tokenId);
  let vo = priceOf(prices, otherId);
  if (!(vt > 0) && vo > 0 && priceInOther > 0) vt = vo * priceInOther;
  if (!(vo > 0) && vt > 0 && priceInOther > 0) vo = vt / priceInOther;
  return { vt, vo };
}

/** One CLMM pool, from the token's side: { rows (USD per bucket, liquidity + orders), price }. */
async function clmmPool(pool, tokenId, metas, prices) {
  const { tokenX, tokenY } = parseDclPoolId(pool.id);
  const x = metas.get(tokenX);
  const y = metas.get(tokenY);
  if (!x || !y) return null;
  const depth = await getMarketDepth(pool.id);
  if (!depth || !Number.isFinite(depth.current)) return null;
  const priceXY = dclPointToPrice(depth.current, x.decimals, y.decimals); // Y per X
  const isX = tokenX === tokenId;
  const other = isX ? tokenY : tokenX;
  const priceInOther = isX ? priceXY : priceXY > 0 ? 1 / priceXY : 0;
  const { vt, vo } = usdPair(prices, tokenId, other, priceInOther);
  if (!(vt > 0) || !(vo > 0)) return null;
  const built = buildDepth({ depth, decimalsX: x.decimals, decimalsY: y.decimals, valueX: isX ? vt : vo, valueY: isX ? vo : vt, view: WIDEST });
  const side = isX ? built : invertDepth(built, WIDEST);
  // The pool's own price of the token in USD (at the other token's USD price).
  return { other, priceUsd: priceInOther * vo, rows: side.rows.map((r) => ({ liquidity: r.liquidity, orders: r.orders })), orderCount: built.ordersTotal };
}

/** One classic AMM pool (two tokens) from the token's side. */
function ammPool(pool, tokenId, metas, prices) {
  if (pool.tokenIds.length !== 2) return null;
  const i = pool.tokenIds.indexOf(tokenId);
  const other = pool.tokenIds[1 - i];
  const mt = metas.get(tokenId);
  const mo = metas.get(other);
  if (!mt || !mo) return null;
  const rt = Number(pool.amounts[i]) / 10 ** mt.decimals;
  const ro = Number(pool.amounts[1 - i]) / 10 ** mo.decimals;
  if (!(rt > 0) || !(ro > 0)) return null;
  const { vt, vo } = usdPair(prices, tokenId, other, ro / rt);
  if (!(vt > 0) || !(vo > 0)) return null;
  // The pool's own price of the token in USD (O per T at the other token's USD price).
  return { other, priceUsd: (ro / rt) * vo, rows: ammRows({ rt, ro, vt, vo, view: WIDEST }).map((v) => ({ liquidity: v, orders: 0 })), orderCount: 0 };
}

/**
 * Every Rhea pool holding `tokenId` (at most `maxPools`, TVL ≥ `minTvl`), mapped. Pools come from
 * Rhea's pool search, deepest first.
 * Returns { tokenId, priceUsd, pools: [{ id, kind, label, symbols, feePercent, tvl, volume24h,
 * mapped, reason?, priceUsd?, gapPct?, rows? }] } with each mapped pool's rows on the ×2 view.
 */
export function getLiquidityMap(tokenId, prices, { maxPools = MAX_POOLS, minTvl = 0 } = {}) {
  const id = tokenId === 'near' ? WNEAR : tokenId;
  const hit = cache.get(id);
  // An entry that read at least these pools serves the request: fresh, or (tab in the background)
  // any age, so a hidden tab makes no network calls.
  const covers = hit && hit.maxPools >= maxPools && hit.minTvl <= minTvl;
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (covers && (hidden || Date.now() - hit.at < FRESH_MS)) return hit.promise;
  const promise = readMap(id, prices, { maxPools, minTvl });
  const entry = { at: Date.now(), maxPools, minTvl, promise };
  cache.set(id, entry);
  // A failed read is not kept: the next call tries again.
  promise.catch(() => cache.get(id) === entry && cache.delete(id));
  return promise;
}

async function readMap(id, prices, { maxPools, minTvl }) {
  const { list } = await searchPools({ tokenList: id, limit: 50, hideLow: true, sort: 'tvl' });
  const pools = list.filter((p) => p.tokenIds.includes(id) && p.tvl >= minTvl).slice(0, maxPools);
  const metas = new Map(Object.entries(await getTokens(pools.flatMap((p) => p.tokenIds))));

  const mapped = await Promise.all(
    pools.map(async (p) => {
      const base = { id: p.id, kind: p.kind, label: p.label, symbols: p.symbols, tokenIds: p.tokenIds, feePercent: p.feePercent, tvl: p.tvl, volume24h: p.volume24h };
      try {
        const m = p.isDcl ? await clmmPool(p, id, metas, prices) : p.kind === 'SIMPLE_POOL' ? ammPool(p, id, metas, prices) : null;
        if (!m) return { ...base, mapped: false, reason: p.isDcl || p.kind === 'SIMPLE_POOL' ? 'No USD price' : `${p.label} curve` };
        return { ...base, ...m, mapped: true };
      } catch {
        return { ...base, mapped: false, reason: 'Unavailable' };
      }
    })
  );

  // Reference price: the token's USD price, else the deepest mapped pool's.
  const priceUsd = priceOf(prices, id) || mapped.find((p) => p.mapped)?.priceUsd || 0;
  for (const p of mapped) if (p.mapped && priceUsd > 0) p.gapPct = (p.priceUsd / priceUsd - 1) * 100;
  return { tokenId: id, priceUsd, pools: mapped };
}

/** The map cut to a view: merged rows, totals and each pool's share inside it. */
export function mapView(map, view) {
  const rows = emptyRows(view);
  const n = rows.length / 2;
  const wn = emptyRows(WIDEST).length / 2;
  const pools = map.pools.map((p) => ({ ...p, support: 0, resistance: 0 }));
  for (const p of pools) {
    if (!p.mapped) continue;
    rows.forEach((r) => {
      const src = p.rows[r.k + wn];
      if (!src) return;
      const v = src.liquidity + src.orders;
      if (p.kind === 'DCL') r.clmm += src.liquidity;
      else r.amm += src.liquidity;
      r.orders += src.orders;
      r.total += v;
      if (v > 0) r.byPool[p.id] = v;
      p[r.side] += v;
    });
  }
  const sum = (side) => rows.filter((r) => r.side === side).reduce((a, r) => a + r.total, 0);
  const support = sum('support');
  const resistance = sum('resistance');
  for (const p of pools) p.share = support + resistance > 0 ? ((p.support + p.resistance) / (support + resistance)) * 100 : 0;
  return {
    rows,
    n,
    max: Math.max(0, ...rows.map((r) => r.total)),
    support,
    resistance,
    balance: support + resistance > 0 ? (support / (support + resistance)) * 100 : null,
    pools
  };
}

/**
 * Key levels from the merged rows, no scoring. Walking away from the price on each side:
 *   step  — depth per 1% grows 1.7× or more and stays up (a wall begins: "sell wall from $100")
 *   thin  — depth drops under a third and stays down (liquidity runs out: moves get fast)
 *   peak  — a single step at least 2.5× the side's median, bigger than its neighbours
 * Returns [{ kind, side, pct, usd, before, after }], nearest to the price first, at most
 * `perSide` per side.
 */
export function keyLevels(view, { perSide = 3 } = {}) {
  const out = [];
  const avg = (rows, a, b) => rows.slice(a, b).reduce((s, r) => s + r.total, 0) / Math.max(1, b - a);
  for (const side of ['resistance', 'support']) {
    // Nearest to the price first.
    const rows = view.rows.filter((r) => r.side === side).sort((a, b) => Math.abs(a.k + 0.5) - Math.abs(b.k + 0.5));
    const vals = rows.map((r) => r.total).filter((v) => v > 0).sort((a, b) => a - b);
    if (!vals.length) continue;
    const median = vals[Math.floor(vals.length / 2)];
    const found = [];
    const near = (i) => found.some((f) => Math.abs(f.i - i) < 3);
    for (let i = 2; i + 2 <= rows.length; i += 1) {
      const before = avg(rows, Math.max(0, i - 3), i);
      const after = avg(rows, i, Math.min(rows.length, i + 3));
      if (before <= 0 || near(i)) continue;
      if (after >= before * 1.7) found.push({ i, kind: 'step', before, after });
      else if (after <= before / 3) found.push({ i, kind: 'thin', before, after });
    }
    rows.forEach((r, i) => {
      if (near(i) || r.total < median * 2.5) return;
      if (r.total >= (rows[i - 1]?.total || 0) && r.total >= (rows[i + 1]?.total || 0)) found.push({ i, kind: 'peak', usd: r.total });
    });
    found
      .sort((a, b) => a.i - b.i)
      .slice(0, perSide)
      .forEach((f) => {
        const r = rows[f.i];
        // Steps and thin zones start at the bucket's edge nearest the price; peaks sit at its middle.
        const pct = f.kind === 'peak' ? r.mid : r.inner;
        out.push({ kind: f.kind, side, pct, usd: f.usd ?? r.total, before: f.before, after: f.after });
      });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

/**
 * How far the pool price moves for a buy or sell worth `usd`: walk the buckets away from the
 * price, eating each one's depth, interpolating inside the last. null when the view runs out.
 */
export function priceMove(view, usd, side) {
  const rows = view.rows.filter((r) => r.side === (side === 'sell' ? 'support' : 'resistance')).sort((a, b) => Math.abs(a.k + 0.5) - Math.abs(b.k + 0.5));
  let left = usd;
  let prev = 0;
  for (const r of rows) {
    if (r.total >= left) return prev + (r.pct - prev) * (left / r.total);
    left -= r.total;
    prev = r.pct;
  }
  return null;
}

/**
 * USD needed to move the price to `pct` (negative = down): every step inside it, plus the share of
 * the step it ends in (steps are 1% on a log scale, so +2% ends inside the second one).
 */
export function depthTo(view, pct) {
  const side = pct < 0 ? 'support' : 'resistance';
  const goal = Math.abs(pct);
  let total = 0;
  for (const r of view.rows) {
    if (r.side !== side) continue;
    const inner = Math.abs(r.inner);
    const outer = Math.abs(r.pct);
    if (outer <= goal) total += r.total;
    else if (inner < goal) total += r.total * ((goal - inner) / (outer - inner));
  }
  return total;
}
