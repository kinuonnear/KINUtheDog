// Intear DEX pools in KINU (/intear-dex): a read-only preview of the Plach AMM pools on Intear DEX
// — pair, fees, TVL, volume, APY and reserves — each linking to the pool on dex.intea.rs.
// Demo for the KINU × Intear conversation: no transactions; adding liquidity from KINU comes only
// after Intear shares its LP flow and the contract's audit status.

import { useMemo, useState } from 'react';
import { useAsync, useDebounced } from '../hooks.js';
import { fetchIntearPools, INTEAR_POOL_TYPES } from '../lib/intearDex.js';
import { getTokens } from '../lib/tokens.js';
import { formatAmount, formatPercent, formatUsd } from '../lib/format.js';
import { ErrorNotice, PairIcons, Skeleton } from '../components/ui.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import PoolSourceTabs from '../components/PoolSourceTabs.jsx';
import '../pools.css';
import '../intear.css';
import PageIcon from '../components/PageIcon.jsx';

const PAGE = 30;
const LOW_TVL = 1_000;
const SORTS = [
  { key: 'tvl', label: 'Liquidity' },
  { key: 'volume24h', label: '24h volume' },
  { key: 'volume7d', label: '7d volume' },
  { key: 'apy', label: 'APY' }
];
const K = { compactAbove: 1e3 };

export default function IntearPools() {
  const pools = useAsync(fetchIntearPools, [], { refreshMs: 120_000 });
  const [kind, setKind] = useState('Public');
  const [sort, setSort] = useState('tvl');
  const [hideLow, setHideLow] = useState(true);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const q = useDebounced(query.trim().toLowerCase(), 200);

  const all = pools.data || [];
  const counts = useMemo(() => {
    const c = { all: all.length };
    all.forEach((p) => {
      c[p.kind] = (c[p.kind] || 0) + 1;
    });
    return c;
  }, [all]);
  const totals = useMemo(
    () => all.reduce((t, p) => ({ tvl: t.tvl + p.tvl, v24: t.v24 + p.volume24h, v7: t.v7 + p.volume7d }), { tvl: 0, v24: 0, v7: 0 }),
    [all]
  );

  // Token metadata for the rows on screen only (a few hundred pools would be a lot of reads).
  const filtered = useMemo(() => {
    const list = all.filter((p) => (kind === 'all' || p.kind === kind) && (!hideLow || p.tvl >= LOW_TVL));
    return [...list].sort((a, b) => b[sort] - a[sort]);
  }, [all, kind, hideLow, sort]);
  const idsKey = filtered.map((p) => p.tokens.join(',')).join('|');
  const meta = useAsync(() => getTokens(filtered.flatMap((p) => p.tokens)), [idsKey], { enabled: filtered.length > 0 });
  const tokenOf = (id) => meta.data?.[id] || { id, symbol: id === 'near' ? 'NEAR' : id.split('.')[0].slice(0, 10).toUpperCase(), decimals: 0 };
  const searched = q
    ? filtered.filter((p) => p.tokens.some((id) => id.toLowerCase().includes(q) || tokenOf(id).symbol?.toLowerCase().includes(q)) || String(p.id) === q)
    : filtered;
  const rows = searched.slice(0, shown);

  return (
    <div className="page page--discover page--pools page--intear">
      <header className="pt-hero">
        <FlowLines />
        <h1 className="pt-title">
          <PageIcon name="pools" />
          Pools
        </h1>
        <p>Every pool on NEAR, sorted by what it pays LPs.</p>
        <PoolSourceTabs active="intear" intear={pools.data ? { pools: all.length, tvl: totals.tvl } : undefined} />
        <p>Plach AMM pools on Intear DEX: fees, liquidity, volume and APY at a glance.</p>
        <a className="pt-start" href="https://dex.intea.rs/pools" target="_blank" rel="noopener noreferrer">
          Open Intear DEX
          <span className="pt-start__arrow" aria-hidden>
            ↗
          </span>
        </a>
      </header>

      <div className="ix-stats">
        <div>
          <span>Pools</span>
          <strong>{pools.data ? all.length : '—'}</strong>
          <small>
            {counts.Public || 0} public · {counts.Private || 0} private · {counts.Launch || 0} launch
          </small>
        </div>
        <div>
          <span>Total liquidity</span>
          <strong>{pools.data ? formatUsd(totals.tvl, K) : '—'}</strong>
        </div>
        <div>
          <span>24h volume</span>
          <strong>{pools.data ? formatUsd(totals.v24, K) : '—'}</strong>
        </div>
        <div>
          <span>7d volume</span>
          <strong>{pools.data ? formatUsd(totals.v7, K) : '—'}</strong>
        </div>
      </div>

      <div className="ix-controls">
        <div className="segmented" role="tablist" aria-label="Pool kind">
          {[...INTEAR_POOL_TYPES, { key: 'all', label: 'All', hint: 'Every pool' }].map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={kind === t.key}
              className={kind === t.key ? 'active' : ''}
              onClick={() => {
                setKind(t.key);
                setShown(PAGE);
              }}
              title={t.hint}
            >
              {t.label} <small>{counts[t.key] ?? 0}</small>
            </button>
          ))}
        </div>
        <input className="ix-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search token, contract or pool #" aria-label="Search pools" />
        <label className="ix-sort">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ix-check">
          <input type="checkbox" checked={hideLow} onChange={(e) => setHideLow(e.target.checked)} /> Hide under $1K
        </label>
      </div>

      {pools.error && !pools.data && <ErrorNotice error={pools.error} onRetry={pools.reload} />}
      {!pools.data && !pools.error && <Skeleton height={320} radius={16} />}

      {pools.data && (
        <div className="ix-table" role="table" aria-label="Intear DEX pools">
          <div className="ix-row ix-row--head" role="row">
            <span>Pool</span>
            <span>Fee</span>
            <span>Liquidity</span>
            <span>24h volume</span>
            <span>7d volume</span>
            <span>APY (7d avg)</span>
            <span>Reserves</span>
            <span />
          </div>
          {rows.map((p) => {
            const tokens = p.tokens.map(tokenOf);
            return (
              <div className="ix-row" role="row" key={p.id}>
                <span className="ix-pair" data-label="Pool">
                  <PairIcons tokens={tokens} size={26} />
                  <span>
                    <strong>{tokens.map((t) => t.symbol).join(' / ')}</strong>
                    <small>
                      #{p.id} · <em className={`ix-kind ix-kind--${p.kind.toLowerCase()}`}>{p.type === 'LaunchV2' ? 'Launch v2' : p.type}</em>
                    </small>
                  </span>
                </span>
                <span data-label="Fee" title={`Pool ${formatPercent(p.fees.pool)} · protocol ${formatPercent(p.fees.protocol)}${p.fees.creator ? ` · creator ${formatPercent(p.fees.creator)}` : ''}`}>
                  <strong>{formatPercent(p.fees.pool + p.fees.creator)}</strong>
                  {p.fees.protocol > 0 && <small>+{formatPercent(p.fees.protocol)} protocol</small>}
                </span>
                <span data-label="Liquidity">
                  <strong>{formatUsd(p.tvl, K)}</strong>
                </span>
                <span data-label="24h volume">{formatUsd(p.volume24h, K)}</span>
                <span data-label="7d volume">{formatUsd(p.volume7d, K)}</span>
                <span data-label="APY (7d avg)" className={p.apy > 0 ? 'up' : 'muted'}>
                  {p.apy > 0 ? formatPercent(p.apy) : '—'}
                </span>
                <span className="ix-reserves" data-label="Reserves">
                  {tokens.map((t, i) => (
                    <small key={t.id}>
                      {t.decimals ? formatAmount(Number(p.balances[i]) / 10 ** t.decimals) : '…'} {t.symbol}
                    </small>
                  ))}
                </span>
                <span className="ix-actions">
                  {/* Liquidity is added on Intear's own site: the Intear DEX contract is not audited yet. */}
                  <a className="button button--outline button--sm" href={p.url} target="_blank" rel="noopener noreferrer">
                    {p.kind === 'Public' ? '+ Add liquidity on Intear ↗' : 'View ↗'}
                  </a>
                </span>
              </div>
            );
          })}
          {!rows.length && <p className="muted ix-empty">No pools match.</p>}
          {searched.length > shown && (
            <button type="button" className="button button--outline ix-more" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({searched.length - shown} left)
            </button>
          )}
        </div>
      )}

      <p className="ix-note">
        Data: Intear DEX (dex.intear.near, Plach AMM), refreshed every 2 minutes. Read-only preview — nothing here sends a transaction. Liquidity is
        added on Intear&apos;s own site (dex.intea.rs); the Intear DEX contract is not audited yet. Swaps on KINU already route through Intear
        DEX pools when they give the best price.
      </p>
    </div>
  );
}
