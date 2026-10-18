// NEAR DeFi Pulse data for /pulse (a Vercel function): chain TVL, DEX volume, fees, stablecoins,
// protocols and yields on NEAR, from DefiLlama's public APIs, cut down to what the page shows.
// DefiLlama's protocol and yield lists are ~10 MB each, too big for a phone, so they are read here.
// Cached at the edge for 30 minutes (DefiLlama itself updates about hourly).

const LLAMA = 'https://api.llama.fi';
const get = async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  return r.json();
};

// Some days a protocol's adapter misses data and NEAR's TVL drops by a third, then comes back
// (11 such days in the 180 to Oct 2026). A day under 75% of its 15-day median takes the median.
export function cleanSeries(series) {
  return series.map(([t, v], i) => {
    const w = series
      .slice(Math.max(0, i - 7), i + 8)
      .map((p) => p[1])
      .sort((a, b) => a - b);
    const median = w[Math.floor(w.length / 2)];
    return [t, v < 0.75 * median ? median : v];
  });
}

/** Percent change from `days` ago to the last point (null when the series is too short). */
function change(series, days) {
  const last = series[series.length - 1];
  const past = series[series.length - 1 - days];
  return last && past && past[1] > 0 ? (last[1] / past[1] - 1) * 100 : null;
}

const round = (n) => Math.round(n);
const tail = (series, days) => series.slice(-days).map(([t, v]) => [t, round(v)]);

// Where KINU lets you act on a protocol's market (the page shows these as links).
const ON_KINU = {
  'Rhea Dex': '/pools',
  'NEAR Intents': '/bridge',
  'LiNEAR Protocol': '/stake',
  'Meta Pool Near': '/stake'
};

async function build() {
  const [tvlRaw, protocols, dexs, fees, stables, yields] = await Promise.all([
    get(`${LLAMA}/v2/historicalChainTvl/Near`),
    get(`${LLAMA}/protocols`),
    get(`${LLAMA}/overview/dexs/Near?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true`),
    get(`${LLAMA}/overview/fees/Near?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`),
    get('https://stablecoins.llama.fi/stablecoincharts/Near'),
    get('https://yields.llama.fi/pools')
  ]);

  const tvl = cleanSeries(tvlRaw.map((p) => [p.date, p.tvl]));
  const st = stables.map((p) => [Number(p.date), Object.values(p.totalCirculatingUSD || {}).reduce((s, v) => s + v, 0)]);
  const st120 = st.slice(-120);
  const low = st120.reduce((a, b) => (b[1] < a[1] ? b : a));
  const high = st120.reduce((a, b) => (b[1] > a[1] ? b : a));

  // DeFi only: centralised exchanges' NEAR wallets are not DeFi.
  const list = protocols
    .filter((p) => p.chainTvls?.Near > 0 && p.category !== 'CEX')
    .map((p) => ({
      name: p.name,
      category: p.category,
      tvl: round(p.chainTvls.Near),
      change7d: Number.isFinite(p.change_7d) ? p.change_7d : null,
      url: `https://defillama.com/protocol/${p.slug}`,
      kinu: ON_KINU[p.name] || null
    }))
    .sort((a, b) => b.tvl - a.tvl);

  const dexList = (dexs.protocols || []).filter((p) => p.total24h > 0).sort((a, b) => b.total24h - a.total24h);
  const intents = dexList.find((p) => p.name === 'NEAR Intents');

  return {
    updatedAt: Date.now(),
    tvl: {
      now: round(tvl[tvl.length - 1][1]),
      change7d: change(tvl, 7),
      change30d: change(tvl, 30),
      change90d: change(tvl, 90),
      change1y: change(tvl, 365),
      series: tail(tvl, 365)
    },
    dex: {
      volume24h: round(dexs.total24h || 0),
      volume7d: round(dexs.total7d || 0),
      volume30d: round(dexs.total30d || 0),
      intentsShare24h: intents && dexs.total24h ? (intents.total24h / dexs.total24h) * 100 : null,
      top: dexList.slice(0, 5).map((p) => ({ name: p.name, volume24h: round(p.total24h), volume7d: round(p.total7d || 0) })),
      series: tail((dexs.totalDataChart || []).map(([t, v]) => [t, v]), 60)
    },
    fees: {
      fees24h: round(fees.total24h || 0),
      fees30d: round(fees.total30d || 0),
      top: (fees.protocols || [])
        .filter((p) => p.total24h > 0)
        .sort((a, b) => b.total24h - a.total24h)
        .slice(0, 5)
        .map((p) => ({ name: p.name, fees24h: round(p.total24h), fees30d: round(p.total30d || 0) }))
    },
    stablecoins: {
      now: round(st[st.length - 1][1]),
      change30d: change(st, 30),
      low120d: [low[0], round(low[1])],
      high120d: [high[0], round(high[1])],
      series: tail(st, 180)
    },
    protocols: list.slice(0, 15),
    categories: Object.entries(list.reduce((acc, p) => ({ ...acc, [p.category]: (acc[p.category] || 0) + p.tvl }), {}))
      .map(([category, value]) => ({ category, tvl: round(value) }))
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 8),
    liquidStaking: list.filter((p) => p.category === 'Liquid Staking').slice(0, 5),
    yields: (yields.data || [])
      .filter((p) => p.chain === 'Near' && p.tvlUsd >= 50_000 && Number.isFinite(p.apy))
      .sort((a, b) => b.tvlUsd - a.tvlUsd)
      .slice(0, 12)
      .map((p) => ({ project: p.project, symbol: p.symbol, tvl: round(p.tvlUsd), apy: p.apy, stablecoin: Boolean(p.stablecoin) }))
  };
}

// One build per function instance per 10 minutes, on top of the edge cache.
let cached = null;

export default async function handler(req, res) {
  try {
    if (!cached || Date.now() - cached.at > 10 * 60_000) cached = { at: Date.now(), body: await build() };
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    res.status(200).json(cached.body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
}
