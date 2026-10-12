import './polyfills.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { inject } from '@vercel/analytics';
import { AppProvider } from './state.jsx';
import App from './App.jsx';
import './styles.css';

// Vercel Web Analytics: cookieless page views. Query strings are dropped so account names
// (?account=…) and wallet results never reach analytics.
inject({ beforeSend: (event) => ({ ...event, url: event.url.split('?')[0] }) });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
);
