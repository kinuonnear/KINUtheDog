// Stake (/stake): liquid staking with LiNEAR (linear-protocol.near) or stNEAR (meta-pool.near), the
// two longest-running, DAO-owned liquid staking contracts on NEAR (lib/staking.js). Stake NEAR for a
// token that grows in NEAR value every epoch and can go into Rhea pools; leave instantly (by
// selling it) or through a delayed unstake withdrawable in ~2–3 days. Non-custodial: the wallet
// calls the staking contract directly.

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { getStakingApy, getPosition, liquidUnstakeQuote, liquidUnstakeTx, nearFor, priceOf, sharesFor, STAKING, stakeTx, totalStaked, unstakeTx, withdrawTx } from '../lib/staking.js';
import { getTokens } from '../lib/tokens.js';
import { formatAmount, formatUnits, toBigInt, tryParseUnits } from '../lib/format.js';
import { NEAR_GAS_RESERVE } from '../config.js';
import { ErrorNotice, Skeleton, Spinner } from '../components/ui.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import '../deposit.css';
import '../stake.css';

const KEYS = ['linear', 'stnear'];
const ONE_NEAR = 10n ** 24n;
// Instant unstake through Meta Pool's pool: accept at most this much worse than the quote.
const LIQUID_SLIPPAGE_BPS = 50n;
const near = (yocto, digits) => formatAmount(Number(formatUnits(yocto, 24)), digits ? { compactAbove: 1e6 } : undefined);
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
  const icons = useAsync(() => getTokens(KEYS.map((k) => STAKING[k].contract)), []);
  const positions = useAsync(
    async () => {
      const rows = await Promise.all(KEYS.map(async (k) => [k, await getPosition(k, accountId, info.data[k].price)]));
      return Object.fromEntries(rows);
    },
    [accountId, Boolean(info.data)],
    { enabled: Boolean(accountId && info.data), refreshMs: 30_000 }
  );
  return { info, apy, icons, positions };
}

function TokenIcon({ icons, k, size = 28 }) {
  const src = icons.data?.[STAKING[k].contract]?.icon;
  return src ? <img className="stk-icon" src={src} alt="" width={size} height={size} /> : <span className="stk-icon stk-icon--blank" style={{ width: size, height: size }} />;
}

export default function Stake() {
  const { accountId, connect, nearBalance, execute } = useApp();
  const { info, apy, icons, positions } = useStakingData(accountId);
  const [pick, setPick] = useState('linear');
  const [mode, setMode] = useState('stake');
  const [amount, setAmount] = useState('');
  const [exit, setExit] = useState('instant');
  const [busy, setBusy] = useState(false);

  const s = STAKING[pick];
  const price = info.data?.[pick]?.price || 0n;
  const pos = positions.data?.[pick];
  const raw = toBigInt(tryParseUnits(amount || '0', 24) || '0');

  // Stake: native NEAR, keeping a little for gas.
  const spendable = useMemo(() => {
    const avail = nearBalance ? toBigInt(nearBalance.available) - toBigInt(NEAR_GAS_RESERVE) : 0n;
    return avail > 0n ? avail : 0n;
  }, [nearBalance]);
  // Unstake: token balance.
  const held = pos?.shares || 0n;
  const max = mode === 'stake' ? spendable : held;
  const tooMuch = accountId && raw > max;
  const belowMin = mode === 'stake' && raw > 0n && raw < s.minStake;

  const liquid = useAsync(() => liquidUnstakeQuote(raw), [raw.toString(), pick, mode, exit], {
    enabled: mode === 'unstake' && exit === 'instant' && pick === 'stnear' && raw > 0n && !tooMuch
  });

  const receive = mode === 'stake' ? sharesFor(raw, price) : exit === 'instant' && pick === 'stnear' ? liquid.data || 0n : nearFor(raw, price);
  const ready = Boolean(accountId && raw > 0n && !tooMuch && !belowMin && price > 0n);

  const run = async (build, labels) => {
    setBusy(true);
    const done = await execute(async () => [build()], labels);
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
      const min = (liquid.data * (10_000n - LIQUID_SLIPPAGE_BPS)) / 10_000n;
      return run(() => liquidUnstakeTx(raw, min), { pending: `Unstaking ${amount} stNEAR instantly`, success: 'NEAR is back in your wallet' });
    }
    const all = raw >= held;
    return run(() => unstakeTx(pick, nearFor(raw, price), all), {
      pending: `Unstaking ${amount} ${s.symbol}`,
      success: 'Unstake started: withdraw in about 2–3 days'
    });
  };

  const instantSwapLink = `/swap?from=${s.contract}&to=near${amount ? `&amount=${amount}` : ''}`;
  const liquidDiscount = pick === 'stnear' && liquid.data && raw > 0n ? Number(((nearFor(raw, price) - liquid.data) * 10_000n) / (nearFor(raw, price) || 1n)) / 100 : null;

  let label;
  if (!accountId) label = 'Connect wallet';
  else if (!(raw > 0n)) label = 'Enter an amount';
  else if (tooMuch) label = mode === 'stake' ? 'More than your NEAR' : `More than your ${s.symbol}`;
  else if (belowMin) label = `Minimum is ${near(s.minStake)} NEAR`;
  else if (mode === 'stake') label = `Stake ${amount} NEAR`;
  else if (exit === 'instant') label = pick === 'stnear' ? (liquid.loading ? 'Getting a price…' : `Unstake now for ≈ ${near(receive)} NEAR`) : 'Sell on Swap';
  else label = `Start unstake (≈ ${near(receive)} NEAR in 2–3 days)`;

  return (
    <div className="page stake">
      <header className="pt-hero stk-hero">
        <FlowLines />
        <h1 className="pt-title">Stake</h1>
        <p>Stake NEAR and keep it liquid. Earn validator rewards with LiNEAR or stNEAR, then put the token to work in Rhea pools.</p>
      </header>

      <div className="stk-grid">
        <div className="stk-main">
          <div className="stk-pick">
            {KEYS.map((k) => {
              const p = info.data?.[k];
              const y = apy.data?.[k];
              return (
                <button key={k} type="button" className={`card stk-option ${pick === k ? 'is-on' : ''}`} onClick={() => setPick(k)} aria-pressed={pick === k}>
                  <span className="stk-option__head">
                    <TokenIcon icons={icons} k={k} />
                    <span>
                      <b>{STAKING[k].symbol}</b>
                      <small className="muted">{STAKING[k].name}</small>
                    </span>
                  </span>
                  <span className="stk-option__apy">
                    {y == null ? (apy.loading ? '…' : '—') : `${y.toFixed(2)}%`}
                    <small className="muted">APY · last 30 days</small>
                  </span>
                  <span className="stk-option__meta muted small">
                    {p ? `1 ${STAKING[k].symbol} = ${(Number(p.price) / 1e24).toFixed(4)} NEAR` : '…'}
                    {p?.total ? ` · ${near(p.total, true)} NEAR staked` : ''}
                  </span>
                  <span className="stk-option__meta muted small">DAO-owned · since {STAKING[k].since}</span>
                </button>
              );
            })}
          </div>

          <section className="card stk-card">
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
                {mode === 'stake' ? <img className="stk-icon" src="/logos/tokens/near.svg" alt="" width={28} height={28} /> : <TokenIcon icons={icons} k={pick} />}
                <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(sanitize(e.target.value))} />
                <span className="stk-unit">{mode === 'stake' ? 'NEAR' : s.symbol}</span>
                {accountId && (
                  <button type="button" className="mini-button" onClick={() => setAmount(formatUnits(max, 24))} disabled={!(max > 0n)}>
                    Max
                  </button>
                )}
              </div>
              {accountId && (
                <small className={tooMuch ? 'down' : 'muted'}>
                  {mode === 'stake' ? `Available ${near(spendable)} NEAR (0.25 NEAR kept for gas)` : `Balance ${near(held)} ${s.symbol}`}
                </small>
              )}
            </div>

            {mode === 'unstake' && (
              <div className="stk-exit">
                <button type="button" className={exit === 'instant' ? 'is-on' : ''} onClick={() => setExit('instant')}>
                  <b>Instant</b>
                  <small className="muted">{pick === 'stnear' ? 'Meta Pool’s pool · small discount' : 'Sell on Rhea via Swap'}</small>
                </button>
                <button type="button" className={exit === 'delayed' ? 'is-on' : ''} onClick={() => setExit('delayed')}>
                  <b>Delayed</b>
                  <small className="muted">Full value · about 2–3 days</small>
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
                      ? `Worth ${amount} NEAR now, growing every epoch (~12 h).`
                      : exit === 'delayed'
                        ? 'Withdraw from “Your staking” once it unlocks (about 4 epochs).'
                        : pick === 'stnear'
                          ? liquidDiscount != null
                            ? `Instant, ${liquidDiscount.toFixed(2)}% below full value (Meta Pool’s liquidity fee).`
                            : 'Getting Meta Pool’s price…'
                          : 'Swap shows the exact price on Rhea before you sign.'}
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
            ) : mode === 'unstake' && exit === 'instant' && pick === 'linear' ? (
              <Link to={instantSwapLink} className={`button button--primary button--block button--lg ${ready ? '' : 'is-disabled'}`} aria-disabled={!ready}>
                {label}
              </Link>
            ) : (
              <button
                type="button"
                className="button button--primary button--block button--lg"
                disabled={!ready || busy || (mode === 'unstake' && exit === 'instant' && pick === 'stnear' && !liquid.data)}
                onClick={submit}
              >
                {busy && <Spinner size={14} />} {label}
              </button>
            )}
            <small className="muted stk-fine">
              Staking goes straight from your wallet to {s.contract}. KINU adds no fee and never holds your NEAR.
            </small>
          </section>
        </div>

        <aside className="stk-side">
          <section className="card stk-positions">
            <h3>Your staking</h3>
            {!accountId && <p className="muted small">Connect your wallet to see your LiNEAR and stNEAR.</p>}
            {accountId && !positions.data && <Skeleton height={90} />}
            {accountId &&
              positions.data &&
              KEYS.map((k) => {
                const p = positions.data[k];
                return (
                  <div key={k} className="stk-pos">
                    <TokenIcon icons={icons} k={k} size={24} />
                    <div>
                      <b>
                        {near(p.shares)} {STAKING[k].symbol}
                      </b>
                      <small className="muted">≈ {near(p.valueNear)} NEAR</small>
                      {p.unstaked > 0n && (
                        <small className={p.canWithdraw ? 'up' : 'muted'}>
                          {near(p.unstaked)} NEAR unstaking · {p.canWithdraw ? 'ready to withdraw' : 'unlocks in ~2–3 days'}
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
            {accountId && positions.data && KEYS.some((k) => positions.data[k].shares > 0n) && (
              <Link to="/pools" className="button button--ghost button--sm stk-lp">
                Put it to work · Find LiNEAR / stNEAR pools
              </Link>
            )}
          </section>

          <div className="card dep-faq">
            <details>
              <summary>Where does the yield come from?</summary>
              <p>Your NEAR is delegated to hundreds of NEAR validators. Their rewards raise the NEAR value of each LiNEAR / stNEAR every epoch. The APY shown is what the token actually gained over the last 30 days, after all fees — not a promise.</p>
            </details>
            <details>
              <summary>How do I get my NEAR back?</summary>
              <p>Instantly, by selling the token (a small discount), or with a delayed unstake at full value: it unlocks after about four epochs (~2–3 days), then you press Withdraw under “Your staking”.</p>
            </details>
            <details>
              <summary>What are the risks?</summary>
              <p>
                Smart-contract risk (a bug in the staking contract), the token trading slightly below its NEAR value when you sell it, and waiting days on a delayed
                unstake. Both contracts are owned by DAOs ({STAKING.linear.owner}, {STAKING.stnear.owner}) that can upgrade them. Start small.
              </p>
            </details>
            <details>
              <summary>Does KINU take a fee?</summary>
              <p>No. The staking providers keep a share of validator rewards (already reflected in the APY). KINU adds nothing.</p>
            </details>
          </div>
        </aside>
      </div>
    </div>
  );
}
