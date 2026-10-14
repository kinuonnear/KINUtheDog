// Swap page activity panel (Jupiter-style tabs under the chart) and the 24h flow card.
//   Transactions — live trades of the token (Intear), filterable
//   My history   — this wallet's trades in the token (Intear)
//   Holders      — top 100 holders (FastNEAR)
//   Top traders  — by volume over the last day, from the deepest pools' trades (GeckoTerminal)
//   Pairs        — every pool of the token (GeckoTerminal)

import { useState } from 'react';
import { useApp } from '../../state.jsx';
import { useAsync } from '../../hooks.js';
import { fetchTokenInfo, fetchTrades, intearTokenId } from '../../lib/intear.js';
import { getTopHolders, getTopTraders } from '../../lib/tokenMarket.js';
import { formatAmount, formatChartPrice, formatUsd, shortAccount, toNumber } from '../../lib/format.js';
import { ENDPOINTS } from '../../config.js';
import { Link, poolPath } from '../../router.jsx';
import { Skeleton } from '../ui.jsx';

const TABS = [
  ['tx', 'Transactions'],
  ['history', 'My history'],
  ['holders', 'Holders'],
  ['traders', 'Top traders'],
  ['pairs', 'Pairs']
];
const FILTERS = [
  ['all', 'All'],
  ['buy', 'Buys'],
  ['sell', 'Sells'],
  ['big', '≥ $100']
];

function timeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const txLink = (hash) => `${ENDPOINTS.explorer}/txns/${hash}`;
const accountLink = (account) => `${ENDPOINTS.explorer}/address/${account}`;

function Rows({ loading, error, empty, children, cols }) {
  if (loading)
    return Array.from({ length: 6 }, (_, i) => (
      <tr key={i}>
        {Array.from({ length: cols }, (__, j) => (
          <td key={j}>
            <Skeleton width={j === 0 ? 28 : 64} />
          </td>
        ))}
      </tr>
    ));
  if (error)
    return (
      <tr>
        <td colSpan={cols} className="activity__empty">
          {error}
        </td>
      </tr>
    );
  if (empty)
    return (
      <tr>
        <td colSpan={cols} className="activity__empty">
          {empty}
        </td>
      </tr>
    );
  return children;
}

function TradesTable({ token, trades, accountId }) {
  return (
    <table className="activity__table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th className="num">Price</th>
          <th className="num">Amount</th>
          <th className="num">Value</th>
          <th>Trader</th>
          <th className="num">Tx</th>
        </tr>
      </thead>
      <tbody>
        <Rows loading={trades.loading && !trades.data} error={trades.error && !trades.data ? 'Trades unavailable right now.' : null} empty={trades.data && !trades.data.length ? 'No trades yet.' : null} cols={7}>
          {(trades.data || []).map((t) => {
            const amount = token?.decimals !== undefined ? toNumber(t.amountRaw, token.decimals) : 0;
            const price = amount > 0 ? t.usd / amount : null;
            const buy = t.side === 'buy';
            const mine = accountId && t.trader === accountId;
            return (
              <tr key={t.id} className={mine ? 'activity__mine' : ''}>
                <td className="muted">{timeAgo(t.time)}</td>
                <td className={buy ? 'up' : 'down'}>{buy ? 'Buy' : 'Sell'}</td>
                <td className="num">{price ? `$${formatChartPrice(price)}` : '—'}</td>
                <td className="num">{formatAmount(amount)}</td>
                <td className={`num ${buy ? 'up' : 'down'}`}>{formatUsd(t.usd)}</td>
                <td>
                  <a href={accountLink(t.trader)} target="_blank" rel="noopener noreferrer">
                    {mine ? 'You' : shortAccount(t.trader, 8, 5)}
                  </a>
                </td>
                <td className="num">
                  <a href={txLink(t.txHash)} target="_blank" rel="noopener noreferrer" aria-label="Open transaction on NearBlocks">
                    ↗
                  </a>
                </td>
              </tr>
            );
          })}
        </Rows>
      </tbody>
    </table>
  );
}

function Transactions({ token, accountId }) {
  const tokenId = intearTokenId(token);
  const [filter, setFilter] = useState('all');
  const trades = useAsync(
    async () => {
      const list = await fetchTrades({
        tokenId,
        side: filter === 'buy' || filter === 'sell' ? filter : undefined,
        minUsd: filter === 'big' ? 100 : undefined,
        limit: 50
      });
      return filter === 'big' ? list.filter((t) => t.usd >= 100) : list;
    },
    [tokenId, filter],
    { enabled: Boolean(tokenId), refreshMs: 15_000 }
  );
  return (
    <>
      <div className="activity__filters segmented" role="group" aria-label="Filter trades">
        {FILTERS.map(([key, label]) => (
          <button key={key} type="button" className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
        <span className="live-pill">Live</span>
      </div>
      <TradesTable token={token} trades={trades} accountId={accountId} />
    </>
  );
}

function MyHistory({ token, accountId, connect }) {
  const tokenId = intearTokenId(token);
  const trades = useAsync(() => fetchTrades({ tokenId, trader: accountId, limit: 50 }), [tokenId, accountId], {
    enabled: Boolean(tokenId && accountId),
    refreshMs: 30_000
  });
  if (!accountId)
    return (
      <div className="activity__connect">
        <span className="muted">Connect a wallet to see your {token?.symbol} swaps.</span>
        <button type="button" className="button button--primary button--sm" onClick={connect}>
          Connect wallet
        </button>
      </div>
    );
  return <TradesTable token={token} trades={trades} accountId={accountId} />;
}

function Holders({ token, accountId }) {
  const tokenId = intearTokenId(token);
  const holders = useAsync(() => getTopHolders(tokenId), [tokenId], { enabled: Boolean(tokenId) });
  const info = useAsync(() => fetchTokenInfo(tokenId), [tokenId], { enabled: Boolean(tokenId) });
  const decimals = info.data?.decimals ?? token?.decimals ?? 0;
  const total = info.data?.totalSupply;
  return (
    <table className="activity__table">
      <thead>
        <tr>
          <th>#</th>
          <th>Account</th>
          <th className="num">Amount</th>
          <th className="num">Share</th>
        </tr>
      </thead>
      <tbody>
        <Rows loading={holders.loading && !holders.data} error={holders.error && !holders.data ? 'Holders unavailable right now.' : null} empty={holders.data && !holders.data.length ? 'No holders found.' : null} cols={4}>
          {(holders.data || []).map((h, i) => {
            const amount = toNumber(h.balance, decimals);
            return (
              <tr key={h.account} className={accountId === h.account ? 'activity__mine' : ''}>
                <td className="muted">{i + 1}</td>
                <td>
                  <a href={accountLink(h.account)} target="_blank" rel="noopener noreferrer">
                    {accountId === h.account ? 'You' : shortAccount(h.account, 12, 6)}
                  </a>
                </td>
                <td className="num">{formatAmount(amount)}</td>
                <td className="num">{total ? `${((amount / total) * 100).toFixed(2)}%` : '—'}</td>
              </tr>
            );
          })}
        </Rows>
      </tbody>
    </table>
  );
}

function TopTraders({ token, pools, accountId }) {
  const tokenId = intearTokenId(token);
  const traders = useAsync(() => getTopTraders(tokenId, pools), [tokenId, (pools || []).map((p) => p.address).join(',')], {
    enabled: Boolean(tokenId && pools?.length)
  });
  return (
    <>
      <p className="activity__note muted small">By volume over roughly the last day, from the token&apos;s deepest pools.</p>
      <table className="activity__table">
        <thead>
          <tr>
            <th>#</th>
            <th>Trader</th>
            <th className="num">Bought</th>
            <th className="num">Sold</th>
            <th className="num">Net</th>
            <th className="num">Trades</th>
          </tr>
        </thead>
        <tbody>
          <Rows
            loading={(traders.loading && !traders.data) || pools === undefined}
            error={traders.error && !traders.data ? 'Traders unavailable right now.' : null}
            empty={(traders.data && !traders.data.length) || (pools && !pools.length) ? 'No trades in the last day.' : null}
            cols={6}
          >
            {(traders.data || []).map((t, i) => {
              const net = t.buyUsd - t.sellUsd;
              return (
                <tr key={t.trader} className={accountId === t.trader ? 'activity__mine' : ''}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <a href={accountLink(t.trader)} target="_blank" rel="noopener noreferrer">
                      {accountId === t.trader ? 'You' : shortAccount(t.trader, 10, 6)}
                    </a>
                  </td>
                  <td className="num up">{formatUsd(t.buyUsd)}</td>
                  <td className="num down">{formatUsd(t.sellUsd)}</td>
                  <td className={`num ${net >= 0 ? 'up' : 'down'}`}>
                    {net >= 0 ? '+' : '−'}
                    {formatUsd(Math.abs(net))}
                  </td>
                  <td className="num">{t.trades}</td>
                </tr>
              );
            })}
          </Rows>
        </tbody>
      </table>
    </>
  );
}

function Pairs({ pools, poolsError }) {
  return (
    <table className="activity__table">
      <thead>
        <tr>
          <th>Pool</th>
          <th>DEX</th>
          <th className="num">TVL</th>
          <th className="num">24h volume</th>
          <th className="num">24h buys / sells</th>
        </tr>
      </thead>
      <tbody>
        <Rows loading={pools === undefined} error={poolsError ? 'Pools unavailable right now.' : null} empty={pools && !pools.length ? 'No pools found.' : null} cols={5}>
          {(pools || []).map((p) => (
            <tr key={p.address}>
              <td>
                {p.rheaId ? <Link to={poolPath(p.rheaId)}>{p.name}</Link> : p.name}
                {p.fee && <span className="muted small"> {p.fee}</span>}
              </td>
              <td className="muted">{p.dex === 'rhea-finance' ? 'Rhea' : p.dex === 'near-intents' ? 'NEAR Intents' : p.dex}</td>
              <td className="num">{formatUsd(p.tvl)}</td>
              <td className="num">{formatUsd(p.volume24)}</td>
              <td className="num">
                <span className="up">{p.buys24.toLocaleString()}</span> / <span className="down">{p.sells24.toLocaleString()}</span>
              </td>
            </tr>
          ))}
        </Rows>
      </tbody>
    </table>
  );
}

export default function SwapActivity({ token, pools, poolsError, flush }) {
  const { accountId, connect } = useApp();
  const [tab, setTab] = useState('tx');
  return (
    <section className={`card activity ${flush ? 'activity--flush' : ''}`} aria-label="Activity">
      <div className="activity__tabs" role="tablist" aria-label="Activity">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
            {key === 'pairs' && pools?.length ? ` (${pools.length})` : ''}
          </button>
        ))}
      </div>
      <div className="activity__body">
        {tab === 'tx' && <Transactions token={token} accountId={accountId} />}
        {tab === 'history' && <MyHistory token={token} accountId={accountId} connect={connect} />}
        {tab === 'holders' && <Holders token={token} accountId={accountId} />}
        {tab === 'traders' && <TopTraders token={token} pools={pools} accountId={accountId} />}
        {tab === 'pairs' && <Pairs pools={pools} poolsError={poolsError} />}
      </div>
    </section>
  );
}

/** 24h flow across the token's pools: volume, buys and sells. */
export function TokenFlow({ token, pools }) {
  const tokenId = intearTokenId(token);
  const info = useAsync(() => fetchTokenInfo(tokenId), [tokenId], { enabled: Boolean(tokenId), refreshMs: 30_000 });
  const buys = (pools || []).reduce((s, p) => s + p.buys24, 0);
  const sells = (pools || []).reduce((s, p) => s + p.sells24, 0);
  const total = buys + sells;
  const buyShare = total > 0 ? (buys / total) * 100 : 50;
  return (
    <section className="card token-flow" aria-label={`${token?.symbol} 24 hour activity`}>
      <dl>
        <div>
          <dt>24h vol</dt>
          <dd>{info.data ? formatUsd(info.data.volume24hUsd) : '—'}</dd>
        </div>
        <div>
          <dt>Buys</dt>
          <dd className="up">{pools ? buys.toLocaleString() : '—'}</dd>
        </div>
        <div>
          <dt>Sells</dt>
          <dd className="down">{pools ? sells.toLocaleString() : '—'}</dd>
        </div>
        <div>
          <dt>Txns</dt>
          <dd>{pools ? total.toLocaleString() : '—'}</dd>
        </div>
      </dl>
      <div className="token-flow__bar" role="img" aria-label={`Buys ${buyShare.toFixed(0)} percent, sells ${(100 - buyShare).toFixed(0)} percent`}>
        <span style={{ width: `${buyShare}%` }} />
      </div>
    </section>
  );
}
