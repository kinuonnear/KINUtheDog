import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const bufferEntry = fileURLToPath(
  new URL('./node_modules/buffer/index.js', import.meta.url)
);

const processEntry = fileURLToPath(
  new URL('./node_modules/process/browser.js', import.meta.url)
);

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      buffer: bufferEntry,
      process: processEntry,
      depd: fileURLToPath(
        new URL('./src/shims/depd.js', import.meta.url)
      )
    }
  },

  optimizeDeps: {
    include: [
      'buffer',
      'process',
      'depd',
      'secp256k1',
      'mustache',
      '@near-wallet-selector/core',
      '@near-wallet-selector/meteor-wallet',
      '@meteorwallet/sdk'
    ]
  },

  define: {
    global: 'globalThis',
    'process.env.NODE_ENV': JSON.stringify('development')
  },

  server: {
    proxy: {
      '/rhea-quote': {
        target: 'https://smartx.rhea.finance',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/rhea-quote/, '/swapMultiDexPath')
      },
      '/near-rpc': {
        target: 'https://rpc.mainnet.near.org',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/near-rpc/, '')
      },

      '/gecko-ohlcv': {
        target: 'https://api.geckoterminal.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) =>
          path.replace(/^\/gecko-ohlcv/, '')
      },
      '/dex-pairs': {
        target: 'https://api.dexscreener.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) =>
          path.replace(/^\/dex-pairs/, '')
      }
    }
  },

  build: {
    commonjsOptions: {
      transformMixedEsModules: true
    }
  }
});

