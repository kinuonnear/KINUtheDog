// Create a Rhea pool: CLMM (pick pair + fee tier, then set the starting price) or
// Classic (pick pair + fee). Existing pools are shown per fee tier so nobody pays
// for a create_pool that the contract would reject as "pool already exist".

import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, navigate, poolPath, useLocation } from '../router.jsx';
import TokenPicker from '../components/TokenPicker.jsx';
import { Modal, Spinner, TokenIcon } from '../components/ui.jsx';
import { asPoolToken, priceOf } from '../lib/tokens.js';
import { pointToPrice } from '../lib/dclLiquidity.js';
import {
  buildCreateClassicPoolTransactions,
  buildCreateDclPoolTransactions,
  CLASSIC_FEES,
  createdClassicPoolId,
  dclPoolId,
  getClassicPoolsForPair,
  getDclPoolsForPair,
  initPointFor,
  sortedPair
} from '../lib/createPool.js';
import { formatAmount, formatUsd } from '../lib/format.js';
import { CONTRACTS, NATIVE_NEAR } from '../config.js';

/** Pools are made of NEP-141 tokens: native NEAR is used as wNEAR. */
const poolToken = (token) => (token?.native || token?.id === NATIVE_NEAR.id ? { ...token, id: CONTRACTS.wrapNear, native: false } : token);

const TYPES = [
  {
    key: 'clmm',
    title: 'CLMM Pool',
    text: 'Liquidity inside a price range you choose. More fees per dollar; best for active strategies.'
  },
  {
    key: 'classic',
    title: 'Classic Pool',
    text: 'Liquidity across the full price range. Simple and steady fee earning for passive LPs.'
  }
];

/** "Select the type of the liquidity pool" — used on the Pools page and here. */
export function CreatePoolChooser({ onClose }) {
  return (
    <Modal title="Create a pool" subtitle="Select the type of liquidity pool." onClose={onClose}>
      <div className="create-types">
        {TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            className="create-type"
            onClick={() => {
              onClose();
              navigate(`/create-pool?type=${t.key}`);
            }}
          >
            <span>
              <strong>{t.title}</strong>
              <small>{t.text}</small>
            </span>
            <span className="create-type__arrow" aria-hidden>
              →
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function TokenSelect({ token, onClick, placeholder = 'Select token' }) {
  return (
    <button type="button" className="token-select create-token" onClick={onClick}>
      {token ? (
        <>
          <TokenIcon token={asPoolToken(token)} size={24} />
          <strong>{asPoolToken(token).symbol}</strong>
        </>
      ) : (
        <span className="muted">{placeholder}</span>
      )}
      <span aria-hidden>▾</span>
    </button>
  );
}

function PairPicker({ tokenA, tokenB, setTokenA, setTokenB }) {
  const [picking, setPicking] = useState(null);
  return (
    <>
      <div className="create-pair">
        <TokenSelect token={tokenA} onClick={() => setPicking('a')} />
        <span className="muted">+</span>
        <TokenSelect token={tokenB} onClick={() => setPicking('b')} />
      </div>
      {picking && (
        <TokenPicker
          title={picking === 'a' ? 'First token' : 'Second token'}
          selectedId={picking === 'a' ? tokenA?.id : tokenB?.id}
          onSelect={(t) => (picking === 'a' ? setTokenA(poolToken(t)) : setTokenB(poolToken(t)))}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}

function Steps({ step }) {
  return (
    <ol className="create-steps card">
      {[
        ['Step 1', 'Select token pair and fee tier'],
        ['Step 2', 'Set the starting price and create the pool']
      ].map(([label, text], i) => (
        <li key={label} className={step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}>
          <b>{step > i + 1 ? '✓' : i + 1}</b>
          <span>
            <small>{label}</small>
            {text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CreateClmm() {
  const { accountId, connect, execute, prices } = useApp();
  const [step, setStep] = useState(1);
  const [tokenA, setTokenA] = useState(null);
  const [tokenB, setTokenB] = useState(null);
  const [fee, setFee] = useState(null);
  const [priceText, setPriceText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const pairReady = tokenA && tokenB && tokenA.id !== tokenB.id;

  const tiers = useAsync(() => getDclPoolsForPair(tokenA.id, tokenB.id), [tokenA?.id, tokenB?.id], { enabled: Boolean(pairReady) });
  const tier = tiers.data?.find((t) => t.fee === fee);
  const existing = tier?.pool;

  const marketPrice = useMemo(() => {
    if (!pairReady) return null;
    const pa = priceOf(prices, tokenA.id);
    const pb = priceOf(prices, tokenB.id);
    return pa > 0 && pb > 0 ? pa / pb : null;
  }, [pairReady, prices, tokenA?.id, tokenB?.id]);

  const price = Number(priceText);
  const priceValid = Number.isFinite(price) && price > 0;
  const initPoint = priceValid && pairReady ? initPointFor({ tokenA, tokenB, price }) : null;
  // The price the pool will actually start at (points are discrete).
  const startPrice = useMemo(() => {
    if (initPoint === null) return null;
    const [x] = sortedPair(tokenA.id, tokenB.id);
    const aIsX = tokenA.id === x;
    const [decX, decY] = aIsX ? [tokenA.decimals, tokenB.decimals] : [tokenB.decimals, tokenA.decimals];
    const yPerX = pointToPrice(initPoint, decX, decY);
    return aIsX ? yPerX : 1 / yPerX;
  }, [initPoint, tokenA, tokenB]);
  const marketGap = marketPrice && priceValid ? Math.abs(price / marketPrice - 1) * 100 : null;

  const create = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const ok = await execute(() => buildCreateDclPoolTransactions({ tokenA: tokenA.id, tokenB: tokenB.id, fee, initPoint, accountId }), {
      pending: 'Creating CLMM pool',
      success: 'Pool created'
    });
    setSubmitting(false);
    if (ok) navigate(poolPath(dclPoolId(tokenA.id, tokenB.id, fee)));
  };

  return (
    <div className="create-layout">
      <Steps step={step} />
      <section className="card create-card">
        {step === 1 ? (
          <>
            <h2>Select pair</h2>
            <p className="muted small">Choose the two tokens of the pool.</p>
            <PairPicker tokenA={tokenA} tokenB={tokenB} setTokenA={setTokenA} setTokenB={setTokenB} />

            <h3>Fee tier</h3>
            <p className="muted small">What traders pay and LPs earn per swap. Pick one that suits the pair&apos;s volatility.</p>
            <div className="fee-tiers">
              {(tiers.data || [
                { fee: 100, label: '0.01%' },
                { fee: 400, label: '0.04%' },
                { fee: 2000, label: '0.2%' },
                { fee: 10000, label: '1%' }
              ]).map((t) => (
                <button
                  key={t.fee}
                  type="button"
                  className={`fee-tier ${fee === t.fee ? 'fee-tier--active' : ''} ${t.pool ? 'fee-tier--exists' : ''}`}
                  onClick={() => setFee(t.fee)}
                  disabled={!pairReady}
                >
                  <strong>{t.label}</strong>
                  <small>
                    {!pairReady ? '—' : tiers.loading ? <Spinner size={10} /> : t.pool ? (t.tvl !== null ? `${formatUsd(t.tvl)} TVL` : 'Exists') : 'Not created'}
                  </small>
                </button>
              ))}
            </div>

            {existing ? (
              <div className="notice notice--warn">
                <span>
                  This pool already exists{existing.whitelist?.length ? ' (liquidity is whitelist only)' : ''} — choose another fee tier, or{' '}
                  <Link to={poolPath(existing.pool_id)}>go to this pool</Link>.
                </span>
              </div>
            ) : (
              <div className="notice notice--info">
                <span>
                  <b>Creating a new pool.</b> New pools start with no liquidity, so prices can move a lot until LPs join. Adding to an
                  existing pool is usually safer.
                </span>
              </div>
            )}
            {pairReady === false && tokenA && tokenB && <div className="notice notice--error">Pick two different tokens.</div>}

            <button type="button" className="button button--primary button--block button--lg" disabled={!pairReady || !fee || Boolean(existing) || tiers.loading} onClick={() => setStep(2)}>
              Continue
            </button>
          </>
        ) : (
          <>
            <h2>Set the starting price</h2>
            <p className="muted small">
              A new pool needs an initial exchange rate. It should match the market — anyone can trade against a wrong price as soon as
              liquidity is added.
            </p>
            <div className="start-price">
              <span>
                1 <TokenIcon token={asPoolToken(tokenA)} size={18} /> {asPoolToken(tokenA).symbol} =
              </span>
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={priceText}
                onChange={(e) => {
                  const v = e.target.value.replace(',', '.');
                  if (/^\d*\.?\d*(e-?\d*)?$/i.test(v)) setPriceText(v);
                }}
              />
              <span>
                <TokenIcon token={asPoolToken(tokenB)} size={18} /> {asPoolToken(tokenB).symbol}
              </span>
            </div>
            {marketPrice && (
              <p className="small">
                Market: 1 {asPoolToken(tokenA).symbol} ≈ {formatAmount(marketPrice)} {asPoolToken(tokenB).symbol}{' '}
                <button type="button" className="link-button" onClick={() => setPriceText(String(Number(marketPrice.toPrecision(8))))}>
                  Use market price
                </button>
              </p>
            )}
            {marketGap !== null && marketGap > 5 && (
              <div className="notice notice--warn">
                Your price is {marketGap.toFixed(1)}% away from the market. Arbitrage would trade against the first liquidity at this
                price.
              </div>
            )}

            <dl className="kv">
              <div>
                <dt>Pair</dt>
                <dd>
                  {asPoolToken(tokenA).symbol} / {asPoolToken(tokenB).symbol}
                </dd>
              </div>
              <div>
                <dt>Fee tier</dt>
                <dd>{tier?.label}</dd>
              </div>
              {startPrice && (
                <div>
                  <dt>Pool starts at</dt>
                  <dd>
                    1 {asPoolToken(tokenA).symbol} = {formatAmount(startPrice)} {asPoolToken(tokenB).symbol}
                  </dd>
                </div>
              )}
              <div>
                <dt>Creation fee</dt>
                <dd>0.1 NEAR (+ token storage if needed)</dd>
              </div>
            </dl>

            <div className="create-actions">
              <button type="button" className="button button--ghost button--lg" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="button button--primary button--lg" disabled={!priceValid || initPoint === null || submitting} onClick={create}>
                {submitting ? <Spinner size={14} /> : !accountId ? 'Connect wallet' : 'Create pool'}
              </button>
            </div>
            <p className="hint">After the pool is created you&apos;ll land on its page to add liquidity with Smart LP setup.</p>
          </>
        )}
      </section>
    </div>
  );
}

function CreateClassic() {
  const { accountId, connect, execute } = useApp();
  const [tokenA, setTokenA] = useState(null);
  const [tokenB, setTokenB] = useState(null);
  const [feeBps, setFeeBps] = useState(30);
  const [submitting, setSubmitting] = useState(false);
  const pairReady = tokenA && tokenB && tokenA.id !== tokenB.id;
  const existing = useAsync(() => getClassicPoolsForPair(tokenA.id, tokenB.id), [tokenA?.id, tokenB?.id], { enabled: Boolean(pairReady) });
  const sameFee = (existing.data || []).find((p) => Math.round(p.feePercent * 100) === feeBps);

  const create = async () => {
    if (!accountId) return connect();
    setSubmitting(true);
    const outcomes = await execute(() => buildCreateClassicPoolTransactions({ tokenA: tokenA.id, tokenB: tokenB.id, feeBps, accountId }), {
      pending: 'Creating classic pool',
      success: 'Pool created'
    });
    setSubmitting(false);
    if (outcomes) {
      const id = createdClassicPoolId(outcomes);
      navigate(id ? poolPath(id) : '/pools');
    }
  };

  return (
    <div className="create-layout create-layout--single">
      <section className="card create-card">
        <h2>Create a classic pool</h2>
        <p className="muted small">Full-range liquidity (x·y=k). Anyone can add to it once it exists.</p>
        <PairPicker tokenA={tokenA} tokenB={tokenB} setTokenA={setTokenA} setTokenB={setTokenB} />

        <h3>Swap fee</h3>
        <div className="fee-tiers">
          {CLASSIC_FEES.map((f) => (
            <button key={f.bps} type="button" className={`fee-tier ${feeBps === f.bps ? 'fee-tier--active' : ''}`} onClick={() => setFeeBps(f.bps)}>
              <strong>{f.label}</strong>
            </button>
          ))}
        </div>

        {pairReady && (existing.data || []).length > 0 && (
          <div className="notice notice--warn">
            <span>
              {existing.data.length} classic pool{existing.data.length === 1 ? '' : 's'} with this pair already exist
              {sameFee ? ', including one with this fee' : ''}:{' '}
              {existing.data.slice(0, 3).map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ', '}
                  <Link to={poolPath(p.id)}>
                    #{p.id} ({p.feePercent}% · {formatUsd(p.tvl)})
                  </Link>
                </span>
              ))}
              . Adding to an existing pool is usually better.
            </span>
          </div>
        )}

        <dl className="kv">
          <div>
            <dt>Creation fee</dt>
            <dd>0.05 NEAR (+ token storage if needed)</dd>
          </div>
        </dl>
        <button type="button" className="button button--primary button--block button--lg" disabled={!pairReady || submitting} onClick={create}>
          {submitting ? <Spinner size={14} /> : !accountId ? 'Connect wallet' : 'Create pool'}
        </button>
        <p className="hint">After the pool is created you&apos;ll land on its page to add the first liquidity.</p>
      </section>
    </div>
  );
}

export default function CreatePool() {
  const { search } = useLocation();
  const type = search.get('type');
  return (
    <div className="page page--create">
      <header className="page-head">
        <Link to="/pools" className="link-button">
          ← All pools
        </Link>
        <h1>{type === 'classic' ? 'Create classic pool' : type === 'clmm' ? 'Create CLMM pool' : 'Create a pool'}</h1>
      </header>
      {type === 'clmm' ? (
        <CreateClmm />
      ) : type === 'classic' ? (
        <CreateClassic />
      ) : (
        <div className="create-types create-types--page">
          {TYPES.map((t) => (
            <Link key={t.key} to={`/create-pool?type=${t.key}`} className="create-type card">
              <span>
                <strong>{t.title}</strong>
                <small>{t.text}</small>
              </span>
              <span className="create-type__arrow" aria-hidden>
                →
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
