// New on Rhea (/new): the newest token launches with a Rhea CLMM pool (via Nearly),
// with live numbers and factual risk flags. Rows open the token page.

import { useMemo, useState } from 'react';
import { useAsync } from '../hooks.js';
import { Link, navigate } from '../router.jsx';
import { ErrorNotice, Skeleton, TokenIcon } from '../components/ui.jsx';
import { getRecentLaunches, launchFlags } from '../lib/launches.js';
import { getTokens } from '../lib/tokens.js';
import { formatAge } from '../lib/lpHistory.js';
import { formatPrice, formatUsd } from '../lib/format.js';
import { NATIVE_NEAR, PINNED_TOKENS } from '../config.js';
import { FlagList } from './Token.jsx';

const QUOTES = [
  ['all', 'All'],
  ['wrap.near', 'NEAR'],
  ['token.rhealab.near', 'RHEA']
];

/** Symbols of the main tokens (the pinned list) → their contract, to spot copies of their names. */
function useKnownSymbols() {
  const known = useAsync(async () => {
    const ids = PINNED_TOKENS.filter((id) => id !== NATIVE_NEAR.id);
    const tokens = await getTokens(ids);
    const map = new Map();
    ids.forEach((id) => {
      const symbol = tokens[id]?.symbol?.toUpperCase();
      if (symbol && !map.has(symbol)) map.set(symbol, id);
    });
    if (!map.has('NEAR')) map.set('NEAR', NATIVE_NEAR.id);
    return map;
  }, []);
  return known.data;
}

export default function NewOnRhea() {
  const [quote, setQuote] = useState('all');
  const [hideThin, setHideThin] = useState(false);
  const launches = useAsync(() => getRecentLaunches({ limit: 80 }), [], { refreshMs: 60_000 });
  const knownSymbols = useKnownSymbols();

  const rows = useMemo(() => {
    const list = launches.data || [];
    const seen = new Map();
    list.forEach((l) => {
      const s = String(l.symbol || '').toUpperCase();
      seen.set(s, (seen.get(s) || 0) + 1);
    });
    return list
      .filter((l) => quote === 'all' || l.quote === quote)
      .filter((l) => !hideThin || l.liquidityUsd >= 500)
      .map((l) => ({ ...l, flags: launchFlags(l, { knownSymbols, seen }) }));
  }, [launches.data, quote, hideThin, knownSymbols]);

  return (
    <div className="page new-page">
      <header className="page-head page-head--split">
        <div>
          <span className="eyebrow">Discover</span>
          <h1>New on Rhea</h1>
          <p>The newest tokens with a Rhea pool, launched on Nearly. Live every minute, with the facts that matter before you buy.</p>
        </div>
        <div className="new-page__filters">
          <div className="segmented">
            {QUOTES.map(([key, label]) => (
              <button key={key} type="button" className={quote === key ? 'active' : ''} onClick={() => setQuote(key)}>
                {label}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={hideThin} onChange={(e) => setHideThin(e.target.checked)} /> Hide thin liquidity
          </label>
        </div>
      </header>

      <div className="notice notice--warn new-page__risk">
        New tokens are extremely risky. Anyone can launch a token with any name — a listing here is not an endorsement.
        Check the contract, liquidity and holders, and never invest more than you can lose.
      </div>

      {launches.error && !launches.data ? (
        <ErrorNotice error={launches.error} onRetry={launches.reload} />
      ) : (
        <section className="card new-table">
          <div className="new-row new-row--head">
            <span>Token</span>
            <span>Age</span>
            <span>Price</span>
            <span>24h</span>
            <span>FDV</span>
            <span title="NEAR/RHEA in the pool — what sellers can actually receive">Liquidity*</span>
            <span>Volume 24h</span>
            <span>Holders</span>
            <span />
          </div>
          {!launches.data
            ? Array.from({ length: 8 }, (_, i) => (
                <div className="new-row" key={i}>
                  <Skeleton width={160} />
                  {Array.from({ length: 7 }, (__, j) => (
                    <Skeleton key={j} width={60} />
                  ))}
                  <span />
                </div>
              ))
            : rows.map((l) => (
                <div className="new-row" key={l.id} onClick={() => navigate(`/token/${encodeURIComponent(l.id)}`)} role="link" tabIndex={0}>
                  <span className="new-row__token">
                    <TokenIcon token={{ symbol: l.symbol, icon: l.icon }} size={32} />
                    <span>
                      <strong>{l.symbol}</strong>
                      <small>{l.name}</small>
                      <FlagList flags={l.flags} />
                    </span>
                  </span>
                  <span data-label="Age">{formatAge(Date.now() - l.createdAt)}</span>
                  <span data-label="Price">{formatPrice(l.priceUsd)}</span>
                  <span data-label="24h" className={l.change24h > 0 ? 'up' : l.change24h < 0 ? 'down' : 'muted'}>
                    {l.change24h === null ? '—' : `${l.change24h > 0 ? '+' : ''}${l.change24h.toFixed(1)}%`}
                  </span>
                  <span data-label="FDV">{formatUsd(l.fdvUsd)}</span>
                  <span data-label="Liquidity">{formatUsd(l.liquidityUsd)}</span>
                  <span data-label="Volume 24h">{formatUsd(l.volume24hUsd)}</span>
                  <span data-label="Holders">{l.holders.toLocaleString()}</span>
                  <span className="new-row__buy">
                    <Link
                      className="button button--outline button--sm"
                      to={`/swap?from=${l.quote === 'wrap.near' ? NATIVE_NEAR.id : encodeURIComponent(l.quote)}&to=${encodeURIComponent(l.id)}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Buy
                    </Link>
                  </span>
                </div>
              ))}
          {launches.data && !rows.length && <p className="muted small new-table__empty">No launches match these filters.</p>}
        </section>
      )}
      <p className="muted small">Data: Nearly launch records and Rhea pools. Flags are on-chain facts, not ratings. *Liquidity = the NEAR/RHEA side of the pool.</p>
    </div>
  );
}
