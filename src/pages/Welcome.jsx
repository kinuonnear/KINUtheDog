// kinudefi.com welcome page: KINU × RHEA — the KINU token (paired with RHEA on Rhea Finance)
// and the KINU Terminal. LAUNCH APP opens the platform.

import { useEffect } from 'react';
import { useApp } from '../state.jsx';
import { Link, poolPath } from '../router.jsx';
import { useAsync } from '../hooks.js';
import { fetchTokenInfo } from '../lib/intear.js';
import { getPoolStats } from '../lib/rhea.js';
import { getToken } from '../lib/tokens.js';
import { formatAmount, formatPrice, formatUsd } from '../lib/format.js';
import '../welcome.css';

const KINU = 'kinu-3.nearlytrade.near';
const RHEA = 'token.rhealab.near';
const KINU_RHEA_POOL = `${KINU}|${RHEA}|10000`; // Rhea CLMM, 1% fee — created at launch on Nearly
const X_URL = 'https://x.com/KINUonNEAR';
const NEARLY_URL = `https://nearly.trade/${KINU}`;
const CHART_URL = `https://dexscreener.com/near/refv2-${KINU}:${RHEA}:10000`;
const BUY_PATH = `/swap?from=${RHEA}&to=${KINU}`;
const POOL_PATH = poolPath(KINU_RHEA_POOL);
const APP_PATH = '/app'; // the platform's home page
const LOGO = '/site/kinu-logo-256.png';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

const PLATFORM = [
  {
    to: '/swap',
    icon: '⇄',
    title: 'Swap aggregator',
    text: "Rhea's SmartRouter and direct CLMM routes up to three hops, quoted side by side — the best output wins. Real price impact, gas estimate and a route picker."
  },
  {
    to: '/pools',
    icon: '◇',
    title: 'Smart LP setup',
    text: 'Drag your price range on the chart, pick Spot, Curve or Bid-Ask, or zap in with a single token. Live pool price keeps deposits from failing.'
  },
  {
    to: '/pools',
    icon: '≋',
    title: 'Liquidity',
    text: 'AMM, CLMM, ALMM, Stable and Farm pools with fees by 1–24h windows and top performers. Create a pool in two steps.'
  },
  {
    to: '/portfolio',
    icon: '◔',
    title: 'Portfolio & PnL',
    text: 'Token PnL from your real buys and sells, LP PnL with fees and win rate, and the history of every closed position.'
  }
];

const FACTS = [
  ['Token', '$KINU · 1B supply'],
  ['Network', 'NEAR Protocol'],
  ['Paired with', 'RHEA · Rhea Finance CLMM, 1% fee'],
  ['Launched on', 'Nearly'],
  ['Terminal', 'Swap · Smart LP · Pools · Portfolio'],
  ['Custody', 'None — you sign every transaction']
];

const WHY = [
  {
    title: 'Best price, every route',
    text: "Each swap is quoted on Rhea's SmartRouter and on direct CLMM paths up to three hops, side by side. The larger output wins — or pick a route yourself."
  },
  {
    title: 'Deposits that land',
    text: 'Live pool price, slippage-safe minimums and gas sized for Rhea mean liquidity deposits go through instead of failing halfway.'
  },
  {
    title: 'See every cost first',
    text: 'Network fee, one-time storage, price impact and the minimum you receive are shown before your wallet ever opens.'
  },
  {
    title: 'Your keys, your funds',
    text: 'Non-custodial by design. Every transaction is checked against an allow-list of Rhea contracts before you are asked to sign.'
  }
];

const STEPS = [
  { title: 'Connect a NEAR wallet', text: 'Meteor, Intear, HOT or MyNearWallet — KINU never holds your keys.' },
  { title: 'Swap or set up Smart LP', text: 'Best-price swaps, or drag a range on the chart and zap in with one token.' },
  { title: 'Track your PnL', text: 'Token and LP profit, fees earned and closed positions in one portfolio.' }
];

export default function Welcome() {
  const { prices } = useApp();

  // The original site scrolled smoothly between sections.
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.scrollBehavior;
    root.style.scrollBehavior = 'smooth';
    return () => {
      root.style.scrollBehavior = before;
    };
  }, []);

  const kinuPrice = prices?.get(KINU)?.price;
  // Live market data for the stats bar (Intear indexer: price, 24h change, supply, volume, holders).
  const market = useAsync(() => fetchTokenInfo(KINU), [], { refreshMs: 60_000 });
  const stats = market.data || (market.error ? {} : null);
  const pool = useAsync(() => getPoolStats(KINU_RHEA_POOL), [], { refreshMs: 60_000 });
  const price = stats?.price ?? kinuPrice;
  const rheaPrice = prices?.get(RHEA)?.price;
  // RHEA's own token icon from its on-chain metadata (as wallets and DEXes show it).
  const rheaToken = useAsync(() => getToken(RHEA), []);

  return (
    <div className="welcome">
      <div className="container">
        <nav>
          <a className="logo" href="#top">
            <div className="logo-mark">
              <img src={LOGO} alt="KINU" />
            </div>
            <div>
              K<span>I</span>NU
            </div>
          </a>
          <div className="navlinks">
            <a href="#rhea">KINU × RHEA</a>
            <a href="#platform">Platform</a>
            <a href="#features">Features</a>
            <a href="#about">About</a>
            <a href="#token">Token</a>
            <a href="#why">Why KINU</a>
            <a href="#community">Community</a>
            <Link to="/docs">Docs</Link>
          </div>
          <div className="navactions">
            <a className="navbtn" href={X_URL} {...ext}>
              JOIN THE PACK ↗
            </a>
            <Link className="navbtn navbtn--app" to={APP_PATH}>
              LAUNCH APP ↗
            </Link>
          </div>
        </nav>

        <header className="hero" id="top">
          <div className="hero-card">
            <div className="hero-bg" aria-hidden="true">
              {/* A still image: on phones (and wallet in-app browsers) a video could open full screen. */}
              <div className="hero-image" />
              <div className="hero-bg-shade" />
            </div>
            <div className="hero-content">
              <div className="hero-copy">
                <div className="kicker">
                  <i className="dot" /> KINU × RHEA · DEFI TERMINAL ON NEAR
                </div>
                <h1>
                  <span className="gradient">KINU</span>
                </h1>
                <div className="hero-tag">
                  THE DOG THAT
                  <br />
                  <span>FOLLOWS THE FLOW.</span>
                </div>
                <div className="hero-promise">
                  KINU-built <b>Swap</b> &amp; <b>Liquidity</b> — made simple with <b>Smart LP</b>.
                </div>
                <p>
                  A community dog on NEAR, <strong>paired with RHEA</strong> — with its own terminal for best-price swaps, simple
                  liquidity and honest PnL on Rhea Finance.
                </p>
                <div className="cta">
                  <Link className="btn primary" to={APP_PATH}>
                    LAUNCH APP ↗
                  </Link>
                  <Link className="btn app" to={BUY_PATH}>
                    BUY $KINU ↗
                  </Link>
                  <a className="btn" href="#platform">
                    EXPLORE ↓
                  </a>
                </div>
              </div>
            </div>
            {kinuPrice ? (
              <div className="hero-strip">
                <span className="hero-chip hero-chip--price">
                  <i className="dot" /> $KINU {formatPrice(kinuPrice)}
                </span>
              </div>
            ) : null}
          </div>
        </header>

        <div className="stats-bar" aria-label="$KINU market data">
          {[
            ['$KINU price', stats ? formatPrice(stats.price ?? kinuPrice) : null, stats?.change24h],
            ['Market cap', stats?.circulatingSupply && (stats.price ?? kinuPrice) ? formatUsd(stats.circulatingSupply * (stats.price ?? kinuPrice)) : stats ? '—' : null],
            ['24h volume', stats ? formatUsd(stats.volume24hUsd) : null],
            ['Holders', stats ? (stats.holders ? stats.holders.toLocaleString() : '—') : null]
          ].map(([label, value, change]) => (
            <div key={label} className="stats-bar__item">
              <span>{label}</span>
              <strong>
                {value ?? <i className="stats-bar__skeleton" />}
                {Number.isFinite(change) && (
                  <em className={change >= 0 ? 'up' : 'down'}>
                    {change >= 0 ? '+' : ''}
                    {change.toFixed(2)}%
                  </em>
                )}
              </strong>
            </div>
          ))}
        </div>

        <div className="trust-row">
          <span>Powered by Rhea Finance</span>
          <span>Built on NEAR</span>
          <span>Non-custodial — you sign every transaction</span>
          <span>Open source</span>
          <Link to="/security">Security &amp; transparency →</Link>
        </div>

        <section id="rhea">
          <div className="section-head">
            <div>
              <div className="eyebrow">KINU × RHEA</div>
              <h2>The dog follows the flow.</h2>
            </div>
            <p>
              RHEA is where liquidity flows on NEAR — so that is where KINU lives. $KINU trades in one main pool: KINU/RHEA on
              Rhea Finance.
            </p>
          </div>
          <div className="pair">
            <div className="pair__head">
              <div className="pair__logos">
                <img src={LOGO} alt="KINU" />
                <span>×</span>
                {rheaToken.data?.icon ? <img src={rheaToken.data.icon} alt="RHEA" /> : <b>RHEA</b>}
              </div>
              <div>
                <h3>KINU / RHEA</h3>
                <span className="pair__meta">Rhea CLMM · 1% fee</span>
              </div>
            </div>
            <dl className="pair__stats">
              {[
                ['Price', price ? formatPrice(price) : null],
                ['In RHEA', price && rheaPrice ? `${formatAmount(price / rheaPrice)} RHEA` : prices ? '—' : null],
                ['Pool TVL', pool.data ? formatUsd(pool.data.tvl) : pool.loading ? null : '—'],
                ['24h volume', pool.data ? formatUsd(pool.data.volume24h) : pool.loading ? null : '—']
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value ?? <i className="stats-bar__skeleton" />}</dd>
                </div>
              ))}
            </dl>
            <div className="pair__actions">
              <Link className="btn primary" to={BUY_PATH}>
                BUY WITH RHEA ↗
              </Link>
              <Link className="btn app" to={POOL_PATH}>
                ADD LIQUIDITY ↗
              </Link>
              <a className="btn" href={CHART_URL} {...ext}>
                CHART ↗
              </a>
            </div>
          </div>
        </section>

        <section id="platform">
          <div className="section-head">
            <div>
              <div className="eyebrow">THE KINU TERMINAL</div>
              <h2>Swap &amp; Liquidity, made simple.</h2>
            </div>
            <p>
              KINU-built swap and liquidity tools with Smart LP setup, running on Rhea Finance liquidity. Non-custodial: every
              action is signed in your own wallet.
            </p>
          </div>
          <div className="platform-grid">
            {PLATFORM.map((item) => (
              <Link key={item.title} to={item.to} className="platform-card">
                <span className="platform-card__icon">{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
                <span className="platform-card__cta">Open →</span>
              </Link>
            ))}
          </div>
          <div className="platform-launch">
            <div>
              <div className="eyebrow">READY?</div>
              <div className="platform-launch__title">
                Swap, provide liquidity, <em>track everything.</em>
              </div>
            </div>
            <Link className="btn primary" to={APP_PATH}>
              LAUNCH APP ↗
            </Link>
          </div>
        </section>

        <section id="features">
          <div className="section-head">
            <div>
              <div className="eyebrow">WHY LPS CHOOSE KINU</div>
              <h2>
                Built for liquidity,
                <br />
                not just swaps.
              </h2>
            </div>
            <p>
              Four tools you won’t find together anywhere else on NEAR — from the first swap to the day you close your
              position.
            </p>
          </div>

          <div className="feature-list">
            <article className="feature">
              <div className="feature__copy">
                <span className="feature__num">01 · SWAP</span>
                <h3>
                  Smart routes. <em>Better swaps.</em>
                </h3>
                <p>
                  Every swap is quoted on Rhea’s SmartRouter <strong>and</strong> on direct CLMM routes up to three hops, side
                  by side. The best output is picked for you — or choose any route yourself.
                </p>
                <ul>
                  <li>Routes compared live, best marked</li>
                  <li>Price impact, minimum received and network fee before you sign</li>
                  <li>Quick 25 · 50 · 80 · 100% amounts</li>
                </ul>
                <Link className="feature__cta" to="/swap">
                  Try a swap →
                </Link>
              </div>
              <div className="feature__art" aria-hidden="true">
                <div className="mock">
                  <div className="mock__head">
                    <strong>Select route</strong>
                    <small>Quoted live on Rhea</small>
                  </div>
                  <div className="mock-route">
                    <span>
                      <b>SmartRouter</b>
                      <small>RheaCLMM</small>
                    </span>
                    <span className="mock-route__out">
                      0.08312 QTC <i className="tag tag--down">−1.58%</i>
                    </span>
                  </div>
                  <div className="mock-route mock-route--best">
                    <span>
                      <b>Rhea CLMM (direct)</b>
                      <small>RheaCLMM · via USDC</small>
                    </span>
                    <span className="mock-route__out">
                      0.08446 QTC <i className="tag tag--best">Best</i>
                    </span>
                  </div>
                  <div className="mock-route">
                    <span>
                      <b>Bridge route (2 steps)</b>
                      <small>RheaAMM + RheaCLMM</small>
                    </span>
                    <span className="mock-route__out">
                      0.08374 QTC <i className="tag tag--down">−0.85%</i>
                    </span>
                  </div>
                  <div className="mock__foot">
                    <span>Price impact</span>
                    <b>0.14%</b>
                    <span>Network fee</span>
                    <b>≈ 0.0035 NEAR</b>
                  </div>
                </div>
              </div>
            </article>

            <article className="feature feature--flip">
              <div className="feature__copy">
                <span className="feature__num">02 · ZAP IN</span>
                <h3>
                  One token. <em>A simpler way in.</em>
                </h3>
                <p>
                  Open a concentrated-liquidity position with <strong>just one token</strong>. KINU swaps the right share into
                  the pair and opens your range — in a single wallet request.
                </p>
                <ul>
                  <li>No manual swapping or ratio math</li>
                  <li>Spot, Curve or Bid-Ask shapes</li>
                  <li>Sized from guaranteed minimums — never over-spends</li>
                </ul>
                <Link className="feature__cta" to="/pools">
                  Find a pool →
                </Link>
              </div>
              <div className="feature__art" aria-hidden="true">
                <div className="mock mock--zap">
                  <div className="zap-in">
                    <span className="chip chip--big">5 NEAR</span>
                    <span className="zap-in__bolt">⚡ Zap in</span>
                  </div>
                  <div className="zap-split">
                    <span className="chip">≈ 2.5 NEAR → wNEAR</span>
                    <span className="chip">≈ 2.5 NEAR → QTC</span>
                  </div>
                  <div className="zap-bars">
                    {[30, 46, 62, 78, 90, 78, 62, 46, 30].map((h, i) => (
                      <i key={i} style={{ height: `${h}%` }} className={i < 4 ? 'y' : i > 4 ? 'x' : 'mid'} />
                    ))}
                  </div>
                  <div className="mock__foot mock__foot--center">
                    <i className="tag tag--best">Position opened</i>
                    <span>Curve · 1 wallet request</span>
                  </div>
                </div>
              </div>
            </article>

            <article className="feature">
              <div className="feature__copy">
                <span className="feature__num">03 · REBALANCE</span>
                <h3>
                  Out of range? <em>One click back in.</em>
                </h3>
                <p>
                  When the price leaves your range, your liquidity stops earning. <strong>Rebalance</strong> withdraws it,
                  swaps what the new range needs and reopens it around the current price — all in one request.
                </p>
                <ul>
                  <li>Same width or ±5 / 10 / 25%, any strategy</li>
                  <li>Every step shown before you sign</li>
                  <li>Stops safely if the pool can’t fill it</li>
                </ul>
                <Link className="feature__cta" to="/portfolio">
                  Check your positions →
                </Link>
              </div>
              <div className="feature__art" aria-hidden="true">
                <div className="mock mock--rebalance">
                  <div className="mock__head">
                    <strong>KINU / RHEA</strong>
                    <small>CLMM · 1% fee</small>
                  </div>
                  <div className="rb-track">
                    <span className="rb-range rb-range--old">
                      <i className="tag tag--warn">Out of range</i>
                    </span>
                    <span className="rb-price">
                      <i>price</i>
                    </span>
                    <span className="rb-range rb-range--new">
                      <i className="tag tag--best">Earning again</i>
                    </span>
                  </div>
                  <div className="rb-steps">
                    <span>
                      <b>1</b> Withdraw
                    </span>
                    <span>
                      <b>2</b> Swap
                    </span>
                    <span>
                      <b>3</b> Reopen
                    </span>
                  </div>
                  <div className="rb-button">⟲ Rebalance</div>
                </div>
              </div>
            </article>

            <article className="feature feature--flip">
              <div className="feature__copy">
                <span className="feature__num">04 · PORTFOLIO</span>
                <h3>
                  Know exactly how <em>your LP performs.</em>
                </h3>
                <p>
                  Total LP PnL <strong>with fees included</strong>, win rate, holding time and the history of every closed
                  position — plus real token PnL from your own buys and sells.
                </p>
                <ul>
                  <li>Unrealized + realized PnL in one place</li>
                  <li>Fees earned per position</li>
                  <li>Share a clean PnL card to X — no wallet address</li>
                </ul>
                <Link className="feature__cta" to="/portfolio">
                  Open portfolio →
                </Link>
              </div>
              <div className="feature__art" aria-hidden="true">
                <div className="mock mock--pnl">
                  <div className="pnl-top">
                    <span>
                      <small>Total LP PnL</small>
                      <b>+$1,284.52</b>
                    </span>
                    <span className="share-chip">↗ Share</span>
                  </div>
                  <svg className="pnl-spark" viewBox="0 0 300 70" preserveAspectRatio="none">
                    <path className="fill" d="M0 60 C30 58 45 50 70 52 S110 40 135 42 S170 26 195 30 S240 12 265 14 S290 6 300 4 L300 70 L0 70Z" />
                    <path className="line" d="M0 60 C30 58 45 50 70 52 S110 40 135 42 S170 26 195 30 S240 12 265 14 S290 6 300 4" />
                  </svg>
                  <div className="pnl-grid">
                    <span>
                      <small>Fees earned</small>
                      <b>$412.30</b>
                    </span>
                    <span>
                      <small>Win rate</small>
                      <b>72%</b>
                    </span>
                    <span>
                      <small>Closed</small>
                      <b>18</b>
                    </span>
                  </div>
                </div>
              </div>
            </article>
          </div>
          <p className="feature-note">Illustrations show example numbers.</p>
        </section>

        <section id="token">
          <div className="section-head">
            <div>
              <div className="eyebrow">TOKENOMICS</div>
              <h2>Simple. Clear. KINU.</h2>
            </div>
            <p>No complicated math on the page. A fair launch: the whole supply went into the KINU/RHEA pool.</p>
          </div>
          <div className="token-wrap">
            <div className="token-top">
              <div>
                <div className="supply-label">TOTAL SUPPLY</div>
                <div>
                  <span className="supply">1B</span>
                  <span className="supply-unit">$KINU</span>
                </div>
              </div>
              <div className="allocations">
                <div className="alloc-card">
                  <small>IN THE POOL AT LAUNCH</small>
                  <strong>100%</strong>
                  <p>Fair launch on Nearly — every token started in the pool.</p>
                </div>
                <div className="alloc-card">
                  <small>PAIRED WITH</small>
                  <strong>RHEA</strong>
                  <p>One main pool on Rhea Finance CLMM.</p>
                </div>
                <div className="alloc-card">
                  <small>POOL FEE</small>
                  <strong>1%</strong>
                  <p>Earned by liquidity providers on every trade.</p>
                </div>
              </div>
            </div>
            <p className="token-note">
              Network: NEAR · Name: KINU · Symbol: $KINU · Contract: <span className="mono-id">{KINU}</span>
            </p>
          </div>
        </section>

        <section id="about">
          <div className="section-head">
            <div>
              <div className="eyebrow">ABOUT KINU</div>
              <h2>From the pack, for the pack.</h2>
            </div>
            <p>A community token on NEAR that grew into a place to trade: KINU-built Swap &amp; Liquidity, made simple with Smart LP.</p>
          </div>
          <div className="about">
            <div className="about__story">
              <p>
                <strong>KINU started as a community dog on NEAR</strong> — a token the pack could rally around, trade and have fun
                with.
              </p>
              <p>
                As the pack grew, so did what it needed: a clear, fair way to swap and to provide liquidity on Rhea Finance without
                fighting failed transactions, hidden costs or confusing pool screens.
              </p>
              <p>
                <strong>So the pack built its own terminal.</strong> Best-price routing, Smart LP setup and honest PnL — open to
                everyone on NEAR, and non-custodial from the first click.
              </p>
              <p>
                <strong>Then KINU followed the flow.</strong> Relaunched as a fair launch paired with RHEA, so the token lives
                where the terminal does: on Rhea Finance liquidity.
              </p>
            </div>
            <div className="about__facts">
              <div className="eyebrow">KINU AT A GLANCE</div>
              <dl>
                {FACTS.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
          <figure className="about__art">
            <img src="/site/kinu-guardian.jpg" alt="KINU under the NEAR moon" loading="lazy" />
            <figcaption>
              <span className="eyebrow">THE PACK</span>
              <strong>One dog. One flow. One terminal.</strong>
            </figcaption>
          </figure>
        </section>

        <section id="why">
          <div className="section-head">
            <div>
              <div className="eyebrow">WHY KINU</div>
              <h2>Built so your trades land.</h2>
            </div>
            <p>Every part of the terminal is designed around one thing: getting you the best result on Rhea, safely.</p>
          </div>
          <div className="why-grid">
            {WHY.map((item, i) => (
              <div key={item.title} className="why-card">
                <span className="why-card__num">{String(i + 1).padStart(2, '0')}</span>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
            ))}
          </div>

          <div className="steps">
            <div className="steps__head">
              <div className="eyebrow">GET STARTED</div>
              <h3>Three steps to your first trade.</h3>
            </div>
            <ol className="steps__list">
              {STEPS.map((step, i) => (
                <li key={step.title}>
                  <b>{i + 1}</b>
                  <div>
                    <h4>{step.title}</h4>
                    <p>{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="closing-banner">
            <div>
              <div className="eyebrow">THE PACK TRADES HERE</div>
              <div className="closing-banner__title">
                ONE DOG. ONE FLOW.
                <br />
                <em>ONE TERMINAL.</em>
              </div>
            </div>
            <Link className="btn primary" to={APP_PATH}>
              LAUNCH APP ↗
            </Link>
          </div>
        </section>

        <section id="community" className="community">
          <div className="community-box">
            <div className="eyebrow">THE NEAR DOG PACK</div>
            <h2>THE PACK IS FORMING.</h2>
            <p>Bring the memes. Bring the energy. Bring your friends.</p>
            <div className="links">
              <Link className="link link--app" to={APP_PATH}>
                LAUNCH THE KINU TERMINAL ↗
              </Link>
              <a className="link" href={X_URL} {...ext}>
                𝕏 @KINUonNEAR ↗
              </a>
              <a className="link" href={NEARLY_URL} {...ext}>
                $KINU ON NEARLY ↗
              </a>
              <a className="link" href={CHART_URL} {...ext}>
                CHART ↗
              </a>
              <span className="link link--muted">TELEGRAM — SOON</span>
            </div>
          </div>
        </section>

        <footer className="site-footer">
          <div className="site-footer__grid">
            <div className="site-footer__brand">
              <a className="logo" href="#top">
                <div className="logo-mark">
                  <img src={LOGO} alt="" />
                </div>
                <div>
                  K<span>I</span>NU
                </div>
              </a>
              <p>KINU × RHEA — the dog that follows the flow. KINU-built Swap &amp; Liquidity on NEAR, made simple with Smart LP.</p>
            </div>
            <div>
              <h4>Platform</h4>
              <Link to={APP_PATH}>Terminal home</Link>
              <Link to="/swap">Swap</Link>
              <Link to="/pools">Pools &amp; Smart LP</Link>
              <Link to="/portfolio">Portfolio</Link>
              <Link to="/docs">Docs</Link>
              <Link to="/security">Security &amp; transparency</Link>
            </div>
            <div>
              <h4>Community</h4>
              <a href={X_URL} {...ext}>
                X / Twitter ↗
              </a>
              <a href={NEARLY_URL} {...ext}>
                Nearly ↗
              </a>
              <a href={CHART_URL} {...ext}>
                Chart ↗
              </a>
              <span className="muted">Telegram — soon</span>
            </div>
            <div>
              <h4>Token</h4>
              <span>Supply 1B $KINU · fair launch</span>
              <Link to={POOL_PATH}>KINU / RHEA pool · 1% fee</Link>
              <Link to={BUY_PATH}>Buy $KINU with RHEA</Link>
              <span className="mono-id">{KINU}</span>
            </div>
          </div>
          <div className="site-footer__legal">
            <span>© 2026 KINU. Liquidity &amp; routing by Rhea Finance.</span>
            <span>
              Non-custodial software. DeFi carries risk, including loss of funds — not financial advice. Do your own research.
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
