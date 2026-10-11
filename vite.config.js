import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const local = (path) => fileURLToPath(new URL(path, import.meta.url));

// All data sources (NEAR RPC, Rhea API/indexer/SmartRouter, FastNEAR,
// DexScreener, GeckoTerminal) allow CORS, so no dev proxy is needed and
// the production build works on any static host.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Node polyfills required by the NEAR wallet-selector packages.
      buffer: local('./node_modules/buffer/index.js'),
      process: local('./node_modules/process/browser.js'),
      depd: local('./src/shims/depd.js')
    }
  },
  define: {
    global: 'globalThis'
  },
  optimizeDeps: {
    include: ['buffer', 'process']
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    commonjsOptions: {
      transformMixedEsModules: true
    }
  }
});
