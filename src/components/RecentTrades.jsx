import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { fetchTrades, intearTokenId } from '../lib/intear.js';
import { formatChartPrice, formatUsd, shortAccount, toNumber } from '../lib/format.js';
import { ENDPOINTS } from '../config.js';
import { Skeleton } from './ui.jsx';

function timeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function RecentTrades({ token }) {
  const { accountId } = useApp();
  const tokenId = intearTokenId(token);
  const trades = useAsync(() => fetchTrades({ tokenId, limit: 30 }), [tokenId], {
    enabled: Boolean(tokenId),
    refreshMs: 15_000
  });

  return (
    <section className="card trades-card">
      <div className="card-head">
        <h3>Recent trades · {token?.symbol}</h3>
        <span className="live-pill">Live</span>
      </div>
      <div className="trades">
        <div className="trades__row trades__row--head">
          <span>Time</span>
          <span>Type</span>
          <span>Value</span>
          <span>Price</span>
          <span>Trader</span>
        </div>
        {trades.loading && !trades.data
          ? Array.from({ length: 6 }, (_, i) => (
              <div className="trades__row" key={i}>
                <Skeleton width={28} />
                <Skeleton width={30} />
                <Skeleton width={50} />
                <Skeleton width={60} />
                <Skeleton width={70} />
              </div>
            ))
          : (trades.data || []).map((t) => {
              const amount = token?.decimals !== undefined ? toNumber(t.amountRaw, token.decimals) : 0;
              const price = amount > 0 ? t.usd / amount : null;
              const mine = accountId && t.trader === accountId;
              return (
                <a
                  key={t.id}
                  className={`trades__row ${mine ? 'trades__row--mine' : ''}`}
                  href={`${ENDPOINTS.explorer}/txns/${t.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open transaction"
                >
                  <span className="muted">{timeAgo(t.time)}</span>
                  <span className={t.side === 'buy' ? 'up' : 'down'}>{t.side === 'buy' ? 'BUY' : 'SELL'}</span>
                  <span className={t.side === 'buy' ? 'up' : 'down'}>{formatUsd(t.usd)}</span>
                  <span>{price ? `$${formatChartPrice(price)}` : '—'}</span>
                  <span className="trades__trader">{mine ? 'You' : shortAccount(t.trader, 8, 5)}</span>
                </a>
              );
            })}
        {trades.data && !trades.data.length && <div className="trades__empty">No trades yet.</div>}
        {trades.error && !trades.data && <div className="trades__empty">Trades unavailable right now.</div>}
      </div>
    </section>
  );
}
