// Token page (/token/:id): price chart, key facts, risk flags, the token's Rhea pools and
// recent trades — a shareable page for any NEAR token, with Buy / Sell in the terminal.

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import RecentTrades from '../components/RecentTrades.jsx';
import WatchStar from '../components/WatchStar.jsx';
import TokenScan, { ScanBadge } from '../components/TokenScan.jsx';
import { CopyButton, EmptyState, PairIcons, Spinner, TokenIcon } from '../components/ui.jsx';
import { formatPercent, formatUsd, shortAccount } from '../lib/format.js';
import { getToken, getWhitelistedTokens } from '../lib/tokens.js';
import { searchPools } from '../lib/rhea.js';
import { getLaunch, launchFlags } from '../lib/launches.js';
import { formatAge } from '../lib/lpHistory.js';
import { ENDPOINTS, KINU_TOKEN, NATIVE_NEAR } from '../config.js';
import { usePoolTokens } from './Pools.jsx';

const PriceChart = lazy(() => import('../components/PriceChart.jsx'));

export function FlagList({ flags }) {
  if (!flags.length) return null;
  return (
    <span className="flags">
      {flags.map((f) => (
        <i key={f.label} className={`flag flag--${f.kind}`} title={f.title}>
          {f.label}
        </i>
      ))}
    </span>
  );
}

export default function Token({ id }) {
  const token = useAsync(() => getToken(id), [id]);
  const whitelist = useAsync(() => getWhitelistedTokens(), []);
  const launch = useAsync(() => getLaunch(id), [id]);
  const pools = useAsync(() => searchPools({ tokenList: id, hideLow: false, limit: 20 }), [id]);
  const tokensOf = usePoolTokens(pools.data?.list);
  // Pools under $10 (dust, abandoned test pools) fold away so the real ones stand out.
  const [showDust, setShowDust] = useState(false);
  const realPools = (pools.data?.list || []).filter((p) => p.tvl >= 10);
  const dustPools = (pools.data?.list || []).filter((p) => !(p.tvl >= 10));
  const t = token.data;

  useEffect(() => {
    document.title = t?.symbol ? `${t.symbol} price, chart & pools · KINU` : 'Token · KINU';
  }, [t?.symbol]);

  const flags = useMemo(() => {
    const list = [];
    const listed = whitelist.data?.includes(id);
    if (id === KINU_TOKEN) list.push({ kind: 'good', label: 'Official $KINU' });
    else if (t?.symbol?.toUpperCase() === 'KINU') list.push({ kind: 'bad', label: 'Not the official $KINU' });
    if (whitelist.data) list.push(listed ? { kind: 'good', label: 'On Rhea’s token list' } : { kind: 'warn', label: 'Not on Rhea’s token list' });
    if (launch.data) list.push(...launchFlags(launch.data).filter((f) => !/KINU/.test(f.label)));
    return list;
  }, [id, t?.symbol, whitelist.data, launch.data]);

  if (token.error || (!token.loading && !t)) {
    return (
      <div className="page">
        <EmptyState icon="?" title="Token not found" action={<Link to="/new" className="button button--primary">See new tokens</Link>}>
          <code>{id}</code> isn’t a token contract on NEAR.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page token-page">
      <header className="card token-head">
        <div className="token-head__id">
          {t ? <TokenIcon token={t} size={52} /> : <Spinner />}
          <div>
            <h1>
              {t?.name || t?.symbol || '…'} {t?.name && t.name !== t.symbol && <span className="muted">{t.symbol}</span>}
            </h1>
            <div className="token-head__ca">
              <code>{id}</code>
              <CopyButton text={id} />
              <a className="link-button" href={`${ENDPOINTS.explorer}/address/${id}`} target="_blank" rel="noopener noreferrer">
                Explorer ↗
              </a>
            </div>
            <FlagList flags={flags} />
            <ScanBadge tokenId={id} />
          </div>
        </div>
        <div className="token-head__actions">
          <Link className="button button--primary" to={`/swap?from=${NATIVE_NEAR.id}&to=${encodeURIComponent(id)}`}>
            Buy {t?.symbol}
          </Link>
          <Link className="button button--outline" to={`/swap?from=${encodeURIComponent(id)}&to=${NATIVE_NEAR.id}`}>
            Sell
          </Link>
          <Link className="button button--outline" to={`/pools?q=${encodeURIComponent(id)}`} title={`Rhea pools with ${t?.symbol || 'this token'}: provide liquidity`}>
            Add LP
          </Link>
          <WatchStar id={id} label />
          <CopyButton text={`https://kinudefi.com/token/${id}`} label="Copy link" />
        </div>
      </header>

      <div className="token-grid">
        <div className="token-main">
          <section className="card token-chart">
            {t ? (
              <Suspense fallback={<Spinner />}>
                <PriceChart tokenIn={t} tokenOut={NATIVE_NEAR} side="in" onSideChange={() => {}} showContract={false} />
              </Suspense>
            ) : (
              <Spinner />
            )}
          </section>
          {t && <RecentTrades token={t} />}
        </div>

        <aside className="token-side">
          <TokenScan tokenId={id} />
          {launch.data && (
            <section className="card token-facts">
              <h2>Launch</h2>
              <dl className="kv">
                <div>
                  <dt>Launched on</dt>
                  <dd>Nearly · {formatAge(Date.now() - launch.data.createdAt)} ago</dd>
                </div>
                <div>
                  <dt>Creator</dt>
                  <dd className="mono">
                    <a href={`${ENDPOINTS.explorer}/address/${launch.data.creator}`} target="_blank" rel="noopener noreferrer" title={launch.data.creator}>
                      {shortAccount(launch.data.creator, 10, 6)} ↗
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>Trades (24h)</dt>
                  <dd>{launch.data.trades24h.toLocaleString()}</dd>
                </div>
              </dl>
            </section>
          )}
          <section className="card token-pools">
            <h2>Rhea pools</h2>
            {pools.loading && !pools.data ? (
              <Spinner />
            ) : pools.data?.list.length ? (
              <div className="token-pools__list">
                {(showDust ? [...realPools, ...dustPools] : realPools).map((pool) => (
                  <Link key={pool.id} to={poolPath(pool.id)} className="token-pool">
                    <PairIcons tokens={tokensOf(pool)} size={22} />
                    <span className="token-pool__pair">
                      <strong>{pool.symbols.join(' / ')}</strong>
                      <small>
                        {pool.label} · {formatPercent(pool.feePercent)} fee
                      </small>
                    </span>
                    <span className="token-pool__nums">
                      <strong>{formatUsd(pool.tvl)}</strong>
                      <small>{formatUsd(pool.volume24h)} 24h</small>
                    </span>
                  </Link>
                ))}
                {dustPools.length > 0 && (
                  <button type="button" className="link-button token-pools__more" onClick={() => setShowDust(!showDust)}>
                    {showDust ? 'Hide pools under $10' : `Show ${dustPools.length} pool${dustPools.length === 1 ? '' : 's'} under $10`}
                  </button>
                )}
              </div>
            ) : (
              <p className="muted small">No Rhea pool found for this token.</p>
            )}
          </section>
          <p className="muted small">
            Flags describe on-chain facts, not a rating. New tokens are high risk — always check the contract.
          </p>
        </aside>
      </div>
    </div>
  );
}
