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

// A speed bump against scripts that fake the Origin header to use KINU's partner key: requests per
// client IP per minute, counted per function instance (instances are short-lived, so this only
// stops bursts; 1Click's own limits stay the backstop).
const hits = new Map();
export function rateLimited(req, perMinute) {
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > perMinute;
}
