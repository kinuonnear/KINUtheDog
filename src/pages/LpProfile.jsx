// LP wallet profile (/lp/<account>): any wallet's Rhea CLMM record, read live in the browser —
// PnL, fees earned, win rate, average invested, positions (open / closed), results by period and
// by pool, the profit history and every position. Read-only; opened from Discover → Smart LP.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import { loadDclPositions, markDclRows } from '../lib/smartLp.js';
import { formatAge as duration } from '../lib/lpHistory.js';
import { PERIODS } from '../lib/lpStats.js';
import { formatUsd } from '../lib/format.js';
import { ENDPOINTS } from '../config.js';
import { ClosedPositions, ProfitChart, RANGES, useLpHistory } from '../components/LpPnl.jsx';
import LiquidityTable from '../components/LiquidityTable.jsx';
import { DayBars, feeSharePct, LpWatchStar, signedUsd } from '../components/SmartLp.jsx';
import { CopyButton, EmptyState, PairIcons, Skeleton, Spinner } from '../components/ui.jsx';

const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(v >= 99.95 ? 0 : 1)}%` : '—');
const date = (t) => (t ? new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

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

export default function LpProfile({ account }) {
  const { prices } = useApp();
  const positions = useAsync(() => loadDclPositions(account), [account], { refreshMs: 60_000 });
  const rows = useMemo(() => (positions.data ? markDclRows(positions.data.dcl, positions.data.tokens, prices) : null), [positions.data, prices]);
  const history = useLpHistory(account, rows, prices);
  const model = history.model;
  const s = model?.stats;
  const busy = !model;
  const [mode, setMode] = useState('pnl');
  const [range, setRange] = useState('30d');
  const link = `${window.location.origin}/lp/${encodeURIComponent(account)}`;
  const failed = (positions.error && !positions.data) || (history.error && !model);

  return (
    <div className="page lpp">
      <Link to="/discover?tab=smartlp" className="lpp__back">
        ← Smart LP
      </Link>
      <header className="lpp__head">
        <div>
          <span className="eyebrow">LP wallet · Rhea CLMM</span>
          <h1 className="mono">{account}</h1>
          <div className="lpp__actions">
            <LpWatchStar account={account} label />
            <CopyButton text={link} label="⧉ Copy profile link" />
            <a href={`${ENDPOINTS.explorer}/address/${account}`} target="_blank" rel="noopener noreferrer" className="link-button">
              Explorer ↗
            </a>
            <Link to={`/portfolio?account=${encodeURIComponent(account)}`} className="link-button">
              Full portfolio →
            </Link>
          </div>
        </div>
        {busy && !failed && (
          <span className="muted small lpp__loading">
            <Spinner size={12} /> Reading on-chain position history…
          </span>
        )}
      </header>

      <p className="lpp__note">
        PnL is rebuilt from this wallet&apos;s on-chain CLMM events, valued at USD prices at the time of each deposit and withdrawal.
        Classic AMM / Stable / ALMM pools are not included{model && !model.complete ? '; only the most recent 2,000 CLMM transactions are read' : ''}.
      </p>

      {failed ? (
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
                  {s && formatUsd(s.openValue)}
                </Metric>
                <Metric label="Fees earned" busy={busy} className="up" hint="Claimed + still unclaimed">
                  {s && formatUsd(s.fees)}
                </Metric>
                <Metric label="Win rate" busy={busy} hint="Closed positions that made money (fees included)" className={s ? (s.winRate >= 70 ? 'up' : s.winRate !== null && s.winRate < 50 ? 'down' : '') : ''}>
                  {s && pct(s.winRate)}
                </Metric>
                <Metric label="Avg invested" busy={busy} hint="Average USD value put into a position">
                  {s && (s.avgInvested === null ? '—' : formatUsd(s.avgInvested))}
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
                <ProfitChart days={model.days} mode={mode} range={range} />
              )}
            </div>
          </section>

          <div className="lpp-row">
            <section className="card lpp-periods">
              <h2>By period</h2>
              {busy ? (
                <Skeleton height={90} />
              ) : (
                <>
                  <div className="slp-periods">
                    <span>Time</span>
                    <span>Positions opened</span>
                    <span>Realized</span>
                    {s.periods.map((p) => (
                      <span key={p.key} className="slp-periods__row">
                        <b>{PERIODS.find((x) => x.key === p.key)?.label}</b>
                        <span>{p.positions}</span>
                        <span className={tone(p.pnl)}>{signedUsd(p.pnl)}</span>
                      </span>
                    ))}
                  </div>
                  <div className="lpp-periods__bars">
                    <span className="muted small">Last 7 days</span>
                    <DayBars values={s.last7} />
                  </div>
                  <p className="muted small">
                    First activity {date(s.firstActivity)} · last activity {date(s.lastActivity)}
                  </p>
                </>
              )}
            </section>

            <section className="card lpp-pools">
              <h2>By pool</h2>
              {busy ? (
                <Skeleton height={90} />
              ) : !model.pools.length ? (
                <p className="muted small">No CLMM positions yet.</p>
              ) : (
                <div className="lpp-pools__table">
                  <span>Pool</span>
                  <span>Positions</span>
                  <span>Invested</span>
                  <span>Fees</span>
                  <span>PnL</span>
                  {model.pools.map((p) => (
                    <Link key={p.poolId} to={poolPath(p.poolId)} className="lpp-pools__row">
                      <span className="lpp-pools__pair">
                        <PairIcons tokens={[p.x, p.y]} size={20} />
                        {p.x.symbol} / {p.y.symbol}
                      </span>
                      <span>
                        {p.positions}
                        {p.open > 0 && <small className="muted"> · {p.open} open</small>}
                      </span>
                      <span>{formatUsd(p.invested, { compactAbove: 1e5 })}</span>
                      <span className="up">{formatUsd(p.fees, { compactAbove: 1e5 })}</span>
                      <span className={tone(p.pnl)}>{signedUsd(p.pnl)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </div>

          <h2 className="lpp__section">Open positions</h2>
          {rows ? (
            <LiquidityTable classicRows={[]} dclRows={rows} depositUsd={0} readOnly history={history} />
          ) : (
            <div className="card">
              <Skeleton height={60} />
            </div>
          )}

          <h2 className="lpp__section">Historical positions</h2>
          <ClosedPositions history={history} />
        </>
      )}
    </div>
  );
}
