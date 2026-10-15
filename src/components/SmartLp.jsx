// Discover → Smart LP: LP wallets ranked by their on-chain CLMM results (PnL, fees, win rate…),
// from the published snapshot (lib/smartLp.js). A card opens the wallet's live profile (/lp/…).

import { useMemo, useState } from 'react';
import { useAsync, useLocalStorage } from '../hooks.js';
import { navigate } from '../router.jsx';
import { useLpWatchlist } from '../lib/watchlist.js';
import { ACTIVE_WINDOWS, BOARD_URL, DEFAULT_FILTERS, FEE_CHECK_MIN, filterBoard, SORTS, sortBoard } from '../lib/smartLp.js';
import { formatAge as since, formatUsd, shortAccount } from '../lib/format.js';
import { formatAge as duration } from '../lib/lpHistory.js';
import { EmptyState, ErrorNotice, Skeleton } from './ui.jsx';

const loadBoard = async () => {
  const response = await fetch(BOARD_URL, { cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Smart LP HTTP ${response.status}`);
  return response.json();
};

export const lpPath = (account) => `/lp/${encodeURIComponent(account)}`;

const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
export const signedUsd = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatUsd(Math.abs(v), { compactAbove: 1e4 })}` : '—');
const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(v >= 99.95 ? 0 : 1)}%` : '—');
// Fees above the profit (the price moved against the LP): fees carried all of it.
export const feeSharePct = (v) => (v === null || !Number.isFinite(v) ? '—' : v > 100 ? '100%+' : pct(v));
const date = (t) => (t ? new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const ago = (t) => (t ? `${since(t)} ago` : '—');
const winTone = (w) => (w === null ? '' : w >= 70 ? 'up' : w < 50 ? 'down' : '');

/** ☆ / ★ for an LP wallet (kept in this browser). Stops the click inside clickable cards. */
export function LpWatchStar({ account, label = false }) {
  const { has, toggle } = useLpWatchlist();
  const on = has(account);
  return (
    <button
      type="button"
      className={`watch-star ${on ? 'watch-star--on' : ''} ${label ? 'watch-star--label' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        toggle(account);
      }}
      aria-pressed={on}
      title={on ? 'Remove from your LP watchlist' : 'Add to your LP watchlist'}
    >
      {on ? '★' : '☆'}
      {label && <span>{on ? 'Watching' : 'Watch'}</span>}
    </button>
  );
}

/** The last 7 days of booked PnL as small bars around a zero line. */
export function DayBars({ values }) {
  const max = Math.max(...values.map((v) => Math.abs(v || 0)), 0);
  return (
    <svg className="slp-bars" viewBox="0 0 70 30" aria-hidden="true">
      <line x1="0" x2="70" y1="15" y2="15" className="slp-bars__zero" />
      {values.map((v, i) => {
        const h = max > 0 ? (Math.abs(v || 0) / max) * 14 : 0;
        return <rect key={i} x={i * 10 + 1.5} width="7" y={v >= 0 ? 15 - h : 15} height={Math.max(h, v ? 1 : 0)} rx="1" className={v >= 0 ? 'up' : 'down'} />;
      })}
    </svg>
  );
}

function PeriodTable({ periods }) {
  return (
    <div className="slp-periods">
      <span>Time</span>
      <span>Positions</span>
      <span title="Closed out + fees claimed in the period">Realized</span>
      {periods.map((p) => (
        <span key={p.key} className="slp-periods__row">
          <b>{p.key === 'all' ? 'ALL' : p.key.toUpperCase()}</b>
          <span>{p.positions}</span>
          <span className={tone(p.pnl)}>{signedUsd(p.pnl)}</span>
        </span>
      ))}
    </div>
  );
}

function WalletCard({ w, rank }) {
  return (
    <article className="slp-card" onClick={() => navigate(lpPath(w.account))} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(lpPath(w.account))}>
      <header className="slp-card__head">
        <span className="slp-card__rank">#{rank}</span>
        <strong className="mono" title={w.account}>
          {shortAccount(w.account, 14, 6)}
        </strong>
        <LpWatchStar account={w.account} />
      </header>
      <div className="slp-card__win">
        <div>
          <span>Win rate</span>
          <strong className={winTone(w.winRate)}>{pct(w.winRate)}</strong>
        </div>
        <DayBars values={w.last7} />
      </div>
      <dl className="slp-card__grid">
        <div>
          <dt>Fee earned</dt>
          <dd className="up">{formatUsd(w.fees, { compactAbove: 1e4 })}</dd>
        </div>
        <div>
          <dt>Total pools</dt>
          <dd>{w.poolCount}</dd>
        </div>
        <div>
          <dt title="Expected value: the average PnL of a closed position">EV</dt>
          <dd className={tone(w.ev)}>{signedUsd(w.ev)}</dd>
        </div>
        <div>
          <dt>Avg age</dt>
          <dd>{w.avgHold === null ? '—' : duration(w.avgHold)}</dd>
        </div>
        <div>
          <dt>Avg invested</dt>
          <dd>{w.avgInvested === null ? '—' : formatUsd(w.avgInvested, { compactAbove: 1e4 })}</dd>
        </div>
        <div>
          <dt>Monthly profit</dt>
          <dd className={tone(w.monthlyPnl)}>{signedUsd(w.monthlyPnl)}</dd>
        </div>
        <div>
          <dt title="Share of the profit that came from LP fees">Fee share</dt>
          <dd>{feeSharePct(w.feeShare)}</dd>
        </div>
        <div>
          <dt>Total PnL</dt>
          <dd className={tone(w.totalPnl)}>{signedUsd(w.totalPnl)}</dd>
        </div>
      </dl>
      <PeriodTable periods={w.periods} />
      <footer className="slp-card__foot">
        <span>
          First activity <b>{date(w.firstActivity)}</b>
        </span>
        <span>
          Last activity <b>{ago(w.lastActivity)}</b>
        </span>
      </footer>
    </article>
  );
}

function WalletTable({ wallets }) {
  return (
    <section className="card slp-table">
      <div className="slp-trow slp-trow--head">
        <span>#</span>
        <span>Wallet</span>
        <span>Total PnL</span>
        <span>Win rate</span>
        <span>Fees</span>
        <span>EV</span>
        <span>Avg invested</span>
        <span>Avg age</span>
        <span>Positions</span>
        <span>Pools</span>
        <span>Last active</span>
      </div>
      {wallets.map((w, i) => (
        <div className="slp-trow" key={w.account} onClick={() => navigate(lpPath(w.account))} role="link" tabIndex={0}>
          <span className="muted">{i + 1}</span>
          <span className="slp-trow__wallet">
            <LpWatchStar account={w.account} />
            <b className="mono" title={w.account}>
              {shortAccount(w.account, 16, 6)}
            </b>
          </span>
          <span data-label="Total PnL" className={tone(w.totalPnl)}>
            {signedUsd(w.totalPnl)}
          </span>
          <span data-label="Win rate" className={winTone(w.winRate)}>
            {pct(w.winRate)}
          </span>
          <span data-label="Fees" className="up">
            {formatUsd(w.fees, { compactAbove: 1e4 })}
          </span>
          <span data-label="EV" className={tone(w.ev)}>
            {signedUsd(w.ev)}
          </span>
          <span data-label="Avg invested">{w.avgInvested === null ? '—' : formatUsd(w.avgInvested, { compactAbove: 1e4 })}</span>
          <span data-label="Avg age">{w.avgHold === null ? '—' : duration(w.avgHold)}</span>
          <span data-label="Positions">
            {w.totalPositions} <small className="muted">({w.closedCount} closed)</small>
          </span>
          <span data-label="Pools">{w.poolCount}</span>
          <span data-label="Last active" className="muted">
            {ago(w.lastActivity)}
          </span>
        </div>
      ))}
    </section>
  );
}

function NumberFilter({ label, value, onChange, hint, placeholder = '' }) {
  return (
    <label className="slp-filter">
      <span title={hint}>
        {label}
        {hint && <i aria-hidden> ⓘ</i>}
      </span>
      <input type="number" min="0" inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function LookUp() {
  const [value, setValue] = useState('');
  return (
    <form
      className="slp-lookup"
      onSubmit={(e) => {
        e.preventDefault();
        const account = value.trim().toLowerCase();
        if (account) navigate(lpPath(account));
      }}
    >
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Look up any wallet · account.near" spellCheck={false} aria-label="Look up an LP wallet" />
      <button type="submit" className="button button--ghost button--sm">
        View
      </button>
    </form>
  );
}

export default function SmartLpBoard() {
  const board = useAsync(loadBoard, []);
  const { list: watched } = useLpWatchlist();
  const [filters, setFilters] = useLocalStorage('kinu.smartlp.filters', DEFAULT_FILTERS);
  const [sort, setSort] = useLocalStorage('kinu.smartlp.sort', { key: 'totalPnl', desc: true });
  const [view, setView] = useLocalStorage('kinu.smartlp.view', 'card');
  const [more, setMore] = useState(false);
  const f = { ...DEFAULT_FILTERS, ...filters };
  const set = (patch) => setFilters({ ...f, ...patch });

  const wallets = useMemo(() => {
    const all = board.data?.wallets || [];
    return sortBoard(filterBoard(all, f, { watched }), sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.data, JSON.stringify(f), sort, watched]);

  if (board.error && !board.data) return <ErrorNotice error={board.error} onRetry={board.reload} />;

  return (
    <div className="slp">
      <section className="card slp-filters" aria-label="Smart LP filters">
        <div className="slp-filters__row">
          <label className="slp-filter">
            <span>Active</span>
            <select value={f.active} onChange={(e) => set({ active: e.target.value })}>
              {ACTIVE_WINDOWS.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <NumberFilter label="Min win rate (%)" value={f.minWinRate} onChange={(v) => set({ minWinRate: v })} hint="Share of closed positions that made money" />
          <NumberFilter label="Min positions" value={f.minPositions} onChange={(v) => set({ minPositions: v })} />
          <NumberFilter label="Min avg age (hrs)" value={f.minAvgHoldH} onChange={(v) => set({ minAvgHoldH: v })} hint="Average time a closed position was held" />
          <LookUp />
        </div>
        {more && (
          <div className="slp-filters__row">
            <NumberFilter label="Min total PnL ($)" value={f.minPnl} onChange={(v) => set({ minPnl: v })} placeholder="any" />
            <NumberFilter label="Min fees earned ($)" value={f.minFees} onChange={(v) => set({ minFees: v })} placeholder="any" />
          </div>
        )}
        <div className="slp-filters__foot">
          <button type="button" className="link-button" onClick={() => setMore((m) => !m)} aria-expanded={more}>
            {more ? '▴ Fewer filters' : '▾ More filters'}
          </button>
          <label className="slp-check" title={`Hides wallets whose profit is under ${FEE_CHECK_MIN}% LP fees — it came from the token's price, often a token they launched`}>
            <input type="checkbox" checked={f.feeChecked} onChange={(e) => set({ feeChecked: e.target.checked })} /> Fee-checked
          </label>
          <label className="slp-check">
            <input type="checkbox" checked={f.watchOnly} onChange={(e) => set({ watchOnly: e.target.checked })} /> ★ My watchlist ({watched.length})
          </label>
          <button type="button" className="button button--ghost button--sm" onClick={() => setFilters(DEFAULT_FILTERS)}>
            Clear
          </button>
        </div>
      </section>

      <div className="slp-sortbar">
        <div className="slp-sorts">
          <span className="muted small">Sort</span>
          {SORTS.map((s) => {
            const on = sort.key === s.key;
            return (
              <button key={s.key} type="button" className={`slp-chip ${on ? 'slp-chip--on' : ''}`} onClick={() => setSort(on ? { key: s.key, desc: !sort.desc } : { key: s.key, desc: true })}>
                {on && <span aria-hidden>{sort.desc ? '↓ ' : '↑ '}</span>}
                {s.label}
              </button>
            );
          })}
        </div>
        <div className="segmented disc-seg">
          {[
            ['card', '▦ Card'],
            ['table', '☰ Table']
          ].map(([k, label]) => (
            <button key={k} type="button" className={view === k ? 'active' : ''} onClick={() => setView(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="slp-note muted small">
        {board.data ? (
          <>
            {wallets.length} of {board.data.wallets.length} wallets that added CLMM liquidity on Rhea in the last {board.data.days} days ·
            snapshot {ago(board.data.generatedAt)}
            {f.feeChecked && <> · fee-checked: wallets whose profit isn&apos;t LP fees are hidden</>}
          </>
        ) : (
          'Loading the Smart LP snapshot…'
        )}
      </p>

      {board.loading && !board.data ? (
        <div className="slp-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div className="slp-card" key={i}>
              <Skeleton height={140} />
            </div>
          ))}
        </div>
      ) : !board.data ? (
        <EmptyState icon="◎" title="Smart LP is warming up">
          The first snapshot of Rhea LP wallets will be published here soon. You can already look up any wallet above.
        </EmptyState>
      ) : !wallets.length ? (
        <EmptyState icon="◎" title="No wallets match">
          {f.watchOnly ? 'Star wallets with ☆ to follow them here.' : 'Loosen a filter, or press Clear.'}
        </EmptyState>
      ) : view === 'table' ? (
        <WalletTable wallets={wallets} />
      ) : (
        <div className="slp-grid">
          {wallets.map((w, i) => (
            <WalletCard key={w.account} w={w} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
