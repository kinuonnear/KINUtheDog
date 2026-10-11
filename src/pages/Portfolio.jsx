import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, navigate, poolPath, useLocation } from '../router.jsx';
import { getAllBalances, getTokens, priceOf } from '../lib/tokens.js';
import { getClassicPositions, getDclPositions, getDeposits, dclPointToPrice } from '../lib/rhea.js';
import { buildWithdrawDepositsTransactions } from '../lib/liquidity.js';
import { buildDclWithdrawTransactions, getDclAssets } from '../lib/dclLiquidity.js';
import { formatAmount, formatPercent, formatPrice, formatUsd, shortAccount, toNumber } from '../lib/format.js';
import { CONTRACTS, ENDPOINTS, NATIVE_NEAR } from '../config.js';
import { EmptyState, ErrorNotice, PairIcons, Skeleton, Spinner, Stat, Tabs, TokenIcon } from '../components/ui.jsx';

const DUST_USD = 0.01;
const ALLOCATION_COLORS = ['#b8ff3d', '#3ddc97', '#5ec8ff', '#ffb547', '#c792ff', '#5a6470'];

async function loadPortfolio(account) {
  const [wallet, deposits, dclAssets, classic, dcl] = await Promise.all([
    getAllBalances(account),
    getDeposits(account).catch(() => ({})),
    getDclAssets(account).catch(() => ({})),
    getClassicPositions(account).catch(() => []),
    getDclPositions(account).catch(() => [])
  ]);
  const ids = new Set([
    ...Object.keys(wallet.balances),
    ...Object.keys(deposits),
    ...Object.keys(dclAssets),
    ...classic.flatMap((p) => p.pool.tokenIds),
    ...dcl.flatMap((p) => [p.tokenX, p.tokenY])
  ]);
  const tokens = await getTokens([...ids]);
  return { wallet, deposits, dclAssets, classic, dcl, tokens };
}

function AccountPrompt() {
  const { connect, walletReady } = useApp();
  const [value, setValue] = useState('');
  return (
    <div className="page">
      <div className="portfolio-gate card">
        <span className="eyebrow">Portfolio</span>
        <h1>Your DeFi, in one place.</h1>
        <p>
          Wallet tokens, Rhea liquidity positions, concentrated ranges, farm stakes and exchange deposits — valued live
          with Rhea prices.
        </p>
        <button type="button" className="button button--primary button--lg" onClick={connect} disabled={!walletReady}>
          Connect wallet
        </button>
        <form
          className="portfolio-gate__lookup"
          onSubmit={(event) => {
            event.preventDefault();
            const account = value.trim().toLowerCase();
            if (account) navigate(`/portfolio?account=${encodeURIComponent(account)}`);
          }}
        >
          <span className="muted small">or view any account (read-only)</span>
          <div className="search-field">
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="account.near" spellCheck={false} />
            <button type="submit" className="button button--ghost button--sm">
              View
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Portfolio() {
  const { accountId, prices, execute } = useApp();
  const { search } = useLocation();
  const viewed = search.get('account') || accountId;
  const readOnly = viewed !== accountId;
  const [tab, setTab] = useState('tokens');
  const [showDust, setShowDust] = useState(false);

  const data = useAsync(() => loadPortfolio(viewed), [viewed], { enabled: Boolean(viewed), refreshMs: 45_000 });

  const model = useMemo(() => {
    if (!data.data) return null;
    const { wallet, deposits, dclAssets, classic, dcl, tokens } = data.data;
    const meta = (id) => (id === NATIVE_NEAR.id ? NATIVE_NEAR : tokens[id] || { id, symbol: id.slice(0, 6), decimals: 0 });
    const usdOf = (id, raw) => toNumber(raw, meta(id).decimals) * priceOf(prices, id);

    const walletRows = Object.entries(wallet.balances)
      .map(([id, raw]) => {
        const token = meta(id);
        const amount = toNumber(raw, token.decimals);
        const price = priceOf(prices, id);
        return { id, token, amount, price, usd: amount * price };
      })
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.usd - a.usd || b.amount - a.amount);

    // Tokens parked inside Rhea: the classic exchange and the CLMM (DCL) contract.
    const depositRows = [
      ...Object.entries(deposits).map(([id, raw]) => ({ id, raw, source: 'exchange' })),
      ...Object.entries(dclAssets).map(([id, raw]) => ({ id, raw, source: 'dcl' }))
    ]
      .map((r) => ({ ...r, token: meta(r.id), amount: toNumber(r.raw, meta(r.id).decimals), usd: usdOf(r.id, r.raw) }))
      .sort((a, b) => b.usd - a.usd);

    const classicRows = classic
      .map((p) => {
        const parts = p.pool.tokenIds.map((id, i) => ({ token: meta(id), amount: toNumber(p.amounts[i], meta(id).decimals), usd: usdOf(id, p.amounts[i]) }));
        const supply = Number(p.pool.sharesTotalSupply);
        return {
          ...p,
          parts,
          usd: parts.reduce((s, x) => s + x.usd, 0),
          sharePct: supply > 0 ? (Number(p.totalShares) / supply) * 100 : 0
        };
      })
      .sort((a, b) => b.usd - a.usd);

    const dclRows = dcl
      .map((p) => {
        const x = meta(p.tokenX);
        const y = meta(p.tokenY);
        const ax = p.amountX / 10 ** x.decimals;
        const ay = p.amountY / 10 ** y.decimals;
        return { ...p, x, y, ax, ay, usd: ax * priceOf(prices, p.tokenX) + ay * priceOf(prices, p.tokenY) };
      })
      .sort((a, b) => b.usd - a.usd);

    const walletUsd = walletRows.reduce((s, r) => s + r.usd, 0);
    const depositUsd = depositRows.reduce((s, r) => s + r.usd, 0);
    const liquidityUsd = classicRows.reduce((s, r) => s + r.usd, 0) + dclRows.reduce((s, r) => s + r.usd, 0);

    return {
      walletRows,
      depositRows,
      classicRows,
      dclRows,
      walletUsd,
      depositUsd,
      liquidityUsd,
      total: walletUsd + depositUsd + liquidityUsd,
      near: wallet.near
    };
  }, [data.data, prices]);

  if (!viewed) return <AccountPrompt />;

  const allocation = (() => {
    if (!model || model.total <= 0) return [];
    const top = model.walletRows.filter((r) => r.usd > 0).slice(0, 4).map((r) => ({ label: r.token.symbol, usd: r.usd }));
    if (model.liquidityUsd > 0) top.push({ label: 'Liquidity', usd: model.liquidityUsd });
    const rest = model.total - top.reduce((s, r) => s + r.usd, 0);
    if (rest > model.total * 0.005) top.push({ label: 'Other', usd: rest });
    return top.map((r, i) => ({ ...r, pct: (r.usd / model.total) * 100, color: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length] }));
  })();

  const visibleTokens = model ? model.walletRows.filter((r) => showDust || r.usd >= DUST_USD || r.id === NATIVE_NEAR.id) : [];
  const hiddenCount = model ? model.walletRows.length - visibleTokens.length : 0;
  const lpCount = model ? model.classicRows.length + model.dclRows.length : 0;

  const withdrawAll = () =>
    execute(
      async () => {
        const fromExchange = model.depositRows.filter((r) => r.source === 'exchange').map((r) => r.id);
        const fromDcl = model.depositRows.filter((r) => r.source === 'dcl').map((r) => r.id);
        return [
          ...(fromExchange.length ? await buildWithdrawDepositsTransactions({ tokenIds: fromExchange, accountId }) : []),
          ...(fromDcl.length ? await buildDclWithdrawTransactions({ tokenIds: fromDcl, accountId }) : [])
        ];
      },
      { pending: 'Withdrawing from Rhea', success: 'Withdrawn to wallet' }
    ).then((r) => r && data.reload());

  return (
    <div className="page">
      <header className="page-head page-head--split">
        <div>
          <span className="eyebrow">Portfolio{readOnly ? ' · read-only' : ''}</span>
          <h1 className="account-title">
            {shortAccount(viewed, 18, 10)}
            <a href={`${ENDPOINTS.explorer}/address/${viewed}`} target="_blank" rel="noopener noreferrer" className="external" title="Open in explorer">
              ↗
            </a>
          </h1>
        </div>
        <div className="page-head__actions">
          {readOnly && accountId && (
            <Link to="/portfolio" className="button button--ghost">
              My portfolio
            </Link>
          )}
          <button type="button" className="button button--ghost" onClick={data.reload} disabled={data.loading}>
            {data.loading ? <Spinner size={14} /> : '↻'} Refresh
          </button>
        </div>
      </header>

      <ErrorNotice error={data.error} onRetry={data.reload} />

      <section className="card net-worth">
        <div className="net-worth__total">
          <span className="eyebrow">Net worth</span>
          <strong>{model ? formatUsd(model.total, { compactAbove: 1e9 }) : <Skeleton width={180} height={40} />}</strong>
          {model?.near && (
            <span className="muted small">
              {formatAmount(toNumber(model.near.available, 24))} NEAR available · {formatAmount(toNumber(model.near.storage, 24))} locked for storage
            </span>
          )}
        </div>
        <div className="net-worth__stats">
          <Stat label="Wallet" value={model ? formatUsd(model.walletUsd) : null} loading={!model} />
          <Stat label="Liquidity" value={model ? formatUsd(model.liquidityUsd) : null} loading={!model} hint={model ? `${lpCount} position${lpCount === 1 ? '' : 's'}` : null} />
          <Stat label="Rhea deposits" value={model ? formatUsd(model.depositUsd) : null} loading={!model} />
        </div>
        {allocation.length > 0 && (
          <div className="allocation">
            <div className="allocation__bar">
              {allocation.map((a) => (
                <span key={a.label} style={{ width: `${Math.max(a.pct, 0.8)}%`, background: a.color }} title={`${a.label} ${a.pct.toFixed(1)}%`} />
              ))}
            </div>
            <div className="allocation__legend">
              {allocation.map((a) => (
                <span key={a.label}>
                  <i style={{ background: a.color }} />
                  {a.label} <b>{a.pct.toFixed(1)}%</b>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <Tabs
        tabs={[
          { key: 'tokens', label: 'Tokens', count: model?.walletRows.length },
          { key: 'liquidity', label: 'Liquidity', count: model ? lpCount : undefined },
          { key: 'deposits', label: 'Rhea deposits', count: model?.depositRows.length }
        ]}
        value={tab}
        onChange={setTab}
      />

      {!model ? (
        <div className="card">
          {[0, 1, 2, 3].map((i) => (
            <div className="asset-row" key={i}>
              <Skeleton width="40%" height={20} />
              <Skeleton width={80} />
              <Skeleton width={80} />
            </div>
          ))}
        </div>
      ) : tab === 'tokens' ? (
        <section className="card asset-table">
          <div className="asset-row asset-row--head">
            <span>Asset</span>
            <span>Price</span>
            <span>Balance</span>
            <span>Value</span>
          </div>
          {visibleTokens.map((r) => (
            <div className="asset-row" key={r.id}>
              <span className="asset-row__token">
                <TokenIcon token={r.token} size={32} />
                <span>
                  <strong>{r.token.symbol}</strong>
                  <small>{r.id === NATIVE_NEAR.id ? 'Native' : shortAccount(r.id, 14, 8)}</small>
                </span>
              </span>
              <span data-label="Price">{formatPrice(r.price)}</span>
              <span data-label="Balance">{formatAmount(r.amount)}</span>
              <span data-label="Value" className="asset-row__value">
                {formatUsd(r.usd)}
                {!readOnly && (
                  <Link to={`/swap?from=${r.id}`} className="mini-button">
                    Swap
                  </Link>
                )}
              </span>
            </div>
          ))}
          {!visibleTokens.length && <EmptyState title="No tokens">This account holds no fungible tokens.</EmptyState>}
          {hiddenCount > 0 && (
            <button type="button" className="link-button asset-table__more" onClick={() => setShowDust((v) => !v)}>
              {showDust ? 'Hide small balances' : `Show ${hiddenCount} small or unpriced balance${hiddenCount === 1 ? '' : 's'}`}
            </button>
          )}
        </section>
      ) : tab === 'liquidity' ? (
        <section className="lp-list">
          {!lpCount && (
            <div className="card">
              <EmptyState
                icon="≋"
                title="No liquidity positions"
                action={
                  <Link to="/pools" className="button button--primary">
                    Explore pools
                  </Link>
                }
              >
                Provide liquidity to a Rhea pool to earn a share of every trade.
              </EmptyState>
            </div>
          )}
          {model.classicRows.map((p) => (
            <Link to={poolPath(p.pool.id)} className="card lp-card" key={`c-${p.pool.id}`}>
              <div className="lp-card__head">
                <PairIcons tokens={p.parts.map((x) => x.token)} size={30} />
                <div>
                  <strong>{p.parts.map((x) => x.token.symbol).join(' / ')}</strong>
                  <small>
                    <span className={`kind kind--${p.pool.label.toLowerCase()}`}>{p.pool.label}</span> #{p.pool.id}
                    {p.staked !== '0' && <span className="kind kind--farm">Farming</span>}
                  </small>
                </div>
                <strong className="lp-card__value">{formatUsd(p.usd)}</strong>
              </div>
              <div className="lp-card__body">
                {p.parts.map((x) => (
                  <span key={x.token.id}>
                    {formatAmount(x.amount)} {x.token.symbol}
                  </span>
                ))}
                <span className="muted">{formatPercent(p.sharePct, 4)} of pool</span>
              </div>
            </Link>
          ))}
          {model.dclRows.map((p) => (
            <Link to={poolPath(p.poolId)} className="card lp-card" key={`d-${p.id}`}>
              <div className="lp-card__head">
                <PairIcons tokens={[p.x, p.y]} size={30} />
                <div>
                  <strong>
                    {p.x.symbol} / {p.y.symbol}
                  </strong>
                  <small>
                    <span className="kind kind--clmm">CLMM</span>
                    <span className={`range-badge ${p.inRange ? 'range-badge--in' : ''}`}>{p.inRange ? 'In range' : 'Out of range'}</span>
                  </small>
                </div>
                <strong className="lp-card__value">{formatUsd(p.usd)}</strong>
              </div>
              <div className="lp-card__body">
                <span>
                  {formatAmount(p.ax)} {p.x.symbol}
                </span>
                <span>
                  {formatAmount(p.ay)} {p.y.symbol}
                </span>
                <span className="muted">
                  Range {formatAmount(dclPointToPrice(p.leftPoint, p.x.decimals, p.y.decimals))} – {formatAmount(dclPointToPrice(p.rightPoint, p.x.decimals, p.y.decimals))}
                </span>
              </div>
            </Link>
          ))}
        </section>
      ) : (
        <section className="card asset-table">
          {model.depositRows.length ? (
            <>
              <div className="deposits-head">
                <p className="muted">
                  Tokens held inside Rhea contracts ({CONTRACTS.exchange} and {CONTRACTS.dcl}), e.g. leftovers from a
                  deposit. They don&apos;t earn fees until added to a pool or withdrawn.
                </p>
                {!readOnly && (
                  <button type="button" className="button button--primary button--sm" onClick={withdrawAll}>
                    Withdraw all to wallet
                  </button>
                )}
              </div>
              {model.depositRows.map((r) => (
                <div className="asset-row" key={`${r.source}-${r.id}`}>
                  <span className="asset-row__token">
                    <TokenIcon token={r.token} size={32} />
                    <span>
                      <strong>{r.token.symbol}</strong>
                      <small>{shortAccount(r.id, 14, 8)}</small>
                    </span>
                  </span>
                  <span className="muted small">{r.source === 'dcl' ? 'CLMM balance' : 'Exchange'}</span>
                  <span data-label="Balance">{formatAmount(r.amount)}</span>
                  <span data-label="Value">{formatUsd(r.usd)}</span>
                </div>
              ))}
            </>
          ) : (
            <EmptyState icon="✓" title="Nothing parked on Rhea">
              All of this account&apos;s tokens are in the wallet or in pools.
            </EmptyState>
          )}
        </section>
      )}
    </div>
  );
}
