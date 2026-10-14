// In-app liquidity management for every Rhea pool type:
//   AMM (SIMPLE_POOL)                  -> AmmLiquidity
//   Stable / ALMM (STABLE, RATED, DEGEN)-> StableLiquidity
//   CLMM (DCL)                         -> DclLiquidity

import { useMemo, useRef, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useChainUpdates, useDebounced } from '../hooks.js';
import {
  amountsForShares,
  buildAddLiquidityTransactions,
  buildAddStableLiquidityTransactions,
  buildRemoveLiquidityTransactions,
  expectedShares,
  pairedAmount,
  buildWithdrawDepositsTransactions,
  predictRemoveAmounts,
  predictStableShares
} from '../lib/liquidity.js';
import { buildDclWithdrawTransactions, getDclAssets } from '../lib/dclLiquidity.js';
import { wrapNeededFor } from '../lib/tx.js';
import {
  applySlippage,
  formatPercent,
  formatRawAmount,
  formatUnits,
  formatUsd,
  maxBig,
  toBigInt,
  toNumber,
  tryParseUnits
} from '../lib/format.js';
import { priceOf } from '../lib/tokens.js';
import { getDegenPoolLimit, getDeposits, getPool } from '../lib/rhea.js';
import { buildClassicZapTransactions, quoteClassicZap } from '../lib/zap.js';
import { buildClassicZapOutTransactions, quoteClassicZapOut } from '../lib/zapOut.js';
import { defaultZapToken, useZapSpendable, ZapInput } from './ZapIn.jsx';
import { CONTRACTS, NEAR_GAS_RESERVE } from '../config.js';
import { EmptyState, Spinner, Tabs, TokenIcon } from './ui.jsx';
import DclCreatePosition from './DclCreatePosition.jsx';

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

/** Inputs show at most 8 decimals (rounded down so balances are never exceeded). */
export function trimDecimals(text) {
  const [whole, fraction = ''] = String(text).split('.');
  const kept = fraction.slice(0, 8).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

const cleanDecimal = (value) => {
  const text = value.replace(',', '.');
  return /^\d*\.?\d*$/.test(text) ? text : null;
};

/** Spendable raw balance per token. wNEAR also counts native NEAR (wrapped automatically). */
export function useSpendable(tokenIds) {
  const { balances, nearBalance } = useApp();
  return useMemo(() => {
    let native = 0n;
    if (nearBalance) {
      const rest = toBigInt(nearBalance.available) - toBigInt(NEAR_GAS_RESERVE);
      native = rest > 0n ? rest : 0n;
    }
    return tokenIds.map((id) => toBigInt(balances[id] || '0') + (id === CONTRACTS.wrapNear ? native : 0n));
  }, [tokenIds, balances, nearBalance]);
}

/**
 * NEAR to wrap at signing time, from the wNEAR balance read on-chain now: the page's balance can
 * lag (e.g. right after a wrap or a swap) and leave the deposit short ("Not enough balance").
 */
function wrapAtSubmit(accountId, tokenIds, raws, balances) {
  const index = tokenIds.indexOf(CONTRACTS.wrapNear);
  if (index < 0 || !raws[index]) return Promise.resolve('0');
  return wrapNeededFor(accountId, raws[index], balances[CONTRACTS.wrapNear]);
}

/** Raw NEAR to wrap so the wNEAR side of a deposit is covered (for display; see wrapAtSubmit). */
export function useWrapAmount(tokenIds, raws) {
  const { balances } = useApp();
  const index = tokenIds.indexOf(CONTRACTS.wrapNear);
  if (index < 0 || !raws[index]) return '0';
  return maxBig(0n, toBigInt(raws[index]) - toBigInt(balances[CONTRACTS.wrapNear] || '0')).toString();
}

export function AmountField({ token, value, onChange, spendable, onMax, disabled, note }) {
  const { accountId } = useApp();
  return (
    <div className={`swap-field ${disabled ? 'swap-field--disabled' : ''}`}>
      <div className="swap-field__top">
        <span>
          {token?.symbol}
          {note && <small className="muted"> · {note}</small>}
        </span>
        {accountId && spendable !== undefined && (
          <span className="swap-field__balance">
            Balance {formatRawAmount(spendable.toString(), token?.decimals ?? 0)}
            {onMax && !disabled && (
              <button type="button" className="mini-button" onClick={onMax}>
                Max
              </button>
            )}
          </span>
        )}
      </div>
      <div className="swap-field__row">
        <input
          inputMode="decimal"
          placeholder={disabled ? 'Not needed' : '0.0'}
          value={disabled ? '' : value}
          disabled={disabled}
          onChange={(e) => {
            const text = cleanDecimal(e.target.value);
            if (text !== null) onChange(text);
          }}
        />
        <span className="token-select token-select--static">
          <TokenIcon token={token} size={24} />
          <strong>{token?.symbol}</strong>
        </span>
      </div>
    </div>
  );
}

function SubmitButton({ label, disabled, submitting, onClick }) {
  return (
    <button type="button" className="button button--primary button--block button--lg" disabled={disabled || submitting} onClick={onClick}>
      {submitting && <Spinner size={14} />}
      {submitting ? 'Confirm in wallet…' : label}
    </button>
  );
}

function ConnectPrompt() {
  const { connect } = useApp();
  return (
    <EmptyState
      title="Connect to manage liquidity"
      action={
        <button type="button" className="button button--primary" onClick={connect}>
          Connect wallet
        </button>
      }
    />
  );
}

function PercentPicker({ percent, setPercent }) {
  return (
    <div className="range-block">
      <div className="range-block__value">{percent}%</div>
      <input type="range" min="1" max="100" value={percent} onChange={(e) => setPercent(Number(e.target.value))} aria-label="Percent to remove" />
      <div className="segmented segmented--full">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} type="button" className={percent === p ? 'active' : ''} onClick={() => setPercent(p)}>
            {p === 100 ? 'Max' : `${p}%`}
          </button>
        ))}
      </div>
    </div>
  );
}

function insufficientLabel(raws, spendable, tokens) {
  const i = raws.findIndex((r, j) => r && toBigInt(r) > spendable[j]);
  return i >= 0 ? `Insufficient ${tokens[i]?.symbol}` : null;
}

/* ------------------------------------------------------------------ */
/* AMM (SIMPLE_POOL)                                                   */
/* ------------------------------------------------------------------ */

function AmmAdd({ pool, tokens, onDone }) {
  const { accountId, connect, slippage, execute, balances } = useApp();
  const [inputs, setInputs] = useState(() => pool.tokenIds.map(() => ''));
  const [submitting, setSubmitting] = useState(false);
  const [zapMode, setZapMode] = useState(false);
  const spendable = useSpendable(pool.tokenIds);
  const raws = inputs.map((v, i) => tryParseUnits(v, tokens[i]?.decimals ?? 0));
  const wrapAmount = useWrapAmount(pool.tokenIds, raws);

  const setAmount = (index, text) => {
    const raw = tryParseUnits(text, tokens[index]?.decimals ?? 0);
    setInputs(
      pool.tokenIds.map((_, j) => {
        if (j === index) return text;
        if (!raw || pool.tokenIds.length !== 2) return inputs[j];
        return trimDecimals(formatUnits(pairedAmount(pool, index, j, raw), tokens[j]?.decimals ?? 0));
      })
    );
  };

  const setMax = (index) => {
    if (pool.tokenIds.length !== 2) return;
    const other = 1 - index;
    let amount = spendable[index];
    if (toBigInt(pairedAmount(pool, index, other, amount.toString())) > spendable[other]) {
      amount = toBigInt(pairedAmount(pool, other, index, spendable[other].toString()));
    }
    setAmount(index, trimDecimals(formatUnits(amount.toString(), tokens[index]?.decimals ?? 0)));
  };

  const complete = raws.every((r) => r && toBigInt(r) > 0n);
  const shares = complete ? expectedShares(pool, raws) : '0';
  const supply = toBigInt(pool.sharesTotalSupply);
  const sharePct = supply > 0n && toBigInt(shares) > 0n ? (Number(shares) / Number(supply + toBigInt(shares))) * 100 : 0;
  const insufficient = complete && insufficientLabel(raws, spendable, tokens);

  const submit = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const ok = await execute(
      async () => {
        const wrap = await wrapAtSubmit(accountId, pool.tokenIds, raws, balances);
        return buildAddLiquidityTransactions({ pool, amounts: raws, accountId, slippage, wrapAmount: wrap });
      },
      { pending: 'Adding liquidity', success: 'Liquidity added' }
    );
    setSubmitting(false);
    if (ok) {
      setInputs(pool.tokenIds.map(() => ''));
      onDone();
    }
  };

  return (
    <div className="liq-form">
      {pool.tokenIds.length === 2 && (
        <div className="segmented liq-mode">
          <button type="button" className={!zapMode ? 'active' : ''} onClick={() => setZapMode(false)}>
            Both tokens
          </button>
          <button type="button" className={zapMode ? 'active' : ''} onClick={() => setZapMode(true)}>
            ⚡ Zap in
          </button>
        </div>
      )}
      {zapMode ? (
        <ClassicZap pool={pool} tokens={tokens} onDone={onDone} />
      ) : (
        <>
      <p className="liq-hint">Deposit both tokens at the current pool ratio — the second amount fills in automatically.</p>
      {pool.tokenIds.map((id, i) => (
        <AmountField
          key={id}
          token={tokens[i]}
          value={inputs[i]}
          onChange={(text) => setAmount(i, text)}
          spendable={spendable[i]}
          onMax={() => setMax(i)}
          note={id === CONTRACTS.wrapNear ? 'NEAR auto-wraps' : null}
        />
      ))}
      {complete && (
        <dl className="kv">
          <div>
            <dt>Share of pool</dt>
            <dd>{formatPercent(sharePct, 4)}</dd>
          </div>
          {accountId && toBigInt(wrapAmount) > 0n && (
            <div>
              <dt>NEAR to wrap</dt>
              <dd>{formatRawAmount(wrapAmount, 24)} NEAR</dd>
            </div>
          )}
          <div>
            <dt>Max slippage</dt>
            <dd>{slippage}%</dd>
          </div>
        </dl>
      )}
      <SubmitButton
        label={!accountId ? 'Connect wallet' : !complete ? 'Enter amounts' : insufficient || 'Add liquidity'}
        disabled={accountId && (!complete || Boolean(insufficient))}
        submitting={submitting}
        onClick={submit}
      />
        </>
      )}
    </div>
  );
}

/**
 * Zap into a classic pool with one token (lib/zap.js quoteClassicZap): the app swaps half its
 * value into the other side and deposits at the pool ratio, in one wallet request.
 */
function ClassicZap({ pool, tokens, onDone }) {
  const { accountId, connect, slippage, execute, prices } = useApp();
  const [a, b] = tokens;
  const [token, setToken] = useState(() => defaultZapToken(a, b));
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const raw = tryParseUnits(text, token.decimals) || '0';
  const spendable = useZapSpendable(token);
  const debounced = useDebounced(raw, 450);
  const quote = useAsync(
    () => quoteClassicZap({ inputToken: token, amountIn: debounced, pool, tokens, slippage, user: accountId || undefined }),
    [token.id, debounced, slippage, accountId, pool.amounts.join()],
    { enabled: toBigInt(debounced) > 0n }
  );
  const zap = quote.data;
  const stale = raw !== debounced;
  const insufficient = accountId && toBigInt(raw) > spendable;
  const legs = zap
    ? [
        [zap.legA, a],
        [zap.legB, b]
      ].filter(([leg]) => leg.kind !== 'none')
    : [];
  const depositUsd = zap ? zap.deposit.reduce((s, d, i) => s + toNumber(d, tokens[i].decimals) * priceOf(prices, tokens[i].id), 0) : 0;
  const inputUsd = toNumber(raw, token.decimals) * priceOf(prices, token.id);

  const submit = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const ok = await execute(
      async () => {
        // Always execute a fresh, user-bound quote on the live pool.
        const fresh = await getPool(pool.id);
        const live = await quoteClassicZap({ inputToken: token, amountIn: raw, pool: fresh, tokens, slippage, user: accountId });
        return buildClassicZapTransactions({ zap: live, inputToken: token, pool: fresh, tokens, slippage, accountId });
      },
      { pending: `Zapping ${token.symbol} into ${a.symbol}/${b.symbol}`, success: 'Zap complete — liquidity added' }
    );
    setSubmitting(false);
    if (ok) {
      setText('');
      onDone();
    }
  };

  const label = !accountId
    ? 'Connect wallet'
    : toBigInt(raw) <= 0n
      ? 'Enter an amount'
      : insufficient
        ? `Insufficient ${token.symbol}`
        : `Zap in ${token.symbol}`;

  return (
    <>
      <p className="liq-hint">One token in: half its value is swapped into the other side and both are deposited at the pool ratio.</p>
      <ZapInput token={token} setToken={setToken} text={text} setText={setText} spendable={spendable} x={a} y={b} />
      {toBigInt(raw) > 0n &&
        (quote.loading && !zap ? (
          <div className="zap-breakdown">
            <Spinner size={14} /> <span className="muted small">Finding the best route…</span>
          </div>
        ) : quote.error ? (
          <div className="notice notice--error">{quote.error.message || 'Could not route this zap.'}</div>
        ) : zap ? (
          <div className="zap-breakdown">
            <dl className="kv">
              {legs.map(([leg, t]) => (
                <div key={t.id}>
                  <dt>{leg.kind === 'swap' ? `Swap → ${t.symbol}` : leg.kind === 'wrap' ? `Wrap → ${t.symbol}` : `Keep ${t.symbol}`}</dt>
                  <dd>
                    {formatRawAmount(leg.amountIn, token.decimals)} {token.symbol}
                    {leg.kind === 'swap' && (
                      <small className="muted">
                        {' '}
                        → ≥ {formatRawAmount(leg.minOut, t.decimals)} {t.symbol} · {leg.quote.dexs.join(' + ')}
                      </small>
                    )}
                  </dd>
                </div>
              ))}
              <div>
                <dt>Deposited</dt>
                <dd>
                  {formatRawAmount(zap.deposit[0], a.decimals)} {a.symbol} + {formatRawAmount(zap.deposit[1], b.decimals)} {b.symbol}
                </dd>
              </div>
              {inputUsd > 0 && depositUsd > 0 && (
                <div>
                  <dt>Deposited value</dt>
                  <dd>
                    {formatUsd(depositUsd)} <small className="muted">of {formatUsd(inputUsd)}</small>
                  </dd>
                </div>
              )}
              <div>
                <dt>Max slippage</dt>
                <dd>{slippage}%</dd>
              </div>
            </dl>
            <p className="hint">Deposits use each swap&apos;s guaranteed minimum; any surplus stays in your wallet.</p>
          </div>
        ) : null)}
      <SubmitButton
        label={label}
        disabled={accountId && (toBigInt(raw) <= 0n || Boolean(insufficient) || !zap || stale || Boolean(quote.error))}
        submitting={submitting}
        onClick={submit}
      />
    </>
  );
}

/** Proportional removal for AMM, Stable and ALMM pools. */
function SharesRemove({ pool, tokens, shares, staked, onDone, predict }) {
  const { accountId, slippage, execute } = useApp();
  const [percent, setPercent] = useState(50);
  const [submitting, setSubmitting] = useState(false);
  // Zap out (two-token pools): receive one token — the other side is swapped (lib/zapOut.js).
  const canZap = pool.tokenIds.length === 2;
  const [zapOut, setZapOut] = useState(false);
  const [target, setTarget] = useState(() => (pool.tokenIds[0] === CONTRACTS.wrapNear ? 0 : pool.tokenIds[1] === CONTRACTS.wrapNear ? 1 : 0));
  const removeShares = ((toBigInt(shares) * BigInt(percent)) / 100n).toString();
  const debounced = useDebounced(removeShares, 300);
  const predicted = useAsync(() => predictRemoveAmounts(pool.id, debounced), [pool.id, debounced], {
    enabled: Boolean(predict) && toBigInt(debounced) > 0n && !zapOut
  });
  const out = predict && predicted.data ? predicted.data : amountsForShares(pool, removeShares);
  const zapQuote = useAsync(
    () => quoteClassicZapOut({ pool, tokens, shares: debounced, target, slippage, user: accountId || undefined }),
    [pool.id, debounced, target, slippage, accountId],
    { enabled: canZap && zapOut && toBigInt(debounced) > 0n }
  );
  const zapStale = debounced !== removeShares;
  const walletToken = (t) => (t.id === CONTRACTS.wrapNear ? { ...t, symbol: 'NEAR' } : t);

  if (!accountId) return <ConnectPrompt />;
  if (toBigInt(shares) === 0n) {
    return (
      <EmptyState title="No removable liquidity">
        {toBigInt(staked) > 0n
          ? 'Your LP shares are staked in a Rhea farm. Unstake them on Rhea before removing.'
          : 'You have no LP shares in this pool yet.'}
      </EmptyState>
    );
  }

  const submit = async () => {
    setSubmitting(true);
    const ok = zapOut
      ? await execute(
          async () => {
            // Always execute a fresh, user-bound quote on the live pool.
            const fresh = await getPool(pool.id);
            const zap = await quoteClassicZapOut({ pool: fresh, tokens, shares: removeShares, target, slippage, user: accountId });
            return buildClassicZapOutTransactions({ zap, slippage, accountId });
          },
          { pending: `Zapping out to ${walletToken(tokens[target]).symbol}`, success: 'Zap out complete' }
        )
      : await execute(
          async () => {
            const expectedAmounts = predict ? await predictRemoveAmounts(pool.id, removeShares) : undefined;
            return buildRemoveLiquidityTransactions({ pool, shares: removeShares, accountId, slippage, expectedAmounts });
          },
          { pending: 'Removing liquidity', success: 'Liquidity removed' }
        );
    setSubmitting(false);
    if (ok) onDone();
  };

  const zap = zapQuote.data;
  if (canZap && zapOut) {
    const outT = walletToken(tokens[target]);
    return (
      <div className="liq-form">
        <div className="segmented liq-mode">
          <button type="button" onClick={() => setZapOut(false)}>
            Both tokens
          </button>
          <button type="button" className="active">
            ⚡ Zap out
          </button>
        </div>
        <PercentPicker percent={percent} setPercent={setPercent} />
        <div className="zap-out-target">
          <span className="muted small">Receive only</span>
          {tokens.map((t, i) => (
            <button key={t.id} type="button" className={`chip ${target === i ? 'chip--active' : ''}`} onClick={() => setTarget(i)}>
              <TokenIcon token={t} size={16} /> {walletToken(t).symbol}
            </button>
          ))}
        </div>
        {zapQuote.loading && !zap ? (
          <div className="zap-breakdown">
            <Spinner size={14} /> <span className="muted small">Finding the best route…</span>
          </div>
        ) : zapQuote.error ? (
          <div className="notice notice--error">{zapQuote.error.message || 'Could not route this zap out.'}</div>
        ) : zap ? (
          <dl className="kv">
            {zap.swap && (
              <div>
                <dt>Swap → {outT.symbol}</dt>
                <dd>
                  {formatRawAmount(zap.swap.amountIn, zap.sellToken.decimals)} {zap.sellToken.symbol}{' '}
                  <small className="muted">· {zap.swap.quote.dexs.join(' + ')}</small>
                </dd>
              </div>
            )}
            <div>
              <dt>You receive</dt>
              <dd>
                <strong>
                  ≈ {formatRawAmount(zap.receiveEst.toString(), outT.decimals)} {outT.symbol}
                </strong>
                <small className="muted">
                  {' '}
                  · at least {formatRawAmount(zap.receiveMin.toString(), outT.decimals)}
                </small>
              </dd>
            </div>
            <div>
              <dt>Max slippage</dt>
              <dd>{slippage}%</dd>
            </div>
          </dl>
        ) : null}
        <SubmitButton
          label={`Zap out to ${outT.symbol}`}
          disabled={!zap || zapStale || Boolean(zapQuote.error)}
          submitting={submitting}
          onClick={submit}
        />
        <p className="hint">Removes your liquidity and swaps the other side into {outT.symbol}, in one wallet request. Fees earned come out with it.</p>
      </div>
    );
  }

  return (
    <div className="liq-form">
      {canZap && (
        <div className="segmented liq-mode">
          <button type="button" className="active">
            Both tokens
          </button>
          <button type="button" onClick={() => setZapOut(true)}>
            ⚡ Zap out
          </button>
        </div>
      )}
      <PercentPicker percent={percent} setPercent={setPercent} />
      <dl className="kv">
        {pool.tokenIds.map((id, i) => (
          <div key={id}>
            <dt>
              <TokenIcon token={tokens[i]} size={18} /> {tokens[i]?.symbol}
            </dt>
            <dd>{predicted.loading && predict ? <Spinner size={12} /> : formatRawAmount(out[i] || '0', tokens[i]?.decimals ?? 0)}</dd>
          </div>
        ))}
        <div>
          <dt>Max slippage</dt>
          <dd>{slippage}%</dd>
        </div>
      </dl>
      <SubmitButton label="Remove liquidity" submitting={submitting} onClick={submit} />
      <p className="hint">Tokens are withdrawn straight back to your wallet in the same transaction.</p>
    </div>
  );
}

/**
 * Tokens of this pool left in the user's Rhea exchange balance (e.g. the excess of an add whose
 * ratio drifted, or a deposit whose add failed), with a one-tap withdrawal to the wallet.
 */
const LEFTOVER_MIN_USD = 0.01;

function ExchangeLeftovers({ pool, tokens }) {
  const { accountId, execute, prices } = useApp();
  const deposits = useAsync(() => getDeposits(accountId), [accountId], { enabled: Boolean(accountId), refreshMs: 15_000 });
  useChainUpdates(() => deposits.reload());
  const left = Object.entries(deposits.data || {}).filter(([id]) => pool.tokenIds.includes(id));
  // An add's rounding dust (worth a fraction of a cent) isn't worth the gas to withdraw: no
  // notice for it. Unpriced tokens still show. Portfolio → Rhea deposits lists everything.
  const worth = left.reduce((s, [id, rawAmount]) => {
    const t = tokens[pool.tokenIds.indexOf(id)];
    const price = priceOf(prices, id);
    return price > 0 ? s + toNumber(rawAmount, t?.decimals ?? 0) * price : Infinity;
  }, 0);
  if (!left.length || worth < LEFTOVER_MIN_USD) return null;
  const withdraw = async () => {
    const ok = await execute(() => buildWithdrawDepositsTransactions({ tokenIds: left.map(([id]) => id), accountId }), {
      pending: 'Withdrawing your Rhea balance',
      success: 'Withdrawn to wallet'
    });
    if (ok) deposits.reload();
  };
  return (
    <div className="notice notice--info">
      <span>
        {left
          .map(([id, rawAmount]) => {
            const t = tokens[pool.tokenIds.indexOf(id)];
            return `${formatRawAmount(rawAmount, t?.decimals ?? 0)} ${t?.symbol || id}`;
          })
          .join(' + ')}{' '}
        waiting in your Rhea balance.
      </span>
      <button type="button" className="link-button" onClick={withdraw}>
        Withdraw
      </button>
    </div>
  );
}

/** How fees work in AMM, Stable and ALMM pools (unlike CLMM, where fees are claimed). */
export function FeeCompoundNote() {
  return (
    <div className="fee-compound-note">
      <span aria-hidden>↻</span>
      <p>
        <strong>AMM, Stable and ALMM fees and profits are auto-compounded and don’t require claiming.</strong> Every swap’s fee goes
        back into the pool, so your LP shares grow in value — they come out with your liquidity when you withdraw.
      </p>
    </div>
  );
}

export function AmmLiquidity({ pool, tokens, shares, staked, onDone, initialTab = 'add' }) {
  const [tab, setTab] = useState(initialTab === 'remove' ? 'remove' : 'add');
  return (
    <>
      <ExchangeLeftovers pool={pool} tokens={tokens} />
      <Tabs tabs={[{ key: 'add', label: 'Deposit' }, { key: 'remove', label: 'Withdraw' }]} value={tab} onChange={setTab} size="block" />
      {tab === 'add' ? (
        <AmmAdd pool={pool} tokens={tokens} onDone={onDone} />
      ) : (
        <SharesRemove pool={pool} tokens={tokens} shares={shares} staked={staked} onDone={onDone} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stable / ALMM                                                       */
/* ------------------------------------------------------------------ */

/** Above this, an unbalanced stable / ALMM deposit gets a visible warning. */
const IMBALANCE_WARN_PCT = 1;

const DEPOSIT_MODES = [
  { key: 'balanced', label: 'Balanced' },
  { key: 'custom', label: 'Custom amounts' }
];

function StableAdd({ pool, tokens, onDone }) {
  const { accountId, connect, slippage, execute, prices, balances } = useApp();
  const [inputs, setInputs] = useState(() => pool.tokenIds.map(() => ''));
  // Balanced by default (same as app.rhea.finance): one amount fills the others at the pool
  // ratio. Custom lets any mix through, including a single token, for an imbalance fee.
  const [mode, setMode] = useState('balanced');
  const capacity = useAsync(() => (pool.kind === 'DEGEN_SWAP' ? getDegenPoolLimit(pool.id) : null), [pool.id, pool.kind]);
  const [submitting, setSubmitting] = useState(false);
  const spendable = useSpendable(pool.tokenIds);
  const raws = inputs.map((v, i) => tryParseUnits(v, tokens[i]?.decimals ?? 0) || '0');
  const wrapAmount = useWrapAmount(pool.tokenIds, raws);
  const any = raws.some((r) => toBigInt(r) > 0n);
  const amountsKey = useDebounced(raws.join(','), 400);

  const prediction = useAsync(() => predictStableShares(pool.id, amountsKey.split(',')), [pool.id, amountsKey], {
    enabled: amountsKey.split(',').some((r) => toBigInt(r) > 0n)
  });
  const shares = prediction.data || '0';
  const supply = toBigInt(pool.sharesTotalSupply);
  const sharePct = toBigInt(shares) > 0n ? (Number(shares) / Number(supply + toBigInt(shares))) * 100 : 0;
  const insufficient = insufficientLabel(raws, spendable, tokens);

  const setAmount = (index, text) => {
    if (mode !== 'balanced') {
      setInputs(inputs.map((v, j) => (j === index ? text : v)));
      return;
    }
    const raw = tryParseUnits(text, tokens[index]?.decimals ?? 0);
    setInputs(
      pool.tokenIds.map((_, j) => {
        if (j === index) return text;
        if (!raw || toBigInt(raw) === 0n) return '';
        return trimDecimals(formatUnits(pairedAmount(pool, index, j, raw), tokens[j]?.decimals ?? 0));
      })
    );
  };

  const setMax = (index) => {
    if (mode !== 'balanced') {
      setAmount(index, trimDecimals(formatUnits(spendable[index].toString(), tokens[index]?.decimals ?? 0)));
      return;
    }
    // Largest balanced deposit the wallet can cover.
    let amount = spendable[index];
    pool.tokenIds.forEach((_, j) => {
      if (j === index) return;
      if (toBigInt(pairedAmount(pool, index, j, amount.toString())) > spendable[j]) {
        amount = toBigInt(pairedAmount(pool, j, index, spendable[j].toString()));
      }
    });
    setAmount(index, trimDecimals(formatUnits(amount.toString(), tokens[index]?.decimals ?? 0)));
  };

  // What goes in vs. what the LP shares are worth: the gap is the pool's imbalance fee.
  const usdOf = (amounts) => amounts.reduce((sum, raw, i) => sum + toNumber(raw, tokens[i]?.decimals ?? 0) * priceOf(prices, pool.tokenIds[i]), 0);
  const depositUsd = usdOf(raws);
  const lpUsd = supply > 0n && toBigInt(shares) > 0n ? (Number(shares) / Number(supply)) * usdOf(pool.amounts) : 0;
  const imbalancePct = depositUsd > 0 && lpUsd > 0 ? Math.max(0, (1 - lpUsd / depositUsd) * 100) : null;
  const filled = raws.map((r, i) => (toBigInt(r) > 0n ? tokens[i]?.symbol : null)).filter(Boolean);
  const singleSided = filled.length === 1 && pool.tokenIds.length > 1;

  const poolUsd = usdOf(pool.amounts);
  const limitUsd = capacity.data || null;
  const remainingUsd = limitUsd ? Math.max(0, limitUsd - poolUsd) : null;
  const overCapacity = remainingUsd !== null && depositUsd > remainingUsd;

  const submit = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const ok = await execute(
      async () => {
        const [fresh, wrap] = await Promise.all([predictStableShares(pool.id, raws), wrapAtSubmit(accountId, pool.tokenIds, raws, balances)]);
        return buildAddStableLiquidityTransactions({
          pool,
          amounts: raws,
          minShares: applySlippage(fresh, slippage),
          accountId,
          wrapAmount: wrap
        });
      },
      { pending: 'Adding liquidity', success: 'Liquidity added' }
    );
    setSubmitting(false);
    if (ok) {
      setInputs(pool.tokenIds.map(() => ''));
      onDone();
    }
  };

  return (
    <div className="liq-form">
      <div className="segmented segmented--full">
        {DEPOSIT_MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            className={mode === m.key ? 'active' : ''}
            onClick={() => {
              setMode(m.key);
              setInputs(pool.tokenIds.map(() => ''));
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="liq-hint">
        {mode === 'balanced'
          ? 'All tokens at the current pool ratio — the other amounts fill in automatically. Lowest fee.'
          : 'Any mix, including a single token. The pool charges a small imbalance fee for uneven deposits.'}
      </p>
      {pool.tokenIds.map((id, i) => (
        <AmountField
          key={id}
          token={tokens[i]}
          value={inputs[i]}
          onChange={(text) => setAmount(i, text)}
          spendable={spendable[i]}
          onMax={() => setMax(i)}
          note={id === CONTRACTS.wrapNear ? 'NEAR auto-wraps' : null}
        />
      ))}
      {limitUsd && (
        <div className="pool-capacity">
          <div className="pool-capacity__head">
            <span>Pool capacity</span>
            <b>
              {formatUsd(poolUsd)} / {formatUsd(limitUsd)}
            </b>
          </div>
          <div className="pool-capacity__bar">
            <span style={{ width: `${Math.min(100, (poolUsd / limitUsd) * 100)}%` }} />
          </div>
          <div className="pool-capacity__foot muted small">
            <span>{formatPercent((poolUsd / limitUsd) * 100, 1)} used</span>
            <span className={overCapacity ? 'down' : 'up'}>{formatUsd(remainingUsd)} remaining</span>
          </div>
        </div>
      )}
      {any && (
        <dl className="kv">
          <div>
            <dt>Deposit</dt>
            <dd>{singleSided ? `${filled[0]} only (single-token)` : filled.join(' + ')}</dd>
          </div>
          {depositUsd > 0 && (
            <div>
              <dt>You put in → LP worth</dt>
              <dd>
                {formatUsd(depositUsd)} → {prediction.loading || !lpUsd ? <Spinner size={12} /> : formatUsd(lpUsd)}
              </dd>
            </div>
          )}
          {imbalancePct !== null && (
            <div>
              <dt>Imbalance fee</dt>
              <dd className={imbalancePct > IMBALANCE_WARN_PCT ? 'warn' : ''}>{formatPercent(imbalancePct, 3)}</dd>
            </div>
          )}
          <div>
            <dt>Share of pool</dt>
            <dd>{prediction.loading ? <Spinner size={12} /> : formatPercent(sharePct, 4)}</dd>
          </div>
          {accountId && toBigInt(wrapAmount) > 0n && (
            <div>
              <dt>NEAR to wrap</dt>
              <dd>{formatRawAmount(wrapAmount, 24)} NEAR</dd>
            </div>
          )}
          <div>
            <dt>Max slippage</dt>
            <dd>{slippage}%</dd>
          </div>
        </dl>
      )}
      {overCapacity && (
        <div className="notice notice--error">
          This deposit ({formatUsd(depositUsd)}) is more than the {formatUsd(remainingUsd)} the pool can still take. Reduce the amount.
        </div>
      )}
      {singleSided && (
        <p className="liq-hint">
          You&apos;re adding only {filled[0]}. This pool accepts that: you receive LP shares for its value, and the pool charges a
          small imbalance fee for tipping its balance. Add both tokens near the pool ratio to pay less.
        </p>
      )}
      {imbalancePct !== null && imbalancePct > IMBALANCE_WARN_PCT && (
        <div className="notice notice--warn">
          This deposit is far from the pool&apos;s balance and costs about {formatPercent(imbalancePct, 2)}. Smaller or more balanced
          amounts cost less.
        </div>
      )}
      {prediction.error && any && <div className="notice notice--error">{prediction.error.message}</div>}
      <SubmitButton
        label={
          !accountId
            ? 'Connect wallet'
            : !any
              ? 'Enter an amount'
              : insufficient || (overCapacity ? 'Over pool capacity' : singleSided ? `Add liquidity (${filled[0]} only)` : 'Add liquidity')
        }
        disabled={accountId && (!any || Boolean(insufficient) || overCapacity || Boolean(prediction.error))}
        submitting={submitting}
        onClick={submit}
      />
    </div>
  );
}

export function StableLiquidity({ pool, tokens, shares, staked, onDone, initialTab = 'add' }) {
  const [tab, setTab] = useState(initialTab === 'remove' ? 'remove' : 'add');
  return (
    <>
      <ExchangeLeftovers pool={pool} tokens={tokens} />
      <Tabs tabs={[{ key: 'add', label: 'Deposit' }, { key: 'remove', label: 'Withdraw' }]} value={tab} onChange={setTab} size="block" />
      {tab === 'add' ? (
        <StableAdd pool={pool} tokens={tokens} onDone={onDone} />
      ) : (
        <SharesRemove pool={pool} tokens={tokens} shares={shares} staked={staked} onDone={onDone} predict />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* CLMM (DCL)                                                          */
/* ------------------------------------------------------------------ */

/** CLMM side panel: open a new position (positions are managed in DclGroupCard). */
export function DclLiquidity({ pool, x, y, rangeState, onDone }) {
  const { accountId, execute } = useApp();
  // Tokens waiting in the CLMM balance: re-read every 15s (like the positions) so a deposit that a
  // later step already used never lingers here as "unused".
  const assets = useAsync(() => getDclAssets(accountId), [accountId], { enabled: Boolean(accountId), refreshMs: 15_000 });
  useChainUpdates(() => assets.reload());
  const parked = Object.entries(assets.data || {}).filter(([id]) => id === pool.token_x || id === pool.token_y);
  // The form's "add the CLMM balance at the current price" (DclCreatePosition), for the notice below.
  const retryRef = useRef(null);
  // Some CLMM pools only accept liquidity from listed accounts (e.g. solvers): same rule
  // app.rhea.finance applies ("Whitelist Only").
  const restricted = Array.isArray(pool.whitelist) && pool.whitelist.length > 0 && !pool.whitelist.includes(accountId);

  const withdrawParked = async () => {
    const ok = await execute(() => buildDclWithdrawTransactions({ tokenIds: parked.map(([id]) => id), accountId }), {
      pending: 'Withdrawing CLMM balance',
      success: 'Withdrawn to wallet'
    });
    if (ok) assets.reload();
  };

  return (
    <>
      <h3 className="card-title">Create position</h3>
      {parked.length > 0 && (
        <div className="notice notice--info">
          <span>
            {parked
              .map(([id, raw]) => {
                const t = id === pool.token_x ? x : y;
                return `${formatRawAmount(raw, t.decimals)} ${t.symbol}`;
              })
              .join(' + ')}{' '}
            unused in your CLMM balance.
          </span>
          <span className="notice__actions">
            {!restricted && (
              <button
                type="button"
                className="link-button"
                onClick={() => retryRef.current?.()}
                title="Add these tokens to the range below at the pool's current price — nothing is deposited again"
              >
                Add at current price
              </button>
            )}
            <button type="button" className="link-button" onClick={withdrawParked}>
              Withdraw
            </button>
          </span>
        </div>
      )}
      {restricted ? (
        <div className="whitelist-only">
          <strong>Whitelist only</strong>
          <p>
            This pool only accepts liquidity from {pool.whitelist.length} approved account{pool.whitelist.length === 1 ? '' : 's'} (set on
            the Rhea contract). You can still swap through it, but deposits from other wallets would be rejected.
          </p>
          <small className="muted">{pool.whitelist.join(' · ')}</small>
          <button type="button" className="button button--ghost button--block" disabled>
            Whitelist only
          </button>
        </div>
      ) : (
        <DclCreatePosition
          pool={pool}
          x={x}
          y={y}
          rangeState={rangeState}
          retryRef={retryRef}
          onDone={() => {
            assets.reload();
            onDone();
          }}
        />
      )}
    </>
  );
}
