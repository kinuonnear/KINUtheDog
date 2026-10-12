// kinuthedog.site welcome page: the original KINU site (video hero, tokenomics, lore,
// culture, community) with the KINU Terminal added — LAUNCH APP opens the platform.

import { useEffect, useRef } from 'react';
import { useApp } from '../state.jsx';
import { Link } from '../router.jsx';
import { formatPrice } from '../lib/format.js';
import '../welcome.css';

const KINU = 'kinu.nearlytrade.near';
const X_URL = 'https://x.com/KINUonNEAR';
const NEARLY_URL = 'https://nearly.trade/kinu.nearlytrade.near';
const CHART_URL = 'https://dexscreener.com/near/refv2-kinu.nearlytrade.near:ninu-4.nearlytrade.near:10000';
const APP_PATH = '/swap';

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
            <a href="#lore">Lore</a>
            <a href="#token">Token</a>
            <a href="#culture">Culture</a>
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
                <p>
                  NINU found the path. KINU followed the scent. <strong>Two dogs. One NEAR.</strong> And now a home for the pack:
                  swap at the best price, set up liquidity the smart way and track your PnL — all on Rhea.
                </p>
                <div className="cta">
                  <Link className="btn primary" to={APP_PATH}>
                    LAUNCH APP ↗
                  </Link>
                  <a className="btn app" href={NEARLY_URL} {...ext}>
                    BUY $KINU ↗
                  </a>
                  <a className="btn" href="#lore">
                    READ THE LORE ↓
                  </a>
                </div>
                <div className="socials">
                  <a className="social" href={X_URL} {...ext}>
                    𝕏 X / @KINUonNEAR
                  </a>
                  <a className="social" href={NEARLY_URL} {...ext}>
                    Ⓝ NEARLY
                  </a>
                  <a className="social" href={NEARLY_URL} {...ext}>
                    ▣ CONTRACT
                  </a>
                  <span className="social">✈ TELEGRAM — SOON</span>
                  <a className="social" href={CHART_URL} {...ext}>
                    ▥ CHART ↗
                  </a>
                </div>
              </div>
            </div>
            <div className="hero-strip">
              {kinuPrice ? <span className="hero-chip hero-chip--price">$KINU {formatPrice(kinuPrice)}</span> : null}
              <span className="hero-chip">NO ROADMAP</span>
              <span className="hero-chip">JUST FUN</span>
              <span className="hero-chip">FOR THE CULTURE</span>
            </div>
          </div>
        </header>

        <section id="platform">
          <div className="section-head">
            <div>
              <div className="eyebrow">THE KINU TERMINAL</div>
              <h2>Built for the pack.</h2>
            </div>
            <p>A DeFi terminal on NEAR powered by Rhea Finance liquidity. Non-custodial: every action is signed in your own wallet.</p>
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

        <section id="lore">
          <div className="section-head">
            <div>
              <div className="eyebrow">THE LORE</div>
              <h2>One found the way.</h2>
            </div>
            <p>A simple story for a simple meme: NINU discovered the path, and KINU followed the scent.</p>
          </div>
          <div className="lore">
            <div className="panel story">
              <p>They said there was only one dog.</p>
              <p>NINU found the path and started walking through the NEAR ecosystem.</p>
              <p>Then KINU appeared.</p>
              <p>He didn&apos;t come to replace NINU. He came because he had followed the scent.</p>
              <p>One dog found the way. The other followed.</p>
              <p>And from that moment, the pack began to form.</p>
            </div>
            <div className="panel">
              <div className="eyebrow">THE LINE</div>
              <div className="quote">
                NINU found the way.
                <br />
                <span>KINU followed.</span>
              </div>
              <div className="quote-sub">Two dogs. One NEAR. Different paths, same sky. The pack is the culture.</div>
            </div>
          </div>
          <div className="lore-art">
            <img src="/site/kinu-banner.jpg" alt="KINU and NINU — The Dog That Followed" loading="lazy" />
          </div>
          <div className="cinematic-gallery">
            <figure>
              <img src="/site/kinu-guardian.jpg" alt="KINU guardian under the neon moon" loading="lazy" />
              <figcaption>THE GUARDIAN</figcaption>
            </figure>
            <figure>
              <img src="/site/kinu-valley.jpg" alt="KINU in the NEAR valley" loading="lazy" />
              <figcaption>THE VALLEY</figcaption>
            </figure>
          </div>
        </section>

        <section id="culture">
          <div className="section-head">
            <div>
              <div className="eyebrow">CULTURE</div>
              <h2>No roadmap.</h2>
            </div>
            <p>KINU isn&apos;t here to sell a future. KINU is here to enjoy the present.</p>
          </div>
          <div className="culture-grid">
            <div className="feature">
              <h3>🐕 No Roadmap</h3>
              <p>
                No fake milestones. No corporate promises. No &ldquo;quarter four vision.&rdquo; We are here to make memes, have fun, and
                let the community write the story.
              </p>
            </div>
            <div className="feature">
              <h3>⚡ Pure Culture</h3>
              <p>NINU × KINU. NEAR × dogs. Community × memes. That&apos;s the meta. Everything else is just noise.</p>
            </div>
          </div>
          <div className="culture-banner">
            <div className="eyebrow">THE MOTTO</div>
            <div className="culture-big">
              JUST FUN
              <br />
              <em>FOR THE CULTURE.</em>
            </div>
          </div>
        </section>

        <section id="community" className="community">
          <div className="community-box">
            <div className="eyebrow">THE NEAR DOG PACK</div>
            <h2>THE PACK IS FORMING.</h2>
            <p>Bring the memes. Bring the energy. Bring your friends.</p>
            <div className="links">
              <Link className="link link--app" to={APP_PATH}>
                ⇄ LAUNCH THE KINU TERMINAL ↗
              </Link>
              <a className="link" href={X_URL} {...ext}>
                𝕏 X — @KINUonNEAR ↗
              </a>
              <a className="link" href={NEARLY_URL} {...ext}>
                Ⓝ VIEW $KINU ON NEARLY ↗
              </a>
              <a className="link" href={CHART_URL} {...ext}>
                ◫ VIEW CHART ↗
              </a>
              <span className="link">✈ TELEGRAM — SOON</span>
            </div>
          </div>
        </section>

        <footer>
          <div className="footerline">
            <div>
              <strong>KINU</strong> — The Dog That Followed. Liquidity &amp; routing by Rhea Finance · Non-custodial.
            </div>
            <div>1B SUPPLY · 20% CREATOR · 20% BUYBACK &amp; BURN · 60% HOLDERS</div>
          </div>
        </footer>
      </div>
    </div>
  );
}
