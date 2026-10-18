// Create a Rhea pool: CLMM (pick pair + fee tier, then set the starting price) or
// Classic (pick pair + fee). Existing pools are shown per fee tier so nobody pays
// for a create_pool that the contract would reject as "pool already exist".
// The CLMM flow is laid out as a "pool forge": a step track, the form, and a live
// spec panel showing exactly what will be deployed.

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, navigate, poolPath, useLocation } from '../router.jsx';
import TokenPicker from '../components/TokenPicker.jsx';
import { AmountInput, Spinner, TokenIcon } from '../components/ui.jsx';
import { asPoolToken, priceOf } from '../lib/tokens.js';
import { pointToPrice } from '../lib/dclLiquidity.js';
import {
  buildCreateClassicPoolTransactions,
  buildCreateDclPoolTransactions,
  CLASSIC_FEES,
  createdClassicPoolId,
  DCL_FEE_TIERS,
  dclPoolId,
  getClassicPoolsForPair,
  getDclPoolsForPair,
  initPointFor,
  sortedPair
} from '../lib/createPool.js';
import { formatAmount, formatUsd } from '../lib/format.js';
import { CONTRACTS, NATIVE_NEAR } from '../config.js';
import { FlowLines } from '../components/FlowLines.jsx';
import '../create.css';

/** Pools are made of NEP-141 tokens: native NEAR is used as wNEAR. */
const poolToken = (token) => (token?.native || token?.id === NATIVE_NEAR.id ? { ...token, id: CONTRACTS.wrapNear, native: false } : token);

const TYPES = [
  {
    key: 'clmm',
    title: 'CLMM Pool',
    tag: 'Concentrated',
    glyph: '◆',
    text: 'Liquidity inside a price range you choose. More fees per dollar; best for active strategies.',
    chips: ['Custom price range', 'Capital efficient', '4 fee tiers', 'Smart LP setup'],
    cost: '0.1 NEAR'
  },
  {
    key: 'classic',
    title: 'Classic Pool',
    tag: 'Full range',
    glyph: '●',
    text: 'Liquidity across the full price range. Simple and steady fee earning for passive LPs.',
    chips: ['x·y=k full range', 'Set & forget', 'Custom swap fee'],
    cost: '0.05 NEAR'
  }
];

function TokenSelect({ token, onClick, label, placeholder = 'Select token' }) {
  return (
    <button type="button" className="forge-token" onClick={onClick}>
      <small>{label}</small>
      <span>
        {token ? (
          <>
            <TokenIcon token={asPoolToken(token)} size={26} />
            <strong>{asPoolToken(token).symbol}</strong>
          </>
        ) : (
          <span className="muted">{placeholder}</span>
        )}
        <span className="forge-token__caret" aria-hidden>
          ▾
        </span>
      </span>
    </button>
  );
}

function PairPicker({ tokenA, tokenB, setTokenA, setTokenB }) {
  const [picking, setPicking] = useState(null);
  return (
    <>
      <div className="forge-pair">
        <TokenSelect label="Token A" token={tokenA} onClick={() => setPicking('a')} />
        <span className="forge-pair__link" aria-hidden>
          ⇌
        </span>
        <TokenSelect label="Token B" token={tokenB} onClick={() => setPicking('b')} />
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

/** Horizontal step track: each stage lights up once it is done. */
function StepTrack({ stages }) {
  const current = stages.findIndex((s) => !s.done);
  return (
    <ol className="forge-track">
      {stages.map((s, i) => (
        <li key={s.label} className={s.done ? 'done' : i === current ? 'active' : ''}>
          <b>{s.done ? '✓' : String(i + 1).padStart(2, '0')}</b>
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function PanelHead({ index, title, text }) {
  return (
    <div className="forge-head">
      <span className="forge-head__index">{index}</span>
      <div>
        <h2>{title}</h2>
        {text && <p>{text}</p>}
      </div>
    </div>
  );
}

/** The live spec of the pool being configured, terminal style. */
function PoolSpec({ tokenA, tokenB, tier, fee, existing, pairReady, startPrice, marketPrice, marketGap, step, priceValid }) {
  const a = tokenA ? asPoolToken(tokenA) : null;
  const b = tokenB ? asPoolToken(tokenB) : null;
  const status = !pairReady
    ? ['AWAITING PAIR', 'idle']
    : existing
      ? ['POOL EXISTS', 'warn']
      : !fee
        ? ['SELECT FEE TIER', 'idle']
        : step === 1
          ? ['CONFIGURING', 'busy']
          : !priceValid
            ? ['SET START PRICE', 'busy']
            : marketGap !== null && marketGap > 5
              ? ['PRICE OFF MARKET', 'warn']
              : ['READY TO DEPLOY', 'ok'];
  const line = (key, value, tone) => (
    <div key={key}>
      <dt>{key}</dt>
      <dd className={tone || ''}>{value ?? <span className="forge-spec__nil">—</span>}</dd>
    </div>
  );
  return (
    <aside className="forge-spec">
      <div className="forge-spec__bar">
        <span className="forge-spec__dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span>pool.spec</span>
        <span className={`forge-spec__status forge-spec__status--${status[1]}`}>{status[0]}</span>
      </div>
      <div className="forge-spec__pair">
        <span className="forge-spec__icons">
          {a ? <TokenIcon token={a} size={34} /> : <span className="forge-spec__ghost" />}
          {b ? <TokenIcon token={b} size={34} /> : <span className="forge-spec__ghost" />}
        </span>
        <div>
          <strong>
            {a?.symbol || '???'} / {b?.symbol || '???'}
          </strong>
          <small>CLMM · {tier?.label || 'fee —'}</small>
        </div>
      </div>
      <dl className="forge-spec__lines">
        {line('contract', CONTRACTS.dcl)}
        {line(
          'pool_id',
          pairReady && fee ? (
            <span className="forge-spec__id">
              {/* Wrap only after a "|", never inside an account name. */}
              {dclPoolId(tokenA.id, tokenB.id, fee)
                .split('|')
                .map((part, i, all) => (
                  <span key={i}>
                    {part}
                    {i < all.length - 1 && (
                      <>
                        |<wbr />
                      </>
                    )}
                  </span>
                ))}
            </span>
          ) : null
        )}
        {line('fee', tier ? `${tier.label} · ${tier.hint}` : null)}
        {line('state', existing ? 'already deployed' : pairReady && fee ? 'new pool' : null, existing ? 'warn' : pairReady && fee ? 'ok' : '')}
        {line('market', marketPrice && a && b ? `1 ${a.symbol} ≈ ${formatAmount(marketPrice)} ${b.symbol}` : null)}
        {line('start', startPrice && a && b ? `1 ${a.symbol} = ${formatAmount(startPrice)} ${b.symbol}` : null)}
        {line(
          'deviation',
          marketGap !== null ? `${marketGap.toFixed(2)}%` : null,
          marketGap === null ? '' : marketGap > 5 ? 'warn' : 'ok'
        )}
        {line('cost', '0.1 NEAR + storage')}
      </dl>
      <p className="forge-spec__prompt">
        <span>&gt;</span> {existing ? 'pool found — open it to add liquidity' : status[1] === 'ok' ? 'deploy when ready' : 'waiting for input'}
        <i className="forge-spec__cursor" aria-hidden />
      </p>
      {existing && (
        <Link to={poolPath(existing.pool_id)} className="forge-spec__open">
          Open pool →
        </Link>
      )}
    </aside>
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
  const tier = (tiers.data || DCL_FEE_TIERS).find((t) => t.fee === fee);
  // While a new pair loads, the previous pair's tiers are still in `data`: don't use them.
  const existing = tiers.loading ? null : tiers.data?.find((t) => t.fee === fee)?.pool;
  const checked = Boolean(pairReady && tiers.data && !tiers.loading && !tiers.error);

  // A start price belongs to one pair: a new pair starts with an empty price.
  useEffect(() => setPriceText(''), [tokenA?.id, tokenB?.id]);

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

  const stages = [
    { label: 'Token pair', done: Boolean(pairReady) },
    { label: 'Fee tier', done: Boolean(checked && fee && !existing) },
    { label: 'Start price', done: step === 2 && priceValid && initPoint !== null },
    { label: 'Deploy', done: false }
  ];

  return (
    <div className="forge">
      <StepTrack stages={stages} />
      <div className="forge-grid">
        <section className="forge-panel">
          {step === 1 ? (
            <>
              <PanelHead index="01" title="Select pair" text="Choose the two tokens of the pool." />
              <PairPicker tokenA={tokenA} tokenB={tokenB} setTokenA={setTokenA} setTokenB={setTokenB} />
              {pairReady === false && tokenA && tokenB && <div className="notice notice--error">Pick two different tokens.</div>}

              <PanelHead index="02" title="Fee tier" text="What traders pay and LPs earn per swap. Pick one that suits the pair's volatility." />
              <div className="forge-tiers">
                {(tiers.data || DCL_FEE_TIERS).map((t, i) => (
                  <button
                    key={t.fee}
                    type="button"
                    className={`forge-tier ${fee === t.fee ? 'forge-tier--active' : ''} ${t.pool ? 'forge-tier--exists' : ''}`}
                    onClick={() => setFee(t.fee)}
                    disabled={!pairReady}
                    aria-pressed={fee === t.fee}
                  >
                    <span className="forge-tier__fee">{t.label}</span>
                    <span className="forge-tier__hint">{t.hint}</span>
                    <span className="forge-tier__vol" title="Volatility it suits" aria-hidden>
                      {[0, 1, 2, 3].map((n) => (
                        <i key={n} className={n <= i ? 'on' : ''} />
                      ))}
                    </span>
                    <span className="forge-tier__state">
                      {!pairReady || tiers.error ? '—' : tiers.loading ? <Spinner size={10} /> : t.pool ? (t.tvl !== null ? `${formatUsd(t.tvl)} TVL` : 'Exists') : 'Available'}
                    </span>
                  </button>
                ))}
              </div>

              {pairReady && tiers.error ? (
                <div className="notice notice--error">
                  <span>
                    Couldn&apos;t check which pools already exist for this pair (network busy).{' '}
                    <button type="button" className="link-button" onClick={tiers.reload}>
                      Try again
                    </button>
                  </span>
                </div>
              ) : existing ? (
                <div className="forge-exists">
                  <span className="forge-exists__icon" aria-hidden>
                    !
                  </span>
                  <span>
                    <b>This pool already exists</b>
                    {existing.whitelist?.length ? ' (liquidity is whitelist only)' : ''}. Open it to add liquidity, or choose another fee tier
                    to create a new pool.
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

              {existing ? (
                <Link to={poolPath(existing.pool_id)} className="button button--primary button--block button--lg forge-cta">
                  Go to this pool →
                </Link>
              ) : (
                <button
                  type="button"
                  className="button button--primary button--block button--lg forge-cta"
                  disabled={!checked || !fee}
                  onClick={() => setStep(2)}
                >
                  Continue →
                </button>
              )}
            </>
          ) : (
            <>
              <PanelHead
                index="03"
                title="Set the starting price"
                text="A new pool needs an initial exchange rate. It should match the market — anyone can trade against a wrong price as soon as liquidity is added."
              />
              <div className="forge-price">
                <span className="forge-price__side">
                  1 <TokenIcon token={asPoolToken(tokenA)} size={20} /> {asPoolToken(tokenA).symbol} =
                </span>
                <AmountInput
                  placeholder="0.0"
                  value={priceText}
                  autoFocus
                  onChange={(v) => {
                    if (/^\d*\.?\d*(e-?\d*)?$/i.test(v)) setPriceText(v);
                  }}
                />
                <span className="forge-price__side">
                  <TokenIcon token={asPoolToken(tokenB)} size={20} /> {asPoolToken(tokenB).symbol}
                </span>
              </div>
              {marketPrice && (
                <p className="forge-market">
                  <span>
                    Market · 1 {asPoolToken(tokenA).symbol} ≈ {formatAmount(marketPrice)} {asPoolToken(tokenB).symbol}
                  </span>
                  <button type="button" className="link-button" onClick={() => setPriceText(String(Number(marketPrice.toPrecision(8))))}>
                    Use market price
                  </button>
                </p>
              )}
              {marketGap !== null && (
                <div className={`forge-gap ${marketGap > 5 ? 'forge-gap--warn' : ''}`}>
                  <span>Deviation from market</span>
                  <span className="forge-gap__bar">
                    <i style={{ width: `${(Math.min(marketGap, 20) / 20) * 100}%` }} />
                    <em style={{ left: '25%' }} title="5% warning line" />
                  </span>
                  <b>{marketGap.toFixed(2)}%</b>
                </div>
              )}
              {priceValid && initPoint === null && (
                <div className="notice notice--error">This price is outside the range a CLMM pool can start at. Check the number.</div>
              )}
              {marketGap !== null && marketGap > 5 && (
                <div className="notice notice--warn">
                  Your price is {marketGap.toFixed(1)}% away from the market. Arbitrage would trade against the first liquidity at this
                  price.
                </div>
              )}

              <PanelHead index="04" title="Deploy" text="Creation fee 0.1 NEAR (+ token storage if needed), paid to the Rhea CLMM contract." />
              <div className="create-actions">
                <button type="button" className="button button--ghost button--lg" onClick={() => setStep(1)}>
                  ← Back
                </button>
                <button
                  type="button"
                  className="button button--primary button--lg forge-cta"
                  disabled={!priceValid || initPoint === null || submitting}
                  onClick={create}
                >
                  {submitting ? <Spinner size={14} /> : !accountId ? 'Connect wallet' : 'Create pool'}
                </button>
              </div>
              <p className="hint">After the pool is created you&apos;ll land on its page to add liquidity with Smart LP setup.</p>
            </>
          )}
        </section>
        <PoolSpec
          tokenA={tokenA}
          tokenB={tokenB}
          tier={tier}
          fee={fee}
          existing={existing}
          pairReady={Boolean(pairReady)}
          startPrice={step === 2 ? startPrice : null}
          marketPrice={marketPrice}
          marketGap={step === 2 ? marketGap : null}
          step={step}
          priceValid={priceValid}
        />
      </div>
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
    <div className="forge forge--single">
      <section className="forge-panel">
        <PanelHead index="01" title="Select pair" text="Full-range liquidity (x·y=k). Anyone can add to it once it exists." />
        <PairPicker tokenA={tokenA} tokenB={tokenB} setTokenA={setTokenA} setTokenB={setTokenB} />

        <PanelHead index="02" title="Swap fee" />
        <div className="forge-tiers">
          {CLASSIC_FEES.map((f) => (
            <button
              key={f.bps}
              type="button"
              className={`forge-tier forge-tier--compact ${feeBps === f.bps ? 'forge-tier--active' : ''}`}
              onClick={() => setFeeBps(f.bps)}
            >
              <span className="forge-tier__fee">{f.label}</span>
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

        <PanelHead index="03" title="Deploy" text="Creation fee 0.05 NEAR (+ token storage if needed)." />
        <button
          type="button"
          className="button button--primary button--block button--lg forge-cta"
          disabled={!pairReady || existing.loading || submitting}
          onClick={create}
        >
          {submitting ? <Spinner size={14} /> : !accountId ? 'Connect wallet' : 'Create pool'}
        </button>
        <p className="hint">After the pool is created you&apos;ll land on its page to add the first liquidity.</p>
      </section>
    </div>
  );
}

function CreateHome() {
  return (
    <>
      <section className="forge-hero">
        <FlowLines />
        <span className="forge-kicker">Pool factory · Built on NEAR</span>
        <h1 className="forge-title">Create</h1>
        <p>Open a new market on NEAR. <small className="muted">Deployed to Rhea Finance&apos;s contracts.</small></p>
      </section>
      <div className="forge-types">
        {TYPES.map((t) => (
          <Link key={t.key} to={`/create-pool?type=${t.key}`} className={`forge-type forge-type--${t.key}`}>
            <span className="forge-type__head">
              <span className="forge-type__glyph" aria-hidden>
                {t.glyph}
              </span>
              <span>
                <strong>{t.title}</strong>
                <small>{t.tag}</small>
              </span>
              <span className="forge-type__arrow" aria-hidden>
                →
              </span>
            </span>
            <span className="forge-type__text">{t.text}</span>
            <span className="forge-type__chips">
              {t.chips.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </span>
            <span className="forge-type__foot">
              <span>Creation fee</span>
              <b>{t.cost}</b>
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}

export default function CreatePool() {
  const { search } = useLocation();
  const type = search.get('type');
  if (type !== 'clmm' && type !== 'classic') {
    return (
      <div className="page page--create">
        <CreateHome />
      </div>
    );
  }
  return (
    <div className="page page--create">
      <header className="forge-pagehead">
        <Link to="/create-pool" className="link-button">
          ← Create
        </Link>
        <span className="forge-kicker">{type === 'clmm' ? 'Concentrated liquidity · Rhea CLMM' : 'Full range · Rhea classic'}</span>
        <h1>{type === 'classic' ? 'Create classic pool' : 'Create CLMM pool'}</h1>
      </header>
      {type === 'clmm' ? <CreateClmm /> : <CreateClassic />}
    </div>
  );
}
