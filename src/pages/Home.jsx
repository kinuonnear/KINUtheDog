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
  return (
    <div className="ticker">
      {TICKER_TOKENS.map((id) => {
        const token = id === NATIVE_NEAR.id ? NATIVE_NEAR : tokens.data?.[id];
        const price = prices?.get(id)?.price;
        return (
          <Link key={id} to={`/swap?from=${id === NATIVE_NEAR.id ? 'usdt.tether-token.near' : NATIVE_NEAR.id}&to=${id}`} className="ticker__item">
            <TokenIcon token={token || { symbol: prices?.get(id)?.symbol || '?' }} size={22} />
            <span>{token?.symbol || prices?.get(id)?.symbol || '…'}</span>
            <strong>{price ? formatPrice(price) : <Skeleton width={50} />}</strong>
          </Link>
        );
      })}
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
            Trade, earn and track
            <br />
            <em>with Rhea liquidity.</em>
          </h1>
          <p>
            Best-price swaps routed across every Rhea pool, one-click liquidity, and a live portfolio of your tokens and
            LP positions. Non-custodial: every action is signed in your own wallet.
          </p>
          <div className="hero__actions">
            <Link to="/swap" className="button button--primary button--lg">
              Start trading
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

      <section className="features">
        <Link to="/swap" className="feature card">
          <span className="feature__icon">⇄</span>
          <h3>Swap aggregator</h3>
          <p>Rhea SmartRouter splits your trade across AMM, stable and concentrated pools for the best output.</p>
          <span className="feature__cta">Swap now →</span>
        </Link>
        <Link to="/pools" className="feature card">
          <span className="feature__icon">≋</span>
          <h3>Liquidity</h3>
          <p>Browse thousands of pools by TVL, volume and APR. Add or remove liquidity in a single flow.</p>
          <span className="feature__cta">Explore pools →</span>
        </Link>
        <Link to="/portfolio" className="feature card">
          <span className="feature__icon">◔</span>
          <h3>Portfolio</h3>
          <p>Net worth across wallet tokens, LP positions, CLMM ranges, farm stakes and Rhea deposits.</p>
          <span className="feature__cta">Open portfolio →</span>
        </Link>
      </section>

      <div className="home-grid">
        <TopPools title="Deepest pools" sort="tvl" />
        <TopPools title="Most traded · 24h" sort="volume_24h" />
      </div>
    </div>
  );
}
