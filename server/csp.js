// Content-Security-Policy for kinudefi.com pages, shared by the Vercel middleware (middleware.js)
// and the local production server (scripts/serve-prod.mjs) so local tests run under the exact live
// policy. script-src carries a fresh nonce per page: NEAR Connect runs each wallet in a srcdoc
// iframe that inherits this policy, and its inline scripts only run with that nonce.

export const NONCE_PLACEHOLDER = "__CSP_NONCE__";

export const WALLET_SCRIPT_HOSTS = [
  "https://raw.githubusercontent.com",
  "https://near-mobile-production.aws.peersyst.tech",
  "https://trezu.app"
];

// The wallets' own servers (mainnet only), read from their pinned scripts and seen in tests under
// this policy: HOT, Meteor, MyNearWallet / OKX (fastnear, Aurora RPC), Ledger, Trezu.
export const WALLET_API_HOSTS = [
  'https://api0.herewallet.app',
  'https://storage.herewallet.app',
  'https://app.hot-labs.org',
  'https://mc.meteorwallet.app',
  'wss://mc.meteorwallet.app',
  'https://c1.rpc.fastnear.com',
  'https://c2.rpc.fastnear.com',
  'https://nearrpc.aurora.dev',
  'https://relmn.aurora.dev',
  'https://rpc.near.org',
  'https://api.mainnet.fastnear.com',
  'https://api.trezu.app'
];

// Fonts the wallets' own screens load (HOT, Meteor, MyNearWallet).
export const WALLET_STYLE_HOSTS = ['https://rsms.me', 'https://fonts.cdnfonts.com'];

const DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "https://telegram.org"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", ...WALLET_STYLE_HOSTS],
  "font-src": ["'self'", "data:", "https://fonts.gstatic.com", ...WALLET_STYLE_HOSTS],
  "img-src": ["'self'", "data:", "blob:", "https:"],
  "connect-src": [
    "'self'",
    "https://solana-rpc.publicnode.com",
    "https://rpc.mainnet.near.org",
    "https://archival-rpc.mainnet.near.org",
    "https://free.rpc.fastnear.com",
    "https://archival-rpc.mainnet.fastnear.com",
    "https://near.drpc.org",
    "https://rpc.intea.rs",
    "https://nearinner.deltarpc.com",
    "https://rpc.shitzuapes.xyz",
    "wss://ws-events-v3.intear.tech",
    "https://mw.rpc.fastnear.com",
    "https://api.fastnear.com",
    "https://tx.main.fastnear.com",
    "https://helper.mainnet.near.org",
    "https://api.rhea.finance",
    "https://indexer.ref.finance",
    "https://smartx.rhea.finance",
    "https://router.intear.tech",
    "wss://router.intear.tech",
    "https://prices.intear.tech",
    "https://api.intea.rs",
    "wss://api.intea.rs",
    "https://dex-backend.intear.tech",
    "https://api.geckoterminal.com",
    "https://api.dexscreener.com",
    "https://api.coingecko.com",
    "https://1click.chaindefuser.com",
    "https://api.morpho.org",
    "https://api.kamino.finance",
    "https://api.nearblocks.io",
    "https://nearly.trade",
    "https://wallet.meteorwallet.app",
    "https://wallet.intear.tech",
    "wss://wallet.intear.tech",
    "https://logout-bridge-service.intear.tech",
    "wss://logout-bridge-service.intear.tech",
    "https://h4n.app",
    "https://my.herewallet.app",
    "https://herewallet.app",
    "https://app.mynearwallet.com",
    // NEAR Connect: wallet scripts (lib/walletManifest.js), fetched by the page.
    ...WALLET_SCRIPT_HOSTS,
    // Each wallet runs in a srcdoc iframe that inherits this policy, so its own API calls need it too.
    ...WALLET_API_HOSTS
  ],
  "frame-src": ["https://wallet.intear.tech", "https://my.herewallet.app", "https://herewallet.app", "https://h4n.app", "https://wallet.meteorwallet.app", "https://app.mynearwallet.com"],
  "worker-src": ["'self'", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  "upgrade-insecure-requests": [],
};

/** The policy string for one page; without a nonce (static pages) script-src stays 'self' only. */
export function buildCsp(nonce) {
  return Object.entries(DIRECTIVES)
    .map(([key, values]) => {
      const list = key === "script-src" && nonce ? [...values, "'nonce-" + nonce + "'"] : values;
      return [key, ...list].join(" ");
    })
    .join("; ");
}

/** A random nonce (base64, 18 bytes) from the Web Crypto API (Node 18+ and Vercel). */
export function newNonce() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** The page with its nonce in place of the placeholder (index.html's csp-nonce meta). */
export function injectNonce(html, nonce) {
  return html.split(NONCE_PLACEHOLDER).join(nonce);
}

/**
 * The other security headers of every page, as vercel.json sets them for all paths (keep the two
 * in sync). The middleware sends them too, so app pages carry them however Vercel orders headers.
 */
export const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(self "https://my.herewallet.app" "https://h4n.app")',
  'cross-origin-opener-policy': 'same-origin-allow-popups'
};
