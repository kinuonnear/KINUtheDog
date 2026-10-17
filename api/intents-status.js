// NEAR Intents Shield status for the Bridge page (a Vercel function). Shield pauses deposits,
// withdrawals and swaps on a chain or bridge while an incident is open; its public status API
// sends no CORS headers, so the browser reads it through here. Cached at the edge for a minute.
// In `vite dev` the same path is proxied straight to the upstream (vite.config.js).

const UPSTREAM = 'https://partners.near-intents.org/api/shield/public/status';

export default async function handler(req, res) {
  try {
    const r = await fetch(UPSTREAM, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ activeIncidents: Array.isArray(body.activeIncidents) ? body.activeIncidents : [] });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
}
