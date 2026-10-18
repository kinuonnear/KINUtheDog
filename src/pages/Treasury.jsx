// Treasury (/treasury): where $KINU's creator fee goes — what the launch position has earned,
// KINU's health (the trigger for moving LP profits into $KINU support), how each payment is split (operations, audit reserve, liquidity), every allocation with its
// transaction, and the public LP wallet's live positions. Read-only. Linked from the More menu.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import { baselineVolume, averageVolume, getCreatorFeeInfo, getKinuDailyVolume, HEALTH_RULES, healthStatus, LEDGER, TREASURY } from '../lib/treasury.js';
import { getSwapQuote } from '../lib/swap.js';
import { getTokenPools } from '../lib/tokenMarket.js';
import { loadDclPositions, markDclRows } from '../lib/smartLp.js';
import { asPoolToken, getTokens, priceOf } from '../lib/tokens.js';
import { getClassicPositions } from '../lib/rhea.js';
import { formatAmount, formatUsd, toNumber } from '../lib/format.js';
import { bpsText, ENDPOINTS, INTEAR_FEE, INTEAR_REFERRER, KINU_TOKEN, NATIVE_NEAR, PLATFORM_FEE, PLATFORM_FEE_TOKENS } from '../config.js';
import { ensureStorageTx, isStorageRegistered } from '../lib/tx.js';
import { convertToUsdc, getIntentsHoldings, withdrawToWalletTxs } from '../lib/intentsTreasury.js';
import { CHAIN_NAMES } from '../lib/intents.js';
import { ErrorNotice, PairIcons, Skeleton, Spinner } from '../components/ui.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import PageIcon from '../components/PageIcon.jsx';
import '../pools.css';
import '../treasury.css';

const K = { compactAbove: 1e3 };
const explorer = (path) => `${ENDPOINTS.explorer}/${path}`;
// KINU's own accounts: the creator / LP wallet and the treasury itself.
const FEE_ADMINS = new Set([TREASURY.creator, PLATFORM_FEE.treasury]);

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

/**
 * For KINU's own accounts only: register the treasury on the tokens it takes the platform fee in.
 * A fee in a token the treasury isn't registered on is skipped, so users never pay its storage.
 */
function FeeSetup() {
  const { accountId, execute } = useApp();
  const status = useAsync(
    () => Promise.all(PLATFORM_FEE_TOKENS.map(async (t) => ({ ...t, ok: await isStorageRegistered(t.id, PLATFORM_FEE.treasury).catch(() => null) }))),
    [],
    { enabled: FEE_ADMINS.has(accountId) }
  );
  if (!FEE_ADMINS.has(accountId)) return null;
  const list = status.data || [];
  const missing = list.filter((t) => t.ok === false);
  const register = async () => {
    const done = await execute(
      async () => (await Promise.all(missing.map((t) => ensureStorageTx(t.id, PLATFORM_FEE.treasury)))).filter(Boolean),
      { pending: `Registering ${PLATFORM_FEE.treasury} on ${missing.length} token(s)`, success: 'Treasury registered' }
    );
    if (done) status.reload();
  };
  return (
    <section className="ts-section ts-admin">
      <h2>Platform fee setup</h2>
      <p className="muted small">
        Visible to KINU&apos;s accounts only. The platform fee ({bpsText(PLATFORM_FEE.bps)}, currently {PLATFORM_FEE.enabled ? 'ON' : 'OFF'}) is only taken in
        tokens <span className="mono">{PLATFORM_FEE.treasury}</span> is registered on. Registering costs about 0.00125 NEAR per token, paid by the signing
        account.
      </p>
      {!status.data ? (
        <Skeleton height={60} />
      ) : (
        <div className="ts-admin__tokens">
          {list.map((t) => (
            <span key={t.id} className={t.ok ? 'up' : t.ok === false ? 'down' : 'muted'} title={t.id}>
              {t.ok ? '✓' : t.ok === false ? '✗' : '?'} {t.symbol}
            </span>
          ))}
        </div>
      )}
      <button type="button" className="button button--primary" disabled={!missing.length} onClick={register}>
        {status.data && !missing.length ? 'Registered on every fee token' : `Register treasury on ${missing.length} token(s)`}
      </button>
    </section>
  );
}

// 1Click won't route much below ~$12 (lib/earn.js), so conversions start here.
const CONVERT_MIN_USD = 15;

/**
 * Bridge and Earn fees: paid into the treasury's balance inside NEAR Intents. Public; the treasury
 * account itself can withdraw NEAR tokens to its wallet or convert bridged ones to USDC.
 */
function IntentsFees() {
  const { accountId, execute, toast } = useApp();
  const owner = PLATFORM_FEE.treasury;
  const holdings = useAsync(() => getIntentsHoldings(owner), [], { refreshMs: 120_000 });
  const [busy, setBusy] = useState('');
  const isOwner = accountId === owner;
  const total = (holdings.data || []).reduce((s, h) => s + h.usd, 0);
  const amountText = (h) => formatAmount(Number(h.amount) / 10 ** h.decimals);

  const withdraw = async (h) => {
    setBusy(h.assetId);
    const done = await execute(() => withdrawToWalletTxs({ assetId: h.assetId, amount: h.amount, accountId }), {
      pending: `Withdrawing ${amountText(h)} ${h.symbol} to ${owner}`,
      success: 'Fees withdrawn to the treasury wallet'
    });
    setBusy('');
    if (done) holdings.reload();
  };
  const convert = async (h) => {
    setBusy(h.assetId);
    try {
      await convertToUsdc({
        assetId: h.assetId,
        amount: h.amount,
        accountId,
        registerKey: (txs) => execute(async () => txs, { pending: 'Registering the treasury key with NEAR Intents (one time)', success: 'Key registered' })
      });
      toast('success', 'Conversion sent', `${h.symbol} → USDC, paid to ${owner} in a few minutes.`);
      setTimeout(() => holdings.reload(), 20_000);
    } catch (e) {
      toast('error', 'Conversion not sent', e.message || String(e));
    }
    setBusy('');
  };

  return (
    <section className="ts-section">
      <h2>Bridge &amp; Earn fees</h2>
      <p className="muted">
        KINU&apos;s share of Bridge and Earn fees is paid by NEAR Intents into{' '}
        <a href={`https://near-intents.org/account?user=near:${owner}`} target="_blank" rel="noopener noreferrer" className="mono">
          {owner}
        </a>
        &apos;s balance inside NEAR Intents, in the token each user sent.
      </p>
      {holdings.error && <ErrorNotice error={holdings.error} onRetry={holdings.reload} />}
      {!holdings.data && !holdings.error && <Skeleton height={80} />}
      {holdings.data && (
        <>
          <div className="ts-tiles">
            <Tile label="Fee balance in NEAR Intents" value={formatUsd(total)} hint={`${holdings.data.length} token${holdings.data.length === 1 ? '' : 's'}`} />
          </div>
          {holdings.data.length > 0 && (
            <div className="ts-ifees">
              {holdings.data.map((h) => (
                <div key={h.assetId} className="ts-ifee">
                  <div>
                    <b>
                      {amountText(h)} {h.symbol}
                    </b>
                    <small className="muted">
                      ≈ {formatUsd(h.usd)}
                      {h.chain && h.chain !== 'near' ? ` · bridged from ${CHAIN_NAMES[h.chain] || h.chain}` : ''}
                    </small>
                  </div>
                  {isOwner &&
                    (h.onNear ? (
                      <button type="button" className="button button--outline button--sm" disabled={Boolean(busy)} onClick={() => withdraw(h)}>
                        {busy === h.assetId && <Spinner size={12} />} Withdraw to wallet
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button button--outline button--sm"
                        disabled={Boolean(busy) || h.usd < CONVERT_MIN_USD}
                        title={h.usd < CONVERT_MIN_USD ? `NEAR Intents converts from about ${CONVERT_MIN_USD}` : undefined}
                        onClick={() => convert(h)}
                      >
                        {busy === h.assetId && <Spinner size={12} />} {h.usd < CONVERT_MIN_USD ? `Convert from ${CONVERT_MIN_USD}` : 'Convert to USDC'}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          )}
          {isOwner && (
            <p className="muted small">
              NEAR tokens come out to the treasury wallet as they are. Bridged tokens and vault shares are converted to USDC on NEAR (from ≈ $
              {CONVERT_MIN_USD}; you sign a message, and the first time register the key with NEAR Intents).
            </p>
          )}
        </>
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
  // AMM (classic) positions too: fees there compound into the shares, nothing to claim.
  const classic = useAsync(
    async () => {
      const list = await getClassicPositions(TREASURY.lpWallet);
      const meta = await getTokens([...new Set(list.flatMap((c) => c.pool.tokenIds))]);
      return { list, meta };
    },
    [],
    { refreshMs: 60_000 }
  );
  const rows = useMemo(() => {
    if (!positions.data || !classic.data) return null;
    const dcl = markDclRows(positions.data.dcl, positions.data.tokens, prices).map((r) => ({
      key: `dcl-${r.id}`,
      poolId: r.poolId,
      x: r.x,
      y: r.y,
      usd: r.usd,
      feeUsd: r.feeUsd,
      kind: 'CLMM',
      state: r.inRange ? 'In range' : 'Out of range',
      up: r.inRange
    }));
    const amm = classic.data.list
      .filter((c) => c.pool.tokenIds.length === 2)
      .map((c) => {
        const [x, y] = c.pool.tokenIds.map((id) => asPoolToken(classic.data.meta[id] || { id, symbol: id.slice(0, 6), decimals: 0 }));
        const usd = c.amounts.reduce((sum, a, i) => sum + toNumber(a, [x, y][i].decimals) * priceOf(prices, c.pool.tokenIds[i]), 0);
        const share = Number(c.totalShares) / Number(c.pool.sharesTotalSupply || 1);
        return { key: `amm-${c.pool.id}`, poolId: c.pool.id, x, y, usd, feeUsd: 0, kind: `AMM ${c.pool.feePercent}%`, state: `${(share * 100).toFixed(1)}% of pool`, up: true };
      });
    return [...amm, ...dcl].sort((a, b) => b.usd - a.usd);
  }, [positions.data, classic.data, prices]);

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
  const symbol = quote?.symbol || 'RHEA';

  return (
    <div className="page page--discover page--pools page--treasury">
      <header className="pt-hero">
        <FlowLines />
        <h1 className="pt-title">
          <PageIcon name="treasury" />
          Treasury
        </h1>
        <p>Where $KINU&apos;s creator fee goes: operations first, the rest into liquidity. Every number links to the chain.</p>
      </header>

      <FeeSetup />
      <IntentsFees />

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
        {INTEAR_FEE.live && (
          <p className="muted small">
            Also in: KINU&apos;s {bpsText(INTEAR_FEE.bps)} fee on swaps routed through the Intear aggregator (80% to KINU),
            paid to{' '}
            <a href={explorer(`address/${INTEAR_REFERRER}`)} target="_blank" rel="noopener noreferrer" className="mono">
              {INTEAR_REFERRER}
            </a>
            . It is split the same way.
          </p>
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
              <div className="ts-entry" key={`${e.date}-${e.txs?.[0]?.hash || e.source}`}>
                <div className="ts-row" role="row">
                  <span>{e.date}</span>
                  <span>{e.source}</span>
                  <span>{e.ops || '—'}</span>
                  <span>{e.audit || '—'}</span>
                  <span>{e.lp || '—'}</span>
                  <span className="ts-txs">
                    {(e.txs || []).map((tx) => (
                      <a key={tx.hash} href={explorer(`txns/${tx.hash}`)} target="_blank" rel="noopener noreferrer">
                        {tx.label} ↗
                      </a>
                    ))}
                  </span>
                </div>
                {e.note && <p className="ts-entry__note muted small">{e.note}</p>}
              </div>
            ))}
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
        {positions.error || classic.error ? (
          <ErrorNotice error={positions.error || classic.error} onRetry={positions.error ? positions.reload : classic.reload} />
        ) : (
          <>
            <div className="ts-tiles">
              <Tile label="Total liquidity" loading={!lp} value={lp ? formatUsd(lp.usd, K) : null} />
              <Tile label="Unclaimed fees" loading={!lp} value={lp ? formatUsd(lp.feeUsd, K) : null} hint="CLMM; AMM fees compound into the shares" />
              <Tile label="Open positions" loading={!lp} value={lp?.count} />
            </div>
            {rows?.length > 0 && (
              <div className="ts-positions">
                {rows.map((r) => (
                  <Link key={r.key} to={poolPath(r.poolId)} className="ts-position">
                    <PairIcons tokens={[r.x, r.y]} size={22} />
                    <span>
                      {r.x.symbol}/{r.y.symbol} <small className="muted">{r.kind}</small>
                    </span>
                    <strong>{formatUsd(r.usd, K)}</strong>
                    <em className={r.up ? 'up' : 'muted'}>{r.state}</em>
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
