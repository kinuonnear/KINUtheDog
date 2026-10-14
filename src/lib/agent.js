// KINU Agent: an LP co-pilot that runs in the browser. It reads the same data as Discover (Rhea's
// most active pools with their recent activity) and the user's positions, and turns them into
// calls with reasons — HOLD, REBALANCE, COMPOUND, WATCH for positions; ENTER, CONSIDER, AVOID for
// pools. It never sends anything: every action it suggests opens the normal KINU flow, signed by
// the user. Rule-based and deterministic: the same data always gives the same call.
//
// The core number is fee coverage: what a pool paid its LPs over 24h divided by what the same
// 24h price move cost them in impermanent loss. Above 1, fees out-earn the price swing; below 1,
// LPs were better off holding — a high APR can hide that.

/** Impermanent loss (%) of a full-range x·y=k position for a price change of `changePct` %. */
export function impermanentLossPct(changePct) {
  if (!Number.isFinite(changePct)) return null;
  const r = 1 + changePct / 100;
  if (!(r > 0)) return 100;
  return (1 - (2 * Math.sqrt(r)) / (1 + r)) * 100;
}

const CLMM_IL_FACTOR = 4;

const fmtPct = (v, d = 2) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(d)}%`;
const fmtX = (v) => (v >= 10 ? '>10×' : `${v.toFixed(v >= 3 ? 1 : 2)}×`);

/** Pool metrics the agent works from (radar row: Rhea pool + GeckoTerminal/DexScreener activity). */
export function poolMetrics(row) {
  const tvl = row.tvl || 0;
  const fees = row.feeVolume24h || 0;
  const dailyYield = tvl > 0 ? (fees / tvl) * 100 : 0;
  const change = row.activity?.change?.h24;
  // Concentrated liquidity loses faster to a price move than full range: about 4× for a ±50%
  // range (a typical LP range), so CLMM pools aren't judged as safer than they are.
  const il = impermanentLossPct(Number.isFinite(change) ? change : 0) * (row.isDcl ? CLMM_IL_FACTOR : 1);
  const coverage = il > 0.0005 ? dailyYield / il : dailyYield > 0 ? 99 : 0;
  // Is trading heating up? The last 6h against a quarter of the day.
  const v6 = row.activity?.volume?.h6;
  const v24 = row.activity?.volume?.h24 || row.volume24h || 0;
  const heat = v6 > 0 && v24 > 0 ? (v6 * 4) / v24 : null;
  const ageDays = row.activity?.createdAt ? (Date.now() - row.activity.createdAt) / 86_400_000 : null;
  return {
    tvl,
    fees,
    dailyYield,
    change: Number.isFinite(change) ? change : null,
    il,
    coverage,
    net: dailyYield - il,
    heat,
    ageDays,
    apr: (row.apy || 0) + (row.farmApy || 0)
  };
}

/** Personas: how each one filters and ranks pools. */
export const PERSONAS = [
  {
    key: 'guardian',
    name: 'Guardian',
    icon: '◈',
    tagline: 'Steady fees, low risk',
    text: 'Deep pools whose fees comfortably cover their price swings. Calm markets, blue chips and stables.',
    minTvl: 50_000,
    minCoverage: 1.5,
    maxMove: 8,
    rank: (m) => m.net * Math.min(m.coverage, 5)
  },
  {
    key: 'hunter',
    name: 'Hunter',
    icon: '◎',
    tagline: 'High yield, eyes open',
    text: 'The highest net yield after price swings, including volatile pairs — only where fees still win.',
    minTvl: 10_000,
    minCoverage: 1,
    maxMove: Infinity,
    rank: (m) => m.net
  },
  {
    key: 'surfer',
    name: 'Surfer',
    icon: '≋',
    tagline: 'Rides the volume',
    text: 'Pools where trading is heating up right now — more swaps, more fees — while fees still cover the swing.',
    minTvl: 10_000,
    minCoverage: 1,
    maxMove: Infinity,
    rank: (m) => m.net * (m.heat || 0.5)
  }
];

/** A pool call for a persona: { verdict, reasons, metrics, score }. */
export function judgePool(row, persona) {
  const m = poolMetrics(row);
  const reasons = [];
  const pair = row.symbols?.join('/') || row.id;
  if (m.coverage < 1) {
    reasons.push(
      m.apr >= 200
        ? `APR ${m.apr.toFixed(0)}% looks great, but fees cover only ${fmtX(m.coverage)} of the 24h price swing (${fmtPct(m.change ?? 0, 1)}).`
        : `Fees cover only ${fmtX(m.coverage)} of the 24h price swing — LPs did better holding.`
    );
    reasons.push(`Net after impermanent loss: ${fmtPct(m.net)} a day.`);
    return { pair, verdict: 'AVOID', reasons, metrics: m, score: -1 };
  }
  reasons.push(`Fees cover ${fmtX(m.coverage)} the 24h price swing; net ${fmtPct(m.net)} a day after impermanent loss.`);
  if (m.heat !== null) {
    if (m.heat >= 1.3) reasons.push(`Trading is heating up: the last 6h ran at ${m.heat.toFixed(1)}× the daily pace.`);
    else if (m.heat <= 0.6) reasons.push(`Trading is cooling: the last 6h ran at ${m.heat.toFixed(1)}× the daily pace.`);
  }
  if (m.ageDays !== null && m.ageDays < 3) reasons.push(`Young pool (${m.ageDays < 1 ? 'under a day' : `${Math.floor(m.ageDays)}d`}): prices can still swing hard.`);
  const fits = m.tvl >= persona.minTvl && m.coverage >= persona.minCoverage && Math.abs(m.change ?? 0) <= persona.maxMove;
  const verdict = fits && m.coverage >= persona.minCoverage * 1.5 ? 'ENTER' : fits ? 'CONSIDER' : 'PASS';
  if (!fits) {
    if (m.tvl < persona.minTvl) reasons.push(`Below ${persona.name}'s $${(persona.minTvl / 1000).toFixed(0)}K TVL floor.`);
    else if (Math.abs(m.change ?? 0) > persona.maxMove) reasons.push(`Price moved ${fmtPct(m.change, 1)} — too swingy for ${persona.name}.`);
  }
  return { pair, verdict, reasons, metrics: m, score: fits ? persona.rank(m) : -0.5 };
}

/** Opportunities for a persona (best first) and the traps (high APR, fees lose to the swing). */
export function scanPools(rows, persona, limit = 6) {
  const calls = rows.filter((r) => r.tvl >= 1_000 && r.feeVolume24h > 0).map((r) => ({ row: r, ...judgePool(r, persona) }));
  const picks = calls
    .filter((c) => c.verdict === 'ENTER' || c.verdict === 'CONSIDER')
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const traps = calls
    .filter((c) => c.verdict === 'AVOID' && c.metrics.apr >= 100)
    .sort((a, b) => b.metrics.apr - a.metrics.apr)
    .slice(0, 4);
  return { picks, traps, scanned: calls.length, passed: calls.filter((c) => c.verdict !== 'AVOID' && c.verdict !== 'PASS').length };
}

/**
 * A call on one of the user's CLMM pools (all its positions together).
 * @param positions  getDclPositions() entries of one pool
 * @param usd        { value, fees } in USD
 * @param radarRow   the pool's radar row when it is among the active pools (for coverage)
 */
export function judgeDclHolding({ positions, usd, radarRow }) {
  const reasons = [];
  const inRange = positions.filter((p) => p.inRange).length;
  const total = positions.length;
  const m = radarRow ? poolMetrics(radarRow) : null;

  if (inRange === 0) {
    reasons.push(`${total === 1 ? 'The position is' : `All ${total} positions are`} out of range: earning no fees until the price returns.`);
    reasons.push('Rebalance moves the range back around the current price in one request.');
    return { verdict: 'REBALANCE', reasons, tone: 'down' };
  }
  if (inRange < total) {
    reasons.push(`${total - inRange} of ${total} positions are out of range and earning nothing.`);
    reasons.push('Rebalance → Out of range only moves just those.');
    return { verdict: 'REBALANCE', reasons, tone: 'warn' };
  }

  // Near an edge: within 10% of the range width from either side.
  const nearEdge = positions.some((p) => {
    const width = p.rightPoint - p.leftPoint;
    return width > 0 && Math.min(p.currentPoint - p.leftPoint, p.rightPoint - p.currentPoint) < width * 0.1;
  });
  if (usd.fees >= 1 && usd.value > 0 && usd.fees / usd.value >= 0.02) {
    reasons.push(`Unclaimed fees are $${usd.fees.toFixed(2)} (${((usd.fees / usd.value) * 100).toFixed(1)}% of the position).`);
    reasons.push('Compound puts them back to work in the same range.');
    return { verdict: 'COMPOUND', reasons, tone: 'up' };
  }
  if (m && m.coverage < 1) {
    reasons.push(`In range, but the pool's fees cover only ${fmtX(m.coverage)} of today's price swing (${fmtPct(m.change ?? 0, 1)}).`);
    reasons.push('Watch it: a wider range or a calmer pool may serve you better.');
    return { verdict: 'WATCH', reasons, tone: 'warn' };
  }
  if (nearEdge) {
    reasons.push('In range, but the price is close to an edge of your range.');
    reasons.push('If it crosses, the position stops earning — a range alert will tell you while KINU is open.');
    return { verdict: 'WATCH', reasons, tone: 'warn' };
  }
  reasons.push(`In range${total > 1 ? ` (all ${total} positions)` : ''} and earning fees.`);
  if (m) reasons.push(`Pool fees cover ${fmtX(m.coverage)} the 24h price swing.`);
  return { verdict: 'HOLD', reasons, tone: 'up' };
}

/** A call on a classic / stable / ALMM holding (fees auto-compound). */
export function judgeClassicHolding({ radarRow }) {
  const m = radarRow ? poolMetrics(radarRow) : null;
  if (m && m.coverage < 1) {
    return {
      verdict: 'WATCH',
      reasons: [`Fees cover only ${fmtX(m.coverage)} of today's price swing (${fmtPct(m.change ?? 0, 1)}).`, 'Fees auto-compound here; the risk is the price swing itself.'],
      tone: 'warn'
    };
  }
  return {
    verdict: 'HOLD',
    reasons: [
      'Full-range liquidity: always earning while the pool trades.',
      m ? `Fees cover ${fmtX(m.coverage)} the 24h price swing; they auto-compound — nothing to claim.` : 'Fees auto-compound — nothing to claim.'
    ],
    tone: 'up'
  };
}
