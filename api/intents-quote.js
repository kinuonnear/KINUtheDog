// Bridge and Earn quotes (a Vercel function): forwards the page's 1Click quote request with KINU's partner
// API key, which must stay off the browser, and sets KINU's fee (src/lib/intentsFees.js) here so
// it can't be changed client-side. Only KINU's own pages may call it (1Click's terms: no public
// proxy), and only the fields the Bridge uses are passed on. 1Click signs the quote; the page
// verifies that signature before showing any deposit address, so nothing here is trusted blindly.
//
// Vercel environment variables:
//   NEAR_INTENTS_API_KEY   the 1Click partner JWT (Partner Portal → API Keys, Distribution Channel)
//   KINU_ALLOWED_ORIGINS   optional, comma-separated extra origins (e.g. a preview URL)
// In `vite dev` the same handler runs from vite.config.js (key from .env.local, if set).

import { isEarnAsset, KINU_FEE_RECIPIENT, quoteFeeBps } from '../src/lib/intentsFees.js';
import { allowed, parse } from './_origin.js';

const API = 'https://1click.chaindefuser.com/v0';
const TOKENS_TTL_MS = 10 * 60_000;
const ASSET = /^nep\d+:[\w.:-]{2,200}$/;
const ADDRESS = /^[\w.:@-]{2,200}$/;

let tokens = { at: 0, symbols: null };

/** assetId -> symbol, from 1Click's token list (cached). */
async function symbols() {
  if (tokens.symbols && Date.now() - tokens.at < TOKENS_TTL_MS) return tokens.symbols;
  const r = await fetch(`${API}/tokens`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`tokens HTTP ${r.status}`);
  tokens = { at: Date.now(), symbols: new Map((await r.json()).map((t) => [t.assetId, t.symbol])) };
  return tokens.symbols;
}

// Three shapes: a Bridge transfer (chain to chain), an Earn deposit (shares delivered to the user's
// NEAR Intents balance) and an Earn withdrawal (shares paid from that balance, by a signed intent).
const isBridge = (b) => b.depositType === 'ORIGIN_CHAIN' && b.recipientType === 'DESTINATION_CHAIN' && b.refundType === 'ORIGIN_CHAIN';
const isEarnDeposit = (b) => b.depositType === 'ORIGIN_CHAIN' && b.recipientType === 'INTENTS' && b.refundType === 'ORIGIN_CHAIN' && isEarnAsset(b.destinationAsset);
const isEarnWithdraw = (b) => b.depositType === 'INTENTS' && b.recipientType === 'DESTINATION_CHAIN' && b.refundType === 'INTENTS' && isEarnAsset(b.originAsset);

/** The request the page sends, checked field by field; null when anything is off. */
function clean(b) {
  if (!b || typeof b !== 'object') return null;
  const ok =
    typeof b.dry === 'boolean' &&
    b.swapType === 'EXACT_INPUT' &&
    Number.isInteger(b.slippageTolerance) &&
    b.slippageTolerance >= 0 &&
    b.slippageTolerance <= 500 &&
    ASSET.test(b.originAsset) &&
    ASSET.test(b.destinationAsset) &&
    (isBridge(b) || isEarnDeposit(b) || isEarnWithdraw(b)) &&
    /^\d{1,40}$/.test(b.amount) &&
    ADDRESS.test(b.recipient) &&
    ADDRESS.test(b.refundTo) &&
    !Number.isNaN(Date.parse(b.deadline));
  if (!ok) return null;
  const { dry, swapType, slippageTolerance, originAsset, depositType, destinationAsset, amount, recipient, recipientType, refundTo, refundType, deadline } = b;
  return { dry, swapType, slippageTolerance, originAsset, depositType, destinationAsset, amount, recipient, recipientType, refundTo, refundType, deadline, referral: 'kinu' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST only' });
  if (!allowed(req.headers.origin, req.headers.host)) return res.status(403).json({ message: 'Not allowed' });
  const body = clean(parse(req.body));
  if (!body) return res.status(400).json({ message: 'Invalid quote request' });
  try {
    const map = await symbols();
    body.appFees = [{ recipient: KINU_FEE_RECIPIENT, fee: quoteFeeBps(body.originAsset, body.destinationAsset, (id) => map.get(id)) }];
    const key = process.env.NEAR_INTENTS_API_KEY;
    const r = await fetch(`${API}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const json = await r.json().catch(() => ({ message: `NEAR Intents HTTP ${r.status}` }));
    return res.status(r.status).json(json);
  } catch (e) {
    return res.status(502).json({ message: `Couldn't reach NEAR Intents: ${e.message || e}` });
  }
}
