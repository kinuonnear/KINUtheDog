// Pool Analysis (/analysis?token=…): where buyers and sellers of a token wait, across every Rhea
// pool that holds it (lib/liquidityMap.js). Key levels from liquidity, not from the price line;
// how far a buy or sell moves the price; and which pool carries the depth. Read-only, no wallet.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useMediaQuery } from '../hooks.js';
import { Link, navigate, poolPath, useLocation } from '../router.jsx';
import { depthTo, getLiquidityMap, keyLevels, MAP_REFRESH_MS, MAP_VIEWS, mapView, priceMove } from '../lib/liquidityMap.js';
import { getToken } from '../lib/tokens.js';
import { formatChartPrice, formatPercent, formatUsd } from '../lib/format.js';
import { ErrorNotice, Skeleton, Tabs, TokenIcon } from '../components/ui.jsx';
import TokenPicker from '../components/TokenPicker.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import PageIcon from '../components/PageIcon.jsx';
import '../pools.css';
import '../treasury.css';
import '../pulse.css';
import '../analysis.css';

const K = { compactAbove: 1e3 };
const DEFAULT_TOKEN = 'kinu-3.nearlytrade.near';
const QUICK = [
  { id: 'kinu-3.nearlytrade.near', symbol: 'KINU' },
  { id: 'token.rhealab.near', symbol: 'RHEA' },
  { id: 'wrap.near', symbol: 'NEAR' },
  { id: 'qtc.omft.near', symbol: 'QTC' }
];
// What each level means, by kind and side (resistance = above the price, support = below).
const LEVEL_LABEL = {
  step: { resistance: 'Sell wall from', support: 'Buy wall from' },
  peak: { resistance: 'Sell wall', support: 'Buy wall' },
  thin: { resistance: 'Thin above', support: 'Thin below' }
};
const SIZES = [1e3, 1e4, 1e5, 1e6];
const STEPS = [-2, -5, -10, 2, 5, 10];

const signed = (v, digits = 1) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${formatPercent(v, digits)}`);

function Tile({ label, value, hint, loading }) {
  return (
    <div className="ts-tile">
      <span>{label}</span>
      <strong>{loading ? <Skeleton width={110} height={24} /> : value}</strong>
      {hint && <small>{loading ? <Skeleton width={90} height={12} /> : hint}</small>}
    </div>
  );
}

/**
 * The merged book as a landscape depth chart: one column per 1% step, buyers (support) left of the
 * price line, sellers (resistance) right of it, each column split into CLMM, AMM and limit orders.
 */
function Book({ view, price, max }) {
  const [hover, setHover] = useState(null);
  const phone = useMediaQuery('(max-width: 760px)');
  const rows = view.rows; // k ascending: lowest price on the left
  const split = rows.findIndex((r) => r.side === 'resistance');
  const h = (v) => (max > 0 ? `${(v / max) * 100}%` : '0%');
  // About 10 price labels under the chart (5 on phones), whatever the view.
  const every = Math.max(1, Math.round(rows.length / (phone ? 5 : 10)));
  const label = (r) => `${r.pct > 0 ? '+' : ''}${Math.round(r.pct)}%`;
  const shown = hover !== null ? rows[hover] : null;
  const col = (r, i) => (
    <span key={r.k} className={`pa-col pa-col--${r.side}${hover === i ? ' is-hover' : ''}`} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
      {/* Stacked from the bottom: CLMM, then AMM, then limit orders. */}
      <i className="pa-col__clmm" style={{ height: h(r.clmm) }} />
      {r.amm > 0 && <i className="pa-col__amm" style={{ height: h(r.amm) }} />}
      {r.orders > 0 && <i className="pa-col__orders" style={{ height: h(r.orders) }} />}
    </span>
  );
  return (
    <div className="pa-land" onMouseLeave={() => setHover(null)}>
      <div className="pa-land__readout" aria-live="polite">
        {shown ? (
          <>
            <b>${formatChartPrice(price * (1 + shown.mid / 100))}</b>
            <em className={shown.side === 'support' ? 'is-support' : 'is-resistance'}>{signed(shown.mid)}</em>
            <span>{formatUsd(shown.total, K)} {shown.side === 'support' ? 'to buy' : 'for sale'}</span>
            {shown.orders > 0 && <small>incl. {formatUsd(shown.orders, K)} limit orders</small>}
          </>
        ) : (
          <span className="muted">{phone ? 'Tap' : 'Hover'} a column · tallest {formatUsd(max, K)} per 1%</span>
        )}
      </div>
      <div className="pa-land__plot" role="img" aria-label="Liquidity by price step">
        {rows.slice(0, split).map((r, i) => col(r, i))}
        <span className="pa-land__now">
          <b>${formatChartPrice(price)}</b>
        </span>
        {rows.slice(split).map((r, i) => col(r, i + split))}
      </div>
      <div className="pa-land__axis" aria-hidden="true">
        {rows.slice(0, split).map((r, i) => (
          <span key={r.k}>{(split - i) % every === 0 ? label(r) : ''}</span>
        ))}
        <span className="pa-land__axis-now">0</span>
        {rows.slice(split).map((r, i) => (
          <span key={r.k}>{(i + 1) % every === 0 ? label(r) : ''}</span>
        ))}
      </div>
    </div>
  );
}

export default function PoolAnalysis() {
  const { prices } = useApp();
  const { search } = useLocation();
  const tokenId = search.get('token') || DEFAULT_TOKEN;
  const [picking, setPicking] = useState(false);
  const [viewKey, setViewKey] = useState('25');

  const token = useAsync(() => getToken(tokenId), [tokenId]);
  const pricesReady = Boolean(prices?.size);
  const map = useAsync(() => getLiquidityMap(tokenId, prices), [tokenId, pricesReady], { enabled: pricesReady, refreshMs: MAP_REFRESH_MS });

  const view = useMemo(() => (map.data ? mapView(map.data, MAP_VIEWS.find((v) => v.key === viewKey) || MAP_VIEWS[0]) : null), [map.data, viewKey]);
  const levels = useMemo(() => (view ? keyLevels(view) : null), [view]);
  // Price moves are read on the widest view so big sizes still land inside it.
  const wide = useMemo(() => (map.data ? mapView(map.data, MAP_VIEWS[MAP_VIEWS.length - 1]) : null), [map.data]);

  const d = map.data;
  const loading = !d && !map.error;
  const price = d?.priceUsd || 0;
  const symbol = token.data?.symbol || '';
  const mapped = d ? d.pools.filter((p) => p.mapped) : [];
  const at = (pct) => price * (1 + pct / 100);
  const level = (l) => (
    <li key={`${l.side}${l.kind}${l.pct}`} className={`pa-level pa-level--${l.kind === 'thin' ? 'thin' : l.side}`}>
      <span>{LEVEL_LABEL[l.kind][l.side]}</span>
      <b>${formatChartPrice(at(l.pct))}</b>
      <em>{signed(l.pct)}</em>
      <small>{l.kind === 'peak' ? formatUsd(l.usd, K) : `${formatUsd(l.before, K)} → ${formatUsd(l.after, K)}`}</small>
    </li>
  );
  const pick = (id) => navigate(`/analysis?token=${encodeURIComponent(id)}`);

  return (
    <div className="page page--discover page--pools page--treasury page--analysis">
      <header className="pt-hero">
        <FlowLines />
        <h1 className="pt-title">
          <PageIcon name="analysis" />
          Pool Analysis
        </h1>
        <p>Where buyers and sellers of a token are waiting, across every Rhea pool that holds it.</p>
      </header>

      <div className="pa-pick">
        <button type="button" className="pa-token" onClick={() => setPicking(true)}>
          {token.data ? <TokenIcon token={token.data} size={28} /> : <Skeleton width={28} height={28} radius={14} />}
          <strong>{symbol || '…'}</strong>
          <span aria-hidden>▾</span>
        </button>
        <div className="pa-quick" role="group" aria-label="Popular tokens">
          {QUICK.map((q) => (
            <button key={q.id} type="button" className={q.id === tokenId ? 'active' : ''} onClick={() => pick(q.id)}>
              {q.symbol}
            </button>
          ))}
        </div>
        <span className="chart-toolbar__spacer" />
        <Link className="pa-swap" to={`/swap?from=near&to=${encodeURIComponent(tokenId)}`}>
          Chart &amp; swap {symbol} →
        </Link>
      </div>

      {map.error && !d && <ErrorNotice error={map.error} onRetry={map.reload} />}

      <div className="ts-tiles">
        <Tile label={`${symbol} price`} loading={loading} value={price ? `$${formatChartPrice(price)}` : '—'} hint={`across ${mapped.length} pools`} />
        <Tile label={`Support (${MAP_VIEWS.find((v) => v.key === viewKey)?.label})`} loading={loading} value={view && formatUsd(view.support, K)} hint="USD waiting to buy below the price" />
        <Tile label={`Resistance (${MAP_VIEWS.find((v) => v.key === viewKey)?.label})`} loading={loading} value={view && formatUsd(view.resistance, K)} hint={`${symbol} waiting to be sold above the price`} />
        <Tile label="Buyer share" loading={loading} value={view?.balance === null || !view ? '—' : `${view.balance.toFixed(0)}%`} hint="of the depth in view; 50% = balanced" />
      </div>

      <div className="pa-grid">
        <section className="ts-section pa-book">
          <div className="pl-head">
            <h2>Liquidity map</h2>
            <Tabs size="sm" tabs={MAP_VIEWS.map((v) => ({ key: v.key, label: v.label }))} value={viewKey} onChange={setViewKey} />
          </div>
          <p className="muted small">Liquidity per 1% price step, in USD. Left of the price: buyers (support). Right: sellers (resistance).</p>
          {!view ? (
            <Skeleton height={240} radius={12} />
          ) : view.max === 0 ? (
            <p className="muted">No mapped liquidity for {symbol} on Rhea.</p>
          ) : (
            <Book view={view} price={price} max={view.max} />
          )}
          <p className="pdepth__note muted">
            <span className="pdepth__key pdepth__key--liquidity" /> CLMM <span className="pdepth__key pa-key--amm" /> AMM <span className="pdepth__key pdepth__key--orders" /> Limit orders
          </p>
        </section>

          <section className="ts-section pa-levels-card">
            <div className="pl-head">
              <h2>Key levels</h2>
            </div>
            <p className="muted small">Where the depth per 1% jumps (walls) or runs out (thin), in the {MAP_VIEWS.find((v) => v.key === viewKey)?.label} view. Numbers: USD per 1% before → after.</p>
            {!levels ? (
              <Skeleton height={120} radius={10} />
            ) : (
              <ul className="pa-levels">
                {levels.filter((l) => l.pct > 0).map(level)}
                <li className="pa-level pa-level--now">
                  <span>Price now</span>
                  <b>${formatChartPrice(price)}</b>
                </li>
                {levels.filter((l) => l.pct <= 0).map(level)}
                {!levels.length && <li className="muted small">Liquidity is spread evenly: no clear walls or gaps.</li>}
              </ul>
            )}
          </section>

          <section className="ts-section pa-impact">
            <div className="pl-head">
              <h2>Price impact</h2>
            </div>
            <p className="muted small">How far one trade moves the pool price, if no one else trades. Rule of thumb: move ≈ size ÷ USD per 1%.</p>
            {!wide ? (
              <Skeleton height={120} radius={10} />
            ) : (
              <table className="pa-table">
                <thead>
                  <tr>
                    <th>Size</th>
                    <th>Buy</th>
                    <th>Sell</th>
                  </tr>
                </thead>
                <tbody>
                  {SIZES.map((s) => {
                    const up = priceMove(wide, s, 'buy');
                    const down = priceMove(wide, s, 'sell');
                    return (
                      <tr key={s}>
                        <td>{formatUsd(s, K)}</td>
                        <td className="up">{up === null ? '> ×2' : signed(up)}</td>
                        <td className="down">{down === null ? '< ½' : signed(down)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {wide && (
              <div className="pa-steps">
                {STEPS.map((p) => (
                  <span key={p}>
                    <small>to {signed(p, 0)}</small>
                    <b>{formatUsd(depthTo(wide, p), K)}</b>
                  </span>
                ))}
              </div>
            )}
          </section>

      <section className="ts-section pa-pools-card">
        <div className="pl-head">
          <h2>Pools</h2>
        </div>
        <p className="muted small">Each pool's part of the depth in view, and its price against {symbol}'s market price (a gap is room for arbitrage).</p>
        {!view ? (
          <Skeleton height={140} radius={10} />
        ) : (
          <div className="pa-pools">
            <table className="pa-table">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th>Type</th>
                  <th>TVL</th>
                  <th>Support</th>
                  <th>Resistance</th>
                  <th>Share</th>
                  <th>Price gap</th>
                </tr>
              </thead>
              <tbody>
                {view.pools.map((p) => (
                  <tr key={p.id} className={p.mapped ? '' : 'muted'}>
                    <td>
                      <Link to={poolPath(p.id)}>{p.symbols.join(' / ')}</Link>
                      {p.feePercent > 0 && <small> {formatPercent(p.feePercent, 2)}</small>}
                    </td>
                    <td>{p.label}</td>
                    <td>{formatUsd(p.tvl, K)}</td>
                    <td>{p.mapped ? formatUsd(p.support, K) : '—'}</td>
                    <td>{p.mapped ? formatUsd(p.resistance, K) : '—'}</td>
                    <td>{p.mapped ? `${p.share.toFixed(0)}%` : p.reason}</td>
                    <td className={p.gapPct > 0.5 ? 'up' : p.gapPct < -0.5 ? 'down' : ''}>{p.mapped && Number.isFinite(p.gapPct) ? (Math.abs(p.gapPct) < 0.005 ? '0.00%' : signed(p.gapPct, 2)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </div>

      <p className="pa-note muted small">
        LPs can add, move or remove liquidity at any time: this is a snapshot, not a forecast or financial advice.
      </p>

      {picking && <TokenPicker title="Analyse a token" selectedId={tokenId} onSelect={(t) => pick(t.id === 'near' ? 'wrap.near' : t.id)} onClose={() => setPicking(false)} />}
    </div>
  );
}
