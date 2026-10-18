// NEAR DeFi Pulse (/pulse): the state of DeFi on NEAR — chain TVL, DEX volume, fees, stablecoins,
// the largest protocols, liquid staking and stable yields — from DefiLlama via api/near-defi.js.
// Read-only; protocols KINU can act on link to the page that does (Pools, Bridge, Stake).

import { useState } from 'react';
import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { formatUsd } from '../lib/format.js';
import { ErrorNotice, Skeleton } from '../components/ui.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import PageIcon from '../components/PageIcon.jsx';
import '../pools.css';
import '../treasury.css';
import '../pulse.css';

const K = { compactAbove: 1e3 };
const RANGES = [
  { key: 90, label: '90D' },
  { key: 180, label: '180D' },
  { key: 365, label: '1Y' }
];

async function getPulse() {
  const r = await fetch('/api/near-defi');
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || body.error) throw new Error('NEAR DeFi data is unavailable right now. Try again in a minute.');
  return body;
}

const day = (t) =>
  new Date(t * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });

function Change({ value, suffix = '' }) {
  if (!Number.isFinite(value)) return <span className="muted">—</span>;
  return (
    <span className={value >= 0 ? 'pl-up' : 'pl-down'}>
      {value >= 0 ? '+' : ''}
      {value.toFixed(1)}%{suffix}
    </span>
  );
}

function Tile({ label, value, hint, loading }) {
  return (
    <div className="ts-tile">
      <span>{label}</span>
      <strong>{loading ? <Skeleton width={110} height={24} /> : value}</strong>
      {hint && <small>{loading ? <Skeleton width={90} height={12} /> : hint}</small>}
    </div>
  );
}

/** Area (line) or column chart of [unixSeconds, usd] points; hover / touch shows the day's value. */
function Chart({ series, kind = 'area' }) {
  const [hover, setHover] = useState(null);
  if (!series?.length) return <div className="pl-chart pl-chart--empty" />;
  const W = 1000;
  const H = 260;
  const values = series.map((p) => p[1]);
  const lo = kind === 'area' ? Math.min(...values) * 0.9 : 0;
  const hi = Math.max(...values) * 1.05;
  const x = (i) => (series.length === 1 ? W : (i / (series.length - 1)) * W);
  const y = (v) => H - ((v - lo) / (hi - lo || 1)) * H;
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const bw = W / series.length;
  const shown = hover ?? series.length - 1;

  const onMove = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const f = (event.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(series.length - 1, Math.round(f * (series.length - 1)))));
  };

  return (
    <div className="pl-chart">
      <div className="pl-chart__readout">
        <b>{formatUsd(series[shown][1], K)}</b>
        <span>{day(series[shown][0])}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Chart">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="pl-grid" vectorEffect="non-scaling-stroke" />
        ))}
        {kind === 'area' ? (
          <>
            <path d={`${line}L${W},${H}L0,${H}Z`} className="pl-area" />
            <path d={line} className="pl-line" vectorEffect="non-scaling-stroke" />
          </>
        ) : (
          series.map((p, i) => {
            const h = H - y(p[1]);
            return <rect key={p[0]} x={i * bw + bw * 0.12} y={H - h} width={bw * 0.76} height={h} className={i === shown ? 'pl-bar pl-bar--on' : 'pl-bar'} />;
          })
        )}
        {kind === 'area' && hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} className="pl-cursor" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="pl-chart__axis">
        {[0, 0.5, 1].map((f) => (
          <span key={f}>{day(series[Math.round(f * (series.length - 1))][0])}</span>
        ))}
      </div>
    </div>
  );
}

function Section({ title, note, children, action, className = '' }) {
  return (
    <section className={`ts-section ${className}`}>
      <div className="pl-head">
        <h2>{title}</h2>
        {action}
      </div>
      {note && <p className="muted small">{note}</p>}
      {children}
    </section>
  );
}

export default function Pulse() {
  const pulse = useAsync(getPulse, [], { refreshMs: 30 * 60_000 });
  const [range, setRange] = useState(180);
  const d = pulse.data;
  const loading = !d;
  const lsTotal = d ? d.liquidStaking.reduce((s, p) => s + p.tvl, 0) : 0;
  const lsMax = d?.liquidStaking[0]?.tvl || 1;

  return (
    <div className="page page--discover page--pools page--treasury page--pulse">
      <header className="pt-hero">
        <FlowLines />
        <h1 className="pt-title">
          <PageIcon name="pulse" />
          NEAR DeFi Pulse
        </h1>
        <p>The state of DeFi on NEAR: TVL, volume, stablecoins and yields, refreshed every 30 minutes from DefiLlama.</p>
      </header>

      {pulse.error && !d && <ErrorNotice error={pulse.error} onRetry={pulse.reload} />}

      <div className="ts-tiles">
        <Tile label="DeFi TVL on NEAR" loading={loading} value={d && formatUsd(d.tvl.now, K)} hint={d && <Change value={d.tvl.change30d} suffix=" in 30d" />} />
        <Tile
          label="DEX volume 24h"
          loading={loading}
          value={d && formatUsd(d.dex.volume24h, K)}
          hint={
            d && (Number.isFinite(d.dex.intentsShare24h) ? `${d.dex.intentsShare24h.toFixed(0)}% via NEAR Intents` : `${formatUsd(d.dex.volume30d, K)} in 30d`)
          }
        />
        <Tile
          label="Stablecoins on NEAR"
          loading={loading}
          value={d && formatUsd(d.stablecoins.now, K)}
          hint={d && <Change value={d.stablecoins.change30d} suffix=" in 30d" />}
        />
        <Tile label="DeFi fees 30d" loading={loading} value={d && formatUsd(d.fees.fees30d, K)} hint={d && `${formatUsd(d.fees.fees24h, K)} in the last 24h`} />
      </div>

      <div className="pl-top">
      <Section
        className="pl-top__main"
        title="DeFi TVL"
        note={
          d && (
            <>
              7d <Change value={d.tvl.change7d} /> · 30d <Change value={d.tvl.change30d} /> · 90d <Change value={d.tvl.change90d} /> · 1y{' '}
              <Change value={d.tvl.change1y} />
            </>
          )
        }
        action={
          <div className="segmented segmented--tight" role="radiogroup" aria-label="Range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                role="radio"
                aria-checked={range === r.key}
                className={range === r.key ? 'active' : ''}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      >
        {loading ? <Skeleton height={420} /> : <Chart series={d.tvl.series.slice(-range)} />}
      </Section>

      <div className="pl-top__side">
        <Section
          className="pl-small"
          title="Stablecoins"
          note={
            d &&
            `120-day range ${formatUsd(d.stablecoins.low120d[1], K)} (${day(d.stablecoins.low120d[0])}) to ${formatUsd(d.stablecoins.high120d[1], K)} (${day(d.stablecoins.high120d[0])}).`
          }
          action={
            <Link to="/earn" className="pl-cta">
              Earn on USDC →
            </Link>
          }
        >
          {loading ? <Skeleton height={150} /> : <Chart series={d.stablecoins.series.slice(-120)} />}
        </Section>
        <Section
          className="pl-small"
          title="DEX volume · daily"
          note={d && `${formatUsd(d.dex.volume7d, K)} in 7 days · ${formatUsd(d.dex.volume30d, K)} in 30 days.`}
          action={
            <Link to="/bridge" className="pl-cta">
              Bridge via Intents →
            </Link>
          }
        >
          {loading ? <Skeleton height={150} /> : <Chart series={d.dex.series} kind="columns" />}
        </Section>
      </div>
      </div>

      <Section title="Largest DeFi protocols on NEAR" note="By TVL on NEAR. Exchanges' wallets are left out.">
        {loading ? (
          <Skeleton height={300} />
        ) : (
          <div className="pl-table" role="table">
            <div className="pl-row pl-row--head" role="row">
              <span>#</span>
              <span>Protocol</span>
              <span>Category</span>
              <span className="num">TVL</span>
              <span className="num">7d</span>
              <span />
            </div>
            {d.protocols.map((p, i) => (
              <div className="pl-row" role="row" key={p.name}>
                <span className="muted">{i + 1}</span>
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="pl-name">
                  {p.name} ↗
                </a>
                <span className="muted">{p.category}</span>
                <span className="num">{formatUsd(p.tvl, K)}</span>
                <span className="num">
                  <Change value={p.change7d} />
                </span>
                <span className="num">
                  {p.kinu && (
                    <Link to={p.kinu} className="pl-cta">
                      Open on KINU
                    </Link>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="pl-grid2">
        <Section
          title="Liquid staking"
          note={d && `${formatUsd(lsTotal, K)} in NEAR liquid staking tokens.`}
          action={
            <Link to="/stake" className="pl-cta">
              Stake NEAR →
            </Link>
          }
        >
          {loading ? (
            <Skeleton height={200} />
          ) : (
            <div className="pl-bars">
              {d.liquidStaking.map((p) => (
                <div key={p.name} className="pl-barrow">
                  <label>
                    <b>{p.name}</b>
                    <span>
                      {formatUsd(p.tvl, K)} · <Change value={p.change7d} suffix=" 7d" />
                    </span>
                  </label>
                  <div>
                    <i style={{ width: `${(p.tvl / lsMax) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section title="Yields on NEAR" note="Pools with at least $50K TVL, by size. APY changes all the time; it isn't a promise.">
          {loading ? (
            <Skeleton height={200} />
          ) : (
            <div className="pl-table pl-table--yields" role="table">
              <div className="pl-row pl-row--head" role="row">
                <span>Pool</span>
                <span>Project</span>
                <span className="num">TVL</span>
                <span className="num">APY</span>
              </div>
              {d.yields.map((p) => (
                <div className="pl-row" role="row" key={`${p.project}-${p.symbol}`}>
                  <span className="pl-name">{p.symbol}</span>
                  <span className="muted">{p.project}</span>
                  <span className="num">{formatUsd(p.tvl, K)}</span>
                  <span className="num pl-up">{p.apy.toFixed(2)}%</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* One span: .center is a flex row, which would drop the spaces around the link. */}
      <p className="muted small center">
        <span>
          Data:{' '}
          <a href="https://defillama.com/chain/Near" target="_blank" rel="noopener noreferrer">
            DefiLlama
          </a>
          . Days where a protocol&apos;s data is missing are smoothed out of the TVL chart.
          {d && ` Updated ${new Date(d.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`}
        </span>
      </p>
    </div>
  );
}
