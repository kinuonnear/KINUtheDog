import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const local = (path) => fileURLToPath(new URL(path, import.meta.url));

// Security headers live in vercel.json; `vite preview` serves the same ones so the
// production policy (CSP etc.) can be tested locally before deploying.
const securityHeaders = Object.fromEntries(
  JSON.parse(readFileSync(local('./vercel.json'), 'utf8')).headers[0].headers.map(({ key, value }) => [key, value])
);

// All data sources (NEAR RPC, Rhea API/indexer/SmartRouter, FastNEAR,
// DexScreener, GeckoTerminal) allow CORS, so no dev proxy is needed and
// the production build works on any static host.
// Netlify / Cloudflare Pages read headers from dist/_headers instead of vercel.json.
const headersFile = {
  name: 'kinu-security-headers',
  apply: 'build',
  closeBundle() {
    const lines = Object.entries(securityHeaders).map(([key, value]) => `  ${key}: ${value}`);
    writeFileSync(local('./dist/_headers'), `/*\n${lines.join('\n')}\n`);
  }
};

// `vite dev` runs api/intents-quote.js (Bridge and Earn quotes with KINU's fee) and
// api/intents-intent.js (Earn's signed withdrawals) and api/near-defi.js (the /pulse page's
// DefiLlama data) like Vercel does; the
// partner key, if any, comes from .env.local (NEAR_INTENTS_API_KEY, never committed).
const devQuoteApi = {
  name: 'kinu-dev-quote-api',
  apply: 'serve',
  configureServer(server) {
    const env = loadEnv(server.config.mode, server.config.root, '');
    if (env.NEAR_INTENTS_API_KEY && !process.env.NEAR_INTENTS_API_KEY) process.env.NEAR_INTENTS_API_KEY = env.NEAR_INTENTS_API_KEY;
    for (const route of ['/api/intents-quote', '/api/intents-intent', '/api/near-defi']) server.middlewares.use(route, async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { default: handler } = await server.ssrLoadModule(`${route}.js`);
      const reply = {
        statusCode: 200,
        setHeader: (k, v) => res.setHeader(k, v),
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          res.statusCode = this.statusCode;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        }
      };
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      await handler({ method: req.method, headers: req.headers, body }, reply);
    });
  }
};

export default defineConfig({
  plugins: [react(), headersFile, devQuoteApi],
  resolve: {
    alias: {
      // Node polyfills required by the NEAR wallet-selector packages.
      buffer: local('./node_modules/buffer/index.js'),
      process: local('./node_modules/process/browser.js'),
      depd: local('./src/shims/depd.js'),
      // HOT Wallet's sign-in nonce (crypto.randomBytes), from the browser's secure random.
      crypto: local('./src/shims/crypto.js')
    }
  },
  define: {
    global: 'globalThis'
  },
  optimizeDeps: {
    include: ['buffer', 'process']
  },
  server: {
    // NEAR Intents Shield status has no CORS; production reads it via api/intents-status.js.
    proxy: {
      '/api/intents-status': {
        target: 'https://partners.near-intents.org',
        changeOrigin: true,
        rewrite: () => '/api/shield/public/status'
      }
    }
  },
  preview: {
    headers: securityHeaders
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    commonjsOptions: {
      transformMixedEsModules: true
    }
  }
});
