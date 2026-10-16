// Discover → Stocks: a price watch of Ondo's tokenized US stocks and ETFs, the assets NEAR offers
// on near.com. Read-only: prices come from CoinGecko (see lib/stocks.js), nothing is traded here.

import { useAsync } from '../hooks.js';
import { BUY_URL, getStockPrices, STOCKS, usMarketOpen } from '../lib/stocks.js';
import { formatAge } from '../lib/format.js';
import { ErrorNotice, Skeleton } from './ui.jsx';

const usd = (v) => (v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v.toFixed(2));

export default function TokenizedStocks() {
  const prices = useAsync(() => getStockPrices(), [], { refreshMs: 60_000 });
  const open = usMarketOpen();
  const updated = Math.max(0, ...Object.values(prices.data || {}).map((p) => p.updated || 0));

  return (
    <section className="card stocks">
      <div className="stocks__head">
        <span className={`stocks__market ${open ? 'stocks__market--open' : ''}`}>
          <i aria-hidden /> US market {open ? 'open' : 'closed'}
        </span>
        <span className="muted small">
          Prices: Ondo tokens on CoinGecko{updated ? ` · updated ${formatAge(updated)} ago` : ''}
        </span>
      </div>

      {prices.error && !prices.data ? (
        <ErrorNotice error={prices.error} onRetry={prices.reload} />
      ) : (
        <div className="stocks__grid">
          {STOCKS.map((s) => {
            const p = prices.data?.[s.symbol];
            return (
              <div key={s.symbol} className="stocks__item">
                <div className="stocks__name">
                  <b>{s.symbol}</b>
                  <small className="muted">
                    {s.name}
                    {s.etf ? ' · ETF' : ''}
                  </small>
                </div>
                {p ? (
                  <div className="stocks__price">
                    <strong>${usd(p.usd)}</strong>
                    {p.change24h !== null && (
                      <span className={p.change24h >= 0 ? 'up' : 'down'}>
                        {p.change24h >= 0 ? '+' : '−'}
                        {Math.abs(p.change24h).toFixed(2)}%
                      </span>
                    )}
                  </div>
                ) : (
                  <Skeleton width={90} height={18} />
                )}
                {s.near && (
                  <small className="stocks__near mono" title={`${s.symbol}on, a NEP-141 token on NEAR: ${s.near}`}>
                    on NEAR
                  </small>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="stocks__foot">
        <a className="button button--ghost button--sm" href={BUY_URL} target="_blank" rel="noopener noreferrer">
          Buy tokenized stocks on near.com ↗
        </a>
        <p className="muted small">
          For information only, not an offer to buy or sell securities. Tokenized stocks (Ondo) may not be available in your
          region. They have no real DEX liquidity on NEAR yet, so KINU doesn&apos;t trade them.
        </p>
      </div>
    </section>
  );
}
