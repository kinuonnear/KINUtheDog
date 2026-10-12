import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { searchPools } from '../lib/rhea.js';
import { getTokens } from '../lib/tokens.js';
import { formatPrice, formatUsd } from '../lib/format.js';
import { NATIVE_NEAR } from '../config.js';
import { ErrorNotice, Skeleton, TokenIcon } from '../components/ui.jsx';
import { PoolRow, PoolRowsSkeleton, usePoolTokens } from './Pools.jsx';

const TICKER_TOKENS = [
  NATIVE_NEAR.id,
  'kinu.nearlytrade.near',
  'token.rhealab.near',
  'ninu-4.nearlytrade.near',
  'meta-pool.near',
  'nbtc.bridge.near'
];

function Ticker() {
  const { prices } = useApp();
  const tokens = useAsync(() => getTokens(TICKER_TOKENS), []);
  const items = (copy) =>
    TICKER_TOKENS.map((id) => {
      const token = id === NATIVE_NEAR.id ? NATIVE_NEAR : tokens.data?.[id];
      const price = prices?.get(id)?.price;
      return (
        <Link
          key={`${copy}-${id}`}
          to={`/swap?from=${id === NATIVE_NEAR.id ? 'usdt.tether-token.near' : NATIVE_NEAR.id}&to=${id}`}
          className="ticker__item"
          tabIndex={copy ? -1 : undefined}
        >
          <TokenIcon token={token || { symbol: prices?.get(id)?.symbol || '?' }} size={22} />
          <span>{token?.symbol || prices?.get(id)?.symbol || '…'}</span>
          <strong>{price ? formatPrice(price) : <Skeleton width={50} />}</strong>
        </Link>
      );
    });
  // Marquee: the list is rendered twice and the track slides by half its width, so it loops
  // seamlessly. Pauses on hover; still for users who prefer reduced motion.
  return (
    <div className="ticker ticker--marquee">
      <div className="ticker__track">
        <div className="ticker__set">{items(0)}</div>
        <div className="ticker__set" aria-hidden="true">
          {items(1)}
        </div>
      </div>
    </div>
  );
}

function TopPools({ title, sort }) {
  const result = useAsync(() => searchPools({ sort, limit: 5 }), [sort], { refreshMs: 60_000 });
  const tokensOf = usePoolTokens(result.data?.list);
  return (
    <section className="card top-pools">
      <div className="card-head">
        <h3>{title}</h3>
        <Link to="/pools" className="link-button">
          All pools →
        </Link>
      </div>
      <ErrorNotice error={result.error} onRetry={result.reload} />
      <div className="pool-table pool-table--compact">
        {result.loading && !result.data ? (
          <PoolRowsSkeleton rows={5} />
        ) : (
          result.data?.list.map((pool) => <PoolRow key={pool.id} pool={pool} tokensOf={tokensOf} />)
        )}
      </div>
    </section>
  );
}

export default function Home() {
  const { accountId, connect, walletReady } = useApp();
  const totals = useAsync(() => searchPools({ limit: 100, hideLow: true }), []);
  const trackedTvl = totals.data?.list.reduce((sum, p) => sum + p.tvl, 0);
  const trackedVolume = totals.data?.list.reduce((sum, p) => sum + p.volume24h, 0);

  return (
    <div className="home">
      <section className="hero">
        <div className="hero__bg" aria-hidden />
        <div className="hero__content">
          <span className="eyebrow eyebrow--glow">KINU · DeFi terminal on NEAR</span>
          <h1>
            Swap at the best price.
            <br />
            <em>Set up LP the smart way.</em>
          </h1>
          <p>
            Every swap compares Rhea&apos;s SmartRouter with direct CLMM routes up to three hops and takes the best output.
            Smart LP setup lets you draw your range on the chart, pick a strategy or zap in with one token — then track
            fees and PnL live. Non-custodial: you sign every action in your own wallet.
          </p>
          <div className="hero__actions">
            <Link to="/swap" className="button button--primary button--lg">
              Start trading
            </Link>
            <Link to="/pools" className="button button--outline button--lg">
              Smart LP setup
            </Link>
            {accountId ? (
              <Link to="/portfolio" className="button button--ghost button--lg">
                View portfolio
              </Link>
            ) : (
              <button type="button" className="button button--ghost button--lg" onClick={connect} disabled={!walletReady}>
                Connect wallet
              </button>
            )}
          </div>
          <div className="hero__stats">
            <div>
              <span>TVL · top 100 pools</span>
              <strong>{trackedTvl !== undefined ? formatUsd(trackedTvl) : <Skeleton width={110} height={26} />}</strong>
            </div>
            <div>
              <span>24h volume</span>
              <strong>{trackedVolume !== undefined ? formatUsd(trackedVolume) : <Skeleton width={110} height={26} />}</strong>
            </div>
            <div>
              <span>Rhea pools</span>
              <strong>{totals.data ? totals.data.total.toLocaleString() : <Skeleton width={60} height={26} />}</strong>
            </div>
          </div>
        </div>
      </section>

      <Ticker />

      <section className="features features--four">
        <Link to="/swap" className="feature card">
          <span className="feature__icon">⇄</span>
          <h3>Swap aggregator</h3>
          <p>
            Rhea SmartRouter and direct CLMM routes up to three hops, quoted side by side — the best output wins. Real price
            impact, gas estimate and a route picker.
          </p>
          <span className="feature__cta">Swap now →</span>
        </Link>
        <Link to="/pools" className="feature card feature--highlight">
          <span className="feature__icon">◇</span>
          <h3>Smart LP setup</h3>
          <p>
            Drag your price range on the chart, choose Spot, Curve or Bid-Ask, and see the pool&apos;s depth as you shape it — or
            zap in with a single token.
          </p>
          <span className="feature__cta">Set up a position →</span>
        </Link>
        <Link to="/pools" className="feature card">
          <span className="feature__icon">≋</span>
          <h3>Liquidity</h3>
          <p>AMM, CLMM, ALMM, Stable and Farm pools with fees by 1–24h windows and top performers. Add or remove in one flow.</p>
          <span className="feature__cta">Explore pools →</span>
        </Link>
        <Link to="/portfolio" className="feature card">
          <span className="feature__icon">◔</span>
          <h3>Portfolio &amp; PnL</h3>
          <p>Token PnL from your real buys and sells, LP PnL with fees and win rate, and the history of every closed position.</p>
          <span className="feature__cta">Open portfolio →</span>
        </Link>
      </section>

      <section className="lp-steps card">
        <div className="lp-steps__head">
          <span className="eyebrow eyebrow--glow">Smart LP setup</span>
          <h2>Concentrated liquidity in three steps</h2>
        </div>
        <ol className="lp-steps__list">
          <li>
            <b>1</b>
            <div>
              <h4>Pick a pool</h4>
              <p>Filter by AMM, CLMM, ALMM, Stable or Farm and sort by fees earned over the last hours.</p>
            </div>
          </li>
          <li>
            <b>2</b>
            <div>
              <h4>Shape your range</h4>
              <p>Drag Min / Max on the chart or type prices. Spot, Curve or Bid-Ask spreads your liquidity into bins.</p>
            </div>
          </li>
          <li>
            <b>3</b>
            <div>
              <h4>Deposit &amp; track</h4>
              <p>Add both tokens or zap in with one. Claim fees, add or remove in place, and follow PnL per position.</p>
            </div>
          </li>
        </ol>
        <Link to="/pools" className="button button--primary">
          Start an LP position
        </Link>
      </section>

      <div className="home-grid">
        <TopPools title="Deepest pools" sort="tvl" />
        <TopPools title="Most traded · 24h" sort="volume_24h" />
      </div>
    </div>
  );
}
