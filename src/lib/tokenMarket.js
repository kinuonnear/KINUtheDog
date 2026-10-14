// Market data for one token on NEAR, for the Swap page:
//   GeckoTerminal -> the token's pools (TVL, 24h volume, buys / sells), its profile (logo,
//                    links, verified), and each pool's recent trades (top traders)
//   FastNEAR      -> the top holders
// GeckoTerminal's public API allows ~30 requests a minute per visitor, so every read is cached
// and identical reads share one request.

import { ENDPOINTS } from '../config.js';
import { geckoFetch } from './gecko.js';

const GECKO = `${ENDPOINTS.geckoterminal}/networks/near`;
const cache = new Map(); // key -> { at, promise }

function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

async function getJson(url) {
  // GeckoTerminal reads share one rate-limited lane with the charts (lib/gecko.js).
  const response = url.startsWith(GECKO) ? await geckoFetch(url) : await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 429 ? 'Market data is busy — retrying shortly.' : `Market data HTTP ${response.status}`);
  return response.json();
}

const stripNetwork = (id) => String(id || '').replace(/^near_/, '');

/** GeckoTerminal pool address -> Rhea pool id (CLMM "x|y|fee", classic "123"), or null for other DEXes. */
export function rheaPoolId(address, dex) {
  if (dex !== 'rhea-finance' && dex !== 'ref-finance') return null;
  if (address.startsWith('refv2-')) return address.slice(6).split(':').join('|');
  if (address.startsWith('refv1-')) return address.slice(6);
  return null;
}

const CLMM_FEES = [100, 400, 2000, 10000];

/** GeckoTerminal addresses of the Rhea CLMM pools a pair could have (one per fee tier). */
function pairPoolAddresses(a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return CLMM_FEES.map((fee) => `refv2-${x}:${y}:${fee}`);
}

/**
 * The token's pools, deepest first: [{ address, rheaId, name, dex, baseId, quoteId, tvl, volume24, buys24, sells24, fee }].
 * GeckoTerminal lists a token's top 20 pools, which big NEAR Intents pools can fill: the Rhea pools
 * pairing it with `counterId` (the other side of the swap) are always looked up as well.
 */
export function getTokenPools(tokenId, counterId = null) {
  return cached(`pools:${tokenId}:${counterId || ''}`, 60_000, async () => {
    const [listed, paired] = await Promise.all([
      getJson(`${GECKO}/tokens/${encodeURIComponent(tokenId)}/pools?page=1`),
      counterId && counterId !== tokenId
        ? getJson(`${GECKO}/pools/multi/${pairPoolAddresses(tokenId, counterId).map(encodeURIComponent).join(',')}`).catch(() => ({ data: [] }))
        : { data: [] }
    ]);
    const seen = new Set();
    return [...(paired.data || []), ...(listed.data || [])]
      .filter((p) => {
        const address = p.attributes?.address;
        if (!address || seen.has(address)) return false;
        seen.add(address);
        return true;
      })
      .map((p) => {
        const a = p.attributes || {};
        const r = p.relationships || {};
        const dex = r.dex?.data?.id || '';
        const tx = a.transactions?.h24 || {};
        const name = String(a.name || '');
        const rheaId = rheaPoolId(String(a.address || ''), dex);
        // CLMM fee from the pool id ("x|y|2000" = 0.2%), else from the name ("… 0.3%").
        const clmmFee = rheaId?.includes('|') ? Number(rheaId.split('|')[2]) / 10_000 : null;
        const fee = clmmFee ?? name.match(/(\d+(?:\.\d+)?)%/)?.[1];
        return {
          address: a.address,
          rheaId,
          name: name.replace(/\s+\d+(?:\.\d+)?%$/, ''),
          dex,
          fee: fee ? `${fee}%` : null,
          baseId: stripNetwork(r.base_token?.data?.id),
          quoteId: stripNetwork(r.quote_token?.data?.id),
          tvl: Number(a.reserve_in_usd) || 0,
          volume24: Number(a.volume_usd?.h24) || 0,
          buys24: Number(tx.buys) || 0,
          sells24: Number(tx.sells) || 0
        };
      })
      .sort((a, b) => b.tvl - a.tvl);
  });
}

/** Logo, links and verified flag from GeckoTerminal (null when the token isn't indexed). */
const handleOf = (url, host) => {
  const m = String(url || '').match(new RegExp(`${host}/(?:#!/)?@?([A-Za-z0-9_+]+)`, 'i'));
  return m ? m[1] : null;
};

/**
 * A token's links from DexScreener: most NEAR teams fill in their socials there (via the
 * DexScreener token profile) rather than on GeckoTerminal. Also the token's DexScreener page.
 */
async function dexScreenerProfile(tokenId) {
  const json = await getJson(`${ENDPOINTS.dexscreener}/latest/dex/tokens/${encodeURIComponent(tokenId)}`);
  const pairs = (json.pairs || []).filter((p) => p.chainId === 'near');
  const info = pairs.find((p) => p.info)?.info;
  const socials = info?.socials || [];
  const social = (type) => socials.find((s) => s.type === type)?.url || null;
  const top = [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return {
    image: info?.imageUrl || null,
    website: info?.websites?.[0]?.url || null,
    twitter: handleOf(social('twitter'), '(?:x|twitter)\\.com'),
    telegram: handleOf(social('telegram'), 't\\.me'),
    discord: social('discord'),
    dexscreener: top?.url || null
  };
}

async function geckoProfile(tokenId) {
  const json = await getJson(`${GECKO}/tokens/${encodeURIComponent(tokenId)}/info`);
  const a = json.data?.attributes;
  if (!a) return null;
  return {
    image: a.image_url && a.image_url !== 'missing.png' ? a.image_url : null,
    website: (a.websites || [])[0] || null,
    twitter: a.twitter_handle || null,
    telegram: a.telegram_handle || null,
    discord: a.discord_url || null,
    verified: Boolean(a.gt_verified)
  };
}

/** Logo, links and GeckoTerminal verification, from GeckoTerminal and DexScreener combined. */
export function getTokenProfile(tokenId) {
  return cached(`profile:${tokenId}`, 10 * 60_000, async () => {
    const [gecko, dex] = await Promise.all([geckoProfile(tokenId).catch(() => null), dexScreenerProfile(tokenId).catch(() => null)]);
    if (!gecko && !dex) return null;
    const pick = (key) => gecko?.[key] || dex?.[key] || null;
    return {
      image: pick('image'),
      website: pick('website'),
      twitter: pick('twitter'),
      telegram: pick('telegram'),
      discord: pick('discord'),
      verified: Boolean(gecko?.verified),
      dexscreener: dex?.dexscreener || null
    };
  });
}

/**
 * The pool the chart follows: the deepest Rhea pool pairing the token with the other side of the
 * swap, else the deepest Rhea pool, else the deepest pool on any DEX.
 */
export function chartPoolFor(pools, counterId) {
  if (!pools?.length) return null;
  const rhea = pools.filter((p) => p.rheaId);
  return rhea.find((p) => p.baseId === counterId || p.quoteId === counterId) || rhea[0] || pools[0];
}

/** Top holders from FastNEAR: [{ account, balance }] (raw balances). */
export function getTopHolders(tokenId) {
  return cached(`holders:${tokenId}`, 2 * 60_000, async () => {
    const json = await getJson(`${ENDPOINTS.fastnear}/v1/ft/${encodeURIComponent(tokenId)}/top`);
    return (json.accounts || []).map((h) => ({ account: h.account_id, balance: String(h.balance || '0') }));
  });
}

/**
 * Top traders of the token over the last day, from its deepest pools' recent trades (GeckoTerminal
 * keeps ~300 per pool): [{ trader, buyUsd, sellUsd, trades }] by volume.
 */
export function getTopTraders(tokenId, pools) {
  const top = (pools || []).slice(0, 3);
  return cached(`traders:${tokenId}:${top.map((p) => p.address).join(',')}`, 60_000, async () => {
    const lists = await Promise.all(
      top.map((p) => getJson(`${GECKO}/pools/${encodeURIComponent(p.address)}/trades`).then((j) => j.data || []).catch(() => []))
    );
    const byTrader = new Map();
    lists.flat().forEach((t) => {
      const a = t.attributes || {};
      const trader = a.tx_from_address;
      if (!trader) return;
      // "buy" / "sell" refer to the pool's base token: flip them when our token is the quote side.
      const boughtToken = stripNetwork(a.to_token_address) === tokenId;
      const usd = Number(a.volume_in_usd) || 0;
      const row = byTrader.get(trader) || { trader, buyUsd: 0, sellUsd: 0, trades: 0 };
      if (boughtToken) row.buyUsd += usd;
      else row.sellUsd += usd;
      row.trades += 1;
      byTrader.set(trader, row);
    });
    return [...byTrader.values()].sort((a, b) => b.buyUsd + b.sellUsd - (a.buyUsd + a.sellUsd)).slice(0, 50);
  });
}
