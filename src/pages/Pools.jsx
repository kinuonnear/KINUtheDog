import { useEffect, useMemo, useState } from 'react';
import { useAsync, useDebounced } from '../hooks.js';
import { Link, navigate, poolPath } from '../router.jsx';
import { POOL_SORTS, POOL_TYPES, searchPools } from '../lib/rhea.js';
import { getCachedToken, getTokens } from '../lib/tokens.js';
import { formatPercent, formatUsd } from '../lib/format.js';
import { ErrorNotice, PairIcons, Skeleton, Tabs } from '../components/ui.jsx';

const PAGE_SIZE = 25;

/** Lazily resolve token metadata (icons) for the visible pools. */
export function usePoolTokens(pools) {
  const ids = useMemo(() => [...new Set((pools || []).flatMap((p) => p.tokenIds))], [pools]);
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!ids.length) return;
    let alive = true;
    getTokens(ids).then(() => alive && setVersion((v) => v + 1));
    return () => {
      alive = false;
    };
  }, [ids]);
  return (pool) =>
    pool.tokenIds.map((id, i) => getCachedToken(id) || { id, symbol: pool.symbols?.[i] || id.slice(0, 4) });
}

export function PoolRow({ pool, tokensOf }) {
  const tokens = tokensOf(pool);
  const totalApr = pool.apy + pool.farmApy;
  return (
    <Link to={poolPath(pool.id)} className="pool-row">
      <span className="pool-row__pair">
        <PairIcons tokens={tokens} size={30} />
        <span>
          <strong>{tokens.map((t) => t.symbol).join(' / ')}</strong>
          <small>
            <span className={`kind kind--${pool.label.toLowerCase()}`}>{pool.label}</span>
            {pool.feePercent > 0 && <span>{formatPercent(pool.feePercent, pool.feePercent < 0.1 ? 3 : 2)} fee</span>}
            {pool.isFarm && <span className="kind kind--farm">Farm</span>}
          </small>
        </span>
      </span>
      <span className="pool-row__num" data-label="TVL">
        {formatUsd(pool.tvl)}
      </span>
      <span className="pool-row__num" data-label="Volume 24h">
        {formatUsd(pool.volume24h)}
      </span>
      <span className="pool-row__num pool-row__apr" data-label="APR">
        {formatPercent(totalApr)}
      </span>
    </Link>
  );
}

export function PoolRowsSkeleton({ rows = 8 }) {
  return Array.from({ length: rows }, (_, i) => (
    <div className="pool-row pool-row--skeleton" key={i}>
      <Skeleton width="45%" height={18} />
      <Skeleton width={70} />
      <Skeleton width={70} />
      <Skeleton width={50} />
    </div>
  ));
}

export default function Pools() {
  const [type, setType] = useState('all');
  const [sort, setSort] = useState('tvl');
  const [order, setOrder] = useState('desc');
  const [hideLow, setHideLow] = useState(true);
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState(1);
  const q = useDebounced(query.trim().toLowerCase(), 300);

  // With a search term we fetch a wider set and filter client-side by symbol/contract.
  const limit = q ? 300 : PAGE_SIZE * pages;
  const result = useAsync(
    () => searchPools({ type, sort, order, limit, offset: 0, hideLow: q ? false : hideLow }),
    [type, sort, order, limit, hideLow, Boolean(q)],
    { refreshMs: 60_000 }
  );

  useEffect(() => setPages(1), [type, sort, order, hideLow]);

  const pools = useMemo(() => {
    const list = result.data?.list || [];
    if (!q) return list;
    return list
      .filter(
        (p) =>
          p.id === q ||
          p.symbols.some((s) => s.toLowerCase().includes(q)) ||
          p.tokenIds.some((id) => id.toLowerCase().includes(q))
      )
      .slice(0, 100);
  }, [result.data, q]);

  const tokensOf = usePoolTokens(pools);
  const total = result.data?.total ?? 0;

  const toggleSort = (key) => {
    if (sort === key) setOrder(order === 'desc' ? 'asc' : 'desc');
    else {
      setSort(key);
      setOrder('desc');
    }
  };

  const sortHeader = (key, label) => (
    <button type="button" className={`th-sort ${sort === key ? 'th-sort--active' : ''}`} onClick={() => toggleSort(key)}>
      {label}
      {sort === key && <span aria-hidden>{order === 'desc' ? ' ↓' : ' ↑'}</span>}
    </button>
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Rhea Finance · NEAR</span>
          <h1>Liquidity pools</h1>
          <p>Live TVL, volume and APR for every Rhea pool. Provide liquidity to earn trading fees.</p>
        </div>
      </header>

      <div className="toolbar">
        <Tabs tabs={POOL_TYPES} value={type} onChange={setType} />
        <div className="toolbar__right">
          <div className="search-field">
            <span aria-hidden>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search token, symbol or pool id"
              spellCheck={false}
            />
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={hideLow} onChange={(e) => setHideLow(e.target.checked)} disabled={Boolean(q)} />
            Hide low TVL
          </label>
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
            {POOL_SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                Sort: {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ErrorNotice error={result.error} onRetry={result.reload} />

      <div className="card pool-table">
        <div className="pool-table__head">
          <span>Pool</span>
          {sortHeader('tvl', 'TVL')}
          {sortHeader('volume_24h', 'Volume 24h')}
          {sortHeader('apy', 'APR')}
        </div>
        {result.loading && !result.data ? (
          <PoolRowsSkeleton />
        ) : pools.length ? (
          pools.map((pool) => <PoolRow key={pool.id} pool={pool} tokensOf={tokensOf} />)
        ) : (
          <div className="pool-table__empty">
            {q ? (
              <>
                No pools match “{query}”.{' '}
                {/^\d+$/.test(q) && (
                  <button type="button" className="link-button" onClick={() => navigate(poolPath(q))}>
                    Open pool #{q}
                  </button>
                )}
              </>
            ) : (
              'No pools found.'
            )}
          </div>
        )}
      </div>

      {!q && pools.length < total && pools.length >= PAGE_SIZE * pages && (
        <div className="center">
          <button type="button" className="button button--ghost" onClick={() => setPages((p) => p + 1)} disabled={result.loading}>
            {result.loading ? 'Loading…' : `Load more (${pools.length} of ${total.toLocaleString()})`}
          </button>
        </div>
      )}
    </div>
  );
}
