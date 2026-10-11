// Top-bar search (Meteora-style): "Search by token, CA, or pool address".
// Tokens come from the Rhea price list (symbol or contract), pools from the
// Rhea pool API (pools containing the matched tokens, or an exact pool id).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useClickOutside, useDebounced } from '../hooks.js';
import { navigate, poolPath } from '../router.jsx';
import { getPoolStats, searchPools } from '../lib/rhea.js';
import { getCachedToken, getTokens, priceOf, searchPriceList } from '../lib/tokens.js';
import { formatPercent, formatPrice, formatUsd, shortAccount } from '../lib/format.js';
import { NATIVE_NEAR } from '../config.js';
import { PairIcons, Spinner, TokenIcon } from './ui.jsx';

const looksLikeContract = (q) => /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(q) || /^[0-9a-f]{64}$/.test(q);

async function findPools(q, tokenIds) {
  if (q.includes('|')) {
    const stats = await getPoolStats(q);
    return stats ? [stats] : [{ id: q, label: 'CLMM', tokenIds: q.split('|').slice(0, 2), symbols: [], tvl: 0, apy: 0, farmApy: 0, feePercent: 0 }];
  }
  if (/^\d+$/.test(q)) {
    const stats = await getPoolStats(q);
    return stats ? [stats] : [];
  }
  if (!tokenIds.length) return [];
  const { list } = await searchPools({ tokenList: tokenIds.join(','), hideLow: false, limit: 30, sort: 'tvl' });
  const seen = new Set();
  return list
    .filter((p) => p.tokenIds.some((id) => tokenIds.includes(id)) && !seen.has(p.id) && seen.add(p.id))
    .slice(0, 6);
}

export default function GlobalSearch() {
  const { prices } = useApp();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const boxRef = useRef(null);
  const q = useDebounced(query.trim().toLowerCase(), 250);
  useClickOutside(boxRef, () => setOpen(false), open);

  // "/" focuses the search from anywhere (like Meteora).
  useEffect(() => {
    const onKey = (event) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const tokens = useMemo(() => {
    if (!q || q.includes('|') || /^\d+$/.test(q)) return [];
    const found = searchPriceList(prices, q, 6).map((t) => ({ id: t.id, symbol: t.symbol, price: t.price }));
    if ('near'.startsWith(q)) found.unshift({ id: NATIVE_NEAR.id, symbol: 'NEAR', price: priceOf(prices, NATIVE_NEAR.id) });
    if (looksLikeContract(q) && !found.some((t) => t.id === q)) found.unshift({ id: q, symbol: shortAccount(q, 10, 6), price: 0 });
    return found.slice(0, 6);
  }, [q, prices]);

  const tokenIdsForPools = useMemo(() => tokens.filter((t) => t.id !== NATIVE_NEAR.id).slice(0, 3).map((t) => t.id), [tokens]);
  const pools = useAsync(() => findPools(q, tokenIdsForPools.length ? tokenIdsForPools : q === 'near' ? ['wrap.near'] : []), [q, tokenIdsForPools.join(',')], {
    enabled: Boolean(q)
  });

  // Icons for everything on screen.
  const [, setVersion] = useState(0);
  const iconIds = useMemo(
    () => [...new Set([...tokens.map((t) => t.id), ...(pools.data || []).flatMap((p) => p.tokenIds)])].filter((id) => id !== NATIVE_NEAR.id),
    [tokens, pools.data]
  );
  useEffect(() => {
    if (!iconIds.length) return;
    let alive = true;
    getTokens(iconIds).then(() => alive && setVersion((v) => v + 1));
    return () => {
      alive = false;
    };
  }, [iconIds]);
  const meta = (id, fallbackSymbol) => (id === NATIVE_NEAR.id ? NATIVE_NEAR : getCachedToken(id) || { id, symbol: fallbackSymbol || id.slice(0, 4) });

  const items = [
    ...tokens.map((t) => ({ kind: 'token', key: `t-${t.id}`, token: t })),
    ...(pools.data || []).map((p) => ({ kind: 'pool', key: `p-${p.id}`, pool: p }))
  ];

  useEffect(() => setActive(0), [q]);

  const choose = (item) => {
    if (!item) return;
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    if (item.kind === 'pool') navigate(poolPath(item.pool.id));
    else navigate(item.token.id === NATIVE_NEAR.id ? '/swap' : `/swap?from=near&to=${encodeURIComponent(item.token.id)}`);
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(items[active]);
    } else if (event.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  let index = -1;
  const showPanel = open && query.trim().length > 0;

  return (
    <div className="gsearch" ref={boxRef}>
      <div className="gsearch__field">
        <span aria-hidden>⌕</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search by token, CA, or pool address"
          spellCheck={false}
          aria-label="Search tokens and pools"
        />
        <kbd>/</kbd>
      </div>

      {showPanel && (
        <div className="gsearch__panel" role="listbox">
          {tokens.length > 0 && <div className="gsearch__group">Tokens</div>}
          {tokens.map((t) => {
            index += 1;
            const i = index;
            const m = meta(t.id, t.symbol);
            return (
              <button
                key={`t-${t.id}`}
                type="button"
                className={`gsearch__item ${active === i ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose({ kind: 'token', token: t })}
              >
                <TokenIcon token={m} size={28} />
                <span className="gsearch__main">
                  <strong>{m.symbol || t.symbol}</strong>
                  <small>{t.id === NATIVE_NEAR.id ? 'Native NEAR' : shortAccount(t.id, 16, 10)}</small>
                </span>
                <span className="gsearch__side">
                  <strong>{t.price > 0 ? formatPrice(t.price) : ''}</strong>
                  <small>Swap →</small>
                </span>
              </button>
            );
          })}

          {(pools.loading || (pools.data || []).length > 0) && (
            <div className="gsearch__group">
              Pools {pools.loading && <Spinner size={10} />}
            </div>
          )}
          {(pools.data || []).map((p) => {
            index += 1;
            const i = index;
            const toks = p.tokenIds.map((id, k) => meta(id, p.symbols?.[k]));
            return (
              <button
                key={`p-${p.id}`}
                type="button"
                className={`gsearch__item ${active === i ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose({ kind: 'pool', pool: p })}
              >
                <PairIcons tokens={toks} size={24} />
                <span className="gsearch__main">
                  <strong>{toks.map((t) => t.symbol).join(' / ')}</strong>
                  <small>
                    <span className={`kind kind--${String(p.label).toLowerCase()}`}>{p.label}</span>
                    {p.feePercent > 0 && ` ${formatPercent(p.feePercent, p.feePercent < 0.1 ? 3 : 2)} fee`}
                  </small>
                </span>
                <span className="gsearch__side">
                  <strong>{p.tvl ? formatUsd(p.tvl) : ''}</strong>
                  <small>{p.apy || p.farmApy ? `APR ${formatPercent(p.apy + p.farmApy)}` : ''}</small>
                </span>
              </button>
            );
          })}

          {!pools.loading && !items.length && q && <div className="gsearch__empty">No tokens or pools match “{query.trim()}”.</div>}
        </div>
      )}
    </div>
  );
}
