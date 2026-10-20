import { useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useLocalStorage } from '../hooks.js';
import { Link, navigate, useLocation } from '../router.jsx';
import { asPoolToken, getAllBalances, getTokens, priceOf } from '../lib/tokens.js';
import { getAggregatorBalances, getClassicPositions, getDclPositions, getDeposits, getLostFound } from '../lib/rhea.js';
import { buildAggregatorWithdrawTransactions, buildClaimLostFoundTransactions, buildWithdrawDepositsTransactions } from '../lib/liquidity.js';
import { buildDclWithdrawTransactions, getDclAssets } from '../lib/dclLiquidity.js';
import { formatAmount, formatPrice, formatUsd, shortAccount, toNumber } from '../lib/format.js';
import { CONTRACTS, ENDPOINTS, NATIVE_NEAR } from '../config.js';
import LiquidityTable from '../components/LiquidityTable.jsx';
import { ClosedPositions, PnlDashboard, PnlValue, useLpHistory } from '../components/LpPnl.jsx';
import { AvgCell, rowPnl, SoldTokens, SwapHistory, TokenPnlSummary, useTokenPnl } from '../components/TokenPnl.jsx';
import { fetchTokenInfo } from '../lib/intear.js';
import { tokenShareCard } from '../lib/shareCard.js';
import ShareButton from '../components/ShareCard.jsx';
import DustSweeper from '../components/DustSweeper.jsx';
import { EmptyState, ErrorNotice, Skeleton, Spinner, Stat, Tabs, TokenIcon } from '../components/ui.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import StakingSummary from '../components/StakingSummary.jsx';
import EarnSummary from '../components/EarnSummary.jsx';
import '../portfolio.css';
import PageIcon from '../components/PageIcon.jsx';

const DUST_USD = 0.01;
const ALLOCATION_COLORS = ['#b8ff3d', '#3ddc97', '#5ec8ff', '#ffb547', '#c792ff', '#5a6470'];

// Where tokens can sit inside Rhea instead of the wallet.
const DEPOSIT_SOURCES = {
  exchange: 'Exchange',
  dcl: 'CLMM balance',
  lostfound: 'Exchange lost & found',
  aggregator: 'Swap router'
};

async function loadPortfolio(account) {
  const [wallet, deposits, dclAssets, lostFound, aggregator, classic, dcl] = await Promise.all([
    getAllBalances(account),
    getDeposits(account).catch(() => ({})),
    getDclAssets(account).catch(() => ({})),
    getLostFound(account).catch(() => ({})),
    getAggregatorBalances(account).catch(() => ({})),
    getClassicPositions(account).catch(() => []),
    // Not caught: a failed read must not show the CLMM positions as gone (the last result stays).
    getDclPositions(account)
  ]);
  const ids = new Set([
    ...Object.keys(wallet.balances),
    ...Object.keys(deposits),
    ...Object.keys(dclAssets),
    ...Object.keys(lostFound),
    ...Object.keys(aggregator),
    ...classic.flatMap((p) => p.pool.tokenIds),
    ...dcl.flatMap((p) => [p.tokenX, p.tokenY])
  ]);
  const tokens = await getTokens([...ids]);
  return { wallet, deposits, dclAssets, lostFound, aggregator, classic, dcl, tokens };
}

/** ⧉ copy the token contract · ↗ open it in the explorer (next to the contract id). */
function ContractLinks({ id }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="contract-links" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="contract-links__btn"
        title={copied ? 'Copied' : 'Copy contract address'}
        aria-label="Copy contract address"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(id);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          } catch {
            // clipboard blocked
          }
        }}
      >
        {copied ? '✓' : '⧉'}
      </button>
      <a className="contract-links__btn" href={`${ENDPOINTS.explorer}/address/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer" title="Open in explorer" aria-label="Open in explorer">
        ↗
      </a>
    </span>
  );
}

/**
 * The contract id under a token's symbol, with copy + explorer. Native NEAR has no contract:
 * it gets a link to trade it on the Swap page instead.
 */
function ContractId({ id }) {
  if (id === NATIVE_NEAR.id) {
    return (
      <small className="asset-row__id">
        <span>Native</span>
        <span className="contract-links">
          <Link to={`/swap?from=${NATIVE_NEAR.id}`} className="contract-links__btn" title="Trade NEAR on Swap" aria-label="Trade NEAR on Swap">
            ⇄
          </Link>
        </span>
      </small>
    );
  }
  return (
    <small className="asset-row__id">
      <span title={id}>{shortAccount(id, 14, 8)}</span>
      <ContractLinks id={id} />
    </small>
  );
}

function AccountPrompt() {
  const { connect, walletReady } = useApp();
  const [value, setValue] = useState('');
  return (
    <div className="page">
      <div className="portfolio-gate card">
        <span className="eyebrow">Portfolio</span>
        <h1>
          <PageIcon name="portfolio" />
          Your DeFi, in one place.
        </h1>
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
  // Cards say "my PnL": only offered on your own portfolio.
  const ownPortfolio = Boolean(accountId) && viewed === accountId;
  const readOnly = viewed !== accountId;
  // The tab the user last picked is remembered; until then an account with liquidity opens on
  // Liquidity (KINU is an LP platform), any other on Tokens. See `tab` below.
  const [savedTab, setTab] = useLocalStorage('kinu.portfolio.tab', null);
  // History: closed LP positions or swaps, shown apart.
  const [historyKind, setHistoryKind] = useState('lp');
  const [showDust, setShowDust] = useState(false);

  const data = useAsync(() => loadPortfolio(viewed), [viewed], { enabled: Boolean(viewed), refreshMs: 45_000 });

  const model = useMemo(() => {
    if (!data.data) return null;
    const { wallet, deposits, dclAssets, lostFound, aggregator, classic, dcl, tokens } = data.data;
    const meta = (id) => (id === NATIVE_NEAR.id ? NATIVE_NEAR : tokens[id] || { id, symbol: id.slice(0, 6), decimals: 0 });
    const usdOf = (id, raw) => toNumber(raw, meta(id).decimals) * priceOf(prices, id);

    const walletRows = Object.entries(wallet.balances)
      .map(([id, raw]) => {
        const token = meta(id);
        const amount = toNumber(raw, token.decimals);
        const price = priceOf(prices, id);
        return { id, token, raw: String(raw), amount, price, usd: amount * price };
      })
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.usd - a.usd || b.amount - a.amount);

    // Tokens parked inside Rhea: the classic exchange (and its lost & found), the CLMM (DCL)
    // contract and the swap aggregator.
    const depositRows = [
      ...Object.entries(deposits).map(([id, raw]) => ({ id, raw, source: 'exchange' })),
      ...Object.entries(dclAssets).map(([id, raw]) => ({ id, raw, source: 'dcl' })),
      ...Object.entries(lostFound).map(([id, raw]) => ({ id, raw, source: 'lostfound' })),
      ...Object.entries(aggregator).map(([id, raw]) => ({ id, raw, source: 'aggregator' }))
    ]
      .map((r) => ({ ...r, token: meta(r.id), amount: toNumber(r.raw, meta(r.id).decimals), usd: usdOf(r.id, r.raw) }))
      .sort((a, b) => b.usd - a.usd);

    const classicRows = classic
      .map((p) => {
        const parts = p.pool.tokenIds.map((id, i) => ({ token: asPoolToken(meta(id)), amount: toNumber(p.amounts[i], meta(id).decimals), usd: usdOf(id, p.amounts[i]) }));
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
        const x = asPoolToken(meta(p.tokenX));
        const y = asPoolToken(meta(p.tokenY));
        const ax = p.amountX / 10 ** x.decimals;
        const ay = p.amountY / 10 ** y.decimals;
        const px = priceOf(prices, p.tokenX);
        const py = priceOf(prices, p.tokenY);
        const feeUsd = toNumber(p.unclaimedFeeX, x.decimals) * px + toNumber(p.unclaimedFeeY, y.decimals) * py;
        return { ...p, x, y, ax, ay, usd: ax * px + ay * py, feeUsd };
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

  const history = useLpHistory(viewed, model?.dclRows, prices);

  const tokenPnl = useTokenPnl(viewed, prices);
  // Transactions that were liquidity actions: kept out of the swap history.
  const lpHashes = useMemo(() => new Set((history.events || []).map((e) => e.hash)), [history.events]);

  // 24h price change per held token (Intear), shown under the price.
  const heldIds = model ? model.walletRows.filter((r) => r.usd >= DUST_USD).map((r) => (r.id === NATIVE_NEAR.id ? CONTRACTS.wrapNear : r.id)) : [];
  const changes = useAsync(
    async () => Object.fromEntries(await Promise.all(heldIds.map(async (id) => [id, (await fetchTokenInfo(id).catch(() => null))?.change24h ?? null]))),
    [heldIds.join(',')],
    { enabled: heldIds.length > 0, refreshMs: 60_000 }
  );
  const change24h = (id) => changes.data?.[id === NATIVE_NEAR.id ? CONTRACTS.wrapNear : id] ?? null;

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
  // One entry per pool: CLMM positions in the same pool count once.
  const lpCount = model ? model.classicRows.length + new Set(model.dclRows.map((r) => r.poolId)).size : 0;
  const tab = savedTab || (lpCount > 0 ? 'liquidity' : 'tokens');

  const withdrawAll = () =>
    execute(
      async () => {
        const from = (source) => model.depositRows.filter((r) => r.source === source).map((r) => r.id);
        const [fromExchange, fromDcl, fromLostFound, fromAggregator] = ['exchange', 'dcl', 'lostfound', 'aggregator'].map(from);
        return [
          ...(fromExchange.length ? await buildWithdrawDepositsTransactions({ tokenIds: fromExchange, accountId }) : []),
          ...(fromDcl.length ? await buildDclWithdrawTransactions({ tokenIds: fromDcl, accountId }) : []),
          ...(fromLostFound.length ? await buildClaimLostFoundTransactions({ tokenIds: fromLostFound, accountId }) : []),
          ...(fromAggregator.length ? await buildAggregatorWithdrawTransactions({ tokenIds: fromAggregator, accountId }) : [])
        ];
      },
      { pending: 'Withdrawing from Rhea', success: 'Withdrawn to wallet' }
    ).then((r) => r && data.reload());

  return (
    <div className="page page--portfolio">
      <header className="page-head page-head--split pf-head">
        <FlowLines />
        <div>
          <span className="eyebrow">Portfolio{readOnly ? ' · read-only' : ''}</span>
          <h1 className="account-title">
            <PageIcon name="portfolio" />
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
          <Stat label="Token" value={model ? formatUsd(model.walletUsd) : null} loading={!model} />
          <Stat label="Liquidity" value={model ? formatUsd(model.liquidityUsd) : null} loading={!model} hint={model ? `${lpCount} pool${lpCount === 1 ? '' : 's'}` : null} />
          <Stat label="Rhea deposits" value={model ? formatUsd(model.depositUsd) : null} loading={!model} />
        </div>
      </section>

      <StakingSummary account={viewed} readOnly={readOnly} />
      <EarnSummary account={viewed} readOnly={readOnly} />

      <Tabs
        tabs={[
          { key: 'tokens', label: 'Tokens', count: model?.walletRows.length },
          { key: 'liquidity', label: 'Liquidity', count: model ? lpCount : undefined },
          { key: 'history', label: 'History', count: history.model?.closed.length },
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
        <>
          <section className="card allocation-card">
            <TokenPnlSummary pnl={tokenPnl} rows={visibleTokens} />
            {ownPortfolio && (
              <div className="sweep-bar">
                <DustSweeper rows={model.walletRows} onDone={data.reload} />
              </div>
            )}
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
          <section className="card asset-table asset-table--pnl">
            <div className="asset-row asset-row--head">
              <span>Asset</span>
              <span>Price</span>
              <span>Balance</span>
              <span>Avg buy</span>
              <span>PnL</span>
              <span>Realized</span>
              <span>Value</span>
            </div>
            {visibleTokens.map((r) => {
              const info = rowPnl(tokenPnl, r);
              const change = change24h(r.id);
              return (
              <div className="asset-row" key={r.id}>
                <span className="asset-row__token">
                  <TokenIcon token={r.token} size={32} />
                  <span>
                    <strong>{r.token.symbol}</strong>
                    <ContractId id={r.id} />
                  </span>
                </span>
                <span data-label="Price" className="price-cell">
                  {formatPrice(r.price)}
                  {change !== null && (
                    <small className={change > 0 ? 'up' : change < 0 ? 'down' : 'muted'}>
                      {change > 0 ? '+' : ''}
                      {change.toFixed(2)}% 24h
                    </small>
                  )}
                </span>
                <span data-label="Balance">{formatAmount(r.amount)}</span>
                <span data-label="Avg buy">
                  <AvgCell info={info} loading={tokenPnl.loading} />
                </span>
                <span data-label="PnL">
                  {info?.avg ? (
                    <span className="pnl-share" title={info.partial ? 'Part of this balance predates the loaded history' : undefined}>
                      <PnlValue value={info.pnl} pct={info.pct} />
                      {ownPortfolio && (
                        <ShareButton label="" className="icon-button pnl-share__button" build={(hideUsd) => tokenShareCard(r, info, hideUsd)} />
                      )}
                    </span>
                  ) : (
                    <span className="muted">{tokenPnl.loading ? <Spinner size={12} /> : '—'}</span>
                  )}
                </span>
                <span data-label="Realized">
                  {info && Math.abs(info.realized) >= 0.005 ? <PnlValue value={info.realized} /> : <span className="muted">—</span>}
                </span>
                <span data-label="Value" className="asset-row__value">
                  {formatUsd(r.usd)}
                  {!readOnly && (
                    <Link to={`/swap?from=${r.id}`} className="mini-button">
                      Swap
                    </Link>
                  )}
                </span>
              </div>
              );
            })}
            {!visibleTokens.length && <EmptyState title="No tokens">This account holds no fungible tokens.</EmptyState>}
            {hiddenCount > 0 && (
              <button type="button" className="link-button asset-table__more" onClick={() => setShowDust((v) => !v)}>
                {showDust ? 'Hide small balances' : `Show ${hiddenCount} small or unpriced balance${hiddenCount === 1 ? '' : 's'}`}
              </button>
            )}
          </section>
          <SoldTokens pnl={tokenPnl} heldIds={new Set(model.walletRows.map((r) => r.id))} />
        </>
      ) : tab === 'liquidity' ? (
        <>
          <PnlDashboard history={history} shareable={ownPortfolio} />
          <LiquidityTable
            classicRows={model.classicRows}
            dclRows={model.dclRows}
            depositUsd={model.depositUsd}
            readOnly={readOnly}
            history={history}
            onDone={data.reload}
            rangeBar
          />
        </>
      ) : tab === 'history' ? (
        <>
          <div className="history-bar">
            <div>
              <strong>{historyKind === 'lp' ? 'Closed LP positions' : 'Swap history'}</strong>
              <span className="muted small">
                {historyKind === 'lp' ? 'Fully removed CLMM positions with their realized PnL.' : 'Every swap from this wallet, newest first.'}
              </span>
            </div>
            <div className="segmented history-kind" role="tablist" aria-label="History type">
              <button type="button" role="tab" aria-selected={historyKind === 'lp'} className={historyKind === 'lp' ? 'active' : ''} onClick={() => setHistoryKind('lp')}>
                LP positions{history.model ? ` · ${history.model.closed.length}` : ''}
              </button>
              <button type="button" role="tab" aria-selected={historyKind === 'swap'} className={historyKind === 'swap' ? 'active' : ''} onClick={() => setHistoryKind('swap')}>
                Swaps
              </button>
            </div>
          </div>
          {historyKind === 'lp' ? (
            <ClosedPositions history={history} />
          ) : (
            <SwapHistory tokenPnl={tokenPnl} lpHashes={lpHashes} prices={prices} />
          )}
        </>
      ) : (
        <section className="card asset-table">
          {model.depositRows.length ? (
            <>
              <div className="deposits-head">
                <p className="muted">
                  Tokens held for you inside Rhea contracts ({CONTRACTS.exchange}, {CONTRACTS.dcl} and the swap router{' '}
                  {CONTRACTS.aggregator}), e.g. leftovers from a deposit or a swap whose final transfer failed. They don&apos;t
                  earn fees until added to a pool or withdrawn.
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
                      <ContractId id={r.id} />
                    </span>
                  </span>
                  <span className="muted small">{DEPOSIT_SOURCES[r.source]}</span>
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
