// KINU LP bot: Telegram webhook (a Vercel function). Paste a token, get its CLMM pool on Rhea and
// one-tap buttons that open KINU as a Telegram Mini App with the Create position form filled in
// (src/lib/lpLink.js). The bot never holds keys or funds: every position is signed by the user
// in their own wallet (HOT Wallet inside Telegram).
//
// Vercel environment variables (set in the Vercel dashboard, never in code):
//   TELEGRAM_BOT_TOKEN       from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  any long random string; also given to setWebhook as secret_token
//   KINU_APP_URL             optional, defaults to https://kinudefi.com
//
// Messages it understands:
//   /start, /help
//   <token> [amount] [range%]   e.g. "kinu", "kinu-3.nearlytrade.near 5", "$TEAR 2 25%"

const RHEA_API = 'https://api.rhea.finance';
const DEXSCREENER_API = 'https://api.dexscreener.com';
const WNEAR = 'wrap.near';
// Tickers people type, mapped to their contracts (anything else: paste the contract).
const ALIASES = {
  kinu: 'kinu-3.nearlytrade.near',
  tear: 'token.intear.near',
  rhea: 'token.rhealab.near',
  usdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  usdt: 'usdt.tether-token.near'
};
const DEFAULT_RANGE = 10;
const QUICK_AMOUNTS = [1, 5, 10];

const appUrl = () => (process.env.KINU_APP_URL || 'https://kinudefi.com').replace(/\/+$/, '');

/* ---------------------------------------------------------------- parsing */

/** "kinu 5 10%" -> { token, amount, range } (token: a contract, or null when none was found). */
export function parseRequest(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  let token = null;
  let amount = null;
  let range = null;
  for (const raw of words) {
    const w = raw.replace(/^\$/, '').toLowerCase();
    if (/^\d+(\.\d+)?%$/.test(w)) range = Number(w.slice(0, -1));
    else if (/^\d+(\.\d+)?$/.test(w)) amount = amount ?? Number(w);
    else if (!token && ALIASES[w]) token = ALIASES[w];
    else if (!token && (/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(w) || /^[0-9a-f]{64}$/.test(w))) token = w;
  }
  if (!(range >= 0.5 && range <= 99)) range = null;
  if (!(amount > 0 && amount < 1e9)) amount = null;
  return { token, amount, range };
}

/* ---------------------------------------------------------------- pools */

/** The token's CLMM pool to LP in: the deepest one paired with NEAR, else the deepest. */
export async function findPool(token) {
  // Rhea's API can turn away server requests (it answered from browsers but not from Vercel):
  // DexScreener lists the same CLMM pools with their liquidity and volume.
  let pools;
  try {
    pools = await rheaPools(token);
  } catch (error) {
    console.error('rhea pools', error.message);
    pools = await dexScreenerPools(token);
  }
  pools.sort((a, b) => b.tvl - a.tvl);
  return pools.find((p) => p.tokens.includes(WNEAR)) || pools[0] || null;
}

/** The token's CLMM pools from DexScreener (pair "refv2-<x>:<y>:<fee>" is Rhea pool "<x>|<y>|<fee>"). */
async function dexScreenerPools(token) {
  const response = await fetch(`${DEXSCREENER_API}/latest/dex/tokens/${encodeURIComponent(token)}`);
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const json = await response.json();
  return (json.pairs || [])
    .filter((p) => p.chainId === 'near' && /^refv2-[^:]+:[^:]+:\d+$/.test(p.pairAddress || ''))
    .map((p) => {
      const [x, y, fee] = p.pairAddress.slice('refv2-'.length).split(':');
      const symbolOf = (id) => {
        const s = id === p.baseToken?.address ? p.baseToken.symbol : id === p.quoteToken?.address ? p.quoteToken.symbol : id;
        return s === 'wNEAR' ? 'NEAR' : s;
      };
      const volume = Number(p.volume?.h24) || 0;
      return {
        id: `${x}|${y}|${fee}`,
        tokens: [x, y],
        symbols: [symbolOf(x), symbolOf(y)],
        tvl: Number(p.liquidity?.usd) || 0,
        volume,
        fees: (volume * Number(fee)) / 1e6,
        feePct: Number(fee) / 1e4
      };
    })
    .filter((p) => p.tokens.includes(token));
}

/** The token's CLMM pools from Rhea's API. */
async function rheaPools(token) {
  const params = new URLSearchParams({
    type: 'dcl',
    sort: 'tvl',
    limit: '50',
    offset: '0',
    hide_low_pool: 'false',
    hide_uncertified_token: 'false',
    order_by: 'desc',
    labels: '',
    token_type: '',
    token_list: token,
    pool_id_list: ''
  });
  const response = await fetch(`${RHEA_API}/pool/search?${params}`);
  if (!response.ok) throw new Error(`Rhea API HTTP ${response.status}`);
  const json = await response.json();
  if (json.code !== 0) throw new Error(json.msg || 'Rhea API error');
  return (json.data?.list || [])
    .filter((p) => p.pool_kind === 'DCL' && (p.token_account_ids || []).includes(token))
    .map((p) => ({
      id: p.id,
      tokens: p.token_account_ids,
      symbols: (p.token_symbols || []).map((s) => (s === 'wNEAR' ? 'NEAR' : s)),
      tvl: Number(p.tvl) || 0,
      volume: Number(p.volume_24h) || 0,
      fees: Number(p.fee_volume_24h) || 0,
      feePct: (Number(p.total_fee) || 0) * 100
    }));
}

/* ---------------------------------------------------------------- replies */

const usd = (v) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(2)}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A button that opens KINU inside Telegram on this pool, the form filled in. */
function lpButton(text, pool, { range, amount } = {}) {
  const query = new URLSearchParams({ range: String(range || DEFAULT_RANGE) });
  if (amount && pool.tokens.includes(WNEAR)) {
    query.set('in', 'NEAR');
    query.set('amount', String(amount));
  }
  return { text, web_app: { url: `${appUrl()}/pools/${encodeURIComponent(pool.id)}?${query}` } };
}

const HELP = [
  '<b>KINU LP bot</b> · liquidity on NEAR in a few taps',
  '',
  'Send a token and I find its concentrated liquidity pool on Rhea:',
  '<code>kinu</code>  ·  <code>$TEAR 5</code>  ·  <code>kinu 5 25%</code>',
  '(token, then NEAR to put in, then the range ±%)',
  '',
  'Tap a button: KINU opens with the position ready. You check it and confirm in your wallet (HOT Wallet works inside Telegram).',
  'KINU never holds your keys or funds. Liquidity can lose value against holding (impermanent loss); this is not financial advice.'
].join('\n');

/** The reply (Bot API sendMessage fields) for a message's text. */
export async function replyFor(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || /^\/(start|help)\b/i.test(trimmed)) {
    return {
      text: HELP,
      reply_markup: { inline_keyboard: [[{ text: '🐕 Open KINU', web_app: { url: `${appUrl()}/pools` } }]] }
    };
  }
  const req = parseRequest(trimmed.replace(/^\/lp(@\w+)?\s*/i, ''));
  if (!req.token) {
    return { text: "Send a token's contract (e.g. <code>kinu-3.nearlytrade.near</code>) or a ticker I know: KINU, TEAR, RHEA, USDC, USDT." };
  }
  const pool = await findPool(req.token);
  if (!pool) {
    return { text: `No concentrated liquidity pool for <code>${esc(req.token)}</code> on Rhea yet.` };
  }
  const apr = pool.tvl >= 100 ? (pool.fees / pool.tvl) * 365 * 100 : null;
  const range = req.range || DEFAULT_RANGE;
  const hasNear = pool.tokens.includes(WNEAR);
  const lines = [
    `<b>${esc(pool.symbols.join(' / '))}</b> · CLMM ${pool.feePct.toFixed(2)}% fee`,
    `TVL ${usd(pool.tvl)} · 24h volume ${usd(pool.volume)} · 24h fees ${usd(pool.fees)}`,
    apr !== null ? `Fee APR ≈ ${apr >= 1000 ? Math.round(apr).toLocaleString('en-US') : apr.toFixed(1)}% (last 24h, not a promise)` : null,
    '',
    hasNear
      ? 'Tap to LP with NEAR: KINU swaps the right share and opens the position. You confirm in your wallet.'
      : 'Tap to open the position in KINU. You confirm in your wallet.'
  ].filter((l) => l !== null);

  let keyboard;
  if (req.amount && hasNear) {
    keyboard = [[lpButton(`⚡ LP ${req.amount} NEAR · ±${range}%`, pool, { range, amount: req.amount })]];
  } else if (hasNear) {
    keyboard = [QUICK_AMOUNTS.map((a) => lpButton(`⚡ ${a} NEAR`, pool, { range, amount: a }))];
  } else {
    keyboard = [];
  }
  keyboard.push([lpButton(`✎ Custom · ±${range}%`, pool, { range })]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } };
}

/* ---------------------------------------------------------------- webhook */

async function send(chatId, reply) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...reply })
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('KINU LP bot');
  // Only Telegram knows the secret (setWebhook secret_token): anything else is ignored.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(401).end();
  if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(500).end();

  const message = req.body?.message;
  // Private chats only: web_app buttons work there, and groups stay quiet.
  if (!message?.chat || message.chat.type !== 'private' || typeof message.text !== 'string') return res.status(200).end();
  try {
    await send(message.chat.id, await replyFor(message.text));
  } catch (error) {
    await send(message.chat.id, { text: "Couldn't load pool data right now. Try again in a minute." }).catch(() => {});
    console.error('telegram bot', error);
  }
  return res.status(200).end();
}
