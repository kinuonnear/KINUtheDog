// Vercel Routing Middleware: every app page gets its Content-Security-Policy with a fresh nonce
// (server/csp.js). The page is the built index.html with the nonce written into its csp-nonce meta,
// where lib/nearConnect.js reads it for the wallets' sandboxed iframes. Files (scripts, styles,
// images), /api and Vercel's own paths never come through here.

import { buildCsp, injectNonce, newNonce, SECURITY_HEADERS } from './server/csp.js';

export const config = {
  // App routes only: no file extension, not /api, /assets or /_vercel.
  matcher: ['/((?!api/|assets/|_vercel/|.*\\.[a-zA-Z0-9]+$).*)']
};

export default async function middleware(request) {
  const page = await fetch(new URL('/index.html', request.url));
  if (!page.ok) return page;
  const nonce = newNonce();
  const html = injectNonce(await page.text(), nonce);
  return new Response(html, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': buildCsp(nonce),
      // One nonce per page view: never shared through a cache.
      'cache-control': 'private, no-store'
    }
  });
}
