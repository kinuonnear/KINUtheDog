// Serves the production build (dist/) the way kinudefi.com does: app pages go through the same
// nonce + Content-Security-Policy as middleware.js (server/csp.js), files are served as they are.
// For testing wallets under the live policy before a deploy. /api is not served here.
// usage: npm run build && node scripts/serve-prod.mjs [port]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { buildCsp, injectNonce, newNonce, SECURITY_HEADERS } from '../server/csp.js';

const ROOT = join(process.cwd(), 'dist');
const PORT = Number(process.argv[2] || 4174);
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
};
// The same paths middleware.js answers.
const APP_ROUTE = /^\/((?!api\/|assets\/|_vercel\/|.*\.[a-zA-Z0-9]+$).*)$/;

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Local only: every CSP violation (wallet iframes included) is reported here and logged.
  if (path === '/__csp-report' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const r = JSON.parse(body)['csp-report'] || {};
        console.log('[csp]', r['violated-directive'] || r['effective-directive'], '<-', r['blocked-uri'] || 'inline', '| doc', (r['document-uri'] || '').slice(0, 40));
      } catch {
        console.log('[csp] report', body.slice(0, 200));
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  try {
    if (APP_ROUTE.test(path)) {
      const nonce = newNonce();
      const html = injectNonce(await readFile(join(ROOT, 'index.html'), 'utf8'), nonce);
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES['.html'], 'content-security-policy': buildCsp(nonce) + '; report-uri /__csp-report', 'cache-control': 'no-store' });
      return res.end(html);
    }
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) throw new Error('outside dist');
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => console.log(`KINU production build with live CSP: http://localhost:${PORT}`));
