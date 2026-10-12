// kinudefi.com welcome page: the original KINU site (video hero, tokenomics, lore,
// culture, community) with the KINU Terminal added — LAUNCH APP opens the platform.

import { useEffect, useRef } from 'react';
import { useApp } from '../state.jsx';
import { Link } from '../router.jsx';
import { useAsync } from '../hooks.js';
import { fetchTokenInfo } from '../lib/intear.js';
import { formatPrice, formatUsd } from '../lib/format.js';
import '../welcome.css';

const KINU = 'kinu.nearlytrade.near';
const X_URL = 'https://x.com/KINUonNEAR';
const NEARLY_URL = 'https://nearly.trade/kinu.nearlytrade.near';
const CHART_URL = 'https://dexscreener.com/near/refv2-kinu.nearlytrade.near:ninu-4.nearlytrade.near:10000';
const APP_PATH = '/app'; // the platform's home page

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
  ['Trades on', 'Nearly · Rhea Finance'],
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

/** Muted, looping hero video with the guardian image as fallback (autoplay can be blocked). */
function useHeroVideo(videoRef, fallbackRef) {
  useEffect(() => {
    const video = videoRef.current;
    const fallback = fallbackRef.current;
    if (!video) return undefined;
    video.muted = true;
    video.defaultMuted = true;
    const showVideo = () => {
      video.classList.remove('video-fallback');
      if (fallback) fallback.style.opacity = '0';
    };
    const showFallback = () => {
      video.classList.add('video-fallback');
      if (fallback) fallback.style.opacity = '1';
    };
    const start = () => video.play().then(showVideo, showFallback);
    const onStalled = () => video.readyState < 2 && showFallback();
    video.addEventListener('playing', showVideo);
    video.addEventListener('error', showFallback);
    video.addEventListener('stalled', onStalled);
    if (video.readyState >= 2) start();
    else video.addEventListener('loadeddata', start, { once: true });
    // A muted video is normally allowed to autoplay; retry after the first interaction if not.
    const retry = () => video.paused && start();
    window.addEventListener('pointerdown', retry, { once: true, passive: true });
    window.addEventListener('keydown', retry, { once: true });
    return () => {
      video.removeEventListener('playing', showVideo);
      video.removeEventListener('error', showFallback);
      video.removeEventListener('stalled', onStalled);
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('keydown', retry);
    };
  }, [videoRef, fallbackRef]);
}

export default function Welcome() {
  const { prices } = useApp();
  const videoRef = useRef(null);
  const fallbackRef = useRef(null);
  useHeroVideo(videoRef, fallbackRef);

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

  return (
    <div className="welcome">
      <div className="container">
        <nav>
          <a className="logo" href="#top">
            <div className="logo-mark">
              <img src="/site/kinu-mascot.png" alt="KINU" />
            </div>
            <div>
              K<span>I</span>NU
            </div>
          </a>
          <div className="navlinks">
            <a href="#platform">Platform</a>
            <a href="#about">About</a>
            <a href="#token">Token</a>
            <a href="#why">Why KINU</a>
            <a href="#community">Community</a>
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
              <video ref={videoRef} className="hero-video" autoPlay muted loop playsInline preload="metadata" poster="/site/kinu-guardian.jpg">
                <source src="/site/kinu-background.mp4" type="video/mp4" />
              </video>
              <div ref={fallbackRef} className="hero-image-fallback" />
              <div className="hero-bg-shade" />
            </div>
            <div className="hero-content">
              <div className="hero-copy">
                <div className="kicker">
                  <i className="dot" /> NEAR DOG PACK · DEFI TERMINAL
                </div>
                <h1>
                  <span className="gradient">KINU</span>
                </h1>
                <div className="hero-tag">
                  THE DOG
                  <br />
                  <span>THAT FOLLOWED.</span>
                </div>
                <div className="hero-promise">
                  KINU-built <b>Swap</b> &amp; <b>Liquidity</b> — made simple with <b>Smart LP</b>.
                </div>
                <p>
                  A community dog on NEAR — <strong>now with its own terminal.</strong> Best-price swaps, simple liquidity and
                  honest PnL, powered by Rhea Finance.
                </p>
                <div className="cta">
                  <Link className="btn primary" to={APP_PATH}>
                    LAUNCH APP ↗
                  </Link>
                  <a className="btn app" href={NEARLY_URL} {...ext}>
                    BUY $KINU ↗
                  </a>
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
        </div>

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

        <section id="token">
          <div className="section-head">
            <div>
              <div className="eyebrow">TOKENOMICS</div>
              <h2>Simple. Clear. KINU.</h2>
            </div>
            <p>No complicated math on the page. Just the supply and the allocation exactly as stated.</p>
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
                  <small>CREATOR</small>
                  <strong>20%</strong>
                  <p>Creator allocation.</p>
                </div>
                <div className="alloc-card">
                  <small>BUYBACK &amp; BURN</small>
                  <strong>20%</strong>
                  <p>Buyback &amp; burn allocation.</p>
                </div>
                <div className="alloc-card">
                  <small>HOLDERS</small>
                  <strong>60%</strong>
                  <p>Community and holders.</p>
                </div>
              </div>
            </div>
            <p className="token-note">Network: NEAR · Name: KINU · Symbol: $KINU</p>
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
              <strong>Two dogs. One NEAR. One terminal.</strong>
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
                TWO DOGS. ONE NEAR.
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
                  <img src="/site/kinu-mascot.png" alt="" />
                </div>
                <div>
                  K<span>I</span>NU
                </div>
              </a>
              <p>The Dog That Followed. KINU-built Swap &amp; Liquidity on NEAR, made simple with Smart LP.</p>
            </div>
            <div>
              <h4>Platform</h4>
              <Link to={APP_PATH}>Terminal home</Link>
              <Link to="/swap">Swap</Link>
              <Link to="/pools">Pools &amp; Smart LP</Link>
              <Link to="/portfolio">Portfolio</Link>
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
              <span>Supply 1B $KINU</span>
              <span>20% Creator · 20% Buyback &amp; Burn</span>
              <span>60% Holders</span>
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
