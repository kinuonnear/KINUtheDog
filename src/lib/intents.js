// Deposits from other chains into a NEAR account through NEAR Intents' 1Click API
// (https://docs.near-intents.org): a quote gives a one-time deposit address on the chain the money
// is on; the user sends to it from any wallet or exchange, and the funds arrive on NEAR in about a
// minute, or go back to the refund address if the swap can't complete. KINU never holds the funds.
//
// Called from the browser without a partner key (1Click's fees are inside each quote). `referral`
// only labels the swaps as coming from KINU. Every quote's 1Click signature is checked
// (lib/intentsSignature.js): a live quote that fails it is never shown.

import { verifyQuoteSignature } from './intentsSignature.js';

const API = 'https://1click.chaindefuser.com/v0';
const REFERRAL = 'kinu';
const TOKENS_TTL_MS = 5 * 60_000;

/** What a deposit can arrive as on NEAR. */
export const RECEIVE = {
  near: { key: 'near', assetId: 'nep141:wrap.near', symbol: 'NEAR', decimals: 24, note: 'arrives as wNEAR' },
  usdc: { key: 'usdc', assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', decimals: 6, note: 'native USDC on NEAR' }
};

/** Chains people deposit from most, first; then the rest in the API's order. */
export const CHAIN_ORDER = ['base', 'sol', 'eth', 'arb', 'bsc', 'tron', 'btc', 'op', 'pol', 'avax', 'ton', 'sui', 'aptos'];
export const CHAIN_NAMES = {
  base: 'Base',
  sol: 'Solana',
  eth: 'Ethereum',
  arb: 'Arbitrum',
  bsc: 'BNB Chain',
  tron: 'Tron',
  btc: 'Bitcoin',
  op: 'Optimism',
  pol: 'Polygon',
  avax: 'Avalanche',
  ton: 'TON',
  sui: 'Sui',
  aptos: 'Aptos',
  zec: 'Zcash',
  doge: 'Dogecoin',
  xrp: 'XRP Ledger',
  ltc: 'Litecoin',
  bch: 'Bitcoin Cash',
  stellar: 'Stellar',
  cardano: 'Cardano',
  gnosis: 'Gnosis',
  bera: 'Berachain',
  monad: 'Monad',
  starknet: 'Starknet',
  scroll: 'Scroll',
  hypercore: 'Hyperliquid'
};
/** What a refund address on each chain looks like (placeholder text). */
export const ADDRESS_HINT = { sol: 'Solana address', btc: 'bc1… / 1… / 3…', tron: 'T…', ton: 'UQ… / EQ…', sui: '0x… (Sui)', aptos: '0x… (Aptos)' };
/** Assets people deposit most, first within a chain. */
const ASSET_ORDER = ['USDC', 'USDT', 'ETH', 'SOL', 'BTC', 'BNB', 'TRX', 'POL', 'AVAX', 'ARB', 'OP'];

let tokensCache = { at: 0, list: null };

async function call(path, init) {
  const response = await fetch(`${API}${path}`, init);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.message || `NEAR Intents HTTP ${response.status}`);
  return json;
}

/** Every asset that can be deposited from another chain (cached a few minutes). */
export async function getDepositAssets() {
  if (tokensCache.list && Date.now() - tokensCache.at < TOKENS_TTL_MS) return tokensCache.list;
  const all = await call('/tokens');
  const list = all
    .filter((t) => t.blockchain !== 'near')
    .sort((a, b) => {
      const ca = CHAIN_ORDER.indexOf(a.blockchain);
      const cb = CHAIN_ORDER.indexOf(b.blockchain);
      if (ca !== cb) return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb);
      const aa = ASSET_ORDER.indexOf(a.symbol);
      const ab = ASSET_ORDER.indexOf(b.symbol);
      return (aa < 0 ? 99 : aa) - (ab < 0 ? 99 : ab);
    });
  tokensCache = { at: Date.now(), list };
  return list;
}

/**
 * A quote for a deposit of `amount` (smallest units of `asset`) arriving on NEAR as `receive`
 * (RECEIVE key) in `recipient`. `dry`: price only, no deposit address. Live quotes have a deposit
 * address valid until `deadline` (30 min here).
 */
export async function depositQuote({ asset, amount, receive, recipient, refundTo, dry = true, slippageBps = 100 }) {
  const body = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippageBps,
    originAsset: asset.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: RECEIVE[receive].assetId,
    amount: String(amount),
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: refundTo.trim(),
    refundType: 'ORIGIN_CHAIN',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    referral: REFERRAL
  };
  const json = await call('/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const verified = verifyQuoteSignature(json);
  // A deposit address is only ever shown when 1Click signed it.
  if (!dry && !verified) throw new Error("This deposit address couldn't be verified as coming from NEAR Intents, so it isn't shown. Try again.");
  return { ...json.quote, request: json.quoteRequest, signature: json.signature, verified };
}

/** Status of a deposit: PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED, FAILED. */
export async function depositStatus(depositAddress, depositMemo) {
  const query = new URLSearchParams({ depositAddress });
  if (depositMemo) query.set('depositMemo', depositMemo);
  return call(`/status?${query}`);
}

/** Optional: tell 1Click the deposit's transaction hash so it picks the deposit up sooner. */
export async function submitDepositTx(depositAddress, txHash, depositMemo) {
  return call('/deposit/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txHash: txHash.trim(), depositAddress, ...(depositMemo ? { memo: depositMemo } : {}) })
  });
}

export const FINAL_STATUSES = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);

/* ---------------------------------------------------------------- logos */

// Chain logos (DefiLlama's icon set); chains it doesn't have get an initial instead.
const LLAMA_CHAIN = {
  eth: 'ethereum',
  base: 'base',
  arb: 'arbitrum',
  sol: 'solana',
  bsc: 'binance',
  tron: 'tron',
  btc: 'bitcoin',
  op: 'optimism',
  pol: 'polygon',
  avax: 'avalanche',
  ton: 'ton',
  sui: 'sui',
  aptos: 'aptos',
  near: 'near',
  zec: 'zcash',
  xrp: 'ripple',
  ltc: 'litecoin',
  bch: 'bitcoincash',
  stellar: 'stellar',
  cardano: 'cardano',
  gnosis: 'xdai',
  bera: 'berachain',
  monad: 'monad',
  scroll: 'scroll',
  hypercore: 'hyperliquid'
};
export const chainIcon = (chain) => (LLAMA_CHAIN[chain] ? `https://icons.llamao.fi/icons/chains/rsz_${LLAMA_CHAIN[chain]}.jpg` : null);

const ICONS_KEY = 'kinu.intents.icons.v1';
const ICONS_TTL_MS = 7 * 86_400_000;

/** Coin logos by CoinGecko id (one CoinGecko call for the whole list, kept a week in this browser). */
export async function getAssetIcons(assets) {
  let cached = {};
  try {
    const stored = JSON.parse(localStorage.getItem(ICONS_KEY) || 'null');
    if (stored && Date.now() - stored.at < ICONS_TTL_MS) cached = stored.icons;
  } catch {
    // storage blocked: fetch every time
  }
  const ids = [...new Set(assets.map((a) => a.coingeckoId).filter(Boolean))];
  const missing = ids.filter((id) => !(id in cached));
  if (missing.length) {
    const found = {};
    for (let i = 0; i < missing.length; i += 250) {
      const query = new URLSearchParams({ vs_currency: 'usd', ids: missing.slice(i, i + 250).join(','), per_page: '250' });
      const response = await fetch(`https://api.coingecko.com/api/v3/coins/markets?${query}`).catch(() => null);
      const list = response?.ok ? await response.json().catch(() => []) : [];
      (Array.isArray(list) ? list : []).forEach((c) => (found[c.id] = c.image));
    }
    // Ids CoinGecko didn't return are remembered as empty so they aren't asked for again.
    missing.forEach((id) => (cached[id] = found[id] || ''));
    try {
      localStorage.setItem(ICONS_KEY, JSON.stringify({ at: Date.now(), icons: cached }));
    } catch {
      // ignore
    }
  }
  return cached;
}

/** Logos of what deposits arrive as on NEAR. */
export const RECEIVE_ICONS = {
  near: 'https://coin-images.coingecko.com/coins/images/10365/large/near.jpg',
  usdc: 'https://coin-images.coingecko.com/coins/images/6319/large/USDC.png'
};
