// "Sweep dust" button + modal on the portfolio's Tokens tab (lib/dust.js).

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { buildDustTransactions, DUST_LIMITS, DUST_TARGETS, dustRows, quoteDust } from '../lib/dust.js';
import { getToken } from '../lib/tokens.js';
import { NATIVE_NEAR } from '../config.js';
import { formatAmount, formatRawAmount, formatUsd } from '../lib/format.js';
import { Modal, Spinner, TokenIcon } from './ui.jsx';

function SweepModal({ rows, onClose, onDone }) {
  const { accountId, slippage, execute } = useApp();
  const [target, setTarget] = useState(NATIVE_NEAR.id);
  const [limit, setLimit] = useState(1);
  const [targetToken, setTargetToken] = useState(NATIVE_NEAR);
  const [quotes, setQuotes] = useState(null); // [{ row, quote } | { row, error }]
  const [progress, setProgress] = useState(null);
  const [off, setOff] = useState(() => new Set()); // unticked token ids
  const [submitting, setSubmitting] = useState(false);

  const candidates = useMemo(() => dustRows(rows, { target, limitUsd: limit }), [rows, target, limit]);
  const key = `${target}:${candidates.map((r) => r.id).join(',')}`;

  useEffect(() => {
    let alive = true;
    setQuotes(null);
    setProgress(null);
    (async () => {
      const tokenOut = target === NATIVE_NEAR.id ? NATIVE_NEAR : await getToken(target);
      if (!alive) return;
      setTargetToken(tokenOut);
      if (!candidates.length) return setQuotes([]);
      const result = await quoteDust({
        rows: candidates,
        targetToken: tokenOut,
        slippage,
        user: accountId,
        onProgress: (done, total) => alive && setProgress([done, total])
      });
      if (alive) setQuotes(result);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, slippage, accountId]);

  const chosen = (quotes || []).filter((q) => q.quote && !off.has(q.row.id));
  const totalOut = chosen.reduce((s, q) => s + Number(q.quote.amountOut) / 10 ** targetToken.decimals, 0);
  const totalUsd = chosen.reduce((s, q) => s + q.row.usd, 0);

  const toggle = (id) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sweep = async () => {
    setSubmitting(true);
    // Fresh quotes at signing time: dust swaps are small, but prices still move.
    const ok = await execute(
      async () => {
        const fresh = await quoteDust({ rows: chosen.map((q) => q.row), targetToken, slippage, user: accountId });
        return buildDustTransactions({ items: fresh.filter((q) => q.quote), targetToken, accountId });
      },
      { pending: `Sweeping ${chosen.length} tokens into ${targetToken.symbol}`, success: 'Dust swept' }
    );
    setSubmitting(false);
    if (ok) {
      onDone?.();
      onClose();
    }
  };

  return (
    <Modal title="Sweep dust" subtitle="Swap small balances into one token, in one wallet request." onClose={onClose} width={520}>
      <div className="liq-form sweep">
        <div className="sweep__controls">
          <div className="rebalance__field">
            <span className="eyebrow">Into</span>
            <div className="segmented segmented--full">
              {DUST_TARGETS.map((t) => (
                <button key={t.key} type="button" className={target === t.key ? 'active' : ''} onClick={() => setTarget(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rebalance__field">
            <span className="eyebrow">Balances under</span>
            <div className="segmented segmented--full">
              {DUST_LIMITS.map((l) => (
                <button key={l} type="button" className={limit === l ? 'active' : ''} onClick={() => setLimit(l)}>
                  {l < 1 ? `${l.toFixed(2)}` : `${l}`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!candidates.length ? (
          <p className="muted">No balances under {formatUsd(limit)} to sweep. KINU, NEAR and wNEAR are never swept.</p>
        ) : !quotes ? (
          <div className="rebalance__loading">
            <Spinner size={14} /> Finding routes{progress ? ` · ${progress[0]}/${progress[1]}` : '…'}
          </div>
        ) : (
          <ul className="sweep__list">
            {quotes.map(({ row, quote, error }) => (
              <li key={row.id} className={quote ? '' : 'sweep__row--skip'}>
                <label>
                  <input type="checkbox" checked={Boolean(quote) && !off.has(row.id)} disabled={!quote} onChange={() => toggle(row.id)} />
                  <TokenIcon token={row.token} size={22} />
                  <span className="sweep__token">
                    <strong>{row.token.symbol}</strong>
                    <small>
                      {formatAmount(row.amount)} · {formatUsd(row.usd)}
                    </small>
                  </span>
                </label>
                <span className="sweep__out">
                  {quote ? (
                    <>
                      ≈ {formatRawAmount(quote.amountOut, targetToken.decimals)} {targetToken.symbol}
                    </>
                  ) : (
                    <small className="muted">{/route|liquidity/i.test(error) ? 'No route' : 'Skipped'}</small>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {quotes && chosen.length > 0 && (
          <dl className="kv">
            <div>
              <dt>You receive about</dt>
              <dd>
                {formatAmount(totalOut)} {targetToken.symbol} <small className="muted">· from {formatUsd(totalUsd)}</small>
              </dd>
            </div>
            <div>
              <dt>Max slippage</dt>
              <dd>{slippage}%</dd>
            </div>
          </dl>
        )}

        <button type="button" className="button button--primary button--block button--lg" disabled={submitting || !chosen.length} onClick={sweep}>
          {submitting && <Spinner size={14} />}
          {submitting ? 'Preparing & confirming…' : chosen.length ? `Sweep ${chosen.length} token${chosen.length === 1 ? '' : 's'}` : 'Nothing to sweep'}
        </button>
        <p className="hint">Quotes are refreshed when you sweep. Network fees for many swaps can be larger than very small balances.</p>
      </div>
    </Modal>
  );
}

/** Shown on your own portfolio when there are small balances to sweep. */
export default function DustSweeper({ rows, onDone }) {
  const [open, setOpen] = useState(false);
  const count = dustRows(rows, { target: NATIVE_NEAR.id, limitUsd: Math.max(...DUST_LIMITS) }).length;
  if (!count) return null;
  return (
    <>
      <button type="button" className="button button--ghost button--sm sweep-button" onClick={() => setOpen(true)}>
        🧹 Sweep dust
      </button>
      {open && <SweepModal rows={rows} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}
