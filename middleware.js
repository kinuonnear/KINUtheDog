// Vercel Routing Middleware: every app page gets its Content-Security-Policy with a fresh nonce
// (server/csp.js). The page is the built index.html with the nonce written into its csp-nonce meta,
// where lib/nearConnect.js reads it for the wallets' sandboxed iframes. Files (scripts, styles,
// images), /api and Vercel's own paths never come through here.

import { buildCsp, injectNonce, newNonce, NONCE_PLACEHOLDER, SECURITY_HEADERS } from './server/csp.js';

export const config = {
  // App routes only: no file extension, not /api, /assets or /_vercel.
  matcher: ['/((?!api/|assets/|_vercel/|.*\\.[a-zA-Z0-9]+$).*)']
};

export default async function middleware(request) {
  // The visitor's cookies go along: on protected preview deployments Vercel answers a request
  // without its login cookie with the login page instead of index.html.
  const page = await fetch(new URL('/index.html', request.url), {
    headers: { cookie: request.headers.get('cookie') || '' }
  });
  const html = await page.text();
  // Anything that is not KINU's page (a login page, an error) goes back exactly as it came.
  if (!page.ok || !html.includes(NONCE_PLACEHOLDER)) {
    // The body was read as text, so it is no longer compressed or of its original length.
    const headers = new Headers(page.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(html, { status: page.status, headers });
  }
  const nonce = newNonce();
  return new Response(injectNonce(html, nonce), {
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
