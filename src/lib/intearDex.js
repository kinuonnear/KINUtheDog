// Intear DEX pools (dex.intear.near, the Plach AMM), read-only, from Intear DEX's own backend —
// the list dex.intea.rs shows. Nothing here builds a transaction: adding liquidity from KINU waits
// for Intear's LP flow and the contract's audit status.

const BACKEND = 'https://dex-backend.intear.tech';
const POOL_URL = 'https://dex.intea.rs/pool?id=PLACH-';
// Fee amounts are parts per million (10_000 = 1%).
const PPM = 1_000_000;
// Intear's protocol fee receiver.
const PROTOCOL = 'plach.intear.near';

/** "nep141:token.intear.near" -> "token.intear.near"; "near" stays "near" (native NEAR). */
const assetToken = (assetId) => String(assetId || '').replace(/^nep141:/, '');

/** Pool kinds: Public (anyone adds liquidity), Private (owner only), Launch / LaunchV2 (token launches). */
export const INTEAR_POOL_TYPES = [
  { key: 'Public', label: 'Public', hint: 'Anyone can add liquidity' },
  { key: 'Private', label: 'Private', hint: 'Only the pool owner adds liquidity' },
  { key: 'Launch', label: 'Launch', hint: 'Token launches (Intear Launch)' }
];

function feesOf(receivers = []) {
  let pool = 0;
  let protocol = 0;
  let creator = 0;
  receivers.forEach(([receiver, amount]) => {
    const pct = (Number(amount) / PPM) * 100;
    if (receiver === 'Pool') pool += pct;
    else if (receiver?.Account === PROTOCOL) protocol += pct;
    else creator += pct;
  });
  return { pool, protocol, creator, total: pool + protocol + creator };
}

/** One pool from the backend -> { id, type, kind, tokens: [id, id], balances, fees, tvl, volume24h, volume7d, apy (%), url }. */
function normalize(row) {
  const [type, body] = Object.entries(row.pool || {})[0] || [];
  if (!type || !body) return null;
  // Public / Private: assets; LaunchV2: quote + launched asset; Launch (v1): launched asset + NEAR.
  const assets =
    body.assets ||
    (body.near_amount !== undefined
      ? [body.launched_asset, { asset_id: 'near', balance: body.near_amount }]
      : [body.quote_asset, body.launched_asset]
    ).filter(Boolean);
  if (assets.length < 2) return null;
  return {
    id: row.id,
    type,
    kind: type.startsWith('Launch') ? 'Launch' : type,
    tokens: assets.map((a) => assetToken(a.asset_id)),
    balances: assets.map((a) => String(a.balance || '0')),
    fees: feesOf(body.fees?.receivers),
    tvl: Number(row.liquidity_usd) || 0,
    volume24h: Number(row.volume_24h_usd) || 0,
    volume7d: Number(row.volume_7d_usd) || 0,
    apy: (Number(row.apy) || 0) * 100,
    url: `${POOL_URL}${row.id}`
  };
}

/** Every Intear DEX pool, deepest first. */
export async function fetchIntearPools({ signal } = {}) {
  const response = await fetch(`${BACKEND}/pools/all`, { signal });
  if (!response.ok) throw new Error(`Intear DEX HTTP ${response.status}`);
  const rows = await response.json();
  return (Array.isArray(rows) ? rows : []).map(normalize).filter(Boolean).sort((a, b) => b.tvl - a.tvl);
}
