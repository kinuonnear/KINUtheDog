// Treasury (/treasury): where $KINU's creator fee goes — what the launch position has earned,
// KINU's health (the trigger for moving LP profits into $KINU support), how each payment is split (operations, audit reserve, liquidity), every allocation with its
// transaction, and the public LP wallet's live positions. Read-only. Not linked from the menu yet.

import { useMemo } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import { baselineVolume, averageVolume, getCreatorFeeInfo, getKinuDailyVolume, HEALTH_RULES, healthStatus, LEDGER, TREASURY } from '../lib/treasury.js';
import { getSwapQuote } from '../lib/swap.js';
import { getTokenPools } from '../lib/tokenMarket.js';
import { loadDclPositions, markDclRows } from '../lib/smartLp.js';
import { getTokens, priceOf } from '../lib/tokens.js';
import { formatAmount, formatUsd, toNumber } from '../lib/format.js';
import { ENDPOINTS, KINU_TOKEN, NATIVE_NEAR } from '../config.js';
import { ErrorNotice, PairIcons, Skeleton } from '../components/ui.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import '../pools.css';
import '../treasury.css';

const K = { compactAbove: 1e3 };
const explorer = (path) => `${ENDPOINTS.explorer}/${path}`;

function Tile({ label, value, hint, loading }) {
  return (
    <div className="ts-tile">
      <span>{label}</span>
      <strong>{loading ? <Skeleton width={110} height={24} /> : value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

const LEVELS = {
  healthy: { label: 'Healthy', text: 'LP profits keep compounding in the strategy.' },
  watch: { label: 'Watch', text: 'Close to the support line: watched more often.' },
  support: { label: 'Support on', text: 'LP profits go to $KINU: deeper liquidity, new pairs, buybacks from profit.' }
};

/** Price impact of buying $KINU with NEAR worth `usd` (best route), in percent. */
async function buyImpact(usd, nearUsd, kinu) {
  const yocto = BigInt(Math.round((usd / nearUsd) * 1e6)) * 10n ** 18n;
  const quote = await getSwapQuote({ tokenIn: NATIVE_NEAR, tokenOut: kinu, amountIn: yocto.toString(), slippage: 0.5 });
  return Number.isFinite(quote?.priceImpact) ? quote.priceImpact : null;
}

/** KINU's volume trend, liquidity and buy impact, and the support trigger they set. */
function KinuHealth({ prices, kinu }) {
  const daily = useAsync(() => getKinuDailyVolume(60), [], { refreshMs: 600_000 });
  const pools = useAsync(() => getTokenPools(KINU_TOKEN), [], { refreshMs: 120_000 });
  const nearUsd = priceOf(prices, 'wrap.near');
  const impacts = useAsync(
    async () => {
      const out = [];
      // One after the other: the swap router rate-limits bursts.
      for (const usd of HEALTH_RULES.probesUsd) out.push({ usd, impact: await buyImpact(usd, nearUsd, kinu).catch(() => null) });
      return out;
    },
    [Boolean(kinu), nearUsd > 0],
    { enabled: Boolean(kinu) && nearUsd > 0 }
  );

  const days = daily.data || [];
  const avg7 = days.length ? averageVolume(days, 7) : null;
  const base = baselineVolume(days);
  const impact100 = impacts.data?.find((p) => p.usd === 100)?.impact;
  const status = daily.data && impacts.data ? healthStatus({ avg7, avg30: base.avg, impact100 }) : null;
  const tvl = pools.data ? pools.data.reduce((s, p) => s + p.tvl, 0) : null;
  const vol24 = pools.data ? pools.data.reduce((s, p) => s + p.volume24, 0) : null;
  const top = pools.data?.[0];
  // The last 30 days, one slot each (days before KINU traded stay empty).
  const byDay = new Map(days.map((d) => [d.time, d.volume]));
  const lastDay = Math.floor(Date.now() / 86_400_000) * 86_400;
  const recent = days.length ? Array.from({ length: 30 }, (_, i) => ({ time: lastDay - (29 - i) * 86_400, volume: byDay.get(lastDay - (29 - i) * 86_400) || 0 })) : [];
  const peak = Math.max(1, ...recent.map((d) => d.volume));

  return (
    <section className="ts-section">
      <h2>
        <span className="ts-step">02</span> $KINU health
      </h2>
      <p className="muted">
        The line for support: when KINU&apos;s 7-day volume falls {HEALTH_RULES.volumeDropPct}% below its baseline, or a $100 buy moves the
        price {HEALTH_RULES.impactSupportPct}% or more, LP profits go to $KINU instead of compounding.
      </p>
      <div className={`ts-status ts-status--${status?.level || 'loading'}`}>
        <strong>{status ? LEVELS[status.level].label : 'Checking…'}</strong>
        <span>{status ? (status.reasons.length ? status.reasons.join(' · ') : LEVELS[status.level].text) : 'Reading volume, liquidity and buy impact.'}</span>
      </div>
      <div className="ts-tiles">
        <Tile label="Volume 24h (all pools)" loading={vol24 === null} value={formatUsd(vol24, K)} hint={top ? `${pools.data.length} pools · most in ${top.name}` : null} />
        <Tile
          label="Avg daily volume · 7d"
          loading={!daily.data && !daily.error}
          value={avg7 !== null ? formatUsd(avg7, K) : '—'}
          hint={base.avg !== null ? `Baseline (${base.days}d): ${formatUsd(base.avg, K)}` : `Trend after ${HEALTH_RULES.minDaysForTrend} days of history (${base.days} so far)`}
        />
        <Tile label="Liquidity (all pools)" loading={tvl === null} value={formatUsd(tvl, K)} hint={top ? `${formatUsd(top.tvl, K)} in ${top.name}` : null} />
        {HEALTH_RULES.probesUsd.map((usd) => {
          const probe = impacts.data?.find((p) => p.usd === usd);
          return (
            <Tile
              key={usd}
              label={`Price impact · $${usd.toLocaleString()} buy`}
              loading={!impacts.data && !impacts.error}
              value={probe && Number.isFinite(probe.impact) ? `${probe.impact.toFixed(2)}%` : '—'}
              hint="NEAR → KINU, best route, before the 1% token tax"
            />
          );
        })}
      </div>
      {recent.length > 0 && (
        <div className="ts-bars" aria-label="KINU daily volume, last 30 days">
          {recent.map((d) => (
            <i key={d.time} className={d.volume ? undefined : 'ts-bars__empty'} style={{ height: `${Math.max(2, (d.volume / peak) * 100)}%` }} title={`${new Date(d.time * 1000).toISOString().slice(0, 10)} · ${formatUsd(d.volume, K)}`} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function Treasury() {
  const { prices } = useApp();
  const info = useAsync(getCreatorFeeInfo, [], { refreshMs: 120_000 });
  const quoteId = info.data?.quote;
  const tokens = useAsync(() => getTokens([KINU_TOKEN, quoteId].filter(Boolean)), [quoteId]);
  const positions = useAsync(() => loadDclPositions(TREASURY.lpWallet), [], { refreshMs: 60_000 });
  const rows = useMemo(() => (positions.data ? markDclRows(positions.data.dcl, positions.data.tokens, prices) : null), [positions.data, prices]);

  const quote = quoteId ? tokens.data?.[quoteId] : null;
  const kinu = tokens.data?.[KINU_TOKEN];
  const fees = useMemo(() => {
    if (!info.data || !quote) return null;
    const amount = toNumber(info.data.feesQuoteRaw, quote.decimals);
    const share = info.data.shareBps / 10_000;
    return { amount, usd: amount * priceOf(prices, quote.id), share, creator: amount * share };
  }, [info.data, quote, prices]);
  const kinuFees = info.data && kinu ? toNumber(info.data.feesTokenRaw, kinu.decimals) : null;

  const lp = useMemo(() => {
    if (!rows) return null;
    return { usd: rows.reduce((s, r) => s + r.usd, 0), feeUsd: rows.reduce((s, r) => s + r.feeUsd, 0), count: rows.length };
  }, [rows]);
  const totals = LEDGER.reduce((t, e) => ({ rhea: t.rhea + e.rhea, ops: t.ops + e.ops, audit: t.audit + e.audit, lp: t.lp + e.lp }), { rhea: 0, ops: 0, audit: 0, lp: 0 });
  const symbol = quote?.symbol || 'RHEA';

  return (
    <div className="page page--discover page--pools page--treasury">
      <header className="pt-hero">
        <FlowLines />
        <h1 className="pt-title">Treasury</h1>
        <p>Where $KINU&apos;s creator fee goes: operations first, the rest into liquidity. Every number links to the chain.</p>
      </header>

      {/* 1. What comes in */}
      <section className="ts-section">
        <h2>
          <span className="ts-step">01</span> Creator fee in
        </h2>
        <p className="muted">
          KINU launched on Nearly. Its launch position in the KINU/{symbol} pool earns trading fees, and the creator&apos;s share is paid to{' '}
          <a href={explorer(`address/${TREASURY.creator}`)} target="_blank" rel="noopener noreferrer" className="mono">
            {TREASURY.creator}
          </a>{' '}
          in {symbol}.
        </p>
        {info.error ? (
          <ErrorNotice error={info.error} onRetry={info.reload} />
        ) : (
          <div className="ts-tiles">
            <Tile
              label={`Launch position fees (${symbol})`}
              loading={!fees}
              value={fees ? `${formatAmount(fees.amount)} ${symbol}` : null}
              hint={fees ? `≈ ${formatUsd(fees.usd, K)} · all-time, per Nearly` : null}
            />
            <Tile
              label="Creator share"
              loading={!info.data}
              value={info.data ? `${(info.data.shareBps / 100).toFixed(0)}%` : null}
              hint={fees ? `≈ ${formatAmount(fees.creator)} ${symbol} to the creator` : null}
            />
            <Tile label="Claims" loading={!info.data} value={info.data?.claims} hint="Fee claims from the launch position" />
            <Tile
              label="Launch position fees (KINU)"
              loading={kinuFees === null}
              value={kinuFees !== null ? `${formatAmount(kinuFees)} KINU` : null}
              hint="KINU side, all-time"
            />
          </div>
        )}
        {info.data?.poolId && (
          <Link to={poolPath(info.data.poolId)} className="ts-link">
            Open the KINU/{symbol} pool →
          </Link>
        )}
      </section>

      <KinuHealth prices={prices} kinu={kinu} />

      {/* 3. How it is split */}
      <section className="ts-section">
        <h2>
          <span className="ts-step">03</span> How it is split
        </h2>
        <div className="ts-split" aria-hidden>
          {TREASURY.split.map((s) => (
            <i key={s.key} className={`ts-split__bar ts-split__bar--${s.key}`} style={{ width: `${s.pct}%` }} />
          ))}
        </div>
        <div className="ts-buckets">
          {TREASURY.split.map((s) => (
            <div key={s.key} className="ts-bucket">
              <span className={`ts-dot ts-dot--${s.key}`} aria-hidden />
              <div>
                <strong>
                  {s.label} · {s.pct}%
                </strong>
                <p className="muted small">{s.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 4. Every allocation */}
      <section className="ts-section">
        <h2>
          <span className="ts-step">04</span> Allocations
        </h2>
        {LEDGER.length ? (
          <div className="ts-table" role="table">
            <div className="ts-row ts-row--head" role="row">
              <span>Date</span>
              <span>Received</span>
              <span>Operations</span>
              <span>Audit</span>
              <span>Liquidity</span>
              <span>Tx</span>
            </div>
            {LEDGER.map((e) => (
              <div className="ts-row" role="row" key={`${e.date}-${e.tx || e.note}`}>
                <span>{e.date}</span>
                <span>{formatAmount(e.rhea)} {symbol}</span>
                <span>{formatAmount(e.ops)}</span>
                <span>{formatAmount(e.audit)}</span>
                <span>{formatAmount(e.lp)}</span>
                <span>
                  {e.tx ? (
                    <a href={explorer(`txns/${e.tx}`)} target="_blank" rel="noopener noreferrer">
                      View ↗
                    </a>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
            ))}
            <div className="ts-row ts-row--total" role="row">
              <span>Total</span>
              <span>{formatAmount(totals.rhea)} {symbol}</span>
              <span>{formatAmount(totals.ops)}</span>
              <span>{formatAmount(totals.audit)}</span>
              <span>{formatAmount(totals.lp)}</span>
              <span />
            </div>
          </div>
        ) : (
          <p className="ts-empty muted">The first allocation will be listed here, with its transaction, when it is made.</p>
        )}
      </section>

      {/* 5. The liquidity it funds */}
      <section className="ts-section">
        <h2>
          <span className="ts-step">05</span> Public LP wallet
        </h2>
        <p className="muted">
          Liquidity is held in{' '}
          <a href={explorer(`address/${TREASURY.lpWallet}`)} target="_blank" rel="noopener noreferrer" className="mono">
            {TREASURY.lpWallet}
          </a>
          . Anyone can follow its positions, fees and PnL.
        </p>
        {positions.error ? (
          <ErrorNotice error={positions.error} onRetry={positions.reload} />
        ) : (
          <>
            <div className="ts-tiles">
              <Tile label="Total liquidity" loading={!lp} value={lp ? formatUsd(lp.usd, K) : null} />
              <Tile label="Unclaimed fees" loading={!lp} value={lp ? formatUsd(lp.feeUsd, K) : null} />
              <Tile label="Open positions" loading={!lp} value={lp?.count} />
            </div>
            {rows?.length > 0 && (
              <div className="ts-positions">
                {rows.map((r) => (
                  <Link key={r.id || `${r.poolId}-${r.lptId}`} to={poolPath(r.poolId)} className="ts-position">
                    <PairIcons tokens={[r.x, r.y]} size={22} />
                    <span>
                      {r.x.symbol}/{r.y.symbol}
                    </span>
                    <strong>{formatUsd(r.usd, K)}</strong>
                    <em className={r.inRange ? 'up' : 'muted'}>{r.inRange ? 'In range' : 'Out of range'}</em>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
        <Link to={`/lp/${TREASURY.lpWallet}`} className="ts-link">
          Full history, PnL and closed positions →
        </Link>
      </section>

      <p className="ts-note muted small">
        The creator fee depends on trading volume and can be small or zero. Liquidity carries risk, including impermanent loss. This page reports
        what happens with the fee; it is not an offer or a promise of returns.
      </p>
    </div>
  );
}
