// Earn (/earn): two ways to grow what you hold, picked at the top.
//   Vaults  — USDC or NEAR into yield vaults on other chains (Morpho on Base, Kamino on Solana) straight
//             from a NEAR wallet, through NEAR Intents (lib/earn.js). Shares stay in the user's own NEAR
//             Intents balance; a withdrawal is a message they sign. KINU's fee is 0.10% each way.
//   Staking — liquid staking with LiNEAR or stNEAR (pages/Stake.jsx; /stake opens this tab).

import { lazy, Suspense, useEffect, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced } from '../hooks.js';
import { Link, navigate } from '../router.jsx';
import {
  buildEarnDepositTransactions,
  depositStatus,
  dropPending,
  EARN_FEES,
  EARN_FINAL,
  earnDepositQuote,
  earnWithdraw,
  earnWithdrawQuote,
  getEarnPositions,
  getVaultStats,
  PAY,
  readPending,
  savePending,
  vaultOf,
  VAULTS
} from '../lib/earn.js';
import { submitDepositTx, SUPPORT } from '../lib/intents.js';
import { formatAmount, formatUnits, formatUsd, toBigInt, tryParseUnits } from '../lib/format.js';
import { NEAR_GAS_RESERVE } from '../config.js';
import { priceOf } from '../lib/tokens.js';
import { ErrorNotice, Skeleton, Spinner } from '../components/ui.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import PageIcon from '../components/PageIcon.jsx';
import '../deposit.css';
import '../stake.css';
import '../earn.css';

const PRESETS = [25, 50, 75, 100];
const STATUS_POLL_MS = 8000;
// NEAR Intents quotes nothing below about $12 (checked 18 Oct 2026: $10 fails, $12 quotes). KINU asks
// for $15 on every deposit and withdrawal, so a position can still be withdrawn after fees and a dip.
const MIN_USD = 15;
/** 1Click's errors in words that say what to do. */
const explain = (error) =>
  /no liquidity/i.test(error?.message || '') ? new Error(`No route for this amount. NEAR Intents needs about $${MIN_USD} or more per deposit or withdrawal.`) : error;
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const sanitize = (v) => v.replace(',', '.').replace(/[^\d.]/g, '');
const apyText = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(2)}%`);

/** Spendable raw balance of a pay asset (NEAR counts native NEAR minus a gas reserve, plus wNEAR). */
function spendableOf(payKey, balances, nearBalance) {
  const pay = PAY[payKey];
  const token = toBigInt(balances?.[pay.contractAddress] || '0');
  if (payKey !== 'near') return token;
  const native = nearBalance ? toBigInt(nearBalance.available) - toBigInt(NEAR_GAS_RESERVE) : 0n;
  return token + (native > 0n ? native : 0n);
}

function VaultIcon({ vault, size = 28 }) {
  return (
    <span className="earn-icon" style={{ width: size, height: size }}>
      <img src={vault.icon} alt="" width={size} height={size} />
      <img className="earn-icon__chain" src={`/logos/chains/${vault.chain}.svg`} alt="" width={size * 0.5} height={size * 0.5} />
    </span>
  );
}

const STEPS = {
  deposit: [
    { key: 'PENDING_DEPOSIT', label: 'Waiting for your transfer' },
    { key: 'KNOWN_DEPOSIT_TX', label: 'Transfer seen' },
    { key: 'PROCESSING', label: 'Depositing into the vault' },
    { key: 'SUCCESS', label: 'In your Earn balance' }
  ],
  withdraw: [
    { key: 'PENDING_DEPOSIT', label: 'Waiting for your signature' },
    { key: 'KNOWN_DEPOSIT_TX', label: 'Signature received' },
    { key: 'PROCESSING', label: 'Withdrawing from the vault' },
    { key: 'SUCCESS', label: 'Paid to your NEAR wallet' }
  ]
};

/** One deposit or withdrawal in flight, with its progress. */
function Tracker({ entry, onDone }) {
  const status = useAsync(() => depositStatus(entry.depositAddress), [entry.depositAddress], { refreshMs: STATUS_POLL_MS });
  const state = status.data?.status || 'PENDING_DEPOSIT';
  const final = EARN_FINAL.has(state);
  const steps = STEPS[entry.kind];
  const at = Math.max(0, steps.findIndex((s) => s.key === state));
  useEffect(() => {
    if (final) onDone?.(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [final]);
  return (
    <div className="earn-track">
      <div className="earn-track__head">
        <VaultIcon vault={vaultOf(entry.vault)} size={26} />
        <div>
          <b>
            {entry.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} · {vaultOf(entry.vault).name}
          </b>
          <small className="muted">{entry.summary}</small>
        </div>
      </div>
      <ol className="dep-steps">
        {steps.map((s, i) => (
          <li key={s.key} className={i < at || state === 'SUCCESS' ? 'done' : i === at && !final ? 'on' : ''}>
            <i>{i < at || state === 'SUCCESS' ? '✓' : i + 1}</i>
            {s.label}
          </li>
        ))}
      </ol>
      {(state === 'REFUNDED' || state === 'FAILED') && (
        <p className="earn-note earn-note--warn">
          {state === 'REFUNDED' ? 'Refunded: it couldn’t complete, so the funds went back to your account.' : 'It failed.'} Details on{' '}
          <a href={SUPPORT.explorer(entry.depositAddress)} target="_blank" rel="noopener noreferrer">
            NEAR Intents Explorer ↗
          </a>
        </p>
      )}
      <a className="muted small" href={SUPPORT.explorer(entry.depositAddress)} target="_blank" rel="noopener noreferrer">
        Track on NEAR Intents Explorer ↗
      </a>
    </div>
  );
}

function VaultsView({ switcher }) {
  const { accountId, connect, balances, nearBalance, execute, toast, prices } = useApp();
  const stats = useAsync(() => getVaultStats(), [], { refreshMs: 600_000 });
  const positions = useAsync(() => getEarnPositions(accountId), [accountId], { enabled: Boolean(accountId), refreshMs: 60_000 });
  const [pending, setPending] = useState(() => readPending(accountId));
  useEffect(() => setPending(readPending(accountId)), [accountId]);

  const [pick, setPick] = useState('usdc');
  const [mode, setMode] = useState('deposit');
  const vault = vaultOf(pick);
  const [payKey, setPayKey] = useState(vault.pay[0]);
  useEffect(() => setPayKey(vault.pay[0]), [pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const [amount, setAmount] = useState('');
  const [share, setShare] = useState(100); // withdraw: percent of the position
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  const pay = PAY[payKey];
  const spendable = spendableOf(payKey, balances, nearBalance);
  const raw = toBigInt(tryParseUnits(amount || '0', pay.decimals) || '0');
  const held = positions.data?.[pick]?.shares || 0n;
  const heldUsd = positions.data?.[pick]?.usd || 0;
  const shares = (held * BigInt(share)) / 100n;
  const tooMuch = mode === 'deposit' && accountId && raw > spendable;
  // Dollar sizes, to keep every deposit and withdrawal above the minimum.
  const payPrice = payKey === 'usdc' ? 1 : priceOf(prices, 'wrap.near') || 0;
  const depositUsd = Number(formatUnits(raw, pay.decimals)) * payPrice;
  const withdrawUsd = (heldUsd * share) / 100;
  const leftUsd = heldUsd - withdrawUsd;
  const belowMin = mode === 'deposit' ? raw > 0n && payPrice > 0 && depositUsd < MIN_USD : held > 0n && withdrawUsd < MIN_USD;
  // A partial withdrawal must not leave a remainder too small to withdraw later.
  const smallRest = mode === 'withdraw' && share < 100 && leftUsd > 0 && leftUsd < MIN_USD;
  const s = stats.data?.[pick];

  // A dry quote for what the user would get, re-asked as they type.
  const formKey = mode === 'deposit' ? `d|${pick}|${payKey}|${raw}` : `w|${pick}|${payKey}|${shares}`;
  const key = useDebounced(formKey, 500);
  const wantQuote = Boolean(accountId) && key === formKey && (mode === 'deposit' ? raw > 0n && !tooMuch : shares > 0n) && !belowMin && !smallRest;
  const preview = useAsync(
    () => (mode === 'deposit' ? earnDepositQuote({ vault, payKey, amount: raw, accountId }) : earnWithdrawQuote({ vault, toKey: payKey, shares, accountId })),
    [key],
    { enabled: wantQuote }
  );
  const q = wantQuote ? preview.data : null;
  useEffect(() => setAgreed(false), [formKey]);

  const yearly = mode === 'deposit' && q && s?.apy != null ? Number(q.amountOutUsd || 0) * (s.apy / 100) : null;

  const track = (entry) => {
    savePending(entry);
    setPending(readPending(accountId));
  };

  const deposit = async () => {
    setBusy(true);
    let live = null;
    const outcomes = await execute(
      async () => {
        live = await earnDepositQuote({ vault, payKey, amount: raw, accountId, dry: false });
        return buildEarnDepositTransactions({ quote: live, payKey, accountId, wnearBalance: balances?.['wrap.near'] });
      },
      { pending: `Depositing ${amount} ${pay.symbol} into ${vault.name}`, success: 'Sent: your deposit is on its way into the vault' }
    );
    setBusy(false);
    if (!outcomes || !live) return;
    const hash = outcomes[outcomes.length - 1]?.transaction?.hash;
    if (hash) submitDepositTx(live.depositAddress, hash).catch(() => {});
    track({
      kind: 'deposit',
      vault: pick,
      depositAddress: live.depositAddress,
      summary: `${live.amountInFormatted} ${pay.symbol} → ≈ ${formatUsd(Number(live.amountOutUsd || 0))} in the vault`,
      account: accountId,
      createdAt: Date.now()
    });
    setAmount('');
  };

  const withdraw = async () => {
    setBusy(true);
    try {
      const done = await earnWithdraw({
        vault,
        toKey: payKey,
        shares,
        accountId,
        registerKey: (txs) => execute(async () => txs, { pending: 'Registering your key with NEAR Intents (one time)', success: 'Key registered' })
      });
      track({
        kind: 'withdraw',
        vault: pick,
        depositAddress: done.depositAddress,
        summary: `${share}% of your position → ≈ ${formatAmount(Number(done.amountOutFormatted))} ${PAY[payKey].symbol}`,
        account: accountId,
        createdAt: Date.now()
      });
      toast('success', 'Withdrawal sent', `About ${vault.exitTime} until it reaches your wallet.`);
    } catch (e) {
      toast('error', 'Withdrawal not sent', e.message || String(e));
    }
    setBusy(false);
  };

  let label;
  if (!accountId) label = 'Connect wallet';
  else if (mode === 'deposit') {
    if (!(raw > 0n)) label = 'Enter an amount';
    else if (tooMuch) label = `More than your ${pay.symbol}`;
    else if (belowMin) label = `Minimum deposit is $${MIN_USD}`;
    else if (preview.loading || !q) label = 'Getting a price…';
    else label = `Deposit ${amount} ${pay.symbol}`;
  } else if (!(held > 0n)) label = 'Nothing to withdraw';
  else if (belowMin) label = heldUsd < MIN_USD ? `Position is below the $${MIN_USD} minimum` : `Minimum withdrawal is $${MIN_USD}`;
  else if (smallRest) label = `Withdraw All: the rest would be under $${MIN_USD}`;
  else if (preview.loading || !q) label = 'Getting a price…';
  else label = `Withdraw ≈ ${formatAmount(Number(q.amountOutFormatted))} ${pay.symbol}`;
  const ready = Boolean(accountId && q && agreed && !belowMin && !smallRest && (mode === 'deposit' ? raw > 0n && !tooMuch : shares > 0n));

  const best = stats.data ? Math.max(...VAULTS.map((v) => stats.data[v.key]?.apy ?? -Infinity)) : null;
  const tvl = stats.data ? VAULTS.reduce((sum, v) => sum + (stats.data[v.key]?.tvlUsd || 0), 0) : null;
  const totalUsd = positions.data ? VAULTS.reduce((sum, v) => sum + (positions.data[v.key]?.usd || 0), 0) : 0;

  return (
    <div className="page stake earn">
      <header className="pt-hero stk-hero">
        <FlowLines />
        <h1 className="pt-title">
          <PageIcon name="earn" />
          Earn
        </h1>
        <p>Put USDC or NEAR to work in leading yield vaults on Base and Solana, straight from your NEAR wallet. Powered by NEAR Intents.</p>
        {switcher}
        <div className="dep-hero__stats">
          <span>
            <b>{best != null && Number.isFinite(best) ? `up to ${best.toFixed(2)}%` : '…'}</b> APY
          </span>
          <span>
            <b>{tvl ? formatUsd(tvl, { compactAbove: 1e3 }) : '…'}</b> in these vaults
          </span>
          <span>
            <b>{pct(EARN_FEES.kinuBps)}</b> KINU fee
          </span>
          <span>
            <b>✓</b> Non-custodial
          </span>
        </div>
      </header>

      <div className="stk-grid">
        <div className="stk-main">
          <section className="card stk-card">
            <div className="stk-pick">
              {VAULTS.map((v) => {
                const st = stats.data?.[v.key];
                return (
                  <button key={v.key} type="button" className={`stk-option ${pick === v.key ? 'is-on' : ''}`} onClick={() => setPick(v.key)} aria-pressed={pick === v.key}>
                    <span className="stk-option__head">
                      <VaultIcon vault={v} size={24} />
                      <span>
                        <b>{v.underlying} · {v.protocol}</b>
                        <small className="muted">{v.name}</small>
                      </span>
                    </span>
                    <span className="stk-option__apy">
                      {st ? apyText(st.apy) : stats.loading ? '…' : '—'}
                      <small className="muted">APY now</small>
                    </span>
                    <span className="stk-option__meta muted">
                      {v.chainName}
                      {st?.tvlUsd ? ` · ${formatUsd(st.tvlUsd, { compactAbove: 1e3 })} TVL` : ''}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="segmented segmented--full stk-tabs" role="tablist">
              {['deposit', 'withdraw'].map((m) => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
                  {m === 'deposit' ? 'Deposit' : 'Withdraw'}
                </button>
              ))}
            </div>

            <div className="stk-field">
              <span className="dep-label">{mode === 'deposit' ? 'Pay with' : 'Receive in'}</span>
              <div className="segmented earn-pay">
                {vault.pay.map((k) => (
                  <button key={k} type="button" className={payKey === k ? 'active' : ''} onClick={() => setPayKey(k)}>
                    <img src={PAY[k].icon} alt="" width={16} height={16} /> {PAY[k].symbol}
                  </button>
                ))}
              </div>
            </div>

            {mode === 'deposit' ? (
              <div className="stk-field">
                <span className="dep-label">You deposit</span>
                <div className="stk-amount">
                  <img className="stk-icon" src={pay.icon} alt="" width={28} height={28} />
                  <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(sanitize(e.target.value))} />
                  <span className="stk-unit">{pay.symbol}</span>
                </div>
                {accountId && (
                  <div className="stk-presets">
                    {PRESETS.map((p) => (
                      <button key={p} type="button" className="mini-button" disabled={!(spendable > 0n)} onClick={() => setAmount(formatUnits((spendable * BigInt(p)) / 100n, pay.decimals))}>
                        {p === 100 ? 'Max' : `${p}%`}
                      </button>
                    ))}
                    <small className={tooMuch ? 'down' : 'muted'}>
                      Available {formatAmount(Number(formatUnits(spendable, pay.decimals)))} {pay.symbol}
                      {payKey === 'near' ? ' · 0.25 kept for gas' : ''} · minimum ≈ ${MIN_USD}
                    </small>
                  </div>
                )}
              </div>
            ) : (
              <div className="stk-field">
                <span className="dep-label">You withdraw</span>
                <div className="earn-share">
                  <strong>{share}%</strong>
                  <span className="muted">of your position · ≈ {formatUsd((heldUsd * share) / 100)}</span>
                </div>
                <div className="stk-presets">
                  {PRESETS.map((p) => (
                    <button key={p} type="button" className={`mini-button ${share === p ? 'is-on' : ''}`} disabled={!(held > 0n)} onClick={() => setShare(p)}>
                      {p === 100 ? 'All' : `${p}%`}
                    </button>
                  ))}
                  <small className="muted">
                    Position ≈ {formatUsd(heldUsd)} · minimum ≈ ${MIN_USD} per withdrawal
                  </small>
                </div>
              </div>
            )}

            {(belowMin || smallRest) && (
              <p className="earn-note earn-note--warn">
                {mode === 'deposit'
                  ? `Deposits start at $${MIN_USD}. NEAR Intents can’t route less, and a smaller position might be impossible to withdraw later.`
                  : heldUsd < MIN_USD
                    ? `This position is worth less than $${MIN_USD}, which NEAR Intents may not be able to route. Deposit a little more, then withdraw All.`
                    : smallRest
                      ? `That would leave ≈ ${formatUsd(leftUsd)}, too little to withdraw later. Withdraw All instead, or a smaller share.`
                      : `Withdrawals start at $${MIN_USD}. Pick a larger share.`}
              </p>
            )}
            {preview.error && wantQuote && <ErrorNotice error={explain(preview.error)} onRetry={preview.reload} />}

            <div className="stk-quote">
              {q ? (
                <>
                  <span className="dep-label">{mode === 'deposit' ? 'In the vault' : 'You receive'}</span>
                  <strong>{mode === 'deposit' ? `≈ ${formatUsd(Number(q.amountOutUsd || 0))} of ${vault.underlying}` : `≈ ${formatAmount(Number(q.amountOutFormatted))} ${pay.symbol}`}</strong>
                  <small className="muted">
                    {mode === 'deposit'
                      ? `${yearly != null ? `Earns ≈ ${formatUsd(yearly)} a year at today's ${apyText(s.apy)}. ` : ''}Arrives in about ${q.timeEstimate || 60}s.`
                      : `Paid to ${accountId} in ${vault.exitTime}.`}{' '}
                    Includes a {pct(EARN_FEES.totalBps)} service fee ({pct(EARN_FEES.kinuBps)} KINU) and the route’s spread.
                  </small>
                </>
              ) : (
                <small className="muted">{mode === 'deposit' ? 'Enter an amount to see what goes into the vault.' : held > 0n ? 'Pick how much to withdraw.' : 'Your vault position shows here once you deposit.'}</small>
              )}
            </div>

            {accountId && q && (
              <label className="dep-agree">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>
                  I understand {vault.protocol} runs this vault, not KINU or NEAR Intents: yield isn’t guaranteed and I can lose money. I accept the{' '}
                  <Link to="/docs/terms">Terms</Link>.
                </span>
              </label>
            )}

            {!accountId ? (
              <button type="button" className="button button--primary button--block button--lg" onClick={connect}>
                Connect wallet
              </button>
            ) : (
              <button type="button" className="button button--primary button--block button--lg" disabled={!ready || busy} onClick={mode === 'deposit' ? deposit : withdraw}>
                {busy && <Spinner size={14} />} {label}
              </button>
            )}
            <small className="muted stk-fine">
              {mode === 'deposit'
                ? 'You send to a one-time NEAR Intents address; the vault shares go to your own NEAR Intents balance, under your account. KINU never holds them.'
                : 'Your wallet signs a message (no NEAR fee). The first time, it also registers your key with NEAR Intents in one small transaction.'}
            </small>
          </section>
        </div>

        <aside className="stk-side">
          <section className="card earn-vault">
            <div className="earn-vault__head">
              <VaultIcon vault={vault} size={34} />
              <div>
                <h3>{vault.name}</h3>
                <small className="muted">
                  {vault.protocol} · {vault.chainName} · curated by {vault.curator}
                </small>
              </div>
            </div>
            <p className="muted small">{vault.blurb}</p>
            {!s && stats.loading && <Skeleton height={80} />}
            {s && (
              <dl className="earn-stats">
                <div>
                  <dt>APY now</dt>
                  <dd className="up">{apyText(s.apy)}</dd>
                </div>
                {s.apyAvg != null && (
                  <div>
                    <dt>APY average</dt>
                    <dd>{apyText(s.apyAvg)}</dd>
                  </div>
                )}
                {s.apy30d != null && (
                  <div>
                    <dt>APY 30 days</dt>
                    <dd>{apyText(s.apy30d)}</dd>
                  </div>
                )}
                {s.apy90d != null && (
                  <div>
                    <dt>APY 90 days</dt>
                    <dd>{apyText(s.apy90d)}</dd>
                  </div>
                )}
                <div>
                  <dt>Total deposits</dt>
                  <dd>{formatUsd(s.tvlUsd, { compactAbove: 1e3 })}</dd>
                </div>
                {s.holders != null && (
                  <div>
                    <dt>Depositors</dt>
                    <dd>{s.holders.toLocaleString()}</dd>
                  </div>
                )}
                <div>
                  <dt>Exit time</dt>
                  <dd>{vault.exitTime}</dd>
                </div>
              </dl>
            )}
            {stats.error && <ErrorNotice error={stats.error} onRetry={stats.reload} />}
            <div className="earn-links">
              <a href={vault.site} target="_blank" rel="noopener noreferrer">
                {vault.protocol} ↗
              </a>
              <a href={vault.explorer} target="_blank" rel="noopener noreferrer">
                Vault contract ↗
              </a>
              <a href={vault.wrapper} target="_blank" rel="noopener noreferrer">
                Share token ↗
              </a>
            </div>
          </section>

          <section className="card earn-how">
            <h3>How it works</h3>
            <ol>
              <li>
                <b>Deposit</b> USDC or NEAR from your NEAR wallet. NEAR Intents moves it to {vault.chainName} and into the vault.
              </li>
              <li>
                <b>Earn</b>: the vault shares sit in your NEAR Intents balance, under your account, and grow with the vault.
              </li>
              <li>
                <b>Withdraw</b> any time by signing a message: the shares are redeemed and paid back to your NEAR wallet.
              </li>
            </ol>
          </section>
        </aside>

        <aside className="stk-faq">
          <section className="card stk-positions">
            <h3>Your Earn</h3>
            {!accountId && <p className="muted small">Connect your wallet to see your vault positions.</p>}
            {accountId && !positions.data && !positions.error && <Skeleton height={90} />}
            {positions.error && <ErrorNotice error={positions.error} onRetry={positions.reload} />}
            {accountId && positions.data && (
              <>
                {totalUsd > 0 && (
                  <p className="earn-total">
                    <b>{formatUsd(totalUsd)}</b> <span className="muted small">in vaults</span>
                  </p>
                )}
                {VAULTS.filter((v) => positions.data[v.key]?.shares > 0n).map((v) => {
                  const p = positions.data[v.key];
                  const apy = stats.data?.[v.key]?.apy;
                  return (
                    <div key={v.key} className="stk-pos">
                      <VaultIcon vault={v} size={24} />
                      <div>
                        <b>{formatUsd(p.usd)}</b>
                        <small className="muted">
                          {v.name}
                          {apy != null ? ` · ${apyText(apy)} APY` : ''}
                        </small>
                        {apy != null && <small className="up">≈ {formatUsd((p.usd * apy) / 100 / 365)} a day</small>}
                      </div>
                      <button
                        type="button"
                        className="button button--outline button--sm"
                        onClick={() => {
                          setPick(v.key);
                          setMode('withdraw');
                        }}
                      >
                        Withdraw
                      </button>
                    </div>
                  );
                })}
                {!VAULTS.some((v) => positions.data[v.key]?.shares > 0n) && !pending.length && <p className="muted small">No vault positions yet.</p>}
              </>
            )}
            {pending.map((entry) => (
              <Tracker
                key={entry.depositAddress}
                entry={entry}
                onDone={(state) => {
                  positions.reload();
                  if (state === 'SUCCESS') {
                    dropPending(entry.depositAddress);
                    setTimeout(() => setPending(readPending(accountId)), 15_000);
                  }
                }}
              />
            ))}
          </section>

          <div className="card dep-faq">
            <details>
              <summary>Where does the yield come from?</summary>
              <p>
                From borrowers. Gauntlet USDC Prime lends USDC on Morpho to borrowers who post more collateral than they borrow; Kamino SOL Balanced lends SOL across
                Kamino’s Solana markets. The APY shown is the vault’s current rate from Morpho or Kamino, and it changes all the time. It isn’t a promise.
              </p>
            </details>
            <details>
              <summary>Who holds my funds?</summary>
              <p>
                You do. The vault shares sit in NEAR Intents’ contract (intents.near) under your own NEAR account, and only your signature can move them. KINU never
                holds them, and NEAR Intents doesn’t run the vaults. If kinudefi.com were ever down, your shares stay where they are and can be withdrawn through NEAR
                Intents (near-intents.org).
              </p>
            </details>
            <details>
              <summary>What does it cost?</summary>
              <p>
                {pct(EARN_FEES.totalBps)} each way ({pct(EARN_FEES.kinuBps)} to KINU, the rest to NEAR Intents), plus the route’s spread, all included in the price
                shown before you sign. With entry and exit together at about 1%, Earn suits money you plan to leave in for a few months.
              </p>
            </details>
            <details>
              <summary>What are the risks?</summary>
              <p>
                Smart-contract risk in the vault, the lending markets and the bridges NEAR Intents uses to reach Base and Solana; borrowers defaulting in extreme
                markets; withdrawals pausing if a network is paused; and for the SOL vault, SOL’s price. Yield and principal aren’t guaranteed by anyone. Start small.
              </p>
            </details>
            <details>
              <summary>Why do I sign a message to withdraw?</summary>
              <p>
                Your shares are already inside NEAR Intents, so a withdrawal is an instruction you sign rather than a transfer. KINU checks the message before your
                wallet shows it: it may only send this vault’s shares, in the amount quoted, to that withdrawal’s one-time address. The first time, your wallet key is
                registered with NEAR Intents (one small transaction to intents.near).
              </p>
            </details>
          </div>
        </aside>
      </div>
    </div>
  );
}

const Stake = lazy(() => import('./Stake.jsx'));
const TABS = [
  {
    key: 'vaults',
    label: 'Vaults',
    sub: 'USDC & SOL · Base, Solana',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
        <path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
      </svg>
    )
  },
  {
    key: 'staking',
    label: 'Staking',
    sub: 'NEAR · LiNEAR, stNEAR',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l7 4v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V7z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    )
  }
];

/** Earn: the Vaults / Staking choice, kept in the URL (/earn?tab=staking; /stake opens Staking). */
export default function Earn({ initialTab = 'vaults' }) {
  const [tab, setTab] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    return q === 'staking' || q === 'vaults' ? q : initialTab;
  });
  const choose = (key) => {
    setTab(key);
    navigate(key === 'vaults' ? '/earn' : '/earn?tab=staking', { replace: true });
  };
  const switcher = (
    <div className="earn-tabs" role="tablist" aria-label="Earn with">
      {TABS.map((x) => (
        <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} className={tab === x.key ? 'is-on' : ''} onClick={() => choose(x.key)}>
          <span className="earn-tabs__icon">{x.icon}</span>
          <span className="earn-tabs__text">
            <b>{x.label}</b>
            <small>{x.sub}</small>
          </span>
        </button>
      ))}
    </div>
  );
  if (tab === 'staking') {
    return (
      <Suspense fallback={<div className="page stake"><Skeleton height={320} /></div>}>
        <Stake switcher={switcher} />
      </Suspense>
    );
  }
  return <VaultsView switcher={switcher} />;
}
