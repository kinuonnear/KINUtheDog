// In-app liquidity management for every Rhea pool type:
//   AMM (SIMPLE_POOL)                  -> AmmLiquidity
//   Stable / ALMM (STABLE, RATED, DEGEN)-> StableLiquidity
//   CLMM (DCL)                         -> DclLiquidity

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced } from '../hooks.js';
import {
  amountsForShares,
  buildAddLiquidityTransactions,
  buildAddStableLiquidityTransactions,
  buildRemoveLiquidityTransactions,
  expectedShares,
  pairedAmount,
  predictRemoveAmounts,
  predictStableShares
} from '../lib/liquidity.js';
import {
  alignPoint,
  buildDclAddTransactions,
  buildDclWithdrawTransactions,
  floatToRaw,
  fullRange,
  getDclAssets,
  pairedRawAmount,
  pointToPrice,
  priceToPoint,
  rangeSide
} from '../lib/dclLiquidity.js';
import { view } from '../lib/rpc.js';
import {
  applySlippage,
  formatPercent,
  formatRawAmount,
  formatUnits,
  maxBig,
  toBigInt,
  tryParseUnits
} from '../lib/format.js';
import { CONTRACTS, NEAR_GAS_RESERVE } from '../config.js';
import { EmptyState, Spinner, Tabs, TokenIcon } from './ui.jsx';

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
function useSpendable(tokenIds) {
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

/** Raw NEAR to wrap so the wNEAR side of a deposit is covered. */
function useWrapAmount(tokenIds, raws) {
  const { balances } = useApp();
  const index = tokenIds.indexOf(CONTRACTS.wrapNear);
  if (index < 0 || !raws[index]) return '0';
  return maxBig(0n, toBigInt(raws[index]) - toBigInt(balances[CONTRACTS.wrapNear] || '0')).toString();
}

function AmountField({ token, value, onChange, spendable, onMax, disabled, note }) {
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
  const { accountId, connect, slippage, execute } = useApp();
  const [inputs, setInputs] = useState(() => pool.tokenIds.map(() => ''));
  const [submitting, setSubmitting] = useState(false);
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
    const ok = await execute(() => buildAddLiquidityTransactions({ pool, amounts: raws, accountId, slippage, wrapAmount }), {
      pending: 'Adding liquidity',
      success: 'Liquidity added'
    });
    setSubmitting(false);
    if (ok) {
      setInputs(pool.tokenIds.map(() => ''));
      onDone();
    }
  };

  return (
    <div className="liq-form">
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
    </div>
  );
}

/** Proportional removal for AMM, Stable and ALMM pools. */
function SharesRemove({ pool, tokens, shares, staked, onDone, predict }) {
  const { accountId, slippage, execute } = useApp();
  const [percent, setPercent] = useState(50);
  const [submitting, setSubmitting] = useState(false);
  const removeShares = ((toBigInt(shares) * BigInt(percent)) / 100n).toString();
  const debounced = useDebounced(removeShares, 300);
  const predicted = useAsync(() => predictRemoveAmounts(pool.id, debounced), [pool.id, debounced], {
    enabled: Boolean(predict) && toBigInt(debounced) > 0n
  });
  const out = predict && predicted.data ? predicted.data : amountsForShares(pool, removeShares);

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
    const ok = await execute(
      async () => {
        const expectedAmounts = predict ? await predictRemoveAmounts(pool.id, removeShares) : undefined;
        return buildRemoveLiquidityTransactions({ pool, shares: removeShares, accountId, slippage, expectedAmounts });
      },
      { pending: 'Removing liquidity', success: 'Liquidity removed' }
    );
    setSubmitting(false);
    if (ok) onDone();
  };

  return (
    <div className="liq-form">
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

export function AmmLiquidity({ pool, tokens, shares, staked, onDone, initialTab = 'add' }) {
  const [tab, setTab] = useState(initialTab === 'remove' ? 'remove' : 'add');
  return (
    <>
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

function StableAdd({ pool, tokens, onDone }) {
  const { accountId, connect, slippage, execute } = useApp();
  const [inputs, setInputs] = useState(() => pool.tokenIds.map(() => ''));
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

  const submit = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const ok = await execute(
      async () => {
        const fresh = await predictStableShares(pool.id, raws);
        return buildAddStableLiquidityTransactions({
          pool,
          amounts: raws,
          minShares: applySlippage(fresh, slippage),
          accountId,
          wrapAmount
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
      <p className="liq-hint">Any ratio works — deposit one token or several. Balanced deposits get the best share price.</p>
      {pool.tokenIds.map((id, i) => (
        <AmountField
          key={id}
          token={tokens[i]}
          value={inputs[i]}
          onChange={(text) => setInputs(inputs.map((v, j) => (j === i ? text : v)))}
          spendable={spendable[i]}
          onMax={() => setInputs(inputs.map((v, j) => (j === i ? trimDecimals(formatUnits(spendable[i].toString(), tokens[i]?.decimals ?? 0)) : v)))}
          note={id === CONTRACTS.wrapNear ? 'NEAR auto-wraps' : null}
        />
      ))}
      {any && (
        <dl className="kv">
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
      {prediction.error && any && <div className="notice notice--error">{prediction.error.message}</div>}
      <SubmitButton
        label={!accountId ? 'Connect wallet' : !any ? 'Enter an amount' : insufficient || 'Add liquidity'}
        disabled={accountId && (!any || Boolean(insufficient) || Boolean(prediction.error))}
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

const RANGE_PRESETS = [
  { key: '5', label: '±5%' },
  { key: '10', label: '±10%' },
  { key: '25', label: '±25%' },
  { key: '50', label: '±50%' },
  { key: 'full', label: 'Full' }
];

function RangeBar({ left, right, current }) {
  // Position on a log-price axis spanning the range with 25% padding either side.
  const span = Math.max(right - left, 1);
  const lo = left - span * 0.25;
  const hi = right + span * 0.25;
  const pos = (p) => `${Math.min(100, Math.max(0, ((p - lo) / (hi - lo)) * 100))}%`;
  return (
    <div className="range-bar">
      <span className="range-bar__band" style={{ left: pos(left), right: `calc(100% - ${pos(right)})` }} />
      <span className="range-bar__now" style={{ left: pos(current) }} title="Current price" />
    </div>
  );
}

function DclAdd({ pool, x, y, onDone }) {
  const { accountId, connect, slippage, execute } = useApp();
  const delta = pool.point_delta;
  const current = pool.current_point;
  const currentPrice = pointToPrice(current, x.decimals, y.decimals);

  const [preset, setPreset] = useState('10');
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [inputs, setInputs] = useState({ x: '', y: '' });
  const [lastEdited, setLastEdited] = useState('x');
  const [submitting, setSubmitting] = useState(false);

  const range = useMemo(() => {
    if (preset === 'full') return fullRange(delta);
    if (preset !== 'custom') {
      const pct = Number(preset) / 100;
      let left = alignPoint(priceToPoint(currentPrice * (1 - pct), x.decimals, y.decimals), delta, 'floor');
      let right = alignPoint(priceToPoint(currentPrice * (1 + pct), x.decimals, y.decimals), delta, 'ceil');
      if (right <= left) right = left + delta;
      return { left, right };
    }
    const min = Number(minText);
    const max = Number(maxText);
    if (!(min > 0) || !(max > min)) return null;
    let left = alignPoint(priceToPoint(min, x.decimals, y.decimals), delta, 'floor');
    let right = alignPoint(priceToPoint(max, x.decimals, y.decimals), delta, 'ceil');
    if (right <= left) right = left + delta;
    return { left, right };
  }, [preset, minText, maxText, currentPrice, delta, x.decimals, y.decimals]);

  // Show the aligned prices in the inputs whenever a preset is selected.
  useEffect(() => {
    if (!range || preset === 'custom') return;
    setMinText(preset === 'full' ? '0' : trimPrice(pointToPrice(range.left, x.decimals, y.decimals)));
    setMaxText(preset === 'full' ? '∞' : trimPrice(pointToPrice(range.right, x.decimals, y.decimals)));
  }, [range, preset, x.decimals, y.decimals]);

  const side = range ? rangeSide(range.left, range.right, current) : 'both';
  const needX = side !== 'y';
  const needY = side !== 'x';

  // Keep the paired amount in sync with whichever side the user typed.
  const raws = useMemo(() => {
    if (!range) return { x: '0', y: '0' };
    const rawX = tryParseUnits(inputs.x, x.decimals) || '0';
    const rawY = tryParseUnits(inputs.y, y.decimals) || '0';
    if (side === 'x') return { x: rawX, y: '0' };
    if (side === 'y') return { x: '0', y: rawY };
    if (lastEdited === 'x') {
      return { x: rawX, y: floatToRaw(pairedRawAmount({ from: 'x', amount: Number(rawX), ...range, current })) };
    }
    return { x: floatToRaw(pairedRawAmount({ from: 'y', amount: Number(rawY), ...range, current })), y: rawY };
  }, [inputs, lastEdited, range, side, current, x.decimals, y.decimals]);

  const shownX = lastEdited === 'x' || side !== 'both' ? inputs.x : trimDecimals(formatUnits(raws.x, x.decimals));
  const shownY = lastEdited === 'y' || side !== 'both' ? inputs.y : trimDecimals(formatUnits(raws.y, y.decimals));

  const dclTokenIds = useMemo(() => [pool.token_x, pool.token_y], [pool.token_x, pool.token_y]);
  const spendable = useSpendable(dclTokenIds);
  const { balances } = useApp();
  const wrapFor = (tokenId, raw) =>
    tokenId === CONTRACTS.wrapNear ? maxBig(0n, toBigInt(raw) - toBigInt(balances[CONTRACTS.wrapNear] || '0')).toString() : '0';
  const wrapX = wrapFor(pool.token_x, raws.x);
  const wrapY = wrapFor(pool.token_y, raws.y);

  const storage = useAsync(() => view(CONTRACTS.dcl, 'get_user_storage_detail', { user_id: accountId }), [accountId], {
    enabled: Boolean(accountId)
  });

  const hasAmount = toBigInt(raws.x) > 0n || toBigInt(raws.y) > 0n;
  const insufficient = insufficientLabel([raws.x, raws.y], spendable, [x, y]);

  const setMax = (which) => {
    const index = which === 'x' ? 0 : 1;
    const token = which === 'x' ? x : y;
    setLastEdited(which);
    setInputs((v) => ({ ...v, [which]: trimDecimals(formatUnits(spendable[index].toString(), token.decimals)) }));
  };

  const submit = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const ok = await execute(
      () =>
        buildDclAddTransactions({
          pool,
          left: range.left,
          right: range.right,
          amountX: raws.x,
          amountY: raws.y,
          slippage,
          accountId,
          wrapX,
          wrapY
        }),
      { pending: 'Adding concentrated liquidity', success: 'Position created' }
    );
    setSubmitting(false);
    if (ok) {
      setInputs({ x: '', y: '' });
      onDone();
    }
  };

  const fullSelected = preset === 'full';

  return (
    <div className="liq-form">
      <div className="range-head">
        <span className="eyebrow">Price range</span>
        <span className="muted small">
          Current: <b>{trimPrice(currentPrice)}</b> {y.symbol} per {x.symbol}
        </span>
      </div>

      <div className="segmented segmented--full">
        {RANGE_PRESETS.map((p) => (
          <button key={p.key} type="button" className={preset === p.key ? 'active' : ''} onClick={() => setPreset(p.key)}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="range-inputs">
        {[
          ['Min price', minText, setMinText],
          ['Max price', maxText, setMaxText]
        ].map(([label, value, setter]) => (
          <label key={label} className="range-input">
            <span>{label}</span>
            <input
              inputMode="decimal"
              value={value}
              disabled={fullSelected}
              onChange={(e) => {
                const text = cleanDecimal(e.target.value);
                if (text === null) return;
                setPreset('custom');
                setter(text);
              }}
            />
            <small>
              {y.symbol} per {x.symbol}
            </small>
          </label>
        ))}
      </div>

      {range && <RangeBar left={range.left} right={range.right} current={current} />}
      {range && side !== 'both' && (
        <p className="liq-hint warn">
          Range is {side === 'x' ? 'above' : 'below'} the current price — only {side === 'x' ? x.symbol : y.symbol} is deposited and
          the position earns fees once the price enters the range.
        </p>
      )}
      {!range && preset === 'custom' && <p className="liq-hint warn">Enter a min price lower than the max price.</p>}

      <AmountField
        token={x}
        value={shownX}
        onChange={(text) => {
          setLastEdited('x');
          setInputs((v) => ({ ...v, x: text }));
        }}
        spendable={spendable[0]}
        onMax={() => setMax('x')}
        disabled={!needX}
        note={pool.token_x === CONTRACTS.wrapNear ? 'NEAR auto-wraps' : null}
      />
      <AmountField
        token={y}
        value={shownY}
        onChange={(text) => {
          setLastEdited('y');
          setInputs((v) => ({ ...v, y: text }));
        }}
        spendable={spendable[1]}
        onMax={() => setMax('y')}
        disabled={!needY}
        note={pool.token_y === CONTRACTS.wrapNear ? 'NEAR auto-wraps' : null}
      />

      {hasAmount && range && (
        <dl className="kv">
          <div>
            <dt>Fee tier</dt>
            <dd>{formatPercent(pool.fee / 10000, 2)}</dd>
          </div>
          {accountId && toBigInt(wrapX) + toBigInt(wrapY) > 0n && (
            <div>
              <dt>NEAR to wrap</dt>
              <dd>{formatRawAmount((toBigInt(wrapX) + toBigInt(wrapY)).toString(), 24)} NEAR</dd>
            </div>
          )}
          {accountId && storage.data === null && (
            <div>
              <dt>One-time CLMM registration</dt>
              <dd>0.5 NEAR</dd>
            </div>
          )}
          <div>
            <dt>Max slippage</dt>
            <dd>{slippage}%</dd>
          </div>
        </dl>
      )}

      <SubmitButton
        label={!accountId ? 'Connect wallet' : !range ? 'Set a price range' : !hasAmount ? 'Enter an amount' : insufficient || 'Add position'}
        disabled={accountId && (!range || !hasAmount || Boolean(insufficient))}
        submitting={submitting}
        onClick={submit}
      />
    </div>
  );
}

function trimPrice(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1) return String(Number(n.toPrecision(6)));
  const digits = Math.min(18, Math.ceil(-Math.log10(n)) + 4);
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

/** CLMM side panel: open a new position (positions are managed in DclGroupCard). */
export function DclLiquidity({ pool, x, y, onDone }) {
  const { accountId, execute } = useApp();
  const assets = useAsync(() => getDclAssets(accountId), [accountId], { enabled: Boolean(accountId) });
  const parked = Object.entries(assets.data || {}).filter(([id]) => id === pool.token_x || id === pool.token_y);

  const withdrawParked = async () => {
    const ok = await execute(() => buildDclWithdrawTransactions({ tokenIds: parked.map(([id]) => id), accountId }), {
      pending: 'Withdrawing CLMM balance',
      success: 'Withdrawn to wallet'
    });
    if (ok) assets.reload();
  };

  return (
    <>
      <h3 className="card-title">New position</h3>
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
          <button type="button" className="link-button" onClick={withdrawParked}>
            Withdraw
          </button>
        </div>
      )}
      <DclAdd
        pool={pool}
        x={x}
        y={y}
        onDone={() => {
          assets.reload();
          onDone();
        }}
      />
    </>
  );
}
