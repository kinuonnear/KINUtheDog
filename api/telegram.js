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
// Messages: /start (menu), /help, /pools, /swap <contract> [$amount], /lp <contract>, or a pasted
// token contract.

const RHEA_API = 'https://api.rhea.finance';
const DEXSCREENER_API = 'https://api.dexscreener.com';
const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const WNEAR = 'wrap.near';
const KINU = 'kinu-3.nearlytrade.near';
const KINU_POOL = `${KINU}|${WNEAR}|10000`;
// Tokens KINU has verified (src/config.js KINU_VERIFIED_TOKENS).
const VERIFIED = new Set([KINU, 'token.intear.near']);
const USD_AMOUNTS = [50, 100, 150];
const RANGES = ['5', '10', '25', '50'];
const SIDE_WIDTHS = ['10', '20', '30', '50', '70', '90'];
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

/* ---------------------------------------------------------------- buttons & state */

const cb = (text, data) => ({ text, callback_data: data });
const open = (text, url) => ({ text, web_app: { url } });
const MENU_ROW = [cb('🏠 Menu', 'm')];

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
  '',
  'KINU never holds your keys or funds: you check everything in KINU and confirm in your wallet (HOT Wallet works inside Telegram). Liquidity can lose value against holding (impermanent loss); this is not financial advice.'
].join('\n');

function menu() {
  return {
    text: HELP,
    reply_markup: {
      inline_keyboard: [
        [cb('💧 New LP', 'm:new'), cb('🐕 KINU / NEAR', 'm:kinu')],
        [cb('🔥 Trending 1h', 'm:t1'), cb('🔥 Trending 6h', 'm:t6')],
        [cb('💰 Top yield', 'm:y'), open('⇄ Swap', `${appUrl()}/swap`)],
        [open('🐕 Open KINU', `${appUrl()}/pools`)]
      ]
    }
  };
}

const ASK_CONTRACT = {
  text: '💧 <b>New LP</b>\nPaste the token contract, e.g. <code>kinu-3.nearlytrade.near</code>.\nContracts only: names and tickers can point at look-alike tokens.',
  reply_markup: { inline_keyboard: [MENU_ROW] }
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

/** A pool: tokens (with contracts), TVL, volume, APR, and the range choices. */
async function poolCard(poolId, fallback = null) {
  const pool = (await poolById(poolId).catch(() => null)) || fallback;
  if (!pool) return { text: 'That pool is not listed yet. Paste the token contract to look again.', reply_markup: { inline_keyboard: [MENU_ROW] } };
  const [x, y] = pool.tokens;
  const [sx, sy] = pool.symbols;
  const apr = pool.tvl >= 100 ? (pool.fees / pool.tvl) * 365 * 100 : null;
  const tokenLine = (id, symbol) => `${esc(symbol)}: <code>${esc(short(id))}</code>${VERIFIED.has(id) ? ' ✓ verified' : ''}`;
  const main = pool.tokens.find((t) => t !== WNEAR) || x;
  const lines = [
    `🎯 <a href="${stateUrl(pool.id)}">${esc(`${sx} / ${sy}`)}</a> · CLMM ${pool.feePct}% fee`,
    tokenLine(x, sx),
    tokenLine(y, sy),
    `TVL ${usd(pool.tvl)} · 24h volume ${usd(pool.volume)} · 24h fees ${usd(pool.fees)}`,
    apr !== null ? `Fee APR ≈ ${pct(apr)}% (last 24h, not a promise)` : null,
    '',
    '<b>Pick a range</b>',
    pool.tokens.includes(WNEAR) ? '⚡ Zap: put in NEAR only, KINU swaps the right share.' : '⚖ Both tokens, at the pool price.',
    `💵 ${esc(sy)} only: sits below the price (a limit buy of ${esc(sx)}).`,
    `🎯 ${esc(sx)} only: sits above the price (a limit sell of ${esc(sx)}).`
  ].filter((l) => l !== null);
  const both = pool.tokens.includes(WNEAR) ? '⚡' : '⚖';
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        RANGES.slice(0, 3).map((r) => cb(`${both} ±${r}%`, `r:${r}`)),
        [cb(`${both} ±${RANGES[3]}%`, `r:${RANGES[3]}`), cb(`${both} Full range`, 'r:full')],
        [cb(`💵 ${sy} only ↓`, 'o:b'), cb(`🎯 ${sx} only ↑`, 'o:a')],
        [cb(`⇄ Buy / Sell ${pool.symbols[pool.tokens.indexOf(main)]}`, 's'), ...MENU_ROW]
      ]
    }
  };
}

/** One-sided range: how far below / above the price it reaches. */
function sideWidth(poolId, side, symbols) {
  const [sx, sy] = symbols;
  const below = side === 'b';
  return {
    text: [
      `📐 <a href="${stateUrl(poolId)}">${esc(`${sx} / ${sy}`)}</a> · ${below ? `${esc(sy)} only` : `${esc(sx)} only`}`,
      below
        ? `How far below the price should it reach? It fills as the price falls: tighter earns more fees but is passed sooner.`
        : `How far above the price should it reach? It sells as the price rises: tighter earns more fees but is passed sooner.`
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        SIDE_WIDTHS.slice(0, 3).map((w) => cb(`${below ? '−' : '+'}${w}%`, `w:${side}:${w}`)),
        SIDE_WIDTHS.slice(3).map((w) => cb(`${below ? '−' : '+'}${w}%`, `w:${side}:${w}`)),
        MENU_ROW
      ]
    }
  };
}

/** What a range puts in: { token, symbol, label } (token null: both tokens, entered in KINU). */
function depositOf(pool, params) {
  const [x, y] = pool.tokens;
  const [sx, sy] = pool.symbols;
  if (params.get('below')) return { token: y, symbol: sy, label: `${sy} only · down to −${params.get('below')}%` };
  if (params.get('above')) return { token: x, symbol: sx, label: `${sx} only · up to +${params.get('above')}%` };
  const width = params.get('range') === 'full' ? 'full range' : `±${params.get('range')}%`;
  return pool.tokens.includes(WNEAR) ? { token: WNEAR, symbol: 'NEAR', label: `Zap NEAR · ${width}` } : { token: null, symbol: null, label: `Both tokens · ${width}` };
}

/** Amount step: $50 / $100 / $150 / custom of the token the range takes. */
async function amountStep(poolId, params) {
  const pool = await poolById(poolId).catch(() => null);
  if (!pool) return { text: 'That pool could not be loaded. Try again in a minute.', reply_markup: { inline_keyboard: [MENU_ROW] } };
  const deposit = depositOf(pool, params);
  const name = `${pool.symbols[0]} / ${pool.symbols[1]}`;
  const link = stateUrl(pool.id, Object.fromEntries(params));
  if (!deposit.token) {
    return {
      text: `🎯 <a href="${link}">${esc(name)}</a> · ${esc(deposit.label)}\nThis pool has no NEAR side: enter both amounts in KINU.`,
      reply_markup: { inline_keyboard: [[open('🐕 Open in KINU', link)], MENU_ROW] }
    };
  }
  return {
    text: `💰 <a href="${link}">${esc(name)}</a> · ${esc(deposit.label)}\nHow much ${esc(deposit.symbol)} do you want to put in? (in dollars, at the latest price)`,
    reply_markup: { inline_keyboard: [USD_AMOUNTS.map((d) => cb(`$${d}`, `a:${d}`)), [cb('✏️ Custom', 'a:c')], MENU_ROW] }
  };
}

/** Last step: the filled-in link, opened in KINU. */
async function finalStep(poolId, params, dollars) {
  const pool = await poolById(poolId).catch(() => null);
  if (!pool) return { text: 'That pool could not be loaded. Try again in a minute.', reply_markup: { inline_keyboard: [MENU_ROW] } };
  const deposit = depositOf(pool, params);
  const query = Object.fromEntries(params);
  let amountText = 'You enter the amount in KINU.';
  if (deposit.token) {
    query.in = deposit.token === WNEAR ? 'NEAR' : deposit.token;
    const usdPrice = pool.prices?.[pool.tokens.indexOf(deposit.token)];
    const amount = dollars && usdPrice ? units(dollars / usdPrice) : null;
    if (amount) {
      query.amount = amount;
      amountText = `$${dollars} ≈ ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${esc(deposit.symbol)}`;
    } else if (dollars) amountText = `No price for ${esc(deposit.symbol)} right now: enter the amount in KINU.`;
  }
  const link = stateUrl(pool.id, query);
  return {
    text: [
      `✅ <a href="${stateUrl(pool.id, Object.fromEntries(params))}">${esc(`${pool.symbols[0]} / ${pool.symbols[1]}`)}</a> · ${esc(deposit.label)}`,
      amountText,
      '',
      'Open it in KINU: everything is filled in. Check the form, then confirm in your wallet.'
    ].join('\n'),
    reply_markup: { inline_keyboard: [[open('🐕 Open in KINU', link)], MENU_ROW] }
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
async function tokenReply(token) {
  const pool = await findPool(token);
  if (pool) return poolCard(pool.id, pool);
  const info = await tokenInfo(token);
  return {
    text: `No concentrated liquidity pool for <code>${esc(token)}</code> on Rhea yet.${info ? ` You can still swap NEAR for ${esc(info.symbol)}.` : ''}`,
    reply_markup: { inline_keyboard: [[open('⇄ Swap', swapUrl(token)), ...MENU_ROW]] }
  };
}

/** The reply for a text message. */
export async function replyFor(text) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^\/([a-z]+)(@\w+)?\s*/i);
  const name = match ? match[1].toLowerCase() : null;
  const rest = match ? trimmed.slice(match[0].length) : trimmed;
  if (!trimmed || name === 'start' || name === 'help' || name === 'menu') return menu();
  if (name === 'pools') return { text: 'Every pool on NEAR (Rhea and Intear DEX), sorted by what it pays LPs.', reply_markup: { inline_keyboard: [[open('🐕 Open Pools', `${appUrl()}/pools`)], MENU_ROW] } };
  if (name === 'trending') return poolList('t1');
  if (name === 'yield') return poolList('y');
  const req = parseRequest(rest);
  if (!req.token) return name === 'swap' ? { text: 'Send <code>/swap</code> with a token contract, e.g. <code>/swap kinu-3.nearlytrade.near</code> or <code>/swap kinu-3.nearlytrade.near $75</code>.', reply_markup: { inline_keyboard: [MENU_ROW] } } : UNKNOWN;
  return name === 'swap' ? swapReply(req) : tokenReply(req.token);
}

/** The reply for a button press (`data`) on one of the bot's messages. */
export async function replyForButton(data, message) {
  const [kind, a, b] = String(data || '').split(':');
  const links = linksIn(message);
  const state = links[0];
  if (kind === 'm') {
    if (!a) return menu();
    if (a === 'new') return ASK_CONTRACT;
    if (a === 'kinu') return poolCard(KINU_POOL);
    return poolList(a);
  }
  if (kind === 'l') return links[Number(a)] ? poolCard(links[Number(a)].poolId) : menu();
  if (!state?.poolId) return menu();
  const [x, y] = state.poolId.split('|');
  if (kind === 's') return swapReply({ token: x === WNEAR ? y : x });
  if (kind === 'r') return amountStep(state.poolId, new URLSearchParams({ range: a }));
  if (kind === 'o') {
    const pool = await poolById(state.poolId).catch(() => null);
    return sideWidth(state.poolId, a, pool?.symbols || [x, y]);
  }
  if (kind === 'w') return amountStep(state.poolId, new URLSearchParams({ [a === 'b' ? 'below' : 'above']: b }));
  if (kind === 'a') return finalStep(state.poolId, state.params, a === 'c' ? null : Number(a));
  return menu();
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
      await telegram('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
      await send(message.chat.id, await replyForButton(callback.data, message));
    } else if (typeof message.text === 'string') {
      await send(message.chat.id, await replyFor(message.text));
    }
  } catch (error) {
    await send(message.chat.id, { text: "Couldn't load pool data right now. Try again in a minute.", reply_markup: { inline_keyboard: [MENU_ROW] } }).catch(() => {});
    console.error('telegram bot', error);
  }
  return res.status(200).end();
}
