// Smart Money In: the Rhea tokens to watch — the featured Main tokens in a fixed order (KINU, our
// token, sits between RHEA and NEARLY), then the Next tokens and the rest of Rhea's most traded
// tokens by 24h volume — with the Smart LP wallets that hold liquidity in their CLMM pools right
// now (one RPC view per wallet; no NearBlocks).

import { getDclPositions } from './rhea.js';
import { getPrices } from './tokens.js';
import { BASE_TOKENS } from './trending.js';
import { FEE_CHECK_MIN } from './smartLp.js';
import { CONTRACTS, KINU_TOKEN } from '../config.js';

/**
 * Featured tokens, in tiers: [tier label, token ids, fixed order?]. Main keeps the order below;
 * the other tiers go by 24h volume.
 */
export const FEATURED = [
  [
    'Main',
    [
      CONTRACTS.wrapNear, // NEAR
      'qtc.omft.near', // QTC
      'token.rhealab.near', // RHEA
      KINU_TOKEN, // KINU — our token
      'nearly-993927.nearlytrade.near', // NEARLY
      'batman-4.nearlytrade.near', // BATMAN
      'dragon-3.nearlytrade.near' // DRAGON
    ],
    true
  ],
  [
    'Next',
    [
      'diarhea.nearlytrade.near', // DIARHEA
      'ninu-4.nearlytrade.near', // NINU
      'singularty.nearlytrade.near', // SINGULARTY
      'jambo-1679.meme-cooking.near', // JAMBO
      'token.0xshitzu.near', // SHITZU
      'token.intear.near' // TEAR
    ]
  ]
];

/** Pools under this much liquidity are not listed. */
export const MIN_POOL_TVL = 10_000;

// Stablecoins are never "in" (NEAR is: it is a featured token).
const SKIP = new Set([...BASE_TOKENS].filter((id) => id !== CONTRACTS.wrapNear));
const CACHE_MS = 5 * 60_000;
let cache = null; // { at, key, promise }

export const isProfitable = (w) => w.totalPnl > 0 && (w.feeShare ?? 0) >= FEE_CHECK_MIN;

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The Smart LP board wallets' live CLMM liquidity by token:
 * Map<tokenId, { lps: [account], profitable: [account], valueUsd, pools: [{ poolId, lps: [account] }] }>
 */
export function loadSmartLps(board) {
  const wallets = board?.wallets || [];
  const key = `${board?.generatedAt}:${wallets.length}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.promise;
  const promise = (async () => {
    const [positions, prices] = await Promise.all([mapLimited(wallets, 4, (w) => getDclPositions(w.account)), getPrices()]);
    const usd = (id, raw) => {
      const info = prices.get(id);
      return info?.price && Number.isFinite(info.decimals) ? (raw / 10 ** info.decimals) * info.price : 0;
    };
    const tokens = new Map();
    wallets.forEach((w, i) => {
      (positions[i] || []).forEach((p) => {
        const value = usd(p.tokenX, p.amountX) + usd(p.tokenY, p.amountY);
        [p.tokenX, p.tokenY]
          .filter((id) => !SKIP.has(id))
          .forEach((id) => {
            if (!tokens.has(id)) tokens.set(id, { lps: new Set(), profitable: new Set(), valueUsd: 0, pools: new Map() });
            const t = tokens.get(id);
            t.lps.add(w.account);
            if (isProfitable(w)) t.profitable.add(w.account);
            t.valueUsd += value;
            if (!t.pools.has(p.poolId)) t.pools.set(p.poolId, new Set());
            t.pools.get(p.poolId).add(w.account);
          });
      });
    });
    return new Map(
      [...tokens].map(([id, t]) => [
        id,
        {
          lps: [...t.lps],
          profitable: [...t.profitable],
          valueUsd: t.valueUsd,
          pools: [...t.pools].map(([poolId, lps]) => ({ poolId, lps: [...lps] })).sort((a, b) => b.lps.length - a.lps.length)
        }
      ])
    );
  })();
  cache = { at: Date.now(), key, promise };
  promise.catch(() => {
    if (cache?.promise === promise) cache = null;
  });
  return promise;
}

/** The tier of a token: 0 main, 1 next, 2 the rest. */
/** A token's place within a fixed-order tier (Main), else null (the tier goes by volume). */
export function fixedRank(id) {
  const tier = FEATURED.find(([, ids, fixed]) => fixed && ids.includes(id));
  return tier ? tier[1].indexOf(id) : null;
}

export function tierOf(id) {
  const i = FEATURED.findIndex(([, ids]) => ids.includes(id));
  return i < 0 ? FEATURED.length : i;
}

/** Token ids to list: the featured ones, then `others` (e.g. Rhea's trending), stablecoins left out. */
export function smartMoneyIds(others = []) {
  return [...new Set([...FEATURED.flatMap(([, ids]) => ids), ...others])].filter((id) => !SKIP.has(id));
}
