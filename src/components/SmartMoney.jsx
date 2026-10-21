// Discover → Smart Money In: the featured Main tokens in a fixed order (with KINU, our token), then the Next ones and Rhea's other most
// traded tokens — each tier by 24h volume — with the Smart LP wallets in their pools. A row opens
// the token's pools (liquidity ≥ $10K), with the Smart LPs in each.

import { useMemo, useState } from 'react';
import { useAsync } from '../hooks.js';
import { Link, navigate, poolPath } from '../router.jsx';
import { FEATURED, fixedRank, loadSmartLps, MIN_POOL_TVL, smartMoneyIds, tierOf } from '../lib/smartMoney.js';
import { enrichTokens, getTrending } from '../lib/trending.js';
import { searchPools } from '../lib/rhea.js';
import { formatAge, formatPercent, formatPrice, formatUsd, shortAccount } from '../lib/format.js';
import { CONTRACTS, KINU_TOKEN, NATIVE_NEAR } from '../config.js';
import { loadBoard, lpPath } from './SmartLp.jsx';
import { usePoolTokens } from '../pages/Pools.jsx';
import { EmptyState, ErrorNotice, PairIcons, Skeleton, TokenIcon } from './ui.jsx';
import DetailsLink from './DetailsLink.jsx';

const K = { compactAbove: 1e4 };
const usd = (v) => (Number.isFinite(v) && v > 0 ? formatUsd(v, K) : '—');
const TIER_TITLES = [...FEATURED.map(([label]) => label), 'More by 24h volume'];
const NO_LPS = { lps: [], profitable: [], valueUsd: 0, pools: [] };

/** A steady colour per wallet, for its avatar. */
function hue(account) {
  let h = 0;
  for (let i = 0; i < account.length; i += 1) h = (h * 31 + account.charCodeAt(i)) % 360;
  return h;
}

/** Up to three wallet avatars (each opens the wallet's Smart LP profile) and the count. */
function LpAvatars({ lps, profitable = [] }) {
  if (!lps.length) return <span className="muted">—</span>;
  const stars = profitable.length;
  return (
    <span className="smi-lps">
      <span className="smi-avatars">
        {lps.slice(0, 3).map((a) => (
          <Link
            key={a}
            to={lpPath(a)}
            className="smi-av"
            style={{ '--h': hue(a) }}
            title={`${a}${profitable.includes(a) ? ' · profitable' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            {a.replace(/[^a-z0-9]/gi, '').slice(0, 1).toUpperCase()}
          </Link>
        ))}
      </span>
      <b>{lps.length}</b>
      {stars > 0 && (
        <small className="smi-star" title={`${stars} of them profitable (fee-checked, positive PnL)`}>
          ★{stars}
        </small>
      )}
    </span>
  );
}

function Change({ value }) {
  if (!Number.isFinite(value)) return null;
  return (
    <small className={value > 0 ? 'up' : value < 0 ? 'down' : 'muted'}>
      {value > 0 ? '+' : ''}
      {value.toFixed(1)}%
    </small>
  );
}

/**
 * The token's Rhea pools with ≥ $10K liquidity (Smart LP pools first), with the Smart LPs in each and
 * a Swap into the token through that pair.
 * KINU, our token, shows all its pools — no filter — largest first.
 */
function TokenPools({ token, smart }) {
  const pools = useAsync(() => searchPools({ tokenList: token.id, hideLow: false, limit: 30, sort: 'tvl' }), [token.id]);
  const ours = token.id === KINU_TOKEN;
  const smartByPool = useMemo(() => new Map(smart.pools.map((p) => [p.poolId, p])), [smart]);
  const rows = useMemo(() => {
    const list = (pools.data?.list || []).filter((p) => ours || p.tvl >= MIN_POOL_TVL);
    if (ours) return list.sort((a, b) => b.tvl - a.tvl);
    return list.sort((a, b) => (smartByPool.get(b.id)?.lps.length || 0) - (smartByPool.get(a.id)?.lps.length || 0) || b.tvl - a.tvl);
  }, [pools.data, smartByPool, ours]);
  const tokensOf = usePoolTokens(rows);

  if (pools.loading && !pools.data) {
    return (
      <div className="smi-pools">
        <Skeleton height={60} />
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="smi-pools muted small">
        No {token.symbol} pool with at least {formatUsd(MIN_POOL_TVL, K)} liquidity.
      </div>
    );
  }
  return (
    <div className="smi-pools">
      <div className="smi-prow smi-prow--head">
        <span>
          {rows.length} pool{rows.length === 1 ? '' : 's'} for {token.symbol} · {ours ? 'all pairs (our token)' : `liquidity ≥ ${formatUsd(MIN_POOL_TVL, K)}`}
        </span>
        <span>Liquidity</span>
        <span>Vol 24h</span>
        <span>Fees 24h</span>
        <span>Fee / TVL 24h</span>
        <span>Smart LPs</span>
        <span />
      </div>
      {rows.map((p) => {
        const s = smartByPool.get(p.id);
        return (
          <div className="smi-prow" key={p.id}>
            <span className="smi-prow__pair">
              <PairIcons tokens={tokensOf(p)} size={22} />
              <span>
                <b>{p.symbols.join(' / ')}</b>
                <small>
                  <span className={`kind kind--${p.label.toLowerCase()}`}>{p.label}</span> {formatPercent(p.feePercent, p.feePercent < 0.1 ? 3 : 2)}
                </small>
              </span>
            </span>
            <span data-label="Liquidity">{usd(p.tvl)}</span>
            <span data-label="Vol 24h">{usd(p.volume24h)}</span>
            <span data-label="Fees 24h">{usd(p.feeVolume24h)}</span>
            <span data-label="Fee / TVL 24h" className={p.tvl > 0 && p.feeVolume24h > 0 ? 'up' : 'muted'}>
              {p.tvl > 0 ? formatPercent((p.feeVolume24h / p.tvl) * 100) : '—'}
            </span>
            <span data-label="Smart LPs">{s ? <LpAvatars lps={s.lps} /> : <span className="muted">—</span>}</span>
            <span className="smi-prow__actions">
              <DetailsLink tokenId={token.id} symbol={token.symbol} />
              <Link to={poolPath(p.id)} className="button button--ghost button--sm">
                Open pool
              </Link>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function SmartMoneyIn() {
  const board = useAsync(loadBoard, []);
  const lps = useAsync(() => loadSmartLps(board.data), [board.data?.generatedAt], { enabled: Boolean(board.data) });
  const trending = useAsync(() => getTrending({ limit: 40 }), []);
  const ids = useMemo(() => (trending.data ? smartMoneyIds(trending.data.map((t) => t.id)) : null), [trending.data]);
  const market = useAsync(() => enrichTokens(ids), [ids?.join(',')], { enabled: Boolean(ids?.length) });
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Main in its fixed order; then Next and the rest, each by 24h volume.
  const rows = useMemo(() => {
    if (!market.data) return null;
    return market.data
      .map((m) => {
        const native = m.id === CONTRACTS.wrapNear;
        return { ...m, token: native ? { ...m.token, symbol: 'NEAR', icon: NATIVE_NEAR.icon || m.token.icon } : m.token, tier: tierOf(m.id) };
      })
      .sort((a, b) => a.tier - b.tier || (fixedRank(a.id) ?? 0) - (fixedRank(b.id) ?? 0) || (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
  }, [market.data]);

  const error = trending.error || market.error;
  if (error && !rows) return <ErrorNotice error={error} onRetry={trending.data ? market.reload : trending.reload} />;

  return (
    <div className="smi">
      <p className="slp-note muted small">
        {rows ? (
          <>
            {rows.length} Rhea tokens · Main in a set order, then Next and the rest by 24h volume · Smart LPs: wallets from the Smart LP board with
            liquidity in the token&apos;s CLMM pools now{lps.loading && !lps.data ? ' (reading…)' : ''} · ★ = profitable
          </>
        ) : (
          'Loading Rhea tokens…'
        )}
      </p>
      <section className="card smi-table">
        <div className="smi-row smi-row--head">
          <span>Token</span>
          <span>Age</span>
          <span>Price 24h</span>
          <span>MC</span>
          <span>Liquidity</span>
          <span>↓ Vol 24h</span>
          <span>Holders</span>
          <span>Smart LPs</span>
          <span title="What the Smart LP wallets hold in this token's pools">Smart LP value</span>
          <span />
        </div>
        {!rows
          ? Array.from({ length: 8 }, (_, i) => (
              <div className="smi-row" key={i}>
                <Skeleton width={150} />
                {Array.from({ length: 8 }, (__, j) => (
                  <Skeleton key={j} width={50} />
                ))}
                <span />
              </div>
            ))
          : rows.map((m, i) => {
              const smart = lps.data?.get(m.id) || NO_LPS;
              const isOpen = open.has(m.id);
              const best = smart.pools[0];
              const heading = i === 0 || rows[i - 1].tier !== m.tier;
              return (
                <div className={`smi-group ${isOpen ? 'smi-group--open' : ''} ${m.id === KINU_TOKEN ? 'smi-group--ours' : ''}`} key={m.id}>
                  {heading && <div className={`smi-tier smi-tier--${m.tier}`}>{TIER_TITLES[m.tier]}</div>}
                  <div className="smi-row" onClick={() => toggle(m.id)} role="button" tabIndex={0} aria-expanded={isOpen} onKeyDown={(e) => e.key === 'Enter' && toggle(m.id)}>
                    <span className="smi-row__token">
                      <span className="smi-caret" aria-hidden>
                        ▸
                      </span>
                      <TokenIcon token={m.token} size={30} />
                      <span>
                        <b>
                          {m.token.symbol}
                          {m.id === KINU_TOKEN && <em className="smi-ours">★ Our token</em>}
                        </b>
                        <small title={m.id}>{shortAccount(m.id, 14, 8)}</small>
                      </span>
                    </span>
                    <span data-label="Age">{m.createdAt ? formatAge(m.createdAt) : '—'}</span>
                    <span data-label="Price 24h" className="smi-price">
                      {m.price ? formatPrice(m.price) : '—'}
                      <Change value={m.change24h} />
                    </span>
                    <span data-label="MC">{m.marketCap ? usd(m.marketCap) : '—'}</span>
                    <span data-label="Liquidity">{usd(m.liquidityUsd)}</span>
                    <span data-label="Vol 24h">{usd(m.volume24hUsd)}</span>
                    <span data-label="Holders">{m.holders ? m.holders.toLocaleString() : '—'}</span>
                    <span data-label="Smart LPs">{lps.data ? <LpAvatars lps={smart.lps} profitable={smart.profitable} /> : <Skeleton width={40} />}</span>
                    <span data-label="Smart LP value">{usd(smart.valueUsd)}</span>
                    <span className="smi-row__actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="button button--outline button--sm"
                        onClick={() => navigate(best ? poolPath(best.poolId) : `/pools?q=${encodeURIComponent(m.id)}`)}
                        title={best ? 'The pool most Smart LPs are in' : `Rhea pools with ${m.token.symbol}`}
                      >
                        Open pool
                      </button>
                    </span>
                  </div>
                  {isOpen && <TokenPools token={{ id: m.id, symbol: m.token.symbol }} smart={smart} />}
                </div>
              );
            })}
        {rows && !rows.length && <EmptyState icon="◎" title="No tokens to show right now" />}
      </section>
    </div>
  );
}
