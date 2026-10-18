// Stake (/stake): liquid staking with LiNEAR (linear-protocol.near) or stNEAR (meta-pool.near), the
// two longest-running, DAO-owned liquid staking contracts on NEAR (lib/staking.js). Stake NEAR for a
// token that grows in NEAR value every epoch (~7 h) and can go into Rhea pools; leave instantly (by
// selling it, priced here) or through a delayed unstake withdrawable after about four epochs.
// Non-custodial: the wallet calls the staking contract directly.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import {
  formatWait,
  getApyHistory,
  getEpochClock,
  getStakeEarnings,
  getLstPools,
  getPosition,
  getStakingApy,
  liquidUnstakeQuote,
  liquidUnstakeTx,
  nearFor,
  priceOf,
  secondsUntilEpoch,
  sharesFor,
  STAKING,
  stakeTx,
  totalStaked,
  unstakeTx,
  withdrawTx
} from '../lib/staking.js';
import { buildSwapTransactions, getSwapQuote } from '../lib/swap.js';
import { getTokens } from '../lib/tokens.js';
import { formatAmount, formatUnits, formatUsd, toBigInt, tryParseUnits } from '../lib/format.js';
import { bpsText, NATIVE_NEAR, NEAR_GAS_RESERVE, PLATFORM_FEE } from '../config.js';
import { ErrorNotice, Skeleton, Spinner } from '../components/ui.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import PageIcon from '../components/PageIcon.jsx';
import '../deposit.css';
import '../stake.css';

const KEYS = ['linear', 'stnear'];
// Instant unstake through Meta Pool's pool: accept at most this much worse than the quote.
const LIQUID_SLIPPAGE_BPS = 50n;
const PRESETS = [25, 50, 75, 100];
const near = (yocto) => formatAmount(Number(formatUnits(yocto, 24)));
const nearCompact = (yocto) => formatAmount(Number(formatUnits(yocto, 24)), { compactAbove: 1e3 });
const sanitize = (v) => v.replace(',', '.').replace(/[^\d.]/g, '');

function useStakingData(accountId) {
  const info = useAsync(
    async () => {
      const rows = await Promise.all(KEYS.map(async (k) => ({ key: k, price: await priceOf(k), total: await totalStaked(k).catch(() => null) })));
      return Object.fromEntries(rows.map((r) => [r.key, r]));
    },
    [],
    { refreshMs: 60_000 }
  );
  const apy = useAsync(() => getStakingApy(), []);
  const tokens = useAsync(() => getTokens(KEYS.map((k) => STAKING[k].contract)), []);
  const pools = useAsync(() => getLstPools(), [], { refreshMs: 300_000 });
  const clock = useAsync(() => getEpochClock(), [], { refreshMs: 60_000 });
  const positions = useAsync(
    async () => {
      const rows = await Promise.all(KEYS.map(async (k) => [k, await getPosition(k, accountId, info.data[k].price)]));
      return Object.fromEntries(rows);
    },
    [accountId, Boolean(info.data)],
    { enabled: Boolean(accountId && info.data), refreshMs: 30_000 }
  );
  return { info, apy, tokens, pools, clock, positions };
}

function TokenIcon({ tokens, k, size = 28 }) {
  const src = tokens.data?.[STAKING[k].contract]?.icon;
  return src ? <img className="stk-icon" src={src} alt="" width={size} height={size} /> : <span className="stk-icon stk-icon--blank" style={{ width: size, height: size }} />;
}

/**
 * The selected token's yield: what 1 LiNEAR / stNEAR is worth in NEAR over the last 30 or 90 days
 * (archival prices, one point a week) as an area chart, with the APY that growth works out to.
 */
function ApyHistory({ pick, tokens, apy90 }) {
  const [range, setRange] = useState(90);
  const history = useAsync(() => getApyHistory(pick, 90), [pick]);
  // Only the selected token's own history (never the previous token's while the new one loads).
  const data = history.data?.key === pick ? history.data : null;
  const points = data ? data.points.slice(range === 30 ? -5 : 0) : [];
  // 90D shows the same 90-day APY as the cards above it; 30D the last four weeks.
  const apyValue = range === 90 ? (apy90 ?? data?.apy90 ?? null) : (data?.apy30 ?? null);
  const W = 320;
  const H = 120;
  const chart = useMemo(() => {
    if (points.length < 2) return null;
    const prices = points.map((p) => p.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const pad = (hi - lo) * 0.15 || hi * 0.0005;
    const y = (v) => H - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * H;
    const x = (i) => (i / (points.length - 1)) * W;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.price).toFixed(1)}`).join(' ');
    return { line, area: `${line} L${W} ${H} L0 ${H} Z`, last: { x: x(points.length - 1), y: y(prices[prices.length - 1]) }, lo, hi };
  }, [points]);
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <section className="card stk-history">
      <div className="stk-history__head">
        <div className="stk-history__title">
          <TokenIcon tokens={tokens} k={pick} size={22} />
          <span>
            <small className="dep-label">{STAKING[pick].symbol} yield · last {range} days</small>
            <strong>{apyValue != null ? `${apyValue.toFixed(2)}%` : '…'} <em>APY</em></strong>
          </span>
        </div>
        <div className="segmented">
          {[30, 90].map((r) => (
            <button key={r} type="button" className={range === r ? 'active' : ''} onClick={() => setRange(r)}>
              {r}D
            </button>
          ))}
        </div>
      </div>
      {history.error && !data && (
        <p className="muted small">
          Couldn&apos;t read the history from the chain just now.{' '}
          <button type="button" className="link-button" onClick={history.reload}>
            Retry
          </button>
        </p>
      )}
      {!data && !history.error && <Skeleton height={150} />}
      {chart && (
        <>
          <svg className="stk-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Value of 1 ${STAKING[pick].symbol} in NEAR`}>
            <defs>
              <linearGradient id="stk-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={chart.area} fill="url(#stk-area)" />
            <path d={chart.line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            <circle cx={chart.last.x} cy={chart.last.y} r="3.5" fill="currentColor" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="stk-chart__axis">
            <span>{day(first.at)} · {first.price.toFixed(4)} NEAR</span>
            <span>{day(last.at)} · {last.price.toFixed(4)} NEAR</span>
          </div>
          <p className="muted small stk-chart__note">
            Value of 1 {STAKING[pick].symbol} in NEAR, read from the chain each week.
            {pick === 'linear' ? ' LiNEAR books its rewards in steps, so the line climbs in stairs; longer periods give the truer rate.' : ''}
          </p>
        </>
      )}
    </section>
  );
}

/** `switcher`: shown inside Earn (pages/Earn.jsx) as its Staking tab, under Earn's title. */
export default function Stake({ switcher = null }) {
  const { accountId, connect, nearBalance, execute } = useApp();
  const { info, apy, tokens, pools, clock, positions } = useStakingData(accountId);
  // What each held position has earned since it was staked (NearBlocks + archival prices).
  const earnings = useAsync(
    async () => {
      const held = KEYS.filter((k) => positions.data[k].shares > 0n);
      const rows = await Promise.all(held.map(async (k) => [k, await getStakeEarnings(k, accountId, positions.data[k].shares, info.data[k].price).catch(() => null)]));
      return Object.fromEntries(rows);
    },
    [accountId, positions.data ? KEYS.map((k) => positions.data[k].shares.toString()).join('|') : ''],
    { enabled: Boolean(accountId && positions.data && info.data) }
  );
  const [pick, setPick] = useState('linear');
  const [mode, setMode] = useState('stake');
  const [amount, setAmount] = useState('');
  const [exit, setExit] = useState('instant');
  const [busy, setBusy] = useState(false);

  const s = STAKING[pick];
  const price = info.data?.[pick]?.price || 0n;
  const pos = positions.data?.[pick];
  const raw = toBigInt(tryParseUnits(amount || '0', 24) || '0');
  const rate = apy.data?.[pick];

  // Stake: native NEAR, keeping a little for gas. Unstake: the token balance.
  const spendable = useMemo(() => {
    const avail = nearBalance ? toBigInt(nearBalance.available) - toBigInt(NEAR_GAS_RESERVE) : 0n;
    return avail > 0n ? avail : 0n;
  }, [nearBalance]);
  const held = pos?.shares || 0n;
  const max = mode === 'stake' ? spendable : held;
  const tooMuch = accountId && raw > max;
  const belowMin = mode === 'stake' && raw > 0n && raw < s.minStake;

  // Instant prices, both shown before choosing: Meta Pool's own pool for stNEAR, Rhea for LiNEAR.
  const quoteKey = useDebounced(`${pick}|${raw}|${mode}`, 400);
  const wantQuote = mode === 'unstake' && raw > 0n && !tooMuch && quoteKey === `${pick}|${raw}|${mode}`;
  const instant = useAsync(
    async () => {
      if (pick === 'stnear') return liquidUnstakeQuote(raw);
      const tokenIn = tokens.data?.[s.contract];
      const q = await getSwapQuote({ tokenIn, tokenOut: NATIVE_NEAR, amountIn: raw.toString(), slippage: 0.5 });
      return toBigInt(q?.amountOut || '0');
    },
    [quoteKey],
    { enabled: wantQuote && Boolean(pick === 'stnear' || tokens.data) }
  );
  const delayedOut = nearFor(raw, price);
  const instantOut = instant.data || 0n;
  const instantGap = instantOut > 0n && delayedOut > 0n ? Number(((delayedOut - instantOut) * 10_000n) / delayedOut) / 100 : null;

  const receive = mode === 'stake' ? sharesFor(raw, price) : exit === 'instant' ? instantOut : delayedOut;
  const yearly = mode === 'stake' && rate != null && raw > 0n ? Number(formatUnits(raw, 24)) * (rate / 100) : null;
  const ready = Boolean(accountId && raw > 0n && !tooMuch && !belowMin && price > 0n);
  const unlockText = clock.data ? formatWait(secondsUntilEpoch(clock.data.epochHeight + 4, clock.data)) : 'a day or two';

  const run = async (build, labels) => {
    setBusy(true);
    const done = await execute(async () => {
      const txs = await build();
      return Array.isArray(txs) ? txs : [txs];
    }, labels);
    setBusy(false);
    if (done) {
      setAmount('');
      positions.reload();
      info.reload();
    }
  };

  const submit = () => {
    if (mode === 'stake') return run(() => stakeTx(pick, raw), { pending: `Staking ${amount} NEAR for ${s.symbol}`, success: `Staked: ${s.symbol} is in your wallet` });
    if (exit === 'instant' && pick === 'stnear') {
      const min = (instantOut * (10_000n - LIQUID_SLIPPAGE_BPS)) / 10_000n;
      return run(() => liquidUnstakeTx(raw, min), { pending: `Unstaking ${amount} stNEAR instantly`, success: 'NEAR is back in your wallet' });
    }
    if (exit === 'instant') {
      return run(
        async () => {
          const tokenIn = tokens.data?.[s.contract];
          const quote = await getSwapQuote({ tokenIn, tokenOut: NATIVE_NEAR, amountIn: raw.toString(), slippage: 0.5, user: accountId });
          if (quote.hybrid) throw new Error('This sale needs two swaps right now. Use the Swap page for it.');
          // Never sign a price clearly worse than the one shown.
          if (toBigInt(quote.amountOut) * 100n < instantOut * 99n) throw new Error('The price moved by more than 1%. Check the new price and try again.');
          return buildSwapTransactions({ tokenIn, tokenOut: NATIVE_NEAR, quote, accountId });
        },
        { pending: `Selling ${amount} LiNEAR for NEAR`, success: 'NEAR is back in your wallet' }
      );
    }
    return run(() => unstakeTx(pick, delayedOut, raw >= held), {
      pending: `Unstaking ${amount} ${s.symbol}`,
      success: `Unstake started: withdraw in about ${unlockText}`
    });
  };


  let label;
  if (!accountId) label = 'Connect wallet';
  else if (!(raw > 0n)) label = 'Enter an amount';
  else if (tooMuch) label = mode === 'stake' ? 'More than your NEAR' : `More than your ${s.symbol}`;
  else if (belowMin) label = `Minimum is ${near(s.minStake)} NEAR`;
  else if (mode === 'stake') label = `Stake ${amount} NEAR`;
  else if (exit === 'instant') label = instant.loading || !instantOut ? 'Getting a price…' : `Unstake now for ≈ ${near(instantOut)} NEAR`;
  else label = `Start unstake · ≈ ${near(delayedOut)} NEAR in ~${unlockText}`;

  // Hero numbers.
  const totalAll = info.data ? KEYS.reduce((sum, k) => sum + (info.data[k].total || 0n), 0n) : null;
  const bestApy = apy.data ? Math.max(...KEYS.map((k) => apy.data[k] ?? -Infinity)) : null;

  return (
    <div className="page stake">
      <header className="pt-hero stk-hero">
        <FlowLines />
        <h1 className="pt-title">
          <PageIcon name="earn" />
          {switcher ? 'Earn' : 'Stake'}
        </h1>
        <p>Stake NEAR and keep it liquid. Earn validator rewards with LiNEAR or stNEAR, then put the token to work in Rhea pools.</p>
        {switcher}
        <div className="dep-hero__stats">
          <span>
            <b>{totalAll != null ? nearCompact(totalAll) : '…'}</b> NEAR staked
          </span>
          <span>
            <b>{bestApy != null && Number.isFinite(bestApy) ? `up to ${bestApy.toFixed(2)}%` : '…'}</b> APY
          </span>
          <span>
            <b>0%</b> staking fee
          </span>
          <span>
            <b>✓</b> DAO-owned contracts
          </span>
        </div>
      </header>

      <div className="stk-grid">
        <div className="stk-main">
          <section className="card stk-card">
            <div className="stk-pick">
              {KEYS.map((k) => {
                const p = info.data?.[k];
                const y = apy.data?.[k];
                return (
                  <button key={k} type="button" className={`stk-option ${pick === k ? 'is-on' : ''}`} onClick={() => setPick(k)} aria-pressed={pick === k}>
                    <span className="stk-option__head">
                      <TokenIcon tokens={tokens} k={k} size={24} />
                      <span>
                        <b>{STAKING[k].symbol}</b>
                        <small className="muted">{STAKING[k].name}</small>
                      </span>
                    </span>
                    <span className="stk-option__apy">
                      {y == null ? (apy.loading ? '…' : '—') : `${y.toFixed(2)}%`}
                      <small className="muted">APY · last 90 days</small>
                    </span>
                    <span className="stk-option__meta muted">
                      {p ? `1 ${STAKING[k].symbol} = ${(Number(p.price) / 1e24).toFixed(4)} NEAR` : '…'}
                      {p?.total ? ` · ${nearCompact(p.total)} NEAR staked` : ''}
                    </span>
                    <span className="stk-option__meta muted">DAO-owned · since {STAKING[k].since}</span>
                  </button>
                );
              })}
            </div>

            <div className="segmented segmented--full stk-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'stake'} className={mode === 'stake' ? 'active' : ''} onClick={() => setMode('stake')}>
                Stake
              </button>
              <button type="button" role="tab" aria-selected={mode === 'unstake'} className={mode === 'unstake' ? 'active' : ''} onClick={() => setMode('unstake')}>
                Unstake
              </button>
            </div>

            {info.error && <ErrorNotice error={info.error} onRetry={info.reload} />}

            <div className="stk-field">
              <span className="dep-label">{mode === 'stake' ? 'You stake' : `You unstake (${s.symbol})`}</span>
              <div className="stk-amount">
                {mode === 'stake' ? <img className="stk-icon" src="/logos/tokens/near.svg" alt="" width={28} height={28} /> : <TokenIcon tokens={tokens} k={pick} />}
                <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(sanitize(e.target.value))} />
                <span className="stk-unit">{mode === 'stake' ? 'NEAR' : s.symbol}</span>
              </div>
              {accountId && (
                <div className="stk-presets">
                  {PRESETS.map((p) => (
                    <button key={p} type="button" className="mini-button" disabled={!(max > 0n)} onClick={() => setAmount(formatUnits((max * BigInt(p)) / 100n, 24))}>
                      {p === 100 ? 'Max' : `${p}%`}
                    </button>
                  ))}
                  <small className={tooMuch ? 'down' : 'muted'}>
                    {mode === 'stake' ? `Available ${near(spendable)} NEAR · 0.25 kept for gas` : `Balance ${near(held)} ${s.symbol}`}
                  </small>
                </div>
              )}
            </div>

            {mode === 'unstake' && (
              <div className="stk-exit">
                <button type="button" className={exit === 'instant' ? 'is-on' : ''} onClick={() => setExit('instant')}>
                  <b>Instant</b>
                  <strong>{raw > 0n ? (instant.loading ? '…' : instantOut ? `≈ ${near(instantOut)} NEAR` : '—') : '—'}</strong>
                  <small className="muted">
                    {pick === 'stnear' ? 'Meta Pool’s pool' : `Best of Rhea & Intear DEX${PLATFORM_FEE.enabled ? ` · incl. ${bpsText(PLATFORM_FEE.bps)} KINU fee` : ''}`}
                    {instantGap != null ? ` · ${instantGap.toFixed(2)}% below full value` : ''}
                  </small>
                </button>
                <button type="button" className={exit === 'delayed' ? 'is-on' : ''} onClick={() => setExit('delayed')}>
                  <b>Delayed</b>
                  <strong>{raw > 0n ? `≈ ${near(delayedOut)} NEAR` : '—'}</strong>
                  <small className="muted">Full value · ready in ~{unlockText}</small>
                </button>
              </div>
            )}

            <div className="stk-quote">
              {raw > 0n && price > 0n ? (
                <>
                  <span className="dep-label">You receive</span>
                  <strong>
                    ≈ {near(receive)} {mode === 'stake' ? s.symbol : 'NEAR'}
                  </strong>
                  <small className="muted">
                    {mode === 'stake'
                      ? `Worth ${amount} NEAR now${yearly != null ? ` · earns ≈ ${formatAmount(yearly)} NEAR a year at today's ${rate.toFixed(2)}%` : ''}.`
                      : exit === 'delayed'
                        ? `Withdraw from “Your staking” once it unlocks, in about ${unlockText} (four epochs).`
                        : pick === 'linear'
                          ? `Sold now on the best route across Rhea and Intear DEX, re-priced just before you sign${PLATFORM_FEE.enabled ? `; includes KINU's ${bpsText(PLATFORM_FEE.bps)} swap fee` : ''}.`
                          : 'Paid out now from Meta Pool’s NEAR/stNEAR pool.'}
                  </small>
                </>
              ) : (
                <small className="muted">Enter an amount to see what you receive.</small>
              )}
            </div>

            {!accountId ? (
              <button type="button" className="button button--primary button--block button--lg" onClick={connect}>
                Connect wallet
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary button--block button--lg"
                disabled={!ready || busy || (mode === 'unstake' && exit === 'instant' && !instantOut)}
                onClick={submit}
              >
                {busy && <Spinner size={14} />} {label}
              </button>
            )}
            <small className="muted stk-fine">
              Staking goes straight from your wallet to {s.contract}. KINU takes no fee on staking and never holds your NEAR.
            </small>
          </section>

        </div>

        <aside className="stk-side">
          <ApyHistory pick={pick} tokens={tokens} apy90={apy.data?.[pick]} />

          <section className="card stk-earn">
            <h3>Put it to work</h3>
            <p className="muted small">In a staking-token pool your liquidity earns trading fees while the token keeps its staking rewards.</p>
            {!pools.data && !pools.error && <Skeleton height={56} />}
            {pools.data?.map((p) => (
              <div key={p.id} className="stk-pool">
                <TokenIcon tokens={tokens} k={p.stakeKey} size={24} />
                <div>
                  <b>{p.symbols.join(' / ')}</b>
                  <small className="muted">
                    {p.label} · TVL {formatUsd(p.tvl, { compactAbove: 1e3 })}
                    {apy.data?.[p.stakeKey] != null ? ` · ~${(apy.data[p.stakeKey] / 2).toFixed(2)}% staking` : ''}
                    {p.apy > 0 ? ` + ${p.apy >= 0.01 ? p.apy.toFixed(2) : '<0.01'}% fees` : ''}
                  </small>
                </div>
                <Link to={poolPath(p.id)} className="button button--outline button--sm">
                  Add LP
                </Link>
              </div>
            ))}
          </section>
        </aside>

        <aside className="stk-faq">
          <section className="card stk-positions">
            <h3>Your staking</h3>
            {!accountId && <p className="muted small">Connect your wallet to see your LiNEAR and stNEAR.</p>}
            {accountId && !positions.data && <Skeleton height={90} />}
            {accountId && positions.data && !KEYS.some((k) => positions.data[k].shares > 0n || positions.data[k].unstaked > 0n) && (
              <p className="muted small">No LiNEAR or stNEAR yet.</p>
            )}
            {accountId &&
              positions.data &&
              KEYS.filter((k) => positions.data[k].shares > 0n || positions.data[k].unstaked > 0n).map((k) => {
                const p = positions.data[k];
                const wait = p.unlockEpoch && clock.data ? formatWait(secondsUntilEpoch(p.unlockEpoch, clock.data)) : null;
                return (
                  <div key={k} className="stk-pos">
                    <TokenIcon tokens={tokens} k={k} size={24} />
                    <div>
                      <b>
                        {near(p.shares)} {STAKING[k].symbol}
                      </b>
                      <small className="muted">
                        ≈ {near(p.valueNear)} NEAR{apy.data?.[k] != null && p.shares > 0n ? ` · ${apy.data[k].toFixed(2)}% APY` : ''}
                      </small>
                      {earnings.data?.[k] && (
                        <small className="up" title={`From ${formatAmount(earnings.data[k].stakedNear)} NEAR you staked with ${STAKING[k].contract}`}>
                          +{earnings.data[k].earned.toFixed(6)} NEAR earned
                          {earnings.data[k].since ? ` since ${new Date(earnings.data[k].since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}
                        </small>
                      )}
                      {p.unstaked > 0n && (
                        <small className={p.canWithdraw ? 'up' : 'muted'}>
                          {near(p.unstaked)} NEAR unstaking · {p.canWithdraw ? 'ready to withdraw' : wait ? `ready in ~${wait}` : 'unlocking'}
                        </small>
                      )}
                    </div>
                    {p.unstaked > 0n && p.canWithdraw && (
                      <button
                        type="button"
                        className="button button--outline button--sm"
                        disabled={busy}
                        onClick={() => run(() => withdrawTx(k), { pending: `Withdrawing ${near(p.unstaked)} NEAR`, success: 'NEAR withdrawn to your wallet' })}
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                );
              })}
          </section>

          <div className="card dep-faq">
            <details>
              <summary>Where does the yield come from?</summary>
              <p>Your NEAR is delegated to hundreds of NEAR validators. Their rewards raise the NEAR value of each LiNEAR / stNEAR every epoch (~7 hours). The APY shown is what the token actually gained over the last 90 days, after all fees — not a promise.</p>
            </details>
            <details>
              <summary>How do I get my NEAR back?</summary>
              <p>Instantly, by selling the token (a small discount, shown before you choose), or with a delayed unstake at full value: it unlocks after about four epochs (roughly a day or two), then you press Withdraw under “Your staking”.</p>
            </details>
            <details>
              <summary>How do I check what I sign?</summary>
              <p>
                Your wallet shows where every request goes. For staking it must be <span className="mono">{STAKING.linear.contract}</span> or{' '}
                <span className="mono">{STAKING.stnear.contract}</span> — anything else, reject it. Your staked NEAR lives in those contracts under your account, not in
                KINU: if kinudefi.com were ever down or compromised, you can still unstake at{' '}
                <a href={STAKING.linear.site} target="_blank" rel="noopener noreferrer">
                  LiNEAR ↗
                </a>{' '}
                or{' '}
                <a href={STAKING.stnear.site} target="_blank" rel="noopener noreferrer">
                  Meta Pool ↗
                </a>
                .
              </p>
            </details>
            <details>
              <summary>Are the contracts audited?</summary>
              <p>
                LiNEAR: by BlockSec (2022) and Hacken (2024),{' '}
                <a href="https://github.com/linear-protocol/audits" target="_blank" rel="noopener noreferrer">
                  reports ↗
                </a>
                . Meta Pool: by BlockSec (2022),{' '}
                <a href="https://www.metapool.app/MetaPool_BlockSec_Audit_signed_v1.1.pdf" target="_blank" rel="noopener noreferrer">
                  report ↗
                </a>
                . An audit lowers risk; it doesn&apos;t remove it.
              </p>
            </details>
            <details>
              <summary>What are the risks?</summary>
              <p>
                Smart-contract risk (a bug in the staking contract), the token trading below its NEAR value when you sell it, and waiting on a delayed unstake. Both
                contracts are owned by DAOs ({STAKING.linear.owner}, {STAKING.stnear.owner}) that can upgrade them. Start small.
              </p>
            </details>
            <details>
              <summary>Does KINU take a fee?</summary>
              <p>
                Not on staking, a delayed unstake or stNEAR's instant exit: the staking providers keep a share of validator rewards (already reflected in the APY), and
                KINU adds nothing.{PLATFORM_FEE.enabled ? ` Selling LiNEAR instantly is a swap, so it carries KINU's ${bpsText(PLATFORM_FEE.bps)} swap fee, shown before you sign.` : ''}
              </p>
            </details>
          </div>
        </aside>
      </div>
    </div>
  );
}
