import { useEffect, useMemo, useState } from 'react';
import { Modal, Spinner, TokenIcon } from './ui.jsx';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced } from '../hooks.js';
import { getCachedToken, getToken, getWhitelistedTokens, priceOf, searchPriceList } from '../lib/tokens.js';
import { formatAmount, formatUsd, shortAccount, toNumber } from '../lib/format.js';
import { NATIVE_NEAR, PINNED_TOKENS } from '../config.js';

const LIST_LIMIT = 60;
const looksLikeAccount = (q) => /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(q) || /^[0-9a-f]{64}$/.test(q);

function useTokenMeta(id, fallback) {
  const [meta, setMeta] = useState(() => getCachedToken(id) || fallback);
  useEffect(() => {
    let alive = true;
    getToken(id).then((m) => alive && m && setMeta(m));
    return () => {
      alive = false;
    };
  }, [id]);
  return meta;
}

function TokenRow({ id, fallback, verified, onPick, selected }) {
  const { balances, prices } = useApp();
  const meta = useTokenMeta(id, fallback);
  const raw = balances[id];
  const amount = raw && meta?.decimals !== undefined ? toNumber(raw, meta.decimals) : 0;
  const usd = amount * priceOf(prices, id);

  return (
    <button
      type="button"
      className={`token-row ${selected ? 'token-row--selected' : ''}`}
      onClick={() => onPick(id)}
    >
      <TokenIcon token={meta} size={34} />
      <span className="token-row__main">
        <strong>
          {meta?.symbol || '…'}
          {verified && <span className="badge badge--verified" title="Whitelisted on Rhea">✓</span>}
        </strong>
        <small>{id === NATIVE_NEAR.id ? 'Native NEAR' : shortAccount(id, 14, 10)}</small>
      </span>
      {amount > 0 && (
        <span className="token-row__balance">
          <strong>{formatAmount(amount)}</strong>
          <small>{usd > 0 ? formatUsd(usd) : ''}</small>
        </span>
      )}
    </button>
  );
}

export default function TokenPicker({ title, selectedId, onSelect, onClose }) {
  const { prices, balances } = useApp();
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(null);
  const [pickError, setPickError] = useState('');
  const q = useDebounced(query.trim().toLowerCase(), 200);

  const whitelist = useAsync(() => getWhitelistedTokens(), []);
  const whitelistSet = useMemo(() => new Set(whitelist.data || []), [whitelist.data]);

  const rows = useMemo(() => {
    if (q) {
      const results = searchPriceList(prices, q, LIST_LIMIT).map((r) => ({
        id: r.id,
        fallback: { id: r.id, symbol: r.symbol, decimals: r.decimals }
      }));
      if ('near'.startsWith(q)) results.unshift({ id: NATIVE_NEAR.id });
      return results;
    }
    // Held tokens first (by USD value), then pinned, then Rhea-whitelisted by liquidity signal.
    const held = Object.entries(balances)
      .filter(([, raw]) => raw && raw !== '0')
      .map(([id, raw]) => {
        const info = prices?.get(id);
        const decimals = getCachedToken(id)?.decimals ?? info?.decimals ?? 0;
        return { id, usd: toNumber(raw, decimals) * (info?.price || 0) };
      })
      .sort((a, b) => b.usd - a.usd)
      .map((h) => h.id);
    const whitelisted = [...(whitelist.data || [])].sort(
      (a, b) => (priceOf(prices, b) > 0) - (priceOf(prices, a) > 0)
    );
    const ids = [...new Set([...held, ...PINNED_TOKENS, ...whitelisted])];
    return ids.slice(0, LIST_LIMIT).map((id) => {
      const info = prices?.get(id);
      return { id, fallback: info ? { id, symbol: info.symbol, decimals: info.decimals } : { id } };
    });
  }, [q, prices, balances, whitelist.data]);

  const showContractOption = q && looksLikeAccount(q) && !rows.some((r) => r.id === q);

  const pick = async (id) => {
    setPicking(id);
    setPickError('');
    try {
      const token = await getToken(id);
      if (!token || !Number.isFinite(token.decimals)) throw new Error('Not a valid NEAR fungible token.');
      onSelect(token);
      onClose();
    } catch (error) {
      setPickError(error?.message || 'Could not read token contract.');
    } finally {
      setPicking(null);
    }
  };

  return (
    <Modal title={title} subtitle="Search by name, symbol or paste a contract address" onClose={onClose}>
      <div className="search-field search-field--lg">
        <span aria-hidden>⌕</span>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="NEAR, USDC, token.contract.near…"
          spellCheck={false}
        />
        {picking && <Spinner />}
      </div>

      {!q && (
        <div className="chip-row">
          {PINNED_TOKENS.slice(0, 6).map((id) => (
            <PinnedChip key={id} id={id} onPick={pick} active={id === selectedId} />
          ))}
        </div>
      )}

      {pickError && <div className="notice notice--error">{pickError}</div>}

      <div className="token-list">
        {showContractOption && (
          <button type="button" className="token-row token-row--contract" onClick={() => pick(q)}>
            <span className="token-icon token-icon--fallback" style={{ width: 34, height: 34 }}>
              +
            </span>
            <span className="token-row__main">
              <strong>Import token</strong>
              <small>{shortAccount(q, 18, 12)}</small>
            </span>
          </button>
        )}
        {rows.map((row) => (
          <TokenRow
            key={row.id}
            id={row.id}
            fallback={row.fallback}
            verified={whitelistSet.has(row.id) || row.id === NATIVE_NEAR.id}
            selected={row.id === selectedId}
            onPick={pick}
          />
        ))}
        {!rows.length && !showContractOption && (
          <div className="token-list__empty">No tokens match “{query}”. Paste the contract address to import it.</div>
        )}
      </div>
    </Modal>
  );
}

function PinnedChip({ id, onPick, active }) {
  const meta = useTokenMeta(id, { id });
  return (
    <button type="button" className={`chip ${active ? 'chip--active' : ''}`} onClick={() => onPick(id)}>
      <TokenIcon token={meta} size={18} />
      {meta?.symbol || '…'}
    </button>
  );
}
