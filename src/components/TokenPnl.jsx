// Token PnL for the portfolio's Tokens tab: average buy price, unrealized and
// realized PnL per token from the account's own trades (see lib/tokenPnl.js).

import { useMemo, useState } from 'react';
import { useAsync } from '../hooks.js';
import { getTokens } from '../lib/tokens.js';
import { loadNearlyPnl, loadTokenPnl, replayTrades } from '../lib/tokenPnl.js';
import { formatPrice, formatUsd } from '../lib/format.js';
import { CONTRACTS, NATIVE_NEAR } from '../config.js';
import { PnlValue } from './LpPnl.jsx';
import { Skeleton, Spinner, TokenIcon } from './ui.jsx';

/** NEAR is the currency trades are paid in (and pays gas / storage), so it has no PnL of its own. */
export const isBaseAsset = (id) => id === NATIVE_NEAR.id || id === CONTRACTS.wrapNear;

/**
 * Two sources, merged per token:
 *   nearly.trade's PnL API — its launchpad tokens (authoritative, instant)
 *   the on-chain trade replay — every other token (USDC, QTC, RHEA, …)
 */
export function useTokenPnl(account, prices) {
  const nearly = useAsync(() => loadNearlyPnl(account), [account], { enabled: Boolean(account), refreshMs: 60_000 });
  const raw = useAsync(() => loadTokenPnl(account, getTokens), [account], { enabled: Boolean(account) });
  const book = useMemo(() => {
    if (!raw.data) return null;
    const { txs, tokens, history } = raw.data;
    const meta = (id) => tokens[id] || { id, symbol: id.slice(0, 6), decimals: 0 };
    return replayTrades(txs, meta, history, prices);
  }, [raw.data, prices]);
  return {
    book,
    nearly: nearly.data || null,
    tokens: raw.data?.tokens || {},
    complete: raw.data?.complete ?? true,
    loading: raw.loading && !raw.data,
    nearlyLoading: nearly.loading && !nearly.data,
    error: raw.error,
    reload: () => {
      raw.reload();
      nearly.reload();
    }
  };
}

/**
 * nearly.trade entry whose traded holding (`held`) is this wallet balance. nearly.trade's
 * unrealized figure only covers `held`; balance that arrived otherwise (e.g. back from an LP
 * position) is left to the on-chain replay.
 */
const nearlyHeld = (pnl, row) => {
  const n = pnl.nearly?.get(row.id);
  return n && n.held > 0 && Math.abs(n.held - row.amount) <= row.amount * 0.02 ? n : null;
};

/** PnL of one wallet row: { avg, pnl, pct, realized, partial, source } or null when unknown. */
export function rowPnl(pnl, row) {
  if (isBaseAsset(row.id)) return null;
  const n = nearlyHeld(pnl, row);
  if (n) {
    return {
      avg: n.bought > 0 ? n.basis_usd / n.bought : null,
      pnl: n.unrealized_usd,
      pct: Number.isFinite(n.roi) ? n.roi * 100 : null,
      realized: n.realized_usd,
      source: 'nearly.trade'
    };
  }
  const nearlyRealized = pnl.nearly?.get(row.id)?.realized_usd;
  if (!pnl.book) return nearlyRealized !== undefined ? { realized: nearlyRealized } : null;
  const s = pnl.book.get(row.id);
  if (!s || s.qty <= 0 || s.cost <= 0) return s || nearlyRealized !== undefined ? { realized: nearlyRealized ?? s.realized } : null;
  const avg = s.cost / s.qty;
  return {
    avg,
    pnl: row.amount * (row.price - avg),
    pct: row.price > 0 ? (row.price / avg - 1) * 100 : null,
    realized: nearlyRealized ?? s.realized,
    // Part of the balance arrived in ways the history doesn't show (older than the loaded range).
    partial: s.qty < row.amount * 0.98,
    source: 'on-chain'
  };
}

/** Realized PnL per token across both sources (nearly.trade wins for its tokens). */
function realizedByToken(pnl) {
  const out = new Map();
  pnl.book?.forEach((s, id) => {
    if (!isBaseAsset(id)) out.set(id, s.realized);
  });
  pnl.nearly?.forEach((n, id) => out.set(id, n.realized_usd || 0));
  return out;
}

export function TokenPnlSummary({ pnl, rows }) {
  const totals = useMemo(() => {
    if (!pnl.book && !pnl.nearly) return null;
    const unrealized = rows.reduce((s, r) => s + (rowPnl(pnl, r)?.pnl || 0), 0);
    let realized = 0;
    realizedByToken(pnl).forEach((v) => {
      realized += v;
    });
    return { unrealized, realized, total: unrealized + realized };
  }, [pnl, rows]);

  const cell = (label, value) => (
    <div className="token-pnl__stat">
      <span>{label}</span>
      {totals ? <PnlValue value={value} /> : pnl.loading || pnl.nearlyLoading ? <Skeleton width={80} height={18} /> : <span className="muted">—</span>}
    </div>
  );

  return (
    <div className="token-pnl">
      {cell('Token PnL', totals?.total)}
      {cell('Unrealized', totals?.unrealized)}
      {cell('Realized', totals?.realized)}
      <span className="token-pnl__note muted small">
        {pnl.error ? (
          <>
            {pnl.nearly ? 'nearly.trade tokens shown · other tokens: ' : ''}
            {pnl.error.message}{' '}
            <button type="button" className="link-button" onClick={pnl.reload}>
              Retry
            </button>
          </>
        ) : pnl.loading ? (
          <>
            <Spinner size={11} /> Reading trade history…
          </>
        ) : (
          `Average buy price · nearly.trade + on-chain swaps${pnl.complete ? '' : ' (last 3,000 transactions)'}`
        )}
      </span>
    </div>
  );
}

/** Tokens bought and sold out completely, with their realized PnL. */
export function SoldTokens({ pnl, heldIds }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => {
    const list = new Map();
    pnl.book?.forEach((s, id) => {
      if (isBaseAsset(id) || heldIds.has(id) || (!s.bought && !s.sold)) return;
      list.set(id, { id, token: pnl.tokens[id] || { id, symbol: id.slice(0, 8), decimals: 0 }, ...s });
    });
    // nearly.trade's numbers replace the on-chain replay for its own tokens.
    pnl.nearly?.forEach((n, id) => {
      if (heldIds.has(id) || n.bag > 0) return;
      list.set(id, {
        id,
        token: { id, symbol: n.symbol, icon: n.icon, decimals: 0 },
        bought: n.basis_usd,
        sold: n.return_usd,
        trades: (n.buys || 0) + (n.sells || 0),
        realized: n.realized_usd ?? n.pnl_usd
      });
    });
    return [...list.values()].sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized));
  }, [pnl, heldIds]);

  if (!rows.length) return null;
  return (
    <section className="card asset-table sold-tokens">
      <button type="button" className="sold-tokens__toggle" onClick={() => setOpen((v) => !v)}>
        <span className={`lp-expand ${open ? 'lp-expand--open' : ''}`}>▸</span>
        Sold tokens <span className="tab__count">{rows.length}</span>
        <span className="sold-tokens__total">
          <PnlValue value={rows.reduce((s, r) => s + r.realized, 0)} />
        </span>
      </button>
      {open && (
        <>
          <div className="asset-row asset-row--head">
            <span>Asset</span>
            <span>Bought</span>
            <span>Sold</span>
            <span>Trades</span>
            <span>Realized PnL</span>
          </div>
          {rows.map((r) => (
            <div className="asset-row" key={r.id}>
              <span className="asset-row__token">
                <TokenIcon token={r.token} size={28} />
                <span>
                  <strong>{r.token.symbol}</strong>
                  <small>{r.id.length > 28 ? `${r.id.slice(0, 14)}…` : r.id}</small>
                </span>
              </span>
              <span data-label="Bought">{formatUsd(r.bought)}</span>
              <span data-label="Sold">{formatUsd(r.sold)}</span>
              <span data-label="Trades">{r.trades}</span>
              <span data-label="Realized PnL">
                <PnlValue value={r.realized} pct={r.bought > 0 ? (r.realized / r.bought) * 100 : null} />
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

export function AvgCell({ info, loading }) {
  if (info?.avg) return <span>{formatPrice(info.avg)}</span>;
  return loading ? <Spinner size={12} /> : <span className="muted">—</span>;
}
