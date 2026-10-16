// Tokenized stocks & ETFs (Ondo) — a price watch only. NEAR brought Ondo's tokenized US stocks
// to near.com (bought through NEAR Intents, region-restricted); a few are also NEP-141 tokens on
// NEAR. Prices are the Ondo tokens' own market prices from CoinGecko (no API key, CORS-enabled),
// not KINU's pools: these assets have no real DEX liquidity on NEAR yet.

const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';

/** Shown in this order. `near`: the token's NEP-141 contract on NEAR, when there is one. */
export const STOCKS = [
  { symbol: 'NVDA', name: 'NVIDIA', cg: 'nvidia-ondo-tokenized-stock', near: 'bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near' },
  { symbol: 'TSLA', name: 'Tesla', cg: 'tesla-ondo-tokenized-stock', near: 'bnb-0x2494b603319d4d9f9715c9f4496d9e0364b59d93.omdep.near' },
  { symbol: 'MSFT', name: 'Microsoft', cg: 'microsoft-ondo-tokenized-stock', near: 'bnb-0x6bfe75d1ad432050ea973c3a3dcd88f02e2444c3.omdep.near' },
  { symbol: 'AAPL', name: 'Apple', cg: 'apple-ondo-tokenized-stock' },
  { symbol: 'AMZN', name: 'Amazon', cg: 'amazon-ondo-tokenized-stock' },
  { symbol: 'GOOGL', name: 'Alphabet', cg: 'alphabet-class-a-ondo-tokenized-stock' },
  { symbol: 'SPY', name: 'S&P 500', cg: 'spdr-s-p-500-etf-ondo-tokenized-etf', etf: true },
  { symbol: 'QQQ', name: 'Nasdaq-100', cg: 'invesco-qqq-etf-ondo-tokenized-etf', etf: true },
  { symbol: 'IAU', name: 'Gold', cg: 'ishares-gold-trust-ondo-tokenized-stock', etf: true },
  { symbol: 'SLV', name: 'Silver', cg: 'ishares-silver-trust-ondo-tokenized-stock', etf: true }
];

export const BUY_URL = 'https://near.com';

/** Latest USD price and 24h change of every stock, keyed by symbol. */
export async function getStockPrices({ signal } = {}) {
  const params = new URLSearchParams({
    ids: STOCKS.map((s) => s.cg).join(','),
    vs_currencies: 'usd',
    include_24hr_change: 'true',
    include_last_updated_at: 'true'
  });
  const response = await fetch(`${COINGECKO}?${params}`, { signal });
  if (!response.ok) throw new Error(response.status === 429 ? 'Price source is busy, retrying shortly.' : `CoinGecko HTTP ${response.status}`);
  const json = await response.json();
  const out = {};
  STOCKS.forEach((s) => {
    const row = json[s.cg];
    if (row && Number.isFinite(row.usd)) {
      out[s.symbol] = { usd: row.usd, change24h: Number.isFinite(row.usd_24h_change) ? row.usd_24h_change : null, updated: row.last_updated_at ? row.last_updated_at * 1000 : null };
    }
  });
  return out;
}

/** Whether the US stock market is in its regular session now (Mon–Fri 9:30–16:00 New York; holidays not counted). */
export function usMarketOpen(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
