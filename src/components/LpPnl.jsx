// LP performance for the portfolio: PnL dashboard, profit history chart and
// the closed-position history, all rebuilt from on-chain CLMM events
// (see lib/lpHistory.js).

import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, HistogramSeries, LineSeries } from 'lightweight-charts';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import { priceOf } from '../lib/tokens.js';
import { buildHistory, formatAge, loadPriceHistory } from '../lib/lpHistory.js';
import { buildLpModel, loadLpHistory } from '../lib/lpStats.js';
import { pointToPrice } from '../lib/dclLiquidity.js';
import { formatAmount, formatPercent, formatUsd, toNumber } from '../lib/format.js';
import { EmptyState, PairIcons, Skeleton, Spinner } from './ui.jsx';
import { lpShareCard } from '../lib/shareCard.js';
import ShareButton from './ShareCard.jsx';
import { ENDPOINTS } from '../config.js';

const UP = '#22e283';
const DOWN = '#ff5d6c';

/**
 * Position ledgers for an account. `dclRows` are the live positions (with
 * amounts / unclaimed fees) so open positions can be marked to market.
 */
export function useLpHistory(account, dclRows, prices) {
  const raw = useAsync(() => loadLpHistory(account), [account], {
    enabled: Boolean(account)
  });

  const model = useMemo(() => (raw.data && dclRows ? buildLpModel(raw.data, dclRows, prices) : null), [raw.data, dclRows, prices]);

  return {
    model,
    events: raw.data?.events || null,
    loading: raw.loading && !raw.data,
    error: raw.error,
    reload: raw.reload
  };
}

const signed = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

/** `short`: K / M from $10K up ($37.45K) — for pages that show large wallets (Smart LP). */
export function PnlValue({ value, pct, compact, short = false }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="muted">—</span>;
  return (
    <span className={`pnl ${signed(value)}`}>
      <b>
        {value > 0 ? '+' : value < 0 ? '−' : ''}
        {formatUsd(Math.abs(value), short ? { compactAbove: 1e4 } : undefined)}
      </b>
      {pct !== null && pct !== undefined && Number.isFinite(pct) && (
        <small>
          {compact ? '' : ' '}
          {pct > 0 ? '+' : ''}
          {formatPercent(pct)}
        </small>
      )}
    </span>
  );
}

export const RANGES = [
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '1M', days: 30 },
  { key: 'all', label: 'All', days: Infinity }
];

export function ProfitChart({ days, mode, range, short = false }) {
  const ref = useRef(null);
  const data = useMemo(() => {
    const span = RANGES.find((r) => r.key === range)?.days ?? Infinity;
    const from = Number.isFinite(span) ? Date.now() / 1000 - span * 86400 : -Infinity;
    let cum = 0;
    const rows = [];
    days.forEach((d) => {
      const v = mode === 'fees' ? d.fees : d.pnl;
      cum += v;
      if (d.time >= from) rows.push({ time: d.time, value: v, cum });
    });
    return rows;
  }, [days, mode, range]);

  useEffect(() => {
    if (!ref.current || !data.length) return undefined;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: 'rgba(226, 234, 245, 0.5)',
        fontSize: 11,
        attributionLogo: false
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(255,255,255,0.04)' }
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true
      },
      handleScroll: false,
      handleScale: false,
      crosshair: { horzLine: { visible: false } },
      localization: { priceFormatter: (v) => formatUsd(v, short ? { compactAbove: 1e4 } : undefined) }
    });
    const bars = chart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false
    });
    bars.setData(
      data.map((d) => ({
        time: d.time,
        value: d.value,
        color: d.value >= 0 ? 'rgba(34,226,131,0.75)' : 'rgba(255,93,108,0.75)'
      }))
    );
    const line = chart.addSeries(LineSeries, {
      color: '#ffb547',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true
    });
    line.setData(data.map((d) => ({ time: d.time, value: d.cum })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);

  if (!data.length) {
    return <div className="profit-chart profit-chart--empty muted small">No realized PnL in this period yet.</div>;
  }
  return <div className="profit-chart" ref={ref} />;
}

function Metric({ label, children, loading, tone }) {
  return (
    <div className="pnl-metric">
      <span>{label}</span>
      <strong className={tone || ''}>{loading ? <Skeleton width={80} height={20} /> : children}</strong>
    </div>
  );
}

export function PnlDashboard({ history, shareable = false }) {
  const [mode, setMode] = useState('pnl');
  const [range, setRange] = useState('30d');
  const { model, loading, error, reload } = history;
  const s = model?.stats;
  const busy = loading || !model;

  return (
    <section className="card pnl-dash">
      <div className="pnl-dash__stats">
        <div className="pnl-dash__headline">
          <span className="pnl-dash__title">
            <span className="eyebrow">Total LP PnL</span>
            {shareable && !busy && (s.closedCount > 0 || s.totalInvested > 0) && (
              <ShareButton label="Share PnL" build={(hideUsd, opts) => lpShareCard(s, hideUsd, { days: model.days, ...opts })} />
            )}
          </span>
          {busy ? (
            <Skeleton width={160} height={34} />
          ) : (
            <strong className={signed(s.totalPnl)}>
              {s.totalPnl > 0 ? '+' : s.totalPnl < 0 ? '−' : ''}
              {formatUsd(Math.abs(s.totalPnl))}
            </strong>
          )}
          <span className="muted small">
            {error ? (
              <>
                {error.message}{' '}
                <button type="button" className="link-button" onClick={reload}>
                  Retry
                </button>
              </>
            ) : busy ? (
              <>
                <Spinner size={11} /> Reading on-chain position history…
              </>
            ) : (
              'Realized + unrealized, fees included · CLMM positions'
            )}
          </span>
        </div>
        <div className="pnl-dash__grid">
          <Metric label="Unrealized PnL" loading={busy} tone={s && signed(s.unrealized)}>
            {s && <PnlValue value={s.unrealized} />}
          </Metric>
          <Metric label="Realized PnL" loading={busy} tone={s && signed(s.realized)}>
            {s && <PnlValue value={s.realized} />}
          </Metric>
          <Metric label="Fees earned" loading={busy} tone="up">
            {s && formatUsd(s.fees)}
          </Metric>
          <Metric label="Win rate" loading={busy}>
            {s && (s.winRate === null ? '—' : formatPercent(s.winRate))}
          </Metric>
          <Metric label="Closed positions" loading={busy}>
            {s && s.closedCount}
          </Metric>
          <Metric label="Avg invested" loading={busy}>
            {s && (s.avgInvested === null ? '—' : formatUsd(s.avgInvested))}
          </Metric>
          <Metric label="Avg holding time" loading={busy}>
            {s && (s.avgHold === null ? '—' : formatAge(s.avgHold))}
          </Metric>
          <Metric label="Open capital (cost)" loading={busy}>
            {s && formatUsd(s.totalInvested)}
          </Metric>
        </div>
      </div>

      <div className="pnl-dash__chart">
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
        <span className="pnl-dash__legend muted small">
          <i style={{ background: UP }} /> daily {mode === 'fees' ? 'fees claimed' : 'realized PnL'} <i style={{ background: '#ffb547' }} />{' '}
          cumulative
          {model && !model.complete && ' · showing the most recent 1,000 CLMM transactions'}
        </span>
      </div>
    </section>
  );
}

function RangeCell({ row }) {
  const lo = pointToPrice(row.leftPoint, row.x.decimals, row.y.decimals);
  const hi = pointToPrice(row.rightPoint, row.x.decimals, row.y.decimals);
  return (
    <span>
      <b className="mono">
        {formatAmount(lo)} – {formatAmount(hi)}
      </b>
      <small className="muted">
        {' '}
        {row.y.symbol}/{row.x.symbol}
      </small>
    </span>
  );
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

export function ClosedPositions({ history, short = false }) {
  const usd = (v) => formatUsd(v, short ? { compactAbove: 1e4 } : undefined);
  const { model, loading, error, reload } = history;
  if (error && !model) {
    return (
      <div className="card">
        <EmptyState
          title="History unavailable"
          action={
            <button type="button" className="button button--ghost" onClick={reload}>
              Retry
            </button>
          }
        >
          {error.message}
        </EmptyState>
      </div>
    );
  }
  if (loading || !model) {
    return (
      <div className="card">
        {[0, 1, 2].map((i) => (
          <div className="asset-row" key={i}>
            <Skeleton width="40%" height={20} />
            <Skeleton width={80} />
            <Skeleton width={80} />
          </div>
        ))}
      </div>
    );
  }
  if (!model.closed.length) {
    return (
      <div className="card">
        <EmptyState icon="◷" title="No closed positions yet">
          Fully removed CLMM positions show up here with their realized PnL.
        </EmptyState>
      </div>
    );
  }
  return (
    <section className="card lp-table-card">
      <div className="hist-table">
        <div className="hist-row hist-row--head">
          <span>Position / Pool</span>
          <span>Price range</span>
          {/* The list is newest-closed first, so the date shown is the close date. */}
          <span>Closed</span>
          <span>Duration</span>
          <span>Invested</span>
          <span>Withdrawn</span>
          <span>Fees</span>
          <span>PnL</span>
          <span>Explorer</span>
        </div>
        {model.closed.map((c) => (
          <div className="hist-row" key={c.lptId}>
            <Link to={poolPath(c.poolId)} className="lp-row__pool">
              <PairIcons tokens={[c.x, c.y]} size={26} />
              <span>
                <strong>
                  {c.x.symbol} / {c.y.symbol}
                </strong>
                <small className="muted">#{c.lptId.split('#')[1]}</small>
              </span>
            </Link>
            <span data-label="Price range">
              <RangeCell row={c} />
            </span>
            <span data-label="Closed" className="muted" title={`Opened ${dateFmt.format(c.openedAt)}`}>
              {dateFmt.format(c.closedAt)}
            </span>
            <span data-label="Duration">{formatAge(c.closedAt - c.openedAt)}</span>
            <span data-label="Invested">{usd(c.investedUsd)}</span>
            <span data-label="Withdrawn">{usd(c.withdrawnUsd)}</span>
            <span data-label="Fees" className="up">
              {usd(c.feesUsd)}
            </span>
            <span data-label="PnL">
              <PnlValue value={c.pnl} pct={c.pnlPct} short={short} />
            </span>
            <span data-label="Explorer" className="hist-tx">
              {c.openHash && (
                <a href={`${ENDPOINTS.explorer}/txns/${c.openHash}`} target="_blank" rel="noopener noreferrer" title="Transaction that opened the position">
                  Open ↗
                </a>
              )}
              {c.closeHash && (
                <a href={`${ENDPOINTS.explorer}/txns/${c.closeHash}`} target="_blank" rel="noopener noreferrer" title="Transaction that closed the position">
                  Close ↗
                </a>
              )}
            </span>
          </div>
        ))}
      </div>
      <p className="hint lp-hint">
        Values use USD prices at the time of each deposit and withdrawal (Intear hourly candles). Classic AMM / Stable pools are not
        included.
      </p>
    </section>
  );
}

/**
 * PnL of the positions in one CLMM pool, for the pool page (e.g. its share cards). `events` are
 * the account's liquidity events the page already loaded (useDepositGroups); only the two tokens'
 * price history is added. Returns pnlOf(positions) -> { known, pnl, pnlPct, fees } (as in the
 * Portfolio), null while loading, or { known: false } when the history could not be read.
 */
export function usePoolPnl(events, poolId, x, y, prices, failed = false) {
  const poolEvents = useMemo(() => (events ? events.filter((e) => e.pool === poolId) : null), [events, poolId]);
  const since = poolEvents?.length ? poolEvents[0].ts : null;
  const history = useAsync(() => loadPriceHistory([x.id, y.id], since), [x.id, y.id, since], { enabled: Boolean(since) });
  const ledgers = useMemo(() => {
    if (!poolEvents || !history.data) return null;
    const meta = (id) => (id === x.id ? x : id === y.id ? y : { id, symbol: id.slice(0, 6), decimals: 0 });
    return buildHistory(poolEvents, meta, history.data, prices).ledgers;
  }, [poolEvents, history.data, prices, x, y]);

  return (positions) => {
    // Events loaded but none for this pool (e.g. opened elsewhere, indexer behind): nothing to price.
    if (!ledgers) return failed || history.error || (poolEvents && !poolEvents.length) ? { known: false } : null;
    const px = priceOf(prices, x.id);
    const py = priceOf(prices, y.id);
    let pnl = 0;
    let gross = 0;
    let fees = 0;
    let known = 0;
    positions.forEach((p) => {
      const value = (p.amountX / 10 ** x.decimals) * px + (p.amountY / 10 ** y.decimals) * py;
      const unclaimed = toNumber(p.unclaimedFeeX, x.decimals) * px + toNumber(p.unclaimedFeeY, y.decimals) * py;
      const l = ledgers.get(p.id);
      fees += unclaimed + (l?.feesUsd || 0);
      if (!l || !l.complete) return;
      known += 1;
      pnl += value + unclaimed - l.costUsd + l.realizedUsd + l.feesUsd;
      gross += l.investedUsd;
    });
    return { known: known > 0 && known === positions.length, pnl, pnlPct: gross > 0 ? (pnl / gross) * 100 : null, fees };
  };
}
