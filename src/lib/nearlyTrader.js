// A wallet's trading record on Nearly launch tokens, from Nearly's public API
// (nearly.trade/api/trader/<account>): PnL, invested, win rate, best trade, per-token results and
// recent trades. Spot trades only (buying and selling Nearly tokens); LP is KINU's own data.

const API = 'https://nearly.trade/api';
const TTL_MS = 60_000;
const cache = new Map(); // account -> { at, promise }

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function normalize(raw) {
  const total = raw?.total || {};
  const stats = raw?.stats || {};
  const tokens = (raw?.tokens || []).filter((t) => t.traded !== false);
  return {
    account: raw?.account,
    rank: num(raw?.rank),
    pnlUsd: num(total.pnl_usd) ?? 0,
    roi: num(total.roi),
    investedUsd: num(total.invested_usd) ?? 0,
    tokenCount: num(total.tokens) ?? 0,
    openCount: num(total.open) ?? 0,
    realizedUsd: tokens.reduce((s, t) => s + (num(t.realized_usd) || 0), 0),
    unrealizedUsd: tokens.reduce((s, t) => s + (num(t.unrealized_usd) || 0), 0),
    trades: num(stats.trades) ?? 0,
    firstTs: num(stats.first_ts),
    lastTs: num(stats.last_ts),
    winRate: num(stats.win_rate),
    best: stats.best ? { token: stats.best.token, symbol: stats.best.symbol, pnlUsd: num(stats.best.pnl_usd), roi: num(stats.best.roi) } : null,
    tokens: tokens.map((t) => ({
      id: t.token,
      symbol: t.symbol,
      name: t.name,
      icon: t.icon || null,
      basisUsd: num(t.basis_usd) || 0,
      pnlUsd: num(t.pnl_usd) || 0,
      roi: num(t.roi),
      open: Boolean(t.open),
      buys: num(t.buys) || 0,
      sells: num(t.sells) || 0,
      lastTs: num(t.last_ts)
    })),
    recent: (raw?.recent || []).map((r) => ({
      ts: num(r.ts_ms),
      token: r.token,
      symbol: r.symbol,
      icon: r.icon || null,
      side: r.side,
      usd: num(r.usd) || 0
    }))
  };
}

/** The account's Nearly trading record (cached for a minute). */
export function getNearlyTrader(account) {
  const hit = cache.get(account);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = fetch(`${API}/trader/${encodeURIComponent(account)}`)
    .then((response) => {
      if (!response.ok) throw new Error(`Nearly API ${response.status}`);
      return response.json();
    })
    .then(normalize);
  cache.set(account, { at: Date.now(), promise });
  promise.catch(() => cache.delete(account));
  return promise;
}
