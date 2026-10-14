// Swap page header for the charted token, Jupiter-style: logo, name, verified mark and links on
// the first line, the contract under it, then price and the key market numbers. The pair button
// ("NEAR/NEARLY ⇄") switches which of the two swap tokens is shown.

import { useAsync } from '../../hooks.js';
import { fetchTokenInfo, intearTokenId } from '../../lib/intear.js';
import { getTokenProfile } from '../../lib/tokenMarket.js';
import { formatChartPrice, formatPercent, formatUsd, shortAccount } from '../../lib/format.js';
import { CONTRACTS, ENDPOINTS, NATIVE_NEAR } from '../../config.js';
import { Link } from '../../router.jsx';
import { CopyButton, TokenIcon } from '../ui.jsx';

function Social({ href, label, children }) {
  return (
    <a className="token-head__link" href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}>
      {children}
    </a>
  );
}

export default function TokenHeader({ tokenIn, tokenOut, side, onSideChange }) {
  const token = side === 'in' ? tokenIn : tokenOut;
  const tokenId = intearTokenId(token);
  const native = token?.id === NATIVE_NEAR.id;
  const info = useAsync(() => fetchTokenInfo(tokenId), [tokenId], { enabled: Boolean(tokenId), refreshMs: 30_000 });
  const profile = useAsync(() => getTokenProfile(tokenId).catch(() => null), [tokenId], { enabled: Boolean(tokenId) && !native });
  const p = profile.data;
  const d = info.data;
  const mcap = d?.circulatingSupply && d?.price ? d.circulatingSupply * d.price : null;
  const pair = tokenIn && tokenOut && tokenIn.id !== tokenOut.id;

  return (
    <section className="card token-head" aria-label={`${token?.symbol} overview`}>
      <div className="token-head__id">
        <TokenIcon token={p?.image && !token?.icon ? { ...token, icon: p.image } : token} size={44} />
        <div className="token-head__names">
          <div className="token-head__title">
            <strong>{token?.symbol}</strong>
            {p?.verified && (
              <svg width="16" height="16" viewBox="0 0 24 24" role="img" aria-label="Verified on GeckoTerminal">
                <circle cx="12" cy="12" r="10" fill="#4fb3ff" />
                <path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#0b0f14" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {!native && (
              <span className="token-head__links">
                <Link to={`/token/${encodeURIComponent(token?.id || '')}`} className="token-head__info">
                  Info
                </Link>
                {p?.website && (
                  <Social href={p.website} label="Website">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
                    </svg>
                  </Social>
                )}
                {p?.twitter && (
                  <Social href={`https://x.com/${p.twitter}`} label={`X @${p.twitter}`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                      <path d="M4 4l16 16M20 4L4 20" />
                    </svg>
                  </Social>
                )}
                {p?.telegram && (
                  <Social href={`https://t.me/${p.telegram}`} label={`Telegram ${p.telegram}`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M21 4L3 11l6 2 2 6 3-4 5 4z" />
                    </svg>
                  </Social>
                )}
              </span>
            )}
          </div>
          <div className="token-head__meta">
            {native ? (
              <span className="muted small">Native token · swaps as {CONTRACTS.wrapNear}</span>
            ) : (
              <>
                <code title={token?.id}>{shortAccount(token?.id || '', 14, 8)}</code>
                <CopyButton text={token?.id} />
                <a href={`${ENDPOINTS.explorer}/address/${token?.id}`} target="_blank" rel="noopener noreferrer" className="small">
                  NearBlocks ↗
                </a>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="token-head__price">
        <strong>{d?.price != null ? `$${formatChartPrice(d.price)}` : '—'}</strong>
        {d?.change24h != null && (
          <em className={d.change24h >= 0 ? 'up' : 'down'}>
            {d.change24h >= 0 ? '+' : ''}
            {formatPercent(d.change24h)}
          </em>
        )}
        <span className="muted small">24h</span>
      </div>

      <dl className="token-head__stats">
        <div>
          <dt>Market cap</dt>
          <dd>{mcap ? formatUsd(mcap) : '—'}</dd>
        </div>
        <div>
          <dt>Liquidity</dt>
          <dd>{d ? formatUsd(d.liquidityUsd) : '—'}</dd>
        </div>
        <div>
          <dt>Holders</dt>
          <dd>{d?.holders ? d.holders.toLocaleString() : '—'}</dd>
        </div>
      </dl>

      {pair && (
        <button
          type="button"
          className="token-head__pair"
          onClick={() => onSideChange(side === 'in' ? 'out' : 'in')}
          title={`Show ${(side === 'in' ? tokenOut : tokenIn).symbol} instead`}
          aria-label={`Showing ${token?.symbol}. Switch to ${(side === 'in' ? tokenOut : tokenIn).symbol}`}
        >
          <span className={side === 'in' ? 'is-shown' : ''}>{tokenIn.symbol}</span>/<span className={side === 'out' ? 'is-shown' : ''}>{tokenOut.symbol}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M4 8h14l-4-4M20 16H6l4 4" />
          </svg>
        </button>
      )}
    </section>
  );
}
