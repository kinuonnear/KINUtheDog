// Earn (/earn): yield vaults on other chains, reached from a NEAR wallet through NEAR Intents' 1Click
// API (docs.near-intents.org, "Earn"). A deposit is a 1Click quote from USDC or NEAR into the vault's
// share token, delivered to the user's own NEAR Intents balance (intents.near, under their account);
// a withdrawal is the reverse, authorised by a message the user signs (shares already live in
// Intents, so there's nothing to transfer on chain). KINU never holds funds: deposits go to a
// one-time 1Click address the quote's signature vouches for, and only the user's signature moves
// their shares. NEAR Intents doesn't run the vaults; Morpho and Kamino do, and APY is theirs.

import { Buffer } from 'buffer';
import { assertQuoteMatches, buildWithdrawTransactions, depositStatus, postQuote } from './intents.js';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { verifyQuoteSignature, base58Decode, base58Encode } from './intentsSignature.js';
import { EARN_FEE_BPS, totalFeeBps } from './intentsFees.js';
import { allowIntentsKey } from './txGuard.js';
import { functionCall, transaction, wrapNeededFor } from './tx.js';
import { rpc, view } from './rpc.js';
import { signMessage } from './wallet.js';

const API = 'https://1click.chaindefuser.com/v0';
const INTENTS = 'intents.near';
const REFERRAL = 'kinu';
const QUOTE_TTL_MS = 30 * 60_000;
const SLIPPAGE_BPS = 100;
// 1Click's withdrawal messages are valid for about 3 days (seen 18 Oct 2026); anything far longer is refused.
const MAX_INTENT_LIFETIME_MS = 7 * 86_400_000;

/** What a deposit can be paid with and a withdrawal paid out in (NEAR-side 1Click assets). */
export const PAY = {
  usdc: { key: 'usdc', assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', decimals: 6, icon: '/logos/tokens/usdc.svg' },
  near: { key: 'near', assetId: 'nep141:wrap.near', contractAddress: 'wrap.near', symbol: 'NEAR', decimals: 24, icon: '/logos/tokens/near.svg' }
};

/** The vaults. `receipt` is the vault share as a 1Click asset (lib/intentsFees.js lists the same ids). */
export const VAULTS = [
  {
    key: 'usdc',
    name: 'Gauntlet USDC Prime',
    protocol: 'Morpho',
    curator: 'Gauntlet',
    chain: 'base',
    chainName: 'Base',
    underlying: 'USDC',
    icon: '/logos/tokens/usdc.svg',
    receipt: { assetId: 'nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near', symbol: 'gtUSDCp', decimals: 18 },
    pay: ['usdc', 'near'],
    apySource: { kind: 'morpho', address: '0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61', chainId: 8453 },
    site: 'https://app.morpho.org/base/vault/0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61',
    explorer: 'https://basescan.org/address/0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61',
    wrapper: 'https://basescan.org/address/0x0bb69b79bc829e1cfcc34a740110886d98d2bd14',
    exitTime: 'about 30 minutes',
    blurb: 'Lends USDC to over-collateralised borrowers on Morpho, Base. Curated by Gauntlet, one of DeFi’s largest risk managers.'
  },
  {
    key: 'sol',
    name: 'Kamino SOL Balanced',
    protocol: 'Kamino',
    curator: 'Kamino',
    chain: 'sol',
    chainName: 'Solana',
    underlying: 'SOL',
    icon: '/logos/tokens/sol.svg',
    receipt: { assetId: 'nep141:sol-0xa69aa1bcb03a369e338156a8718ad60271145803.omdep.near', symbol: 'kV-gtSOLb', decimals: 9 },
    pay: ['near', 'usdc'],
    apySource: { kind: 'kamino', vault: 'DcCRSdUMgAt6ZMeuL4BJAsZmJgND2LQd74Zq4z6ckhpg' },
    site: 'https://app.kamino.finance/',
    explorer: 'https://solscan.io/account/DcCRSdUMgAt6ZMeuL4BJAsZmJgND2LQd74Zq4z6ckhpg',
    wrapper: 'https://solscan.io/token/5EBsGgVTubrd7ShJgE89k6nC2bnLzqGCjXb2ejrhtdBK',
    exitTime: 'about a minute',
    blurb: 'Lends SOL across Kamino’s Solana lending markets, rebalanced between them for yield. Your position is in SOL, so its dollar value moves with SOL.'
  }
];
export const vaultOf = (key) => VAULTS.find((v) => v.key === key) || VAULTS[0];

/** KINU's fee, and what the user pays in all, per direction. */
export const EARN_FEES = { kinuBps: EARN_FEE_BPS / 2, totalBps: totalFeeBps(EARN_FEE_BPS) };

/* ---------------------------------------------------------------- vault stats */

const STATS_KEY = 'kinu.earn.stats.v1';
const STATS_TTL_MS = 10 * 60_000;

async function morphoStats({ address, chainId }) {
  const query = `{ vaultByAddress(address:"${address}", chainId:${chainId}){ state{ netApy avgNetApy totalAssetsUsd } } }`;
  const r = await fetch('https://api.morpho.org/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const s = (await r.json())?.data?.vaultByAddress?.state;
  if (!s) throw new Error('Morpho data unavailable');
  return { apy: s.netApy * 100, apyAvg: s.avgNetApy != null ? s.avgNetApy * 100 : null, tvlUsd: s.totalAssetsUsd };
}

async function kaminoStats({ vault }) {
  const r = await fetch(`https://api.kamino.finance/kvaults/${vault}/metrics`);
  const m = await r.json();
  if (m?.apy == null) throw new Error('Kamino data unavailable');
  return { apy: Number(m.apy) * 100, apy7d: Number(m.apy7d) * 100, apy30d: Number(m.apy30d) * 100, apy90d: Number(m.apy90d) * 100, tvlUsd: Number(m.tokensInvestedUsd), holders: m.numberOfHolders };
}

/** APY (percent) and TVL per vault key, from Morpho's and Kamino's public APIs (cached 10 min). */
export async function getVaultStats() {
  try {
    const hit = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
    if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.stats;
  } catch {
    // storage blocked: fetch every time
  }
  const rows = await Promise.all(
    VAULTS.map(async (v) => [v.key, await (v.apySource.kind === 'morpho' ? morphoStats(v.apySource) : kaminoStats(v.apySource)).catch(() => null)])
  );
  const stats = Object.fromEntries(rows);
  if (rows.some(([, s]) => s)) {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify({ at: Date.now(), stats }));
    } catch {
      // ignore
    }
  }
  return stats;
}

/* ---------------------------------------------------------------- prices and positions */

let tokenCache = { at: 0, map: null };

/** USD price per whole token, by 1Click asset id (1Click's list, cached 5 min). */
export async function getAssetPrices() {
  if (tokenCache.map && Date.now() - tokenCache.at < 5 * 60_000) return tokenCache.map;
  const r = await fetch(`${API}/tokens`);
  if (!r.ok) throw new Error(`NEAR Intents HTTP ${r.status}`);
  const list = await r.json();
  tokenCache = { at: Date.now(), map: new Map(list.map((t) => [t.assetId, Number(t.price) || 0])), info: new Map(list.map((t) => [t.assetId, t])) };
  return tokenCache.map;
}

/** 1Click's token record (symbol, decimals, chain, price) by asset id. */
export async function getAssetInfo() {
  await getAssetPrices();
  return tokenCache.info;
}

/** The user's vault shares in their NEAR Intents balance, with a USD value: { [vaultKey]: { shares, usd } }. */
export async function getEarnPositions(accountId) {
  const ids = VAULTS.map((v) => v.receipt.assetId);
  const [balances, prices] = await Promise.all([view(INTENTS, 'mt_batch_balance_of', { account_id: accountId, token_ids: ids }, { fresh: true }), getAssetPrices().catch(() => new Map())]);
  return Object.fromEntries(
    VAULTS.map((v, i) => {
      const shares = BigInt(balances?.[i] || '0');
      const usd = (Number(shares) / 10 ** v.receipt.decimals) * (prices.get(v.receipt.assetId) || 0);
      return [v.key, { shares, usd }];
    })
  );
}

/* ---------------------------------------------------------------- quotes */

function checkLive(body, json, what) {
  assertQuoteMatches(body, json);
  const verified = verifyQuoteSignature(json);
  if (!body.dry && !verified) throw new Error(`This ${what} couldn't be verified as coming from NEAR Intents, so nothing was sent. Try again.`);
  if (!body.dry && !/^[0-9a-f]{64}$/.test(String(json.quote?.depositAddress))) throw new Error('Unexpected deposit address from NEAR Intents. Nothing was sent.');
  return { ...json.quote, request: json.quoteRequest, verified };
}

/** Deposit `amount` (raw) of PAY[payKey] into a vault; shares go to the user's NEAR Intents balance. */
export async function earnDepositQuote({ vault, payKey, amount, accountId, dry = true }) {
  const pay = PAY[payKey];
  const body = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: pay.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: vault.receipt.assetId,
    amount: String(amount),
    recipient: accountId,
    recipientType: 'INTENTS',
    refundTo: accountId,
    refundType: 'ORIGIN_CHAIN',
    deadline: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    referral: REFERRAL
  };
  return checkLive(body, await postQuote(body), 'deposit');
}

/** Withdraw `shares` (raw) of a vault from the user's NEAR Intents balance, paid out as PAY[toKey] to their NEAR wallet. */
export async function earnWithdrawQuote({ vault, toKey, shares, accountId, dry = true }) {
  const to = PAY[toKey];
  const body = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: vault.receipt.assetId,
    depositType: 'INTENTS',
    destinationAsset: to.assetId,
    amount: String(shares),
    recipient: accountId,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: accountId,
    refundType: 'INTENTS',
    deadline: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    referral: REFERRAL
  };
  return checkLive(body, await postQuote(body), 'withdrawal');
}

/* ---------------------------------------------------------------- deposit */

/** The wallet request for a verified deposit quote (wrap NEAR if needed, then send to the deposit address). */
export async function buildEarnDepositTransactions({ quote, payKey, accountId, wnearBalance }) {
  const pay = PAY[payKey];
  const wrap = pay.key === 'near' ? await wrapNeededFor(accountId, String(quote.amountIn), wnearBalance) : '0';
  return buildWithdrawTransactions({ quote, fromAsset: { contractAddress: pay.contractAddress }, accountId, wrap });
}

/* ---------------------------------------------------------------- withdrawal (signed intent) */

async function intentCall(payload) {
  const r = await fetch('/api/intents-intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const json = await r.json().catch(() => ({}));
  if (r.status === 404 || r.status === 503) throw new Error('This needs kinudefi.com: withdrawals from NEAR Intents are signed through KINU’s server.');
  if (!r.ok) throw new Error(json.message || `NEAR Intents HTTP ${r.status}`);
  return json;
}

/**
 * The generated message must do exactly one thing: move this quote's shares out of the user's
 * balance to the quote's deposit address. Anything else and it is never shown to the wallet.
 */
function assertWithdrawIntent(intent, { accountId, depositAddress, assetId, amount }) {
  const p = intent?.payload;
  if (intent?.standard !== 'nep413' || p?.recipient !== INTENTS || typeof p.message !== 'string') throw new Error('Unexpected withdrawal message from NEAR Intents. Nothing was signed.');
  let m;
  try {
    m = JSON.parse(p.message);
  } catch {
    throw new Error('Unreadable withdrawal message from NEAR Intents. Nothing was signed.');
  }
  const deadline = Date.parse(m.deadline);
  const sends = new Map();
  let ok = m.signer_id === accountId && Number.isFinite(deadline) && deadline > Date.now() && deadline < Date.now() + MAX_INTENT_LIFETIME_MS && Array.isArray(m.intents) && m.intents.length > 0;
  for (const i of ok ? m.intents : []) {
    if (i.intent === 'transfer' && i.receiver_id === depositAddress && i.tokens && typeof i.tokens === 'object') {
      for (const [token, value] of Object.entries(i.tokens)) sends.set(token, (sends.get(token) || 0n) + BigInt(value));
    } else if (i.intent === 'token_diff' && i.diff && typeof i.diff === 'object') {
      // A diff may only take the shares out; it may not take or give anything else.
      for (const [token, value] of Object.entries(i.diff)) {
        const v = BigInt(value);
        if (v > 0n) ok = false;
        else sends.set(token, (sends.get(token) || 0n) - v);
      }
    } else ok = false;
  }
  if (!ok || sends.size !== 1 || sends.get(assetId) !== BigInt(amount)) throw new Error('This withdrawal message doesn’t match your request, so it wasn’t signed. Try again.');
}

const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The bytes a NEP-413 signature covers: sha256(borsh(tag) + borsh({ message, nonce, recipient, callbackUrl: None })). */
function nep413Hash({ message, nonce, recipient }) {
  const enc = new TextEncoder();
  const str = (s) => {
    const b = enc.encode(s);
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length, true);
    out.set(b, 4);
    return out;
  };
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, 2 ** 31 + 413, true);
  const parts = [tag, str(message), nonce, str(recipient), new Uint8Array([0])];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return sha256(all);
}

/**
 * Before a key is registered on intents.near (which lets it sign intents for the account): the
 * wallet's signature must verify for exactly this message, and the key must be one of the
 * account's full-access keys, never a key the page itself could hold.
 */
async function assertSigningKey({ accountId, publicKey, signatureB64, message, nonce, recipient }) {
  const ok = (() => {
    try {
      return ed25519.verify(base64ToBytes(signatureB64), nep413Hash({ message, nonce, recipient }), base58Decode(publicKey.replace(/^ed25519:/, '')));
    } catch {
      return false;
    }
  })();
  if (!ok) throw new Error('Your wallet’s signature didn’t check out, so nothing was sent.');
  const key = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }).catch(() => null);
  if (key?.permission !== 'FullAccess') throw new Error('Your wallet signed with a key that isn’t a full-access key of your account, so it wasn’t registered. Nothing was sent.');
}

/**
 * Pays a live `depositType: INTENTS` quote from the account's NEAR Intents balance: the message from
 * 1Click (checked), the user's signature, a one-time key registration on intents.near if their key
 * isn't known there yet (`registerKey(txs)` sends it through the app's wallet flow), then submit.
 */
export async function payFromIntents({ quote, accountId, registerKey }) {
  const { intent } = await intentCall({ action: 'generate', depositAddress: quote.depositAddress, signerId: accountId });
  assertWithdrawIntent(intent, { accountId, depositAddress: quote.depositAddress, assetId: quote.request?.originAsset, amount: quote.amountIn });

  const nonce = Buffer.from(intent.payload.nonce, 'base64');
  const signed = await signMessage({ message: intent.payload.message, recipient: intent.payload.recipient, nonce });
  if (signed.accountId && signed.accountId !== accountId) throw new Error('Your wallet signed with a different account. Nothing was sent.');
  const publicKey = signed.publicKey.startsWith('ed25519:') ? signed.publicKey : `ed25519:${signed.publicKey}`;
  await assertSigningKey({ accountId, publicKey, signatureB64: signed.signature, message: intent.payload.message, nonce: new Uint8Array(nonce), recipient: intent.payload.recipient });

  // NEAR Intents only accepts signatures from keys registered for a named account (once per key).
  const known = await view(INTENTS, 'has_public_key', { account_id: accountId, public_key: publicKey }, { fresh: true }).catch(() => false);
  if (!known) {
    allowIntentsKey(publicKey);
    const done = await registerKey([transaction(INTENTS, [functionCall('add_public_key', { public_key: publicKey }, '100000000000000', '1')])]);
    if (!done) throw new Error('Your key wasn’t registered with NEAR Intents, so the withdrawal wasn’t sent.');
  }

  const signature = `ed25519:${base58Encode(base64ToBytes(signed.signature))}`;
  const submitted = await intentCall({ action: 'submit', signedData: { ...intent, public_key: publicKey, signature } });
  return { ...quote, intentHash: submitted.intentHash };
}

/** Withdraw a vault position: a fresh signed quote, then paid from the user's Intents balance. */
export async function earnWithdraw({ vault, toKey, shares, accountId, registerKey }) {
  const quote = await earnWithdrawQuote({ vault, toKey, shares, accountId, dry: false });
  if (quote.request?.originAsset !== vault.receipt.assetId) throw new Error('This withdrawal quote is for another token. Nothing was signed.');
  return payFromIntents({ quote, accountId, registerKey });
}

/* ---------------------------------------------------------------- tracking */

export { depositStatus };
export const EARN_FINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
const PENDING_KEY = 'kinu.earn.pending.v1';

/** Deposits and withdrawals in flight on this device (kept a day), newest first. */
export function readPending(accountId) {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return list.filter((p) => p.account === accountId && Date.now() - p.createdAt < 86_400_000);
  } catch {
    return [];
  }
}

export function savePending(entry) {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]').filter((p) => Date.now() - p.createdAt < 86_400_000 && p.depositAddress !== entry.depositAddress);
    localStorage.setItem(PENDING_KEY, JSON.stringify([entry, ...list].slice(0, 20)));
  } catch {
    // storage blocked: tracking only lasts while the page is open
  }
}

export function dropPending(depositAddress) {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]').filter((p) => p.depositAddress !== depositAddress);
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}
