// Earn withdrawals (a Vercel function): vault shares sit in the user's NEAR Intents balance, so a
// withdrawal is authorised by a message the user signs in their wallet instead of a transfer. 1Click
// builds that message (generate-intent) and executes it once signed (submit-intent); both need KINU's
// partner key, which must stay off the browser. The page checks every generated message before the
// wallet sees it (lib/earn.js), and only the user's signature can move their shares.
//
// POST { action: 'generate', depositAddress, signerId }  -> { intent }
// POST { action: 'submit', signedData }                  -> { intentHash }

import { allowed, parse, rateLimited } from './_origin.js';

const API = 'https://1click.chaindefuser.com/v0';
const HEX64 = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*$/;
const B58 = '[1-9A-HJ-NP-Za-km-z]';
const PUBLIC_KEY = new RegExp(`^ed25519:${B58}{32,50}$`);
const SIGNATURE = new RegExp(`^ed25519:${B58}{60,100}$`);
const NONCE = /^[A-Za-z0-9+/]{43}=$/;

/** The forwarded request, checked field by field; null when anything is off. */
function clean(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.action === 'generate') {
    if (!HEX64.test(String(b.depositAddress)) || !ACCOUNT.test(String(b.signerId))) return null;
    return { path: '/generate-intent', body: { type: 'swap_transfer', standard: 'nep413', signerId: b.signerId, depositAddress: b.depositAddress } };
  }
  if (b.action === 'submit') {
    const s = b.signedData;
    const ok =
      s &&
      s.standard === 'nep413' &&
      s.payload?.recipient === 'intents.near' &&
      typeof s.payload.message === 'string' &&
      s.payload.message.length < 8000 &&
      NONCE.test(String(s.payload.nonce)) &&
      PUBLIC_KEY.test(String(s.public_key)) &&
      SIGNATURE.test(String(s.signature));
    if (!ok) return null;
    const signedData = { standard: 'nep413', payload: { recipient: 'intents.near', nonce: s.payload.nonce, message: s.payload.message }, public_key: s.public_key, signature: s.signature };
    return { path: '/submit-intent', body: { type: 'swap_transfer', signedData } };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST only' });
  if (!allowed(req.headers.origin, req.headers.host)) return res.status(403).json({ message: 'Not allowed' });
  if (rateLimited(req, 20)) return res.status(429).json({ message: 'Too many requests. Wait a minute and try again.' });
  const call = clean(parse(req.body));
  if (!call) return res.status(400).json({ message: 'Invalid request' });
  const key = process.env.NEAR_INTENTS_API_KEY;
  if (!key) return res.status(503).json({ message: 'Withdrawals from Earn are not available on this server.' });
  try {
    const r = await fetch(`${API}${call.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(20000)
    });
    const json = await r.json().catch(() => ({ message: `NEAR Intents HTTP ${r.status}` }));
    return res.status(r.status).json(json);
  } catch (e) {
    return res.status(502).json({ message: `Couldn't reach NEAR Intents: ${e.message || e}` });
  }
}
