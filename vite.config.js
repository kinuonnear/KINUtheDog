import { defineConfig } from 'vite';
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

export default defineConfig({
  plugins: [react(), headersFile],
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
