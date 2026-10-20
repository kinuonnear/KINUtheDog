// Swap page header for the charted token, Jupiter-style: logo, name, verified mark and links on
// the first line, the contract under it, then price and the key market numbers. Links come from
// GeckoTerminal and DexScreener (lib/tokenMarket.js getTokenProfile).

import { useEffect, useRef, useState } from 'react';
import { useAsync } from '../../hooks.js';
import { fetchTokenInfo, intearTokenId } from '../../lib/intear.js';
import { getTokenProfile } from '../../lib/tokenMarket.js';
import { formatChartPrice, formatPercent, formatUsd, shortAccount } from '../../lib/format.js';
import { CONTRACTS, ENDPOINTS, NATIVE_NEAR } from '../../config.js';
import { Link } from '../../router.jsx';
import { CopyButton, TokenIcon } from '../ui.jsx';
import { ScanBadge } from '../TokenScan.jsx';

function Social({ href, label, children }) {
  return (
    <a className="token-head__link" href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}>
      {children}
    </a>
  );
}

export default function TokenHeader({ token }) {
  const tokenId = intearTokenId(token);
  const native = token?.id === NATIVE_NEAR.id;
  const info = useAsync(() => fetchTokenInfo(tokenId), [tokenId], { enabled: Boolean(tokenId), refreshMs: 30_000 });
  const profile = useAsync(() => getTokenProfile(tokenId).catch(() => null), [tokenId], { enabled: Boolean(tokenId) && !native });
  const p = profile.data;
  const d = info.data;
  const mcap = d?.circulatingSupply && d?.price ? d.circulatingSupply * d.price : null;
  const fdv = d?.totalSupply && d?.price ? d.totalSupply * d.price : null;
  // One fixed layout for every token, chosen by the card's own width (not by the token's name or
  // price): wide = name | price | numbers in one row; narrow = numbers on a second row. The width
  // the one-row layout needs comes from the CSS (--head-wide-min; smaller in the laptop layout).
  const cardRef = useRef(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= (parseFloat(getComputedStyle(el).getPropertyValue('--head-wide-min')) || 870)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The price in NEAR (NEAR itself: none).
  const nearInfo = useAsync(() => fetchTokenInfo(CONTRACTS.wrapNear), [], { enabled: !native, refreshMs: 30_000 });
  const priceNear = !native && d?.price && nearInfo.data?.price ? d.price / nearInfo.data.price : null;
  // DexScreener's page for the token's deepest pair; its token search otherwise.
  const dexUrl = p?.dexscreener || `https://dexscreener.com/near/${encodeURIComponent(tokenId || '')}`;

  return (
    <section ref={cardRef} className={`card token-head token-head--swap ${wide ? 'token-head--wide' : 'token-head--narrow'}`} aria-label={`${token?.symbol} overview`}>
      <div className="token-head__id">
        <TokenIcon token={p?.image && !token?.icon ? { ...token, icon: p.image } : token} size={38} />
        <div className="token-head__names">
          <div className="token-head__title">
            {native ? (
              <strong>{token?.symbol}</strong>
            ) : (
              <Link to={`/token/${encodeURIComponent(token?.id || '')}`} className="token-head__sym" title={`${token?.symbol}: open the token page`}>
                <strong>{token?.symbol}</strong>
              </Link>
            )}
            {p?.verified && (
              <svg width="16" height="16" viewBox="0 0 24 24" role="img" aria-label="Verified on GeckoTerminal">
                <circle cx="12" cy="12" r="10" fill="#4fb3ff" />
                <path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#0b0f14" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {!native && tokenId && <ScanBadge tokenId={tokenId} compact />}
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
                <span className="token-head__links">
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
                  <Social href={dexUrl} label="DexScreener">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
                    </svg>
                  </Social>
                </span>
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
        {priceNear != null && (
          <span className="token-head__quote" title={`Price in NEAR, at NEAR's price of ${formatChartPrice(nearInfo.data.price)}`}>
            <small>Price</small>
            <b>
              {formatChartPrice(priceNear)} <i>NEAR</i>
            </b>
          </span>
        )}
      </div>

      <dl className="token-head__stats">
        <div>
          <dt title="Market cap: price × circulating supply">MCap</dt>
          <dd title={mcap ? formatUsd(mcap) : undefined}>{mcap ? formatUsd(mcap, { compactAbove: 1e3 }) : '—'}</dd>
        </div>
        <div>
          <dt>FDV</dt>
          <dd title={fdv ? `Fully diluted value: price × total supply · ${formatUsd(fdv)}` : 'Fully diluted value: price × total supply'}>{fdv ? formatUsd(fdv, { compactAbove: 1e3 }) : '—'}</dd>
        </div>
        <div>
          <dt>Liquidity</dt>
          <dd title={d ? formatUsd(d.liquidityUsd) : undefined}>{d ? formatUsd(d.liquidityUsd, { compactAbove: 1e3 }) : '—'}</dd>
        </div>
        <div>
          <dt>Holders</dt>
          <dd>{d?.holders ? d.holders.toLocaleString() : '—'}</dd>
        </div>
      </dl>
    </section>
  );
}
