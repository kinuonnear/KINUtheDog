// Deposits from other chains into a NEAR account through NEAR Intents' 1Click API
// (https://docs.near-intents.org): a quote gives a one-time deposit address on the chain the money
// is on; the user sends to it from any wallet or exchange, and the funds arrive on NEAR in about a
// minute, or go back to the refund address if the swap can't complete. KINU never holds the funds.
//
// Quotes go through api/intents-quote.js (KINU's partner key and fee, lib/intentsFees.js); `referral`
// only labels the swaps as coming from KINU. Every quote's 1Click signature is checked
// (lib/intentsSignature.js): a live quote that fails it is never shown.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { verifyQuoteSignature } from './intentsSignature.js';
import { ensureStorageTx, functionCall, transaction, wrapNearTx } from './tx.js';
import { allowBridgeDeposit } from './txGuard.js';
import { CONTRACTS, DEPOSIT } from '../config.js';
import { CHAIN_SVGS, TOKEN_SVGS } from './logoManifest.js';
import { KINU_FEE_RECIPIENT, quoteFeeBps } from './intentsFees.js';

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
  hypercore: 'Hyperliquid',
  abs: 'Abstract',
  adi: 'ADI Chain',
  aleo: 'Aleo',
  dash: 'Dash',
  fogo: 'Fogo',
  hood: 'Robinhood Chain',
  movement: 'Movement',
  plasma: 'Plasma',
  xlayer: 'X Layer'
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

/**
 * A quote, through KINU's api/intents-quote.js: it adds KINU's partner key (which must not reach the
 * browser) and KINU's fee. On a host without that function the request goes straight to 1Click
 * with the same fee, unauthenticated. Either way the page verifies 1Click's signature on the answer.
 */
export async function postQuote(body) {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
  let response = null;
  try {
    response = await fetch('/api/intents-quote', { ...init, body: JSON.stringify(body) });
  } catch {
    response = null;
  }
  if (!response || response.status === 404 || response.status === 405) {
    const fee = quoteFeeBps(body.originAsset, body.destinationAsset, symbolOf);
    return call('/quote', { ...init, body: JSON.stringify({ ...body, appFees: [{ recipient: KINU_FEE_RECIPIENT, fee }] }) });
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.message || `NEAR Intents HTTP ${response.status}`);
  return json;
}

const BOUND_FIELDS = ['swapType', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'recipient', 'recipientType', 'refundTo', 'refundType'];
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * A signed quote must also be the quote that was asked for: 1Click signs the request it echoes,
 * so a genuine quote made for someone else's recipient, refund address or amount would still
 * verify. Anything between KINU and 1Click that swapped one in is caught here.
 */
export function assertQuoteMatches(sent, json) {
  const echoed = json?.quoteRequest || {};
  const off = BOUND_FIELDS.find((k) => !same(echoed[k], sent[k]));
  if (off) throw new Error(`This quote doesn't match your request (${off}), so it isn't used. Try again.`);
  if (json.quote && String(json.quote.amountIn) !== String(sent.amount)) throw new Error("This quote's amount doesn't match your request, so it isn't used. Try again.");
}

const symbolOf = (assetId) => (tokensCache.all || []).find((t) => t.assetId === assetId)?.symbol || (assetId === RECEIVE.near.assetId ? 'NEAR' : '');

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
  tokensCache = { at: Date.now(), list, all };
  return list;
}

/**
 * A quote for a deposit of `amount` (smallest units of `asset`) arriving on NEAR as `receive`
 * (RECEIVE key) in `recipient`. `dry`: price only, no deposit address. Live quotes have a deposit
 * address valid until `deadline` (30 min here).
 */
export async function depositQuote({ asset, amount, receive, recipient, refundTo, dry = true, slippageBps = 100 }) {
  return chainQuote({ fromAsset: asset, toAssetId: RECEIVE[receive].assetId, amount, recipient, refundTo, dry, slippageBps });
}

/**
 * Any chain to any chain: `amount` of `fromAsset` sent on its own chain arrives as `toAsset` at
 * `recipient` on the other chain; a failed swap goes back to `refundTo` on the first chain. Same
 * deposit-address flow (and checks) as a deposit to NEAR.
 */
export async function crossQuote({ fromAsset, toAsset, amount, recipient, refundTo, dry = true, slippageBps = 100 }) {
  return chainQuote({ fromAsset, toAssetId: toAsset.assetId, amount, recipient: recipient.trim(), refundTo, dry, slippageBps });
}

async function chainQuote({ fromAsset, toAssetId, amount, recipient, refundTo, dry, slippageBps }) {
  const body = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippageBps,
    originAsset: fromAsset.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: toAssetId,
    amount: String(amount),
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: refundTo.trim(),
    refundType: 'ORIGIN_CHAIN',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    referral: REFERRAL
  };
  const json = await postQuote(body);
  assertQuoteMatches(body, json);
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

/* ---------------------------------------------------------------- status and help */

/** Where people get help with a transfer. near.com's help centre and chat are NEAR Intents' own. */
export const SUPPORT = {
  status: 'https://partners.near-intents.org/shield/status',
  helpCenter: 'https://near-com.helpscoutdocs.com/',
  chat: 'https://near.com/',
  explorer: (depositAddress) => `https://explorer.near-intents.org/transactions/${encodeURIComponent(depositAddress)}`
};

const BRIDGE_NAMES = { hot: 'HOT bridge', omni: 'Omni bridge', poa: 'PoA bridge' };
const STATUS_TTL_MS = 60_000;
let statusCache = { at: 0, value: null };

/**
 * Open NEAR Intents Shield incidents: while one is open, deposits, withdrawals and swaps on that
 * chain (or through that bridge) are paused. Read through /api/intents-status (no CORS upstream).
 * { chains: Set of 1Click chain ids, items: [{ id, kind, chain, label, since }] }; empty when unreachable.
 */
export async function getShieldStatus() {
  if (statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const value = { chains: new Set(), items: [] };
  try {
    const response = await fetch('/api/intents-status');
    const json = response.ok ? await response.json() : {};
    for (const i of json.activeIncidents || []) {
      if (i.status && i.status !== 'active') continue;
      const kind = i.scopeType === 'bridge' ? 'bridge' : 'chain';
      if (kind === 'chain') value.chains.add(i.scopeValue);
      const label = kind === 'chain' ? CHAIN_NAMES[i.scopeValue] || i.scopeValue.toUpperCase() : BRIDGE_NAMES[i.scopeValue] || `${i.scopeValue} bridge`;
      value.items.push({ id: i.id, kind, chain: kind === 'chain' ? i.scopeValue : null, label, since: i.createdAt });
    }
  } catch {
    // Status is a courtesy: if it can't be read, the quote itself still fails on a paused chain.
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/* ---------------------------------------------------------------- withdrawals (NEAR -> other chains) */

/** What can be sent out from NEAR (1Click's NEAR-side assets), wNEAR first and shown as NEAR. */
export async function getWithdrawAssets() {
  const all = tokensCache.all || (await call('/tokens'));
  tokensCache.all = all;
  const order = ['wrap.near', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'usdt.tether-token.near'];
  return all
    .filter((t) => t.blockchain === 'near' && /^nep141:/.test(t.assetId) && t.contractAddress)
    .map((t) => (t.contractAddress === 'wrap.near' ? { ...t, symbol: 'NEAR' } : t))
    .sort((a, b) => {
      const ia = order.indexOf(a.contractAddress);
      const ib = order.indexOf(b.contractAddress);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
}

/**
 * A quote for sending `amount` (smallest units) of a NEAR asset to `recipient` on another chain as
 * `toAsset`; refunds go back to `account` on NEAR. A live quote's deposit address is a one-time NEAR
 * account (64 hex) and is only returned when 1Click's signature on it checks out.
 */
export async function withdrawQuote({ fromAsset, toAsset, amount, recipient, account, dry = true, slippageBps = 100 }) {
  const body = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippageBps,
    originAsset: fromAsset.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: toAsset.assetId,
    amount: String(amount),
    recipient: recipient.trim(),
    recipientType: 'DESTINATION_CHAIN',
    refundTo: account,
    refundType: 'ORIGIN_CHAIN',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    referral: REFERRAL
  };
  const json = await postQuote(body);
  assertQuoteMatches(body, json);
  const verified = verifyQuoteSignature(json);
  if (!dry && !verified) throw new Error("This withdrawal couldn't be verified as coming from NEAR Intents, so nothing was sent. Try again.");
  if (!dry && !/^[0-9a-f]{64}$/.test(String(json.quote?.depositAddress))) throw new Error('Unexpected deposit address from NEAR Intents. Nothing was sent.');
  return { ...json.quote, request: json.quoteRequest, signature: json.signature, verified };
}

/**
 * The wallet request for a verified withdrawal quote: wrap NEAR if needed, register the deposit
 * address on the token if it isn't yet, and send the tokens to it (lib/txGuard.js only lets a
 * transfer through to a deposit address passed to allowBridgeDeposit).
 */
export async function buildWithdrawTransactions({ quote, fromAsset, accountId, wrap = '0' }) {
  const token = fromAsset.contractAddress;
  const to = quote.depositAddress;
  allowBridgeDeposit(to, token, String(quote.amountIn));
  const txs = [];
  if (token === CONTRACTS.wrapNear && BigInt(wrap) > 0n) {
    txs.push(await ensureStorageTx(CONTRACTS.wrapNear, accountId));
    txs.push(wrapNearTx(wrap));
  }
  txs.push(await ensureStorageTx(token, to));
  txs.push(
    transaction(token, [
      functionCall('ft_transfer', { receiver_id: to, amount: String(quote.amountIn), ...(quote.depositMemo ? { memo: quote.depositMemo } : {}) }, GAS_FT_TRANSFER, DEPOSIT.oneYocto)
    ])
  );
  return txs.filter(Boolean);
}

const GAS_FT_TRANSFER = '30000000000000';

export const FINAL_STATUSES = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);

/* ---------------------------------------------------------------- logos */

// Logos, best source first: KINU's own vector logos (public/logos: Web3 Icons' original logos for
// every chain and major token — lib/logoManifest.js), then Trust Wallet's curated asset repository
// (256 px, per token contract, via jsDelivr), then CoinGecko's image, then the base asset's vector
// for wrapped / bridged versions, then an initial (ui).
const TW = 'https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains';
const TW_CHAIN = {
  eth: 'ethereum',
  base: 'base',
  arb: 'arbitrum',
  sol: 'solana',
  bsc: 'smartchain',
  tron: 'tron',
  btc: 'bitcoin',
  op: 'optimism',
  pol: 'polygon',
  avax: 'avalanchec',
  ton: 'ton',
  sui: 'sui',
  aptos: 'aptos',
  near: 'near',
  doge: 'doge',
  xrp: 'ripple',
  ltc: 'litecoin',
  zec: 'zcash',
  stellar: 'stellar',
  cardano: 'cardano',
  bch: 'bitcoincash',
  gnosis: 'xdai',
  scroll: 'scroll',
  monad: 'monad'
};
// DefiLlama's chain icons, for chains Trust Wallet doesn't have.
const LLAMA_CHAIN = { bera: 'berachain', hypercore: 'hyperliquid', starknet: 'starknet' };
const EVM = new Set(['eth', 'base', 'arb', 'bsc', 'op', 'pol', 'avax', 'gnosis', 'scroll', 'monad']);
// A native coin's logo is its home chain's logo.
const NATIVE_HOME = { ETH: 'eth', SOL: 'sol', BTC: 'btc', BNB: 'bsc', TRX: 'tron', POL: 'pol', AVAX: 'avax', TON: 'ton', SUI: 'sui', APT: 'aptos', DOGE: 'doge', XRP: 'xrp', LTC: 'ltc', ZEC: 'zec', BCH: 'bch', XLM: 'stellar', ADA: 'cardano', NEAR: 'near' };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const tokenSvg = (symbol) => (TOKEN_SVGS.has(norm(symbol)) ? `/logos/tokens/${norm(symbol)}.svg` : null);
// Wrapped / bridged / renamed versions that look like their base asset.
const BASE_ASSET = { weth: 'ETH', wnear: 'NEAR', usdt0: 'USDT', usdt0deprecated: 'USDT', nrusdt: 'USDT', btcomni: 'BTC', xbtc: 'BTC', cbbtc: 'BTC', hemibtc: 'BTC', wsteth: 'ETH', xdai: 'DAI', usdcx: 'USDC', susdc: 'USDC' };

/** Logo candidates for a chain, best first. */
export function chainLogos(chain) {
  return [CHAIN_SVGS.has(chain) && `/logos/chains/${chain}.svg`, TW_CHAIN[chain] && `${TW}/${TW_CHAIN[chain]}/info/logo.png`, LLAMA_CHAIN[chain] && `https://icons.llamao.fi/icons/chains/rsz_${LLAMA_CHAIN[chain]}.jpg`].filter(Boolean);
}
/** Kept for callers that want one chain logo. */
export const chainIcon = (chain) => chainLogos(chain)[0] || null;

/** EIP-55 checksum casing of an EVM address (Trust Wallet's folders use it). */
function checksum(address) {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  return `0x${[...lower].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join('')}`;
}

/** Logo candidates for a deposit asset, best first; `cg`: CoinGecko images by id (getAssetIcons). */
export function assetLogos(asset, cg = {}) {
  if (!asset) return [];
  const out = [];
  const own = tokenSvg(asset.symbol);
  if (own) out.push(own);
  const twChain = TW_CHAIN[asset.blockchain];
  const contract = asset.contractAddress;
  if (twChain && contract) {
    const id = EVM.has(asset.blockchain) && /^0x[0-9a-fA-F]{40}$/.test(contract) ? checksum(contract) : contract;
    out.push(`${TW}/${twChain}/assets/${id}/logo.png`);
  }
  const home = NATIVE_HOME[String(asset.symbol).toUpperCase()];
  if (!contract && home) out.push(...chainLogos(home));
  if (asset.coingeckoId && cg[asset.coingeckoId]) out.push(cg[asset.coingeckoId]);
  const base = BASE_ASSET[norm(asset.symbol)];
  if (base && tokenSvg(base)) out.push(tokenSvg(base));
  return [...new Set(out)];
}

const ICONS_KEY = 'kinu.intents.icons.v2';
const ICONS_TTL_MS = 7 * 86_400_000;

/**
 * CoinGecko images by id, the fallback after Trust Wallet (one call for the whole list, kept a week
 * in this browser). Ids are only remembered as "no image" when CoinGecko actually answered.
 */
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
  let answered = false;
  for (let i = 0; i < missing.length; i += 250) {
    const chunk = missing.slice(i, i + 250);
    const query = new URLSearchParams({ vs_currency: 'usd', ids: chunk.join(','), per_page: '250' });
    const response = await fetch(`https://api.coingecko.com/api/v3/coins/markets?${query}`).catch(() => null);
    const list = response?.ok ? await response.json().catch(() => null) : null;
    if (!Array.isArray(list)) continue;
    answered = true;
    const found = Object.fromEntries(list.map((c) => [c.id, c.image]));
    chunk.forEach((id) => (cached[id] = found[id] || ''));
  }
  if (answered) {
    try {
      localStorage.setItem(ICONS_KEY, JSON.stringify({ at: Date.now(), icons: cached }));
    } catch {
      // ignore
    }
  }
  return cached;
}

/** Logos of what deposits arrive as on NEAR. */
export const RECEIVE_ICONS = { near: '/logos/tokens/near.svg', usdc: '/logos/tokens/usdc.svg' };
