// LP wallet profile (/lp/<account>): any wallet's Rhea CLMM record, read live in the browser —
// PnL, fees earned, win rate, average invested, positions (open / closed), results by period and
// by pool, the profit history and every position. Read-only; opened from Discover → Smart LP.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { getPoolRadar } from '../lib/poolRadar.js';
import { judgeDclHolding } from '../lib/agent.js';
import { Link, poolPath } from '../router.jsx';
import { isNearAccount, loadDclPositions, markDclRows } from '../lib/smartLp.js';
import { formatAge as duration } from '../lib/lpHistory.js';
import { formatUsd } from '../lib/format.js';
import { ENDPOINTS } from '../config.js';
import { ClosedPositions, ProfitChart, RANGES, useLpHistory } from '../components/LpPnl.jsx';
import LiquidityTable from '../components/LiquidityTable.jsx';
import { feeSharePct, LpBadges, LpWatchStar, signedUsd } from '../components/SmartLp.jsx';
import { CopyButton, EmptyState, Skeleton, Spinner } from '../components/ui.jsx';

const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(v >= 99.95 ? 0 : 1)}%` : '—');

const POOL_TYPES = [
  { key: 'clmm', label: 'CLMM' },
  { key: 'amm', label: 'AMM', soon: true }
];

/** "Type Pool ▾": which kind of position the lists below show. */
function PoolTypeMenu({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const current = POOL_TYPES.find((t) => t.key === value);
  return (
    <div className="lpp-type" ref={ref}>
      <button type="button" className="lpp-type__button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        Type Pool: <b>{current.label}</b> <span aria-hidden>▾</span>
      </button>
      {open && (
        <ul className="lpp-type__menu" role="listbox" aria-label="Pool type">
          {POOL_TYPES.map((t) => (
            <li key={t.key}>
              <button
                type="button"
                role="option"
                aria-selected={t.key === value}
                className={t.key === value ? 'lpp-type__opt--on' : ''}
                onClick={() => {
                  onChange(t.key);
                  setOpen(false);
                }}
              >
                {t.label}
                {t.soon && <em className="lpp-type__soon">Soon</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Amounts in the pills use K / M from $10K up ($149.63K): short enough to never crowd a pill.
const short = (v) => formatUsd(v, { compactAbove: 1e4 });

/**
 * The open positions at a glance, in the Position header: value now, unrealized PnL, and fees —
 * with a split bar of what was already claimed vs. what is still waiting in the positions.
 */
function OpenSummary({ model }) {
  const open = [...model.open.values()];
  if (!open.length) return null;
  const value = open.reduce((s, o) => s + o.value, 0);
  const unclaimed = open.reduce((s, o) => s + o.unclaimed, 0);
  const claimed = open.reduce((s, o) => s + (o.ledger?.feesUsd || 0), 0);
  const known = open.filter((o) => o.known);
  const pnl = known.reduce((s, o) => s + o.pnl, 0);
  const gross = known.reduce((s, o) => s + o.ledger.investedUsd, 0);
  const fees = claimed + unclaimed;
  const claimedPct = fees > 0 ? (claimed / fees) * 100 : 0;
  return (
    <div className="lpp-sum">
      <span className="lpp-sum__pill">
        <small>Open value</small>
        <b title={formatUsd(value)}>{short(value)}</b>
      </span>
      <span className="lpp-sum__pill">
        <small>uPnL</small>
        <b className={tone(pnl)}>
          {known.length ? signedUsd(pnl) : '—'}
          {gross > 0 && <em> {pct((pnl / gross) * 100)}</em>}
        </b>
      </span>
      <span className="lpp-sum__pill lpp-sum__pill--fees" title="Fees of the open positions: already claimed, and still unclaimed in the positions">
        <span className="lpp-sum__main">
          <small>Total fee</small>
          <b className="up" title={formatUsd(fees)}>{short(fees)}</b>
        </span>
        <span className="lpp-sum__side">
          <span className="lpp-sum__split" aria-hidden>
            <i className="lpp-sum__claimed" style={{ width: `${claimedPct}%` }} />
            <i className="lpp-sum__unclaimed" style={{ width: `${100 - claimedPct}%` }} />
          </span>
          <span className="lpp-sum__legend">
            <span>
              <i className="lpp-sum__dot lpp-sum__dot--claimed" /> claimed {short(claimed)}
            </span>
            <span>
              <i className="lpp-sum__dot lpp-sum__dot--unclaimed" /> unclaimed {short(unclaimed)}
            </span>
          </span>
        </span>
      </span>
    </div>
  );
}

function Metric({ label, hint, children, busy, className = '' }) {
  return (
    <div className="lpp-metric">
      <span title={hint}>
        {label}
        {hint && <i aria-hidden> ⓘ</i>}
      </span>
      <strong className={className}>{busy ? <Skeleton width={72} height={18} /> : children}</strong>
    </div>
  );
}

export default function LpProfile({ account: raw }) {
  // NEAR account ids are lowercase: /lp/Alex.near is alex.near.
  const account = raw.trim().toLowerCase();
  const valid = isNearAccount(account);
  const { prices } = useApp();
  // Nothing is read for an id that can't be a NEAR account.
  const positions = useAsync(() => loadDclPositions(account), [account], { refreshMs: 60_000, enabled: valid });
  const rows = useMemo(() => (positions.data ? markDclRows(positions.data.dcl, positions.data.tokens, prices) : null), [positions.data, prices]);
  const history = useLpHistory(valid ? account : null, rows, prices);
  const model = history.model;
  const s = model?.stats;
  const busy = !model;
  const [mode, setMode] = useState('pnl');
  const [range, setRange] = useState('30d');
  const [poolType, setPoolType] = useState('clmm');
  const link = `${window.location.origin}/lp/${encodeURIComponent(account)}`;
  const failed = (positions.error && !positions.data) || (history.error && !model);
  // Read fine, but this wallet never provided CLMM liquidity on Rhea.
  const inactive = Boolean(model && rows && model.stats.totalPositions === 0);
  // KINU Agent's call on each pool (same rules as /agent), with the pool's live activity.
  const radar = useAsync(getPoolRadar, []);
  const radarById = useMemo(() => new Map((radar.data || []).map((r) => [String(r.id), r])), [radar.data]);
  const groupExtra = (g) => {
    const call = judgeDclHolding({ positions: g.positions, usd: { value: g.summary.usd, fees: g.summary.feeUsd }, radarRow: radarById.get(g.poolId) });
    const left = Math.min(...g.positions.map((p) => p.leftPoint));
    const right = Math.max(...g.positions.map((p) => p.rightPoint));
    return (
      <>
        <span className={`ag-verdict ag-verdict--${call.verdict.toLowerCase()}`} title={`KINU Agent: ${call.reasons.join(' ')}`}>
          {call.verdict}
        </span>
        <Link
          to={`${poolPath(g.poolId)}?tab=add&left=${left}&right=${right}`}
          className="button button--outline button--sm"
          title="Open this pool's Add liquidity form with the same price range — you choose the amount and sign"
        >
          Use this range
        </Link>
      </>
    );
  };

  return (
    <div className="page lpp">
      <Link to="/discover?tab=smartlp" className="lpp__back">
        <span aria-hidden>←</span> Back to Smart LP
      </Link>
      <header className="lpp__head">
        <div>
          <h1 className="mono">{account}</h1>
          {s && <LpBadges stats={s} />}
          <div className="lpp__actions">
            <LpWatchStar account={account} label />
            <CopyButton text={link} label="⧉ Copy profile link" />
            <a href={`${ENDPOINTS.explorer}/address/${encodeURIComponent(account)}`} target="_blank" rel="noopener noreferrer" className="link-button">
              Explorer ↗
            </a>
            <Link to={`/portfolio?account=${encodeURIComponent(account)}`} className="link-button">
              Full portfolio →
            </Link>
            <span className="lpp__chip">LP wallet · Rhea CLMM</span>
          </div>
        </div>
        {valid && busy && !failed && (
          <span className="muted small lpp__loading">
            <Spinner size={12} /> Reading on-chain position history…
          </span>
        )}
      </header>

      <p className="lpp__note">
        PnL is rebuilt from this wallet&apos;s on-chain CLMM events, valued at USD prices at the time of each deposit and withdrawal.
        Classic AMM / Stable / ALMM pools are not included{model && !model.complete ? '; only the most recent 1,000 CLMM transactions are read' : ''}.
      </p>

      {!valid ? (
        <div className="card">
          <EmptyState icon="?" title="That isn't a NEAR account">
            Account ids look like <b>alex.near</b>, a 64-character implicit id, or an 0x address. Check the link, or look the
            wallet up from <Link to="/discover?tab=smartlp">Smart LP</Link>.
          </EmptyState>
        </div>
      ) : inactive ? (
        <div className="card">
          <EmptyState icon="◎" title="No Rhea CLMM activity yet">
            This wallet hasn&apos;t provided concentrated liquidity on Rhea (or not in its most recent transactions). Its other
            assets are in its <Link to={`/portfolio?account=${encodeURIComponent(account)}`}>full portfolio</Link>.
          </EmptyState>
        </div>
      ) : failed ? (
        <div className="card">
          <EmptyState
            title="Couldn't read this wallet right now"
            action={
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  positions.reload();
                  history.reload();
                }}
              >
                Retry
              </button>
            }
          >
            {(positions.error || history.error)?.message} Check the account name, or try again in a minute.
          </EmptyState>
        </div>
      ) : (
        <>
          <section className="card lpp-dash">
            <div className="lpp-dash__stats">
              <div className="lpp-dash__headline">
                <span className="eyebrow">Total LP PnL</span>
                {busy ? (
                  <Skeleton width={150} height={32} />
                ) : (
                  <strong className={tone(s.totalPnl)}>{signedUsd(s.totalPnl)}</strong>
                )}
                <span className="muted small">Realized + unrealized, fees included</span>
              </div>
              <div className="lpp-dash__grid">
                <Metric label="LP value now" busy={busy}>
                  {s && short(s.openValue)}
                </Metric>
                <Metric label="Fees earned" busy={busy} className="up" hint="Claimed + still unclaimed">
                  {s && short(s.fees)}
                </Metric>
                <Metric label="Win rate" busy={busy} hint="Closed positions that made money (fees included)" className={s ? (s.winRate >= 70 ? 'up' : s.winRate !== null && s.winRate < 50 ? 'down' : '') : ''}>
                  {s && pct(s.winRate)}
                </Metric>
                <Metric label="Avg invested" busy={busy} hint="Average USD value put into a position">
                  {s && (s.avgInvested === null ? '—' : short(s.avgInvested))}
                </Metric>
                <Metric label="Total positions" busy={busy}>
                  {s && (
                    <>
                      {s.totalPositions} <small className="muted">· {s.openCount} open</small>
                    </>
                  )}
                </Metric>
                <Metric label="Closed positions" busy={busy}>
                  {s && s.closedCount}
                </Metric>
                <Metric label="Expected value" busy={busy} hint="Average PnL of a closed position" className={s ? tone(s.ev) : ''}>
                  {s && signedUsd(s.ev)}
                </Metric>
                <Metric label="Avg monthly profit" busy={busy} className={s ? tone(s.monthlyPnl) : ''}>
                  {s && signedUsd(s.monthlyPnl)}
                </Metric>
                <Metric label="Avg holding time" busy={busy}>
                  {s && (s.avgHold === null ? '—' : duration(s.avgHold))}
                </Metric>
                <Metric label="Fee share" busy={busy} hint="How much of the profit is LP fees — low means it came from the token's price">
                  {s && feeSharePct(s.feeShare)}
                </Metric>
              </div>
            </div>
            <div className="lpp-dash__chart">
              <div className="pnl-dash__chart-head">
                <span className="eyebrow">Profit history</span>
                <div className="segmented">
                  {[
                    ['pnl', 'PnL'],
                    ['fees', 'Fees']
                  ].map(([k, label]) => (
                    <button key={k} type="button" className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="segmented">
                  {RANGES.map((r) => (
                    <button key={r.key} type="button" className={range === r.key ? 'active' : ''} onClick={() => setRange(r.key)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
              {busy ? (
                <div className="profit-chart profit-chart--empty">
                  <Spinner />
                </div>
              ) : (
                <ProfitChart days={model.days} mode={mode} range={range} short />
              )}
            </div>
          </section>

          <div className="lpp__section-head">
            <h2 className="lpp__section">
              Position
              {model && model.open.size > 0 && poolType === 'clmm' && <small className="muted"> · {model.open.size} open</small>}
            </h2>
            {model && poolType === 'clmm' && <OpenSummary model={model} />}
            <PoolTypeMenu value={poolType} onChange={setPoolType} />
          </div>
          {poolType === 'amm' ? (
            <div className="card">
              <EmptyState icon="◷" title="AMM · coming soon">
                PnL for AMM / Stable / ALMM pools is on the way. Until then, this wallet&apos;s classic pool positions are in its{' '}
                <Link to={`/portfolio?account=${encodeURIComponent(account)}`}>full portfolio</Link>.
              </EmptyState>
            </div>
          ) : (
            <>
              {rows ? (
                <LiquidityTable classicRows={[]} dclRows={rows} depositUsd={0} readOnly history={history} sortBy="age" showTotal rangeBar groupExtra={groupExtra} short />
              ) : (
                <div className="card">
                  <Skeleton height={60} />
                </div>
              )}

              <h2 className="lpp__section">Historical positions</h2>
              <ClosedPositions history={history} short />
            </>
          )}
        </>
      )}
    </div>
  );
}
