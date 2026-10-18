// Shared by KINU's NEAR Intents functions (a leading underscore keeps this file from being a route
// on Vercel): only KINU's own pages may use them, as 1Click's terms allow no public proxy.

const ORIGINS = ['https://kinudefi.com', 'https://www.kinudefi.com', 'http://localhost:5173', 'http://127.0.0.1:5173'];

/** KINU's own pages: the listed origins, or the page this function is served with (any KINU domain). */
export function allowed(origin, host) {
  if (!origin) return false;
  if (ORIGINS.concat((process.env.KINU_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)).includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.host === host;
  } catch {
    return false;
  }
}

/** A JSON body, whether the platform parsed it already or not; null when it isn't JSON. */
export function parse(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body || 'null');
  } catch {
    return null;
  }
}
