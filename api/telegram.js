// KINU LP bot: Telegram webhook (a Vercel function). A menu of buttons, Zenith-style: New LP (paste
// a token contract), Trending pools by 1h / 6h volume, Top yield, KINU/NEAR; then pick a range and
// a dollar amount, and "Open in KINU" opens KINU as a Telegram Mini App with the Create position
// form filled in (src/lib/lpLink.js). /swap buys or sells a token for NEAR in dollars. The bot
// never holds keys or funds: the user signs every position and swap in their own wallet (HOT
// Wallet inside Telegram). Tokens are taken by contract only (tickers can point at look-alikes).
//
// It keeps no state: each step's message links the pool (and the range chosen so far) on its
// name, and a button press reads that link back from the message it was pressed on.
//
// Vercel environment variables (set in the Vercel dashboard, never in code):
//   TELEGRAM_BOT_TOKEN       from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  any long random string; also given to setWebhook as secret_token
//   KINU_APP_URL             optional, defaults to https://kinudefi.com
//
// The last step's "⚡ Sign & create" opens KINU's Quick LP panel on its last step with the chat's
// choices (src/components/QuickLp.jsx): one tap, one wallet approval. KINU then sends the
// transaction hashes back (POST ?notify=1 with Telegram's signed initData); the bot checks them on
// chain and posts the result in that chat.
//
// A wallet can be linked to the chat, read-only: /wallet name.near, or automatically when the user
// connects a wallet in KINU opened from the bot. The bot pins "👛 KINU wallet: name.near" and reads
// it back from the chat's pinned message (it keeps no database); the amount step then shows the
// account's balance with 10–Max% buttons. Balances are public data: the bot can't move anything.
//
// A wallet comes first: until the chat has one linked, every message and button answers with the
// connect screen (connect HOT Wallet in KINU, or type the account). /wallet always works.
//
// Messages: /start (menu), /help, /wallet [account], /pools, /swap <contract> [$amount], /lp <contract>, /balance and
// /positions <account> (read-only), /terminal, or a pasted
// token contract.

import { createHmac, timingSafeEqual } from 'node:crypto';

const RHEA_API = 'https://api.rhea.finance';
const DEXSCREENER_API = 'https://api.dexscreener.com';
const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const WNEAR = 'wrap.near';
const KINU = 'kinu-3.nearlytrade.near';
const KINU_POOL = `${KINU}|${WNEAR}|10000`;
// Tokens KINU has verified (src/config.js KINU_VERIFIED_TOKENS).
const VERIFIED = new Set([KINU, 'token.intear.near']);
const USD_AMOUNTS = [50, 100, 150];
// Width presets, then ✏️ Custom (as KINU's Quick LP panel): one side up to WIDTH_MAX below / above;
// around the price, % below and % above apart ("50:300" is −50% / +300%).
const RANGES = ['5', '10', '25', '50', '75'];
const SIDE_WIDTHS = ['10', '20', '30', '50', '70'];
const WIDTH_MAX = { below: 99, above: 1000, b: 99, a: 500 };
const CUSTOM_PROMPT = '✏️ Custom range';
const AMOUNT_PROMPT = '✏️ Custom amount';
const LIST_SIZE = 10;
const TOP_YIELD_MIN_TVL = 1000;

const appUrl = () => (process.env.KINU_APP_URL || 'https://kinudefi.com').replace(/\/+$/, '');
const CONTRACT = /^([a-z0-9_-]+(\.[a-z0-9_-]+)+|[0-9a-f]{64})$/;

/* ---------------------------------------------------------------- parsing */

/** "<contract> 5 $75" -> { token, amount, usd } (token: null when no contract was given). */
export function parseRequest(text) {
  let token = null;
  let amount = null;
  let usd = null;
  for (const raw of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    const w = raw.toLowerCase();
    if (/^\$\d+(\.\d+)?$/.test(w)) usd = usd ?? Number(w.slice(1));
    else if (/^\d+(\.\d+)?$/.test(w)) amount = amount ?? Number(w);
    else if (!token && CONTRACT.test(w)) token = w;
  }
  if (!(amount > 0 && amount < 1e9)) amount = null;
  if (!(usd > 0 && usd < 1e7)) usd = null;
  return { token, amount, usd };
}

/* ---------------------------------------------------------------- data */

const nearSymbol = (s) => (s === 'wNEAR' ? 'NEAR' : s);

async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${new URL(url).host} HTTP ${response.status}`);
  return response.json();
}

/** The token's CLMM pool to LP in: the deepest one paired with NEAR, else the deepest. */
export async function findPool(token) {
  // Rhea's API turns away requests from Vercel; DexScreener lists the same CLMM pools.
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
  const json = await getJson(`${DEXSCREENER_API}/latest/dex/tokens/${encodeURIComponent(token)}`);
  return (json.pairs || [])
    .filter((p) => p.chainId === 'near' && /^refv2-[^:]+:[^:]+:\d+$/.test(p.pairAddress || ''))
    .map(fromDexScreener)
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
  const json = await getJson(`${RHEA_API}/pool/search?${params}`);
  if (json.code !== 0) throw new Error(json.msg || 'Rhea API error');
  return (json.data?.list || [])
    .filter((p) => p.pool_kind === 'DCL' && (p.token_account_ids || []).includes(token))
    .map((p) => ({
      id: p.id,
      tokens: p.token_account_ids,
      symbols: (p.token_symbols || []).map(nearSymbol),
      tvl: Number(p.tvl) || 0,
      volume: Number(p.volume_24h) || 0,
      fees: Number(p.fee_volume_24h) || 0,
      feePct: (Number(p.total_fee) || 0) * 100,
      prices: null
    }));
}

/** A DexScreener refv2 pair as a pool, with both tokens' USD prices. */
function fromDexScreener(p) {
  const [x, y, fee] = p.pairAddress.slice('refv2-'.length).split(':');
  const baseUsd = Number(p.priceUsd) || null;
  // priceNative: the base token in quote units, so the quote's USD price is base / native.
  const quoteUsd = baseUsd && Number(p.priceNative) > 0 ? baseUsd / Number(p.priceNative) : null;
  const of = (id) =>
    id === p.baseToken?.address
      ? { symbol: p.baseToken.symbol, usd: baseUsd }
      : id === p.quoteToken?.address
        ? { symbol: p.quoteToken.symbol, usd: quoteUsd }
        : { symbol: id, usd: null };
  const volume = Number(p.volume?.h24) || 0;
  return {
    id: `${x}|${y}|${fee}`,
    tokens: [x, y],
    symbols: [nearSymbol(of(x).symbol), nearSymbol(of(y).symbol)],
    tvl: Number(p.liquidity?.usd) || 0,
    volume,
    fees: (volume * Number(fee)) / 1e6,
    feePct: Number(fee) / 1e4,
    prices: [of(x).usd, of(y).usd]
  };
}

/** One CLMM pool by its Rhea id, with prices (DexScreener). Null when it isn't listed. */
async function poolById(id) {
  const [x, y, fee] = id.split('|');
  const json = await getJson(`${DEXSCREENER_API}/latest/dex/pairs/near/${encodeURIComponent(`refv2-${x}:${y}:${fee}`)}`);
  const pair = (json.pairs || []).find((p) => p.pairAddress === `refv2-${x}:${y}:${fee}`);
  return pair ? fromDexScreener(pair) : null;
}

/**
 * Rhea CLMM pools from GeckoTerminal (the most traded first): id, symbols, TVL and volume over
 * 1h / 6h / 24h. GeckoTerminal has no 4h window.
 */
// GeckoTerminal allows ~30 requests a minute: the list is kept for a while (per warm function
// instance), and the last good one is used while GeckoTerminal turns requests away.
const GECKO_TTL_MS = 120_000;
let geckoCache = { at: 0, pools: [] };

async function geckoClmmPools(pages = 3) {
  if (Date.now() - geckoCache.at < GECKO_TTL_MS && geckoCache.pools.length) return geckoCache.pools;
  const lists = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      getJson(`${GECKO_API}/networks/near/dexes/rhea-finance/pools?sort=h24_volume_usd_desc&page=${i + 1}`, {
        headers: { accept: 'application/json' }
      }).catch((error) => {
        console.error('gecko pools', error.message);
        return null;
      })
    )
  );
  if (lists.some((l) => !l) && geckoCache.pools.length) return geckoCache.pools;
  const pools = lists
    .map((l) => l || { data: [] })
    .flatMap((l) => l.data || [])
    .filter((p) => /^refv2-[^:]+:[^:]+:\d+$/.test(p.attributes?.address || ''))
    .map((p) => {
      const a = p.attributes;
      const [x, y, fee] = a.address.slice('refv2-'.length).split(':');
      const tvl = Number(a.reserve_in_usd) || 0;
      const v = a.volume_usd || {};
      return {
        id: `${x}|${y}|${fee}`,
        name: String(a.name || '').replace(/\bwNEAR\b/g, 'NEAR').replace(/\s+\d+(\.\d+)?%$/, ''),
        feePct: Number(fee) / 1e4,
        tvl,
        h1: Number(v.h1) || 0,
        h6: Number(v.h6) || 0,
        h24: Number(v.h24) || 0,
        apr: tvl > 0 ? (((Number(v.h24) || 0) * Number(fee)) / 1e6 / tvl) * 365 * 100 : 0
      };
    });
  if (pools.length) geckoCache = { at: Date.now(), pools };
  return pools;
}

/** USD price of a token from its deepest pair it is the base of (DexScreener), or null. */
async function tokenInfo(token) {
  try {
    const json = await getJson(`${DEXSCREENER_API}/latest/dex/tokens/${encodeURIComponent(token)}`);
    const pairs = (json.pairs || []).filter((p) => p.chainId === 'near');
    const deepest = (list) => list.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0];
    const pair = deepest(pairs.filter((p) => p.baseToken?.address === token));
    if (pair) return { symbol: nearSymbol(pair.baseToken.symbol), price: Number(pair.priceUsd) || null, change: Number(pair.priceChange?.h24) };
    const quoted = deepest(pairs.filter((p) => p.quoteToken?.address === token));
    return quoted ? { symbol: nearSymbol(quoted.quoteToken.symbol), price: null, change: null } : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- formatting */

const usd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(2)}`);
// $1.23 · $0.04712 · $0.00000001215 (four significant digits, never in e-notation)
const price = (v) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(Math.min(20, 3 - Math.floor(Math.log10(v))))}`);
const pct = (v) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v >= 10 ? 0 : 1));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (id) => (id.length > 28 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id);
/** An amount for KINU's forms: ~6 significant digits, never in e-notation. */
const units = (v) => {
  if (!(v > 0) || !Number.isFinite(v)) return null;
  return v.toFixed(Math.max(0, Math.min(18, 5 - Math.floor(Math.log10(v))))).replace(/\.?0+$/, '');
};
/** As units, rounded down: a share of a balance never comes out above it. */
const unitsDown = (v) => {
  if (!(v > 0) || !Number.isFinite(v)) return null;
  const digits = Math.max(0, Math.min(18, 5 - Math.floor(Math.log10(v))));
  const down = Math.floor(v * 10 ** digits) / 10 ** digits;
  return down > 0 ? down.toFixed(digits).replace(/\.?0+$/, '') : null;
};

/* ---------------------------------------------------------------- buttons & state */

const cb = (text, data) => ({ text, callback_data: data });
const open = (text, url) => ({ text, web_app: { url } });
const MENU_ROW = [cb('🏠 Menu', 'm')];
/** ← Back to the step before (`data`: its callback) and the menu. */
const backRow = (data) => [cb('← Back', data), ...MENU_ROW];

/** The pool page URL carrying the flow's state (range so far) — linked on the pool's name. */
function stateUrl(poolId, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  return `${appUrl()}/pools/${encodeURIComponent(poolId)}${query.toString() ? `?${query}` : ''}`;
}

/** The pool links in a message (its text_link entities on KINU pool pages), in order. */
function linksIn(message) {
  const base = `${appUrl()}/pools/`;
  return (message?.entities || [])
    .filter((e) => e.type === 'text_link' && e.url?.startsWith(base))
    .map((e) => {
      const url = new URL(e.url);
      return { poolId: decodeURIComponent(url.pathname.split('/pools/')[1] || ''), params: url.searchParams };
    });
}

/** KINU's Quick LP panel on its last step, for the range in `params` (see QuickLp.jsx parseQuickLink). */
function quickUrl(poolId, params, amount) {
  const hasNear = poolId.split('|').includes(WNEAR);
  const side = params.get('below') ? 'y' : params.get('above') ? 'x' : hasNear && !params.get('both') ? 'zap' : 'z';
  const width = params.get('below') || params.get('above') || params.get('range');
  const query = new URLSearchParams({ type: 'clmm', quick: poolId, side, strategy: params.get('strategy') || 'spot', width });
  if (amount && side !== 'z') query.set('amount', amount);
  return `${appUrl()}/pools?${query}`;
}

/** NEAR → token (or with `sell`, token → NEAR) on KINU's Swap; `amount` in the token swapped from. */
function swapUrl(token, amount, sell = false) {
  const query = new URLSearchParams(sell ? { from: token, to: 'near' } : { from: 'near', to: token });
  if (amount) query.set('amount', String(amount));
  return `${appUrl()}/swap?${query}`;
}

/* ---------------------------------------------------------------- screens */

const HELP = [
  '<b>KINU LP bot</b> · liquidity and swaps on NEAR in a few taps',
  '',
  '💧 <b>New LP</b>: paste a token contract, pick a range and an amount, open it in KINU.',
  '🔥 <b>Trending</b>: Rhea CLMM pools by volume in the last 1h or 6h.',
  '💰 <b>Top yield</b>: fee APR over the last 24h (pools with at least $1K TVL).',
  '⇄ <b>/swap</b> <code>contract</code>: buy or sell for NEAR in dollars.',
  '👛 <b>/balance</b> · 📊 <b>/positions</b> <code>account.near</code>: tokens and LP positions of any account (read-only).',
  '🔗 <b>/wallet</b> <code>yourname.near</code>: link your account (read-only) to see your balance and pick 10–100% of it when you LP. Connecting a wallet in KINU from here links it too.',
  '💻 <b>/terminal</b>: the full KINU app.',
  '',
  'KINU never holds your keys or funds: you check everything in KINU and confirm in your wallet (HOT Wallet works inside Telegram). Liquidity can lose value against holding (impermanent loss); this is not financial advice.'
].join('\n');

/** The first screen until a wallet is linked: connect HOT Wallet in KINU, or type the account. */
function connectFirst() {
  return {
    text: [
      '👋 <b>Welcome to the KINU LP bot</b> · liquidity and swaps on NEAR in a few taps',
      '',
      '<b>First, connect your NEAR wallet.</b> The bot then shows your balances and positions, and lets you put in 10–100% of what you hold.',
      '',
      '🔐 Read-only for the bot: it never holds keys or moves funds. Every transaction is signed in your own wallet (HOT Wallet works right inside Telegram).'
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[open('🔐 Connect HOT Wallet', `${appUrl()}/pools?${new URLSearchParams({ type: 'clmm', connect: '1' })}`)], [cb('✍️ Enter my NEAR account', 'm:wal')]]
    }
  };
}

function menu() {
  return {
    text: HELP,
    reply_markup: {
      inline_keyboard: [
        [cb('💧 New LP', 'm:new'), cb('🐕 KINU / NEAR', 'm:kinu')],
        [cb('🔥 Trending 1h', 'm:t1'), cb('🔥 Trending 6h', 'm:t6')],
        [cb('💰 Top yield', 'm:y'), cb('⇄ Swap', 'm:swap')],
        [cb('👛 Balance', 'm:bal'), cb('📊 LP positions', 'm:pos')],
        [cb('🔗 My wallet', 'm:wal'), cb('💻 Terminal', 'm:term')]
      ]
    }
  };
}

// Prompts for a contract answer with a forced reply: the contract the user sends comes back as a
// reply to the prompt, and the prompt's first words say which flow it belongs to (no state kept).
const LP_PROMPT = '💧 New LP';
const SWAP_PROMPT = '⇄ Swap';
const ASK_CONTRACT = {
  text: '💧 <b>New LP</b>\nPaste the token contract, e.g. <code>kinu-3.nearlytrade.near</code>.\nContracts only: names and tickers can point at look-alike tokens.',
  reply_markup: { force_reply: true, input_field_placeholder: 'Token contract to LP' }
};
const ASK_SWAP = {
  text: '⇄ <b>Swap</b>\nPaste the token contract to buy or sell, e.g. <code>kinu-3.nearlytrade.near</code>. Add a dollar amount if you like: <code>kinu-3.nearlytrade.near $75</code>.',
  reply_markup: { force_reply: true, input_field_placeholder: 'Token contract to swap' }
};

/** Trending (1h / 6h volume) or top yield: ten pools, each a button to its pool card. */
async function poolList(kind) {
  const pools = await geckoClmmPools();
  const key = kind === 't1' ? 'h1' : kind === 't6' ? 'h6' : 'apr';
  const list = pools
    .filter((p) => (key === 'apr' ? p.tvl >= TOP_YIELD_MIN_TVL && p.apr > 0 : p[key] > 0))
    .sort((a, b) => b[key] - a[key])
    .slice(0, LIST_SIZE);
  const title = kind === 't1' ? '🔥 <b>Trending · 1h volume</b>' : kind === 't6' ? '🔥 <b>Trending · 6h volume</b>' : '💰 <b>Top yield · 24h fee APR</b>';
  if (!list.length) return { text: `${title}\nNothing to show right now. Try again in a minute.`, reply_markup: { inline_keyboard: [MENU_ROW] } };
  const lines = list.map((p, i) => {
    const stat =
      key === 'apr'
        ? `APR ≈ ${pct(p.apr)}% · TVL ${usd(p.tvl)}`
        : `${key.slice(1)}h vol ${usd(p[key])} · TVL ${usd(p.tvl)}`;
    return `${i + 1}. <a href="${stateUrl(p.id)}">${esc(p.name)}</a> · ${p.feePct}%\n    ${stat}`;
  });
  const buttons = list.map((p, i) => cb(`${i + 1}. ${p.name}`.slice(0, 32), `l:${i}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([cb('🔄 Refresh', `m:${kind}`), ...MENU_ROW]);
  return {
    text: [title, '', ...lines, '', key === 'apr' ? 'Last 24h fees against TVL: not a promise.' : 'Tap a pool to LP in it.'].join('\n'),
    reply_markup: { inline_keyboard: rows }
  };
}

/**
 * A pool: tokens (with contracts), TVL, volume, APR, then what goes in. The flow after it:
 * side (one token below / above the price, or both) → strategy (shape) → width % → $ amount.
 */
async function poolCard(poolId, fallback = null) {
  const pool = (await poolById(poolId).catch(() => null)) || fallback;
  if (!pool) return { text: 'That pool is not listed yet. Paste the token contract to look again.', reply_markup: { inline_keyboard: [MENU_ROW] } };
  const [x, y] = pool.tokens;
  const [sx, sy] = pool.symbols;
  const apr = pool.tvl >= 100 ? (pool.fees / pool.tvl) * 365 * 100 : null;
  const tokenLine = (id, symbol) => `${esc(symbol)}: <code>${esc(short(id))}</code>${VERIFIED.has(id) ? ' ✓ verified' : ''}`;
  const main = pool.tokens.find((t) => t !== WNEAR) || x;
  const hasNear = pool.tokens.includes(WNEAR);
  const lines = [
    `🎯 <a href="${stateUrl(pool.id)}">${esc(`${sx} / ${sy}`)}</a> · CLMM ${pool.feePct}% fee`,
    tokenLine(x, sx),
    tokenLine(y, sy),
    `TVL ${usd(pool.tvl)} · 24h volume ${usd(pool.volume)} · 24h fees ${usd(pool.fees)}`,
    apr !== null ? `Fee APR ≈ ${pct(apr)}% (last 24h, not a promise)` : null,
    '',
    '<b>What do you put in?</b>',
    `💵 ${esc(sy)} only: below the price, buys ${esc(sx)} as it falls.`,
    `🎯 ${esc(sx)} only: above the price, sells ${esc(sx)} as it rises.`,
    hasNear ? '⚡ Zap NEAR: both sides around the price; put in NEAR only, KINU swaps the right share.' : null,
    `⚖ Both tokens: both sides around the price; you put in ${esc(sx)} and ${esc(sy)}.`
  ].filter((l) => l !== null);
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [cb(`💵 ${sy} only ↓`, 'd:b'), cb(`🎯 ${sx} only ↑`, 'd:a')],
        hasNear ? [cb('⚡ Zap NEAR · both sides', 'd:z')] : null,
        [cb(`⚖ Both tokens · ${sx} + ${sy}`, hasNear ? 'd:k' : 'd:z')],
        [cb(`⇄ Buy / Sell ${pool.symbols[pool.tokens.indexOf(main)]}`, 's'), ...MENU_ROW]
      ].filter(Boolean)
    }
  };
}

const STRATEGY_NAMES = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-Ask' };
// The same icon as the strategy's button, wherever the choice is shown.
const STRATEGY_ICONS = { spot: '▤', curve: '⛰', bidask: '📐' };
const sideLabel = (side, [sx, sy], hasNear) => (side === 'b' ? `${sy} only` : side === 'a' ? `${sx} only` : side === 'k' || !hasNear ? 'Both tokens' : 'Zap NEAR');

/** Step 2: the shape. KINU spreads Curve most near the price and Bid-Ask most far from it. */
function strategyStep(poolId, side, symbols) {
  const hasNear = poolId.split('|').includes(WNEAR);
  const [sx] = symbols;
  const options =
    side === 'b'
      ? [['▤ Spot · even buys', 'spot'], ['⛰ Curve · most near price', 'curve'], ['📐 Bid-Ask · ladder, more on dips', 'bidask']]
      : side === 'a'
        ? [['▤ Spot · even sells', 'spot'], ['⛰ Curve · most near price', 'curve'], ['📐 Bid-Ask · ladder, more on pumps', 'bidask']]
        : [['▤ Spot · even', 'spot'], ['⛰ Curve · peak at price', 'curve'], ['📐 Bid-Ask · heavier at edges', 'bidask']];
  const hint =
    side === 'b'
      ? `Spot buys ${esc(sx)} evenly on the way down; Curve buys most just below the price; Bid-Ask buys more the deeper it drops (a DCA ladder).`
      : side === 'a'
        ? `Spot sells ${esc(sx)} evenly on the way up; Curve sells most just above the price; Bid-Ask sells more the higher it goes.`
        : 'Spot works for any market; Curve earns the most while the price stays calm; Bid-Ask suits volatile prices.';
  return {
    text: [`🧭 <a href="${stateUrl(poolId, { side })}">${esc(`${symbols[0]} / ${symbols[1]}`)}</a> · ${esc(sideLabel(side, symbols, hasNear))}`, '<b>Pick a strategy</b>', hint].join('\n'),
    reply_markup: { inline_keyboard: [...options.map(([label, key]) => [cb(label, `g:${key}`)]), backRow('bk:card')] }
  };
}

/** Step 3: how wide — ± around the price for both sides, down / up from it for one side. */
function widthStep(poolId, side, strategy, symbols) {
  const hasNear = poolId.split('|').includes(WNEAR);
  const head = `${STRATEGY_ICONS[strategy] || '▤'} <a href="${stateUrl(poolId, { side, strategy })}">${esc(`${symbols[0]} / ${symbols[1]}`)}</a> · ${esc(sideLabel(side, symbols, hasNear))} · ${STRATEGY_NAMES[strategy] || 'Spot'}`;
  if (side === 'z' || side === 'k') {
    const both = hasNear && side === 'z' ? '⚡' : '⚖';
    return {
      text: [head, '<b>How wide around the price?</b> Tighter earns more fees but leaves the range sooner.'].join('\n'),
      reply_markup: {
        inline_keyboard: [
          RANGES.slice(0, 3).map((r) => cb(`${both} ±${r}%`, `r:${r}`)),
          [...RANGES.slice(3).map((r) => cb(`${both} ±${r}%`, `r:${r}`)), cb('✏️ Custom', 'c')],
          backRow(`d:${side}`)
        ]
      }
    };
  }
  const below = side === 'b';
  return {
    text: [
      head,
      below
        ? '<b>How far below the price?</b> It fills as the price falls: tighter earns more fees but is passed sooner.'
        : '<b>How far above the price?</b> It sells as the price rises: tighter earns more fees but is passed sooner.'
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        SIDE_WIDTHS.slice(0, 3).map((w) => cb(`${below ? '−' : '+'}${w}%`, `w:${side}:${w}`)),
        [...SIDE_WIDTHS.slice(3).map((w) => cb(`${below ? '−' : '+'}${w}%`, `w:${side}:${w}`)), cb('✏️ Custom', 'c')],
        backRow(`d:${side}`)
      ]
    }
  };
}

/** ±10% or −50% / +300% (a range of "10" or "50:300"). */
function aroundLabel(range) {
  const [lo, hi = lo] = String(range).split(':');
  return lo === hi ? `±${lo}%` : `−${lo}% / +${hi}%`;
}

/** A % typed for a Custom range, one decimal, or null when it is outside 1 – max. */
function customPct(text, max) {
  const v = Number(String(text).replace(',', '.'));
  return Number.isFinite(v) && v >= 1 && v <= max ? String(Math.round(v * 10) / 10) : null;
}

/** ✏️ Custom: asks for the range as a reply; the pool and choices so far ride in the prompt's link. */
async function customPrompt(poolId, side, strategy, error = null) {
  const hasNear = poolId.split('|').includes(WNEAR);
  const pool = await poolById(poolId).catch(() => null);
  const symbols = pool?.symbols || poolId.split('|').slice(0, 2).map((t) => (t === WNEAR ? 'NEAR' : t.split('.')[0].toUpperCase()));
  const around = side === 'z' || side === 'k';
  const ask = around
    ? `How far below and above the price, in %? Send one number for both ways (<code>20</code> = ±20%) or two (<code>50 300</code> = −50% / +300%). Below 1–${WIDTH_MAX.below}, above 1–${WIDTH_MAX.above}.`
    : side === 'b'
      ? `How far below the price, in %? Send a number from 1 to ${WIDTH_MAX.b}, e.g. <code>35</code>.`
      : `How far above the price, in %? Send a number from 1 to ${WIDTH_MAX.a}, e.g. <code>150</code>.`;
  return {
    text: [
      `${CUSTOM_PROMPT} · <a href="${stateUrl(poolId, { side, strategy })}">${esc(`${symbols[0]} / ${symbols[1]}`)}</a> · ${esc(sideLabel(side, symbols, hasNear))} · ${STRATEGY_NAMES[strategy] || 'Spot'}`,
      error ? `⚠️ ${error}` : null,
      ask
    ]
      .filter((l) => l !== null)
      .join('\n'),
    reply_markup: { force_reply: true, input_field_placeholder: around ? 'e.g. 20 or 50 300' : side === 'b' ? 'e.g. 35' : 'e.g. 150' }
  };
}

/** The answer to a Custom prompt: on to the amount step, or the prompt again with what was wrong. */
async function customAnswer(text, prompt, chatId) {
  const state = linksIn(prompt)[0];
  if (!state?.poolId) return menu();
  const side = state.params.get('side') || 'z';
  const strategy = STRATEGY_NAMES[state.params.get('strategy')] ? state.params.get('strategy') : 'spot';
  const nums = String(text).match(/\d+(?:[.,]\d+)?/g) || [];
  if (side === 'b' || side === 'a') {
    const v = nums.length === 1 ? customPct(nums[0], WIDTH_MAX[side]) : null;
    if (!v) return customPrompt(state.poolId, side, strategy, `Send one number from 1 to ${WIDTH_MAX[side]}.`);
    return amountStep(state.poolId, new URLSearchParams({ [side === 'b' ? 'below' : 'above']: v, strategy }), chatId);
  }
  const lo = customPct(nums[0], WIDTH_MAX.below);
  const hi = customPct(nums[1] ?? nums[0], WIDTH_MAX.above);
  if (!nums.length || nums.length > 2 || !lo || !hi) {
    return customPrompt(state.poolId, side, strategy, `Below must be 1–${WIDTH_MAX.below} and above 1–${WIDTH_MAX.above}.`);
  }
  const range = lo === hi ? lo : `${lo}:${hi}`;
  return amountStep(state.poolId, new URLSearchParams({ range, strategy, ...(side === 'k' ? { both: '1' } : {}) }), chatId);
}

/** ✏️ Custom amount: asks for it as a reply; the pool and range ride in the prompt's link. */
async function amountPrompt(poolId, params, chatId, error = null) {
  const [pool, linked] = await Promise.all([poolById(poolId).catch(() => null), linkedAccount(chatId)]);
  if (!pool) return { text: 'That pool could not be loaded. Try again in a minute.', reply_markup: { inline_keyboard: [MENU_ROW] } };
  const deposit = depositOf(pool, params);
  const zap = !params.get('below') && !params.get('above');
  const balance = linked && deposit.token ? await spendableOf(linked.account, deposit.token, zap) : null;
  const sym = esc(deposit.symbol);
  return {
    text: [
      `${AMOUNT_PROMPT} · <a href="${stateUrl(pool.id, Object.fromEntries(params))}">${esc(`${pool.symbols[0]} / ${pool.symbols[1]}`)}</a> · ${esc(deposit.label)}`,
      error ? `⚠️ ${error}` : null,
      balance !== null ? `👛 Balance ${amount(balance)} ${sym}` : null,
      balance !== null
        ? `How much <b>${sym}</b>? Send it in ${sym}, e.g. <code>2.5</code>, or a share of your balance, e.g. <code>30%</code>.`
        : `How much <b>${sym}</b>? Send it in ${sym}, e.g. <code>2.5</code>.`
    ]
      .filter((l) => l !== null)
      .join('\n'),
    reply_markup: { force_reply: true, input_field_placeholder: balance !== null ? `${deposit.symbol}, e.g. 2.5 or 30%` : `${deposit.symbol}, e.g. 2.5` }
  };
}

/** The answer to a Custom amount prompt: on to the last step, or the prompt again. */
async function amountAnswer(text, prompt, chatId) {
  const state = linksIn(prompt)[0];
  if (!state?.poolId) return menu();
  const params = new URLSearchParams([...state.params.entries()].filter(([k]) => ['range', 'below', 'above', 'strategy', 'both'].includes(k)));
  const t = String(text).trim().replace(/,/g, '.').replace(/\s+/g, '');
  const num = (v) => (/^\d*\.?\d+$/.test(v) && Number(v) > 0 && Number(v) < 1e12 ? v : null);
  // A plain number is the token, as in KINU's Amount field; 30% is a share of the linked balance.
  let choice = null;
  if (t.endsWith('%') && num(t.slice(0, -1)) && Number(t.slice(0, -1)) <= 100) choice = { pct: Number(t.slice(0, -1)) };
  else if (num(t)) choice = { units: t.startsWith('.') ? '0' + t : t };
  if (!choice) {
    const error = t.startsWith('$') ? 'Amounts are in the token, not dollars: send e.g. 2.5.' : 'Send a number, e.g. 2.5.';
    return amountPrompt(state.poolId, params, chatId, error);
  }
  // A share needs a balance to take it from.
  if (choice.pct && !(await linkedAccount(chatId))) {
    return amountPrompt(state.poolId, params, chatId, 'A % needs a linked wallet: /wallet yourname.near. Or send the amount instead.');
  }
  return finalStep(state.poolId, params, choice, chatId);
}

/** What a range puts in: { token, symbol, label } (token null: both tokens, entered in KINU). */
function depositOf(pool, params) {
  const [x, y] = pool.tokens;
  const [sx, sy] = pool.symbols;
  const shape = STRATEGY_NAMES[params.get('strategy')] || 'Spot';
  if (params.get('below')) return { token: y, symbol: sy, label: `${sy} only · ${shape} · down to −${params.get('below')}%` };
  if (params.get('above')) return { token: x, symbol: sx, label: `${sx} only · ${shape} · up to +${params.get('above')}%` };
  const width = params.get('range') === 'full' ? 'full range' : aroundLabel(params.get('range'));
  return pool.tokens.includes(WNEAR) && !params.get('both')
    ? { token: WNEAR, symbol: 'NEAR', label: `Zap NEAR · ${shape} · ${width}` }
    : { token: null, symbol: null, label: `Both tokens · ${shape} · ${width}` };
}

/** Amount step, in the token: with a linked wallet its balance and 10–Max% of it; ✏️ Custom either way. */
async function amountStep(poolId, params, chatId) {
  const [pool, linked] = await Promise.all([poolById(poolId).catch(() => null), linkedAccount(chatId)]);
  if (!pool) return { text: 'That pool could not be loaded. Try again in a minute.', reply_markup: { inline_keyboard: [MENU_ROW] } };
  const deposit = depositOf(pool, params);
  const name = `${pool.symbols[0]} / ${pool.symbols[1]}`;
  const link = stateUrl(pool.id, Object.fromEntries(params));
  const zap = !params.get('below') && !params.get('above');
  if (!deposit.token) {
    const balances = linked
      ? await Promise.all(pool.tokens.map((t, i) => spendableOf(linked.account, t, false).then((v) => (v === null ? null : `${amount(v)} ${esc(pool.symbols[i])}`))))
      : [];
    return {
      text: [
        `✅ <a href="${link}">${esc(name)}</a> · ${esc(deposit.label)}`,
        'Both tokens: type one amount in KINU and the other follows the range.',
        linked && balances.every(Boolean) ? `👛 ${esc(linked.account)}: ${balances.join(' · ')}` : null,
        '',
        '⚡ <b>Sign & create</b>: KINU opens on the amount step with all of this set, then you confirm in your wallet and the result comes back here.',
        '📝 <b>Full form</b>: the pool page with the form filled in, to fine-tune first.'
      ]
        .filter((l) => l !== null)
        .join('\n'),
      reply_markup: { inline_keyboard: [[open('⚡ Sign & create', quickUrl(pool.id, params))], [open('📝 Full form', link)], backRow('bk:w')] }
    };
  }
  const balance = linked ? await spendableOf(linked.account, deposit.token, zap) : null;
  const head = `💰 <a href="${link}">${esc(name)}</a> · ${esc(deposit.label)}`;
  if (balance !== null) {
    const lines = [
      head,
      `👛 ${esc(linked.account)} · balance <b>${amount(balance)} ${esc(deposit.symbol)}</b>${deposit.token === WNEAR ? ' (0.25 NEAR kept for gas)' : ''}`,
      balance > 0 ? `How much of it do you want to put in?` : `Not enough ${esc(deposit.symbol)} for this deposit. Top up, or link another wallet with /wallet.`
    ];
    const rows = balance > 0 ? [SHARE_BUTTONS.slice(0, 3).map(([t, p]) => cb(t, `a:p${p}`)), SHARE_BUTTONS.slice(3).map(([t, p]) => cb(t, `a:p${p}`))] : [];
    return { text: lines.join('\n'), reply_markup: { inline_keyboard: [...rows, [cb('✏️ Custom', 'a:c')], backRow('bk:w')] } };
  }
  // Amounts are always in the token, as KINU's Amount field: no dollar amounts to mix up.
  return {
    text: [
      head,
      `How much ${esc(deposit.symbol)} do you want to put in? Tap ✏️ Custom and send it in ${esc(deposit.symbol)}, e.g. <code>2.5</code>.`,
      '🔗 Link your wallet with /wallet <code>yourname.near</code> to see your balance and pick 10–100% of it.'
    ].join('\n'),
    reply_markup: { inline_keyboard: [[cb('✏️ Custom', 'a:c')], backRow('bk:w')] }
  };
}

/** Last step: the filled-in link, opened in KINU. `choice`: dollars, { pct } of the linked balance, or null (custom). */
async function finalStep(poolId, params, choice, chatId) {
  const pct = choice && typeof choice === 'object' ? choice.pct : null;
  const typed = choice && typeof choice === 'object' ? choice.units : null;
  const dollars = typeof choice === 'number' ? choice : null;
  const [pool, linked] = await Promise.all([poolById(poolId).catch(() => null), linkedAccount(chatId)]);
  if (!pool) return { text: 'That pool could not be loaded. Try again in a minute.', reply_markup: { inline_keyboard: [MENU_ROW] } };
  const deposit = depositOf(pool, params);
  const zap = !params.get('below') && !params.get('above');
  const query = Object.fromEntries(params);
  let amountText = 'You enter the amount in KINU.';
  if (deposit.token) {
    query.in = deposit.token === WNEAR ? 'NEAR' : deposit.token;
    const usdPrice = pool.prices?.[pool.tokens.indexOf(deposit.token)];
    const balance = linked ? await spendableOf(linked.account, deposit.token, zap) : null;
    const shown = (v) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${esc(deposit.symbol)}`;
    // More than the linked wallet holds: stop here, as KINU's panel would ("Not enough …").
    const tooMuch = (asked) => ({
      text: [
        `💰 <a href="${stateUrl(pool.id, Object.fromEntries(params))}">${esc(`${pool.symbols[0]} / ${pool.symbols[1]}`)}</a> · ${esc(deposit.label)}`,
        `⚠️ ${asked} is more than your balance: <b>${shown(unitsDown(balance) || 0)}</b>${deposit.token === WNEAR ? ' (0.25 NEAR kept for gas)' : ''}.`,
        balance > 0 ? 'Use Max, or send a smaller amount.' : `Top up ${esc(deposit.symbol)}, or link another wallet with /wallet.`
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [balance > 0 ? [cb('Max', 'a:p100'), cb('✏️ Custom', 'a:c')] : [cb('✏️ Custom', 'a:c')], backRow('bk:a')]
      }
    });
    if (typed) {
      if (balance !== null && Number(typed) > balance) return tooMuch(shown(typed));
      query.amount = typed;
      amountText = `${shown(typed)}${usdPrice ? ` ≈ ${usd(Number(typed) * usdPrice)}` : ''}`;
    } else if (pct) {
      const value = balance > 0 ? unitsDown((balance * pct) / 100) : null;
      if (value) {
        query.amount = value;
        amountText = `${pct === 100 ? 'Max' : `${pct}%`} of your balance ≈ ${shown(value)}${usdPrice ? ` (${usd(Number(value) * usdPrice)})` : ''}`;
      } else amountText = `No ${esc(deposit.symbol)} balance to use: enter the amount in KINU.`;
    } else {
      const value = dollars && usdPrice ? units(dollars / usdPrice) : null;
      if (value) {
        if (balance !== null && Number(value) > balance) return tooMuch(`$${dollars} ≈ ${shown(value)}`);
        query.amount = value;
        amountText = `$${dollars} ≈ ${shown(value)}`;
      } else if (dollars) amountText = `No price for ${esc(deposit.symbol)} right now: enter the amount in KINU.`;
    }
  }
  const link = stateUrl(pool.id, query);
  return {
    text: [
      `✅ <a href="${stateUrl(pool.id, Object.fromEntries(params))}">${esc(`${pool.symbols[0]} / ${pool.symbols[1]}`)}</a> · ${esc(deposit.label)}`,
      amountText,
      '',
      '⚡ <b>Sign & create</b>: KINU opens with all of this set. Tap once, confirm in your wallet, and the result comes back here. The range is set on the live price when you sign.',
      '📝 <b>Full form</b>: the pool page with the form filled in, to fine-tune first.'
    ].join('\n'),
    reply_markup: { inline_keyboard: [[open('⚡ Sign & create', quickUrl(pool.id, params, query.amount))], [open('📝 Full form', link)], backRow('bk:a')] }
  };
}

/** /swap: buy (NEAR → token) and sell (token → NEAR) in dollars, at the latest prices. */
async function swapReply(req) {
  const [info, near] = await Promise.all([tokenInfo(req.token), tokenInfo(WNEAR)]);
  const symbol = info?.symbol || req.token.split('.')[0].slice(0, 12).toUpperCase();
  const move = Number.isFinite(info?.change) ? ` · 24h ${info.change > 0 ? '+' : ''}${info.change.toFixed(1)}%` : '';
  const dollars = req.usd ? [req.usd] : USD_AMOUNTS;
  const label = (d) => `$${d.toLocaleString('en-US')}`;
  const buyRow = near?.price ? dollars.map((d) => open(`🟢 Buy ${label(d)}`, swapUrl(req.token, units(d / near.price)))) : [];
  const sellRow = info?.price ? dollars.map((d) => open(`🔴 Sell ${label(d)}`, swapUrl(req.token, units(d / info.price), true))) : [];
  const lines = [
    `⇄ <b>Swap ${esc(symbol)}</b>${info?.price ? ` · ${price(info.price)}${move}` : ''}`,
    `<code>${esc(req.token)}</code>${VERIFIED.has(req.token) ? ' ✓ verified' : ''}`,
    '',
    'Buy with NEAR or sell for NEAR, in dollars at the latest price. KINU quotes the best route across Rhea and Intear DEX; you check the quote and confirm in your wallet.',
    !info?.price ? `No price for ${esc(symbol)} right now: sell opens without an amount.` : null
  ].filter((l) => l !== null);
  const keyboard = [buyRow, sellRow, [open('🟢 Buy · custom', swapUrl(req.token)), open('🔴 Sell · custom', swapUrl(req.token, null, true))], MENU_ROW].filter((r) => r.length);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } };
}

const UNKNOWN = {
  text: 'Paste a token <b>contract</b> (e.g. <code>kinu-3.nearlytrade.near</code>) or pick from the menu. Names and tickers are not looked up: they can point at look-alike tokens.',
  reply_markup: { inline_keyboard: [[cb('🐕 KINU / NEAR', 'm:kinu'), ...MENU_ROW]] }
};

/** A pasted contract: its CLMM pool card, or a swap offer when it has no CLMM pool. */
const CLASSIC_MIN_TVL = 1000; // classic pools shown as links from this TVL
const PICK_SIZE = 8;

/**
 * A token's pools. Concentrated (CLMM): Rhea's API and DexScreener together (either can miss one),
 * NEAR pairs first, then by TVL. Classic (AMM, "refv1-<id>" on DexScreener) from CLASSIC_MIN_TVL.
 */
async function tokenPools(token) {
  const [rhea, dex] = await Promise.all([
    rheaPools(token).catch(() => []),
    getJson(`${DEXSCREENER_API}/latest/dex/tokens/${encodeURIComponent(token)}`).catch(() => ({ pairs: [] }))
  ]);
  const pairs = (dex.pairs || []).filter((p) => p.chainId === 'near');
  const clmm = new Map();
  pairs
    .filter((p) => /^refv2-[^:]+:[^:]+:\d+$/.test(p.pairAddress || ''))
    .map(fromDexScreener)
    .filter((p) => p.tokens.includes(token))
    .forEach((p) => clmm.set(p.id, p));
  rhea.forEach((p) => clmm.has(p.id) || clmm.set(p.id, p));
  const nearFirst = (a, b) => Number(b.tokens.includes(WNEAR)) - Number(a.tokens.includes(WNEAR)) || b.tvl - a.tvl;
  const classic = pairs
    .filter((p) => /^refv1-\d+$/.test(p.pairAddress || '') && (Number(p.liquidity?.usd) || 0) >= CLASSIC_MIN_TVL)
    .map((p) => ({ id: p.pairAddress.slice('refv1-'.length), name: `${nearSymbol(p.baseToken.symbol)} / ${nearSymbol(p.quoteToken.symbol)}`, tvl: Number(p.liquidity.usd) }))
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, 3);
  return { clmm: [...clmm.values()].sort(nearFirst), classic };
}

async function tokenReply(token) {
  const { clmm, classic } = await tokenPools(token);
  if (clmm.length === 1 && !classic.length) return poolCard(clmm[0].id, clmm[0]);
  if (clmm.length || classic.length) {
    const own = clmm[0] ? clmm[0].symbols[clmm[0].tokens.indexOf(token)] : classic[0].name.split(' / ')[0];
    const shown = clmm.slice(0, PICK_SIZE);
    const lines = [
      `💧 <b>${esc(own)}</b> · <code>${esc(short(token))}</code>${VERIFIED.has(token) ? ' ✓ verified' : ''}`,
      shown.length ? '<b>Concentrated pools</b> · pick one to LP step by step' : null,
      ...shown.map((p, i) => `${i + 1}. <a href="${stateUrl(p.id)}">${esc(`${p.symbols[0]} / ${p.symbols[1]}`)}</a> · ${p.feePct}% · TVL ${usd(p.tvl)}${p.tvl < 1000 ? ' · low liquidity' : ''}`),
      clmm.length > PICK_SIZE ? `… and ${clmm.length - PICK_SIZE} more` : null,
      classic.length ? '' : null,
      classic.length ? '<b>Classic pools</b> · add liquidity in KINU' : null,
      ...classic.map((p) => `• ${esc(p.name)} · TVL ${usd(p.tvl)}`)
    ].filter((l) => l !== null);
    const picks = shown.map((p, i) => cb(`${i + 1}. ${p.symbols[0]}/${p.symbols[1]} ${p.feePct}%`.slice(0, 40), `l:${i}`));
    const rows = [];
    for (let i = 0; i < picks.length; i += 2) rows.push(picks.slice(i, i + 2));
    classic.forEach((p) => rows.push([open(`🏊 ${p.name} · classic`.slice(0, 40), `${appUrl()}/pools/${p.id}`)]));
    rows.push([open(`⇄ Swap ${own}`.slice(0, 40), swapUrl(token)), ...MENU_ROW]);
    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
  }
  const info = await tokenInfo(token);
  return {
    text: `No concentrated liquidity pool for <code>${esc(token)}</code> on Rhea yet.${info ? ` You can still swap NEAR for ${esc(info.symbol)}.` : ''}`,
    reply_markup: { inline_keyboard: [[open('⇄ Swap', swapUrl(token)), ...MENU_ROW]] }
  };
}

/* ---------------------------------------------------------------- accounts (read-only) */

// The bot holds no wallets: /balance and /positions read any account's public data, by name.
const RPCS = ['https://near.drpc.org', 'https://free.rpc.fastnear.com'];
const FASTNEAR_API = 'https://api.fastnear.com';
const PRICES_API = 'https://prices.intear.tech/list-token-price';
const DCL = 'dclv2.ref-labs.near';
const BAL_PROMPT = '👛 Balance';
const POS_PROMPT = '📊 LP positions';
const MAX_ROWS = 10;

async function rpc(params) {
  let last;
  for (const url of RPCS) {
    try {
      const json = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }) });
      if (json.error) {
        const cause = json.error.cause?.name || json.error.data || json.error.message;
        if (/UNKNOWN_ACCOUNT|does not exist/i.test(JSON.stringify(cause))) return { missing: true };
        throw new Error(String(cause));
      }
      return json.result;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

async function viewCall(contract, method, args) {
  const result = await rpc({ request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  if (result.missing) throw new Error(`${contract} not found`);
  return JSON.parse(Buffer.from(result.result).toString());
}

// Intear's price list (~0.5 MB): price, symbol and decimals of every NEAR token, kept a while.
let priceCache = { at: 0, map: null };
async function tokenPrices() {
  if (priceCache.map && Date.now() - priceCache.at < 120_000) return priceCache.map;
  const map = await getJson(PRICES_API);
  priceCache = { at: Date.now(), map };
  return map;
}

const symbolOf = (prices, id) => nearSymbol(prices?.[id]?.symbol || id.split('.')[0].slice(0, 10).toUpperCase());
const decimalsOf = (prices, id) => Number(prices?.[id]?.decimal ?? (id === WNEAR ? 24 : 18));
const priceOf = (prices, id) => Number(prices?.[id]?.price) || 0;
const amount = (v) =>
  v >= 1e6 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : v > 0 ? units(v) : '0';
/** A price as a plain number, four significant digits (no $). */
const plain = (v) => (v >= 1 ? v.toFixed(4) : v.toFixed(Math.min(20, 3 - Math.floor(Math.log10(v)))));
const accountLink = (account) => `<a href="${appUrl()}/lp/${encodeURIComponent(account)}">${esc(account)}</a>`;

/** The account a message's link names (the bot's balance / positions replies link it). */
function accountIn(message) {
  const base = `${appUrl()}/lp/`;
  const link = (message?.entities || []).find((e) => e.type === 'text_link' && e.url?.startsWith(base));
  return link ? decodeURIComponent(link.url.slice(base.length).split(/[?#]/)[0]) : null;
}

const accountButtons = (account, other) => [
  [other === 'pos' ? cb('📊 LP positions', 'v:pos') : cb('👛 Balance', 'v:bal'), open('🐕 Open in KINU', `${appUrl()}/lp/${encodeURIComponent(account)}`)],
  [cb('🔄 Refresh', other === 'pos' ? 'rf:bal' : 'rf:pos'), ...MENU_ROW]
];

/** "Updated 14:05:09 UTC": when a balance / positions reply was read (a refresh always changes it). */
const updatedLine = () => `<i>Updated ${new Date().toISOString().slice(11, 19)} UTC</i>`;

const ASK_BALANCE = {
  text: '👛 <b>Balance</b>\nSend a NEAR account, e.g. <code>yourname.near</code> or <code>yourname.tg</code>.\nRead-only: the bot never connects to your wallet. Tip: 🔗 My wallet links it once, then this opens straight away.',
  reply_markup: { force_reply: true, input_field_placeholder: 'NEAR account' }
};
const ASK_POSITIONS = {
  text: '📊 <b>LP positions</b>\nSend a NEAR account, e.g. <code>yourname.near</code> or <code>yourname.tg</code>.\nRead-only: the bot never connects to your wallet. Tip: 🔗 My wallet links it once, then this opens straight away.',
  reply_markup: { force_reply: true, input_field_placeholder: 'NEAR account' }
};

/* ---------------------------------------------------------------- linked wallet (read-only) */

const WALLET_TAG = '👛 KINU wallet:';
const WALLET_PROMPT = '🔗 My wallet';
const NEAR_GAS_KEEP = 0.25; // NEAR left for gas, as KINU's forms keep
const SHARE_BUTTONS = [['10%', 10], ['25%', 25], ['50%', 50], ['75%', 75], ['Max', 100]];

/** A Bot API call's result (null when it fails). */
async function telegramResult(method, body) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await response.json();
    return json.ok ? json.result : null;
  } catch {
    return null;
  }
}

/** The account linked to a chat: the bot's pinned "👛 KINU wallet: …" message, or null. */
async function linkedAccount(chatId) {
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return null;
  const pin = (await telegramResult('getChat', { chat_id: chatId }))?.pinned_message;
  const match = pin?.from?.is_bot && typeof pin.text === 'string' ? pin.text.match(/^👛 KINU wallet: (\S+)/u) : null;
  return match && CONTRACT.test(match[1]) ? { account: match[1], messageId: pin.message_id } : null;
}

/** Links (pins) an account in a chat, replacing the bot's earlier pin. False when it was already linked. */
async function linkWallet(chatId, account) {
  const current = await linkedAccount(chatId);
  if (current?.account === account) return false;
  const sent = await telegramResult('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: [
      `${WALLET_TAG} <b>${esc(account)}</b>`,
      'Read-only: the LP steps show this account\'s balance so you can pick 10–100% of it. The bot never holds keys or moves funds: you still sign in your wallet.',
      'Change it with /wallet <code>name.near</code>.'
    ].join('\n'),
    reply_markup: { inline_keyboard: [[cb('💧 New LP', 'm:new'), cb('📊 LP positions', 'm:pos')], MENU_ROW] }
  });
  if (!sent?.message_id) return false;
  if (current) await telegramResult('unpinChatMessage', { chat_id: chatId, message_id: current.messageId });
  await telegramResult('pinChatMessage', { chat_id: chatId, message_id: sent.message_id, disable_notification: true });
  return true;
}

const ftDecimals = new Map();
/**
 * What an account can put in, in token units (null when it can't be read). wNEAR: the wallet's
 * NEAR (storage and 0.25 NEAR for gas kept) — plus its wNEAR unless `nativeOnly` (Zap pays in NEAR).
 */
async function spendableOf(account, token, nativeOnly) {
  try {
    const ft = async (id) => {
      if (!ftDecimals.has(id)) ftDecimals.set(id, Number((await viewCall(id, 'ft_metadata', {}))?.decimals ?? 18));
      return Number(await viewCall(id, 'ft_balance_of', { account_id: account })) / 10 ** ftDecimals.get(id);
    };
    if (token !== WNEAR) return await ft(token);
    const view = await rpc({ request_type: 'view_account', finality: 'final', account_id: account });
    if (view.missing) return null;
    const liquid = Math.max(0, (Number(view.amount) - Number(view.storage_usage) * 1e19) / 1e24 - NEAR_GAS_KEEP);
    return nativeOnly ? liquid : liquid + (await ft(WNEAR).catch(() => 0));
  } catch {
    return null;
  }
}

/** /wallet: link an account (or say which one is linked and ask for one). */
async function walletReply(chatId, account) {
  if (!account) {
    const linked = await linkedAccount(chatId);
    return {
      text: [
        '🔗 <b>My wallet</b> · read-only',
        linked ? `Linked: <b>${esc(linked.account)}</b> (pinned at the top). Send another account to change it.` : 'Send your NEAR account, e.g. <code>yourname.near</code> or <code>yourname.tg</code>.',
        'The bot reads its public balances for the LP steps. It never holds keys or moves funds.'
      ].join('\n'),
      reply_markup: { force_reply: true, input_field_placeholder: 'NEAR account' }
    };
  }
  const view = await rpc({ request_type: 'view_account', finality: 'final', account_id: account });
  if (view.missing) return { text: `No NEAR account named <code>${esc(account)}</code>.`, reply_markup: { inline_keyboard: [MENU_ROW] } };
  const changed = await linkWallet(chatId, account);
  return {
    // The account's link lets 👛 Balance below read it (accountIn).
    text: changed ? `✅ ${accountLink(account)} is linked and pinned at the top. The amount step now shows its balance.` : `${accountLink(account)} is already linked.`,
    reply_markup: { inline_keyboard: [[cb('💧 New LP', 'm:new'), cb('👛 Balance', 'v:bal')], MENU_ROW] }
  };
}

/** /balance: NEAR and the account's tokens with their dollar value. */
async function balanceReply(account) {
  const [view, fts, prices] = await Promise.all([
    rpc({ request_type: 'view_account', finality: 'final', account_id: account }),
    getJson(`${FASTNEAR_API}/v1/account/${encodeURIComponent(account)}/ft`).catch(() => ({ tokens: [] })),
    tokenPrices().catch(() => ({}))
  ]);
  if (view.missing) return { text: `No NEAR account named <code>${esc(account)}</code>.`, reply_markup: { inline_keyboard: [MENU_ROW] } };
  const nearAmount = Number(view.amount) / 1e24;
  const rows = [{ symbol: 'NEAR', amount: nearAmount, usd: nearAmount * priceOf(prices, WNEAR) }];
  let unpriced = 0;
  for (const t of fts.tokens || []) {
    if (!(Number(t.balance) > 0)) continue;
    if (!prices[t.contract_id]) {
      unpriced += 1;
      continue;
    }
    const value = Number(t.balance) / 10 ** decimalsOf(prices, t.contract_id);
    rows.push({ symbol: t.contract_id === WNEAR ? 'wNEAR' : symbolOf(prices, t.contract_id), amount: value, usd: value * priceOf(prices, t.contract_id) });
  }
  const shown = rows.filter((r, i) => i === 0 || r.usd >= 0.01).sort((a, b) => b.usd - a.usd);
  const total = rows.reduce((s, r) => s + r.usd, 0);
  const hidden = shown.length - MAX_ROWS;
  const lines = [
    `👛 ${accountLink(account)} · ≈ <b>${usd(total)}</b>`,
    '',
    ...shown.slice(0, MAX_ROWS).map((r) => `• <b>${esc(r.symbol)}</b> ${amount(r.amount)} · ${usd(r.usd)}`),
    hidden > 0 ? `… and ${hidden} more` : null,
    unpriced ? `${unpriced} token${unpriced === 1 ? '' : 's'} without a price not counted.` : null,
    '',
    'Read-only, from public data. LP positions are not included: tap 📊.',
    updatedLine()
  ].filter((l) => l !== null);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: accountButtons(account, 'pos') } };
}

/** "In range · 32% to edge" / "Out of range · 16% above", like the pool page. */
function rangeStatus(lo, hi, now, inBins, bins) {
  // A one-sided position starts right at the price: on its edge, it fills as soon as the price moves in.
  const off = now < lo ? (lo - now) / lo : now >= hi ? (now - hi) / hi : null;
  if (off !== null && off < 0.0005) return '🟡 On the range edge · starts earning once the price moves in';
  if (now < lo) return `🔴 Out of range · ${pct(((lo - now) / lo) * 100)}% below`;
  if (now >= hi) return `🔴 Out of range · ${pct(((now - hi) / hi) * 100)}% above`;
  const edge = (Math.min(now - lo, hi - now) / now) * 100;
  return `🟢 In range · ${pct(edge)}% to edge${bins > 1 ? ` · ${inBins}/${bins} bins earning` : ''}`;
}

/** /positions: the account's Rhea CLMM positions, per pool: range, status, value, unclaimed fees. */
async function positionsReply(account) {
  const view = await rpc({ request_type: 'view_account', finality: 'final', account_id: account });
  if (view.missing) return { text: `No NEAR account named <code>${esc(account)}</code>.`, reply_markup: { inline_keyboard: [MENU_ROW] } };
  const [liquidities, prices] = await Promise.all([viewCall(DCL, 'list_liquidities', { account_id: account }), tokenPrices().catch(() => ({}))]);
  if (!liquidities?.length) {
    return { text: `📊 ${accountLink(account)}\nNo CLMM positions on Rhea.\n${updatedLine()}`, reply_markup: { inline_keyboard: accountButtons(account, 'bal') } };
  }
  const groups = new Map();
  liquidities.forEach((l) => groups.set(l.pool_id, [...(groups.get(l.pool_id) || []), l]));
  const pools = Object.fromEntries(await Promise.all([...groups.keys()].map(async (id) => [id, await viewCall(DCL, 'get_pool', { pool_id: id }).catch(() => null)])));
  let total = 0;
  const blocks = [];
  for (const [poolId, list] of groups) {
    const pool = pools[poolId];
    if (!pool) continue;
    const [x, y, fee] = poolId.split('|');
    const dx = decimalsOf(prices, x);
    const dy = decimalsOf(prices, y);
    const current = pool.current_point;
    let ax = 0;
    let ay = 0;
    let fx = 0;
    let fy = 0;
    let inBins = 0;
    list.forEach((l) => {
      const split = Math.min(Math.max(current, l.left_point), l.right_point);
      const sqrt = (p) => Math.pow(Math.sqrt(1.0001), p);
      const r = Math.sqrt(1.0001);
      const L = Number(l.amount);
      if (l.right_point > split) ax += (L * (1 / sqrt(split) - 1 / sqrt(l.right_point)) * r) / (r - 1);
      if (split > l.left_point) ay += (L * (sqrt(split) - sqrt(l.left_point))) / (r - 1);
      fx += Number(l.unclaimed_fee_x || 0);
      fy += Number(l.unclaimed_fee_y || 0);
      if (current >= l.left_point && current < l.right_point) inBins += 1;
    });
    const px = priceOf(prices, x);
    const py = priceOf(prices, y);
    const value = (ax / 10 ** dx) * px + (ay / 10 ** dy) * py;
    const fees = (fx / 10 ** dx) * px + (fy / 10 ** dy) * py;
    total += value + fees;
    const toPrice = (point) => Math.pow(1.0001, point) * 10 ** (dx - dy);
    const lo = toPrice(Math.min(...list.map((l) => l.left_point)));
    const hi = toPrice(Math.max(...list.map((l) => l.right_point)));
    const now = toPrice(current);
    const [sx, sy] = [symbolOf(prices, x), symbolOf(prices, y)];
    blocks.push({
      value,
      poolId,
      name: `${sx}/${sy}`,
      text: [
        `<b>${esc(sx)} / ${esc(sy)}</b> · ${Number(fee) / 1e4}% · ${list.length} bin${list.length === 1 ? '' : 's'}`,
        `   ${rangeStatus(lo, hi, now, inBins, list.length)}`,
        `   ${usd(value)} · unclaimed fees ${usd(fees)}`,
        `   ${plain(lo)} – ${plain(hi)} ${esc(sy)}/${esc(sx)}`
      ].join('\n')
    });
  }
  blocks.sort((a, b) => b.value - a.value);
  const lines = [
    `📊 ${accountLink(account)} · ${blocks.length} CLMM pool${blocks.length === 1 ? '' : 's'} · ≈ <b>${usd(total)}</b>`,
    '',
    ...blocks.slice(0, MAX_ROWS).map((b, i) => `${i + 1}. ${b.text}`),
    blocks.length > MAX_ROWS ? `… and ${blocks.length - MAX_ROWS} more pools` : null,
    '',
    '✖ <b>Close</b> opens KINU\'s remove form for that pool: take out 25–100%, get both tokens back or one, and sign in your wallet (the one holding the position).',
    updatedLine()
  ].filter((l) => l !== null);
  // One ✖ Close per pool shown, two to a row.
  const closeButtons = blocks
    .slice(0, MAX_ROWS)
    .map((b, i) => open(`✖ Close ${i + 1}. ${b.name}`.slice(0, 40), `${appUrl()}/pools?${new URLSearchParams({ type: 'clmm', close: b.poolId })}`));
  const closeRows = [];
  for (let i = 0; i < closeButtons.length; i += 2) closeRows.push(closeButtons.slice(i, i + 2));
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [...closeRows, ...accountButtons(account, 'bal')] } };
}

/** /terminal: the full KINU app, inside Telegram or in a browser. */
function terminal() {
  return {
    text: [
      '💻 <b>KINU Terminal</b> ✨',
      'The full KINU app: swap, every pool on NEAR, LP positions with PnL, portfolio and charts.',
      '',
      '🔐 Opened from Telegram it connects with HOT Wallet right here, nothing to sign up for.',
      `In a browser: <a href="${appUrl()}">kinudefi.com</a>`
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[open('💻 Open Terminal', `${appUrl()}/app`)], [{ text: '🌐 Open in browser', url: appUrl() }], [cb('🎛 Menu: Commands', 'm')]]
    }
  };
}

/** The first NEAR account named in a message (an account id with a dot, or a 64-hex implicit one). */
function accountFrom(text) {
  for (const raw of String(text || '').trim().split(/\s+/)) {
    const w = raw.replace(/^@/, '').toLowerCase();
    if (CONTRACT.test(w) && w.length >= 2 && w.length <= 64) return w;
  }
  return null;
}

/**
 * The reply for a text message. `replyTo`: the text of the bot message it answers, if any (a
 * contract sent in reply to the swap prompt is a swap, not an LP).
 */
export async function replyFor(text, replyTo = '', chatId = null, replyMessage = null) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^\/([a-z]+)(@\w+)?\s*/i);
  const name = match ? match[1].toLowerCase() : null;
  const rest = match ? trimmed.slice(match[0].length) : trimmed;
  if (name === 'wallet' || (!name && String(replyTo).startsWith(WALLET_PROMPT))) return walletReply(chatId, accountFrom(rest));
  if (chatId && !(await linkedAccount(chatId))) return connectFirst();
  if (!trimmed || name === 'start' || name === 'help' || name === 'menu') return menu();
  if (name === 'pools') return { text: 'Every pool on NEAR (Rhea and Intear DEX), sorted by what it pays LPs.', reply_markup: { inline_keyboard: [[open('🐕 Open Pools', `${appUrl()}/pools`)], MENU_ROW] } };
  if (name === 'trending') return poolList('t1');
  if (name === 'yield') return poolList('y');
  if (name === 'terminal') return terminal();
  if (!name && String(replyTo).startsWith(CUSTOM_PROMPT)) return customAnswer(rest, replyMessage, chatId);
  if (!name && String(replyTo).startsWith(AMOUNT_PROMPT)) return amountAnswer(rest, replyMessage, chatId);
  // Balance / positions: an account in the command, or sent in reply to their prompt.
  const replied = !name ? String(replyTo) : '';
  if (['balance', 'mybalance', 'bal'].includes(name) || replied.startsWith(BAL_PROMPT)) {
    const account = accountFrom(rest);
    // No account named: the chat's linked wallet, else ask for one.
    const target = account || (await linkedAccount(chatId))?.account;
    return target ? balanceReply(target) : ASK_BALANCE;
  }
  if (['positions', 'position', 'pos', 'mypositions'].includes(name) || replied.startsWith(POS_PROMPT)) {
    const account = accountFrom(rest);
    const target = account || (await linkedAccount(chatId))?.account;
    return target ? positionsReply(target) : ASK_POSITIONS;
  }
  const req = parseRequest(rest);
  const swap = name === 'swap' || (!name && String(replyTo).startsWith(SWAP_PROMPT));
  if (!req.token) {
    if (swap) return ASK_SWAP;
    if (name === 'lp' || String(replyTo).startsWith(LP_PROMPT)) return ASK_CONTRACT;
    return UNKNOWN;
  }
  return swap ? swapReply(req) : tokenReply(req.token);
}

/** The reply for a button press (`data`) on one of the bot's messages. */
export async function replyForButton(data, message) {
  const [kind, a, b] = String(data || '').split(':');
  const chat = message?.chat?.id;
  const links = linksIn(message);
  const state = links[0];
  if (kind === 'm' && a === 'wal') return walletReply(chat, null);
  if (chat && !(await linkedAccount(chat))) return connectFirst();
  if (kind === 'm') {
    if (!a) return menu();
    if (a === 'new') return ASK_CONTRACT;
    if (a === 'swap') return ASK_SWAP;
    // The menu's Balance / LP positions: the linked wallet when there is one.
    if (a === 'bal' || a === 'pos') {
      const linked = await linkedAccount(chat);
      if (!linked) return a === 'bal' ? ASK_BALANCE : ASK_POSITIONS;
      return a === 'bal' ? balanceReply(linked.account) : positionsReply(linked.account);
    }
    if (a === 'term') return terminal();
    if (a === 'wal') return walletReply(message?.chat?.id, null);
    if (a === 'kinu') return poolCard(KINU_POOL);
    return poolList(a);
  }
  if (kind === 'l') return links[Number(a)] ? poolCard(links[Number(a)].poolId) : menu();
  // Balance <-> positions of the account linked in the message.
  if (kind === 'rf') return replyForButton(`v:${a}`, message);
  if (kind === 'v') {
    const account = accountIn(message);
    if (!account) return a === 'pos' ? ASK_POSITIONS : ASK_BALANCE;
    return a === 'pos' ? positionsReply(account) : balanceReply(account);
  }
  if (!state?.poolId) return menu();
  const [x, y] = state.poolId.split('|');
  if (kind === 's') return swapReply({ token: x === WNEAR ? y : x });
  // The strategy picked so far rides along in the message's pool link (spot when none).
  const strategy = STRATEGY_NAMES[state.params.get('strategy')] ? state.params.get('strategy') : 'spot';
  const symbolsOf = async () => (await poolById(state.poolId).catch(() => null))?.symbols || [x, y].map((t) => (t === WNEAR ? 'NEAR' : t.split('.')[0].toUpperCase()));
  // d: side → strategy step ('o' is the side button of older messages).
  if (kind === 'd' || kind === 'o') return strategyStep(state.poolId, a, await symbolsOf());
  if (kind === 'c') return customPrompt(state.poolId, state.params.get('side') || 'z', strategy);
  if (kind === 'g') return widthStep(state.poolId, state.params.get('side') || 'z', STRATEGY_NAMES[a] ? a : 'spot', await symbolsOf());
  if (kind === 'r') return amountStep(state.poolId, new URLSearchParams({ range: a, strategy, ...(state.params.get('side') === 'k' ? { both: '1' } : {}) }), chat);
  if (kind === 'bk') {
    const p = state.params;
    if (a === 'card') return poolCard(state.poolId);
    if (a === 'w') {
      const side = p.get('below') ? 'b' : p.get('above') ? 'a' : p.get('both') ? 'k' : 'z';
      return widthStep(state.poolId, side, strategy, await symbolsOf());
    }
    if (a === 'a') {
      const kept = new URLSearchParams([...p.entries()].filter(([k]) => ['range', 'below', 'above', 'strategy', 'both'].includes(k)));
      return amountStep(state.poolId, kept, chat);
    }
    return poolCard(state.poolId);
  }
  if (kind === 'w') return amountStep(state.poolId, new URLSearchParams({ [a === 'b' ? 'below' : 'above']: b, strategy }), chat);
  if (kind === 'a' && a === 'c') return amountPrompt(state.poolId, state.params, chat);
  if (kind === 'a') return finalStep(state.poolId, state.params, a.startsWith('p') ? { pct: Number(a.slice(1)) } : Number(a), chat);
  return menu();
}

/* ---------------------------------------------------------------- results from KINU */

const NOTIFY_MAX_AGE_S = 24 * 3600;
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * Telegram's Mini App launch data, checked with the bot token (core.telegram.org/bots/webapps):
 * the Telegram user it was issued to, or null when it is forged, malformed or too old.
 */
export function telegramUserFrom(initData, botToken) {
  if (typeof initData !== 'string' || initData.length > 4096 || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') || '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date'));
  if (!(age >= -60 && age < NOTIFY_MAX_AGE_S)) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return Number.isSafeInteger(user?.id) ? user : null;
  } catch {
    return null;
  }
}

/** A transaction's final result from the chain: { ok, receiver } (null when it isn't found). */
async function txResult(hash, account) {
  for (const url of RPCS) {
    try {
      const json = await getJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: hash, sender_account_id: account, wait_until: 'EXECUTED_OPTIMISTIC' } })
      });
      if (json.error) continue;
      const r = json.result;
      if (r?.transaction?.signer_id !== account) return null;
      const failed = 'Failure' in (r.status || {}) || (r.receipts_outcome || []).some((o) => 'Failure' in (o.outcome?.status || {}));
      return { ok: !failed, receiver: r.transaction.receiver_id };
    } catch {
      // next RPC
    }
  }
  return null;
}

/** POST ?notify=1 from KINU: a Quick LP signed in the Mini App, posted in that user's chat. */
async function notify(req, res) {
  const user = telegramUserFrom(req.body?.initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!user) return res.status(401).end();
  const { account, hashes, pool, label, kind } = req.body || {};
  if (typeof account !== 'string' || !CONTRACT.test(account) || account.length > 64) return res.status(400).end();
  if (kind === 'wallet') {
    const view = await rpc({ request_type: 'view_account', finality: 'final', account_id: account });
    if (view.missing) return res.status(422).end();
    await linkWallet(user.id, account);
    return res.status(200).json({ ok: true });
  }
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > 10 || !hashes.every((h) => typeof h === 'string' && HASH.test(h))) return res.status(400).end();
  if (typeof pool !== 'string' || !/^[^|]{2,80}\|[^|]{2,80}\|\d{1,6}$/.test(pool)) return res.status(400).end();
  // Every transaction signed by that account and settled, at least one of them on Rhea's CLMM.
  const results = await Promise.all(hashes.map((h) => txResult(h, account)));
  if (results.some((r) => !r) || !results.some((r) => r.receiver === DCL)) return res.status(422).end();
  const ok = results.every((r) => r.ok);
  const [x, y, fee] = pool.split('|');
  const prices = await tokenPrices().catch(() => ({}));
  const name = `${symbolOf(prices, x)} / ${symbolOf(prices, y)}`;
  const last = hashes[hashes.length - 1];
  const text = [
    ok ? `✅ <b>Position created</b> · ${esc(name)} · ${Number(fee) / 1e4}%` : `⚠️ <b>Not completed</b> · ${esc(name)} · ${Number(fee) / 1e4}%`,
    typeof label === 'string' && label.length <= 120 ? esc(label) : null,
    `Account ${accountLink(account)}`,
    `<a href="https://nearblocks.io/txns/${last}">View transaction</a>`,
    ok ? null : 'A step failed on chain. Check your balances and positions in KINU.'
  ].filter((l) => l !== null);
  await send(user.id, {
    text: text.join('\n'),
    reply_markup: { inline_keyboard: [[open('🐕 View pool', stateUrl(pool)), cb('📊 LP positions', 'v:pos')], MENU_ROW] }
  });
  if (ok) await linkWallet(user.id, account).catch(() => {});
  return res.status(200).json({ ok: true });
}

/* ---------------------------------------------------------------- webhook */

async function telegram(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const send = (chatId, reply) => telegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...reply });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('KINU LP bot');
  if (req.query?.notify) {
    if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(500).end();
    return notify(req, res).catch((error) => {
      console.error('telegram notify', error);
      return res.status(500).end();
    });
  }
  // Only Telegram knows the secret (setWebhook secret_token): anything else is ignored.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(401).end();
  if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(500).end();

  const callback = req.body?.callback_query;
  const message = callback?.message || req.body?.message;
  // Private chats only: web_app buttons work there, and groups stay quiet.
  if (!message?.chat || message.chat.type !== 'private') return res.status(200).end();
  try {
    if (callback) {
      if (String(callback.data).startsWith('rf:')) {
        // 🔄 Refresh: the same message, read again.
        const reply = await replyForButton(callback.data, message);
        await telegram('editMessageText', { chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'HTML', disable_web_page_preview: true, ...reply });
        await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Updated' }).catch(() => {});
        return res.status(200).end();
      }
      await telegram('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
      await send(message.chat.id, await replyForButton(callback.data, message));
    } else if (typeof message.text === 'string') {
      await send(message.chat.id, await replyFor(message.text, message.reply_to_message?.text, message.chat.id, message.reply_to_message));
    }
  } catch (error) {
    await send(message.chat.id, { text: "Couldn't load pool data right now. Try again in a minute.", reply_markup: { inline_keyboard: [MENU_ROW] } }).catch(() => {});
    console.error('telegram bot', error);
  }
  return res.status(200).end();
}
