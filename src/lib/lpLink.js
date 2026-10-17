// LP links: a URL that opens a CLMM pool's Create position form already filled in, for the
// Telegram bot's "Open in KINU" buttons and for shared links. A link only fills the form: the
// user still checks it and signs in their wallet, and the price is read again at signing.
//
//   /pools/<pool>?range=10&in=NEAR&amount=5&strategy=spot
//     range     ±% around the price when the link is opened (0.5–99), or "full"
//     in        the token to zap in with: NEAR, or a pool token's symbol / contract
//     amount    how much of it (capped by the wallet's balance in the form)
//     strategy  spot | curve | bidask
//   /quick-lp?token=<contract>&…  picks the token's deepest CLMM pool, then opens it as above.

const STRATEGY_KEYS = ['spot', 'curve', 'bidask'];

/** The LP-link fields in a URL's query, or null when it has none. */
export function parseLpLink(search) {
  if (!search) return null;
  const out = {};
  const range = (search.get('range') || '').toLowerCase();
  if (range === 'full') out.range = 'full';
  else if (range) {
    const pct = Number(range.replace('%', ''));
    if (Number.isFinite(pct) && pct >= 0.5 && pct <= 99) out.range = String(pct);
  }
  const amount = (search.get('amount') || '').replace(/,/g, '');
  if (/^\d*\.?\d+$/.test(amount) && Number(amount) > 0) out.amount = amount;
  const token = (search.get('in') || '').trim();
  if (token && token.length <= 80) out.in = token;
  const strategy = (search.get('strategy') || '').toLowerCase();
  if (STRATEGY_KEYS.includes(strategy)) out.strategy = strategy;
  return Object.keys(out).length ? out : null;
}

/** The query string that carries an LP link's fields (without the leading "?"). */
export function lpLinkQuery({ range, in: token, amount, strategy } = {}) {
  const params = new URLSearchParams();
  if (range) params.set('range', String(range));
  if (token) params.set('in', token);
  if (amount) params.set('amount', String(amount));
  if (strategy) params.set('strategy', strategy);
  return params.toString();
}

/** The token a link's `in` names, among the ones the form can zap with (null when none). */
export function linkToken(name, candidates) {
  if (!name) return null;
  const want = name.toLowerCase();
  return candidates.find((t) => t && (t.id.toLowerCase() === want || t.symbol?.toLowerCase() === want)) || null;
}
