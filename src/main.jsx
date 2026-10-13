import './polyfills.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { inject } from '@vercel/analytics';
import { AppProvider } from './state.jsx';
import App from './App.jsx';
import { startAutoRpc } from './lib/rpc.js';
import './styles.css';

// Vercel Web Analytics: cookieless page views. Query strings are dropped so account names
// (?account=…) and wallet results never reach analytics.
inject({ beforeSend: (event) => ({ ...event, url: event.url.split('?')[0] }) });

// Auto RPC: read from whichever endpoint answers fastest for this visitor (lib/rpc.js).
startAutoRpc();

// Service worker: makes KINU installable as an app and serves an offline page (public/sw.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
);
