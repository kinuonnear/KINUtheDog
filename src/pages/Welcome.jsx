// The public landing page (kinudefi.com/): what KINU is, the LP tools it gives you, the tokens the
// best Rhea LPs are in right now, how to start, how your funds stay yours, and $KINU.
// Live numbers come from the same sources as the app (Rhea's pool search, the Smart LP board,
// Intear); the Smart money section only loads when it scrolls into view.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, poolPath } from '../router.jsx';
import { useAsync } from '../hooks.js';
import { fetchTokenInfo } from '../lib/intear.js';
import { searchPools } from '../lib/rhea.js';
import { getToken } from '../lib/tokens.js';
import { enrichTokens } from '../lib/trending.js';
import { FEATURED, loadSmartLps } from '../lib/smartMoney.js';
import { formatPrice, formatUsd } from '../lib/format.js';
import { CONTRACTS, FEE_SUMMARY, INTEAR_FEE, NATIVE_NEAR } from '../config.js';
import { loadBoard } from '../components/SmartLp.jsx';
import { CopyButton, TokenIcon } from '../components/ui.jsx';
import { AgentBot } from '../components/AgentBot.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import { pauseWhenOffscreen } from '../lib/pauseOffscreen.js';
import '../landing.css';

const KINU = 'kinu-3.nearlytrade.near';
const RHEA = 'token.rhealab.near';
const KINU_RHEA_POOL = `${KINU}|${RHEA}|10000`;
const X_URL = 'https://x.com/KINUonNEAR';
const NEARLY_URL = `https://nearly.trade/${KINU}`;
const CHART_URL = `https://dexscreener.com/near/refv2-${KINU}:${RHEA}:10000`;
const BUY_PATH = `/swap?from=${RHEA}&to=${KINU}`;
const APP_PATH = '/app';
const AGENT_PATH = '/agent';
const SMART_LP_PATH = '/discover?tab=smartlp';
const SMART_MONEY_PATH = '/discover?tab=smartmoney';
const EMBLEM = '/site/kinu-emblem.svg';
const ext = { target: '_blank', rel: 'noopener noreferrer' };
const K = { compactAbove: 1e4 };

const TRUST = ['Non-custodial', 'You sign every transaction', 'LP co-pilot', 'Built on NEAR', 'Live on-chain PnL', 'Transaction guard', INTEAR_FEE.live ? 'Fees shown before you sign' : 'No platform fee'];

// The closing timeline: how to start, in four words each.
const START = [
  ['Connect', 'your wallet'],
  ['Pick a pool', 'that pays'],
  ['Deposit', 'or zap in with one token'],
  ['Track', 'and compound']
];
const WALLETS = ['Meteor', 'HOT', 'Intear', 'MyNEAR'];

// Small line icons for the four security points.
const svg = (children) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const SAFETY_ICONS = [
  svg(
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8-8M16 7l3 3M14 9l2 2" />
    </>
  ),
  svg(<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3zM9 12l2 2 4-4" />),
  svg(<path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12" />),
  svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M8 16L16 8" />
    </>
  )
];

const SAFETY = [
  ['Non-custodial', 'Your funds stay in your wallet. Nothing moves until you sign it.'],
  ['Transaction guard', 'Every request is checked before your wallet sees it: tokens only go to the DEX contracts (Rhea, Intear DEX) and swap output comes back to you.'],
  ['Open source', 'The code that builds your transactions is public. Read it, verify it.'],
  INTEAR_FEE.live ? ['Clear fees', FEE_SUMMARY] : ['No platform fee', 'KINU adds nothing on top. You pay the pool fee and network gas, and that’s all.']
];

/** True once the element has scrolled into view (then stays true). */
function useInView(ref) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return undefined;
    }
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/* ------------------------------------------------------------------ */
/* Product: Find → Enter → Manage (sticky stages, bento of the real UI) */
/* ------------------------------------------------------------------ */

// An area chart from a list of values (0..1), drawn into a 300×100 box.
function areaPath(values) {
  const step = 300 / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(100 - v * 88 - 6).toFixed(1)}`);
  return { line: `M${pts.join(' L')}`, area: `M0,100 L${pts.join(' L')} L300,100 Z` };
}

function AreaChart({ values, id }) {
  const { line, area } = areaPath(values);
  return (
    <svg className="lx-area" viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8fd3a8" stopOpacity="0.32" />
          <stop offset="1" stopColor="#8fd3a8" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} className="lx-area__line" />
    </svg>
  );
}

function ShowSmartLp() {
  return (
    <div className="lx-show lx-show--smartlp">
      <div className="lx-show__stats">
        {[
          ['Win rate', '68.7%', 'up'],
          ['Fees earned', '$1.41K'],
          ['Total PnL', '+$441', 'up'],
          ['Avg hold', '28h']
        ].map(([label, value, tone]) => (
          <span key={label}>
            <small>{label}</small>
            <b className={tone}>{value}</b>
          </span>
        ))}
      </div>
      <AreaChart id="lx-g-slp" values={[0.08, 0.12, 0.1, 0.22, 0.2, 0.34, 0.3, 0.46, 0.52, 0.48, 0.64, 0.7, 0.68, 0.84, 0.92]} />
      <div className="lx-show__tags">
        <i>Fee earner</i>
        <i>Tight ranges</i>
        <i>Active this week</i>
      </div>
    </div>
  );
}

function ShowYields() {
  const rows = [
    ['QTC / NEAR', '1.91%', 'calm'],
    ['NEARLY / NEAR', '1.42%', 'moving'],
    ['RHEA / NEAR', '0.88%', 'calm'],
    ['BATMAN / NEAR', '0.74%', 'moving'],
    ['USDC / NEAR', '0.31%', 'calm']
  ];
  return (
    <div className="lx-show lx-show--rows">
      <span className="lx-show__head">
        <small>Pool</small>
        <small>Fees / TVL · 24h</small>
      </span>
      {rows.map(([pair, y, s]) => (
        <span key={pair}>
          <b>{pair}</b>
          <em>{y}</em>
          <i className={`lx-chip lx-chip--${s}`}>{s}</i>
        </span>
      ))}
    </div>
  );
}

// Liquidity by price, as on the CLMM chart: bars, the chosen range, and the current price.
const DEPTH = [6, 8, 7, 10, 12, 15, 14, 18, 24, 30, 38, 46, 58, 70, 82, 76, 64, 52, 44, 36, 28, 22, 18, 14, 12, 9, 8, 6];
const RANGE = [9, 19];
const NOW = 14;

function ShowRange() {
  const max = Math.max(...DEPTH);
  return (
    <div className="lx-show lx-show--range">
      <div className="lx-show__modes">
        <b>Spot</b>
        <span>Curve</span>
        <span>Bid-Ask</span>
      </div>
      <div className="lx-depth">
        {DEPTH.map((v, i) => (
          <i key={i} className={i >= RANGE[0] && i <= RANGE[1] ? 'in' : ''} style={{ height: `${(v / max) * 100}%` }} />
        ))}
        <span className="lx-depth__band" style={{ left: `${(RANGE[0] / DEPTH.length) * 100}%`, width: `${((RANGE[1] - RANGE[0] + 1) / DEPTH.length) * 100}%` }}>
          <u>Min</u>
          <u>Max</u>
        </span>
        <span className="lx-depth__now" style={{ left: `${((NOW + 0.5) / DEPTH.length) * 100}%` }} />
      </div>
      <div className="lx-show__prices">
        <span>
          <small>Min price</small>
          <b>0.0000041</b>
        </span>
        <span>
          <small>Current</small>
          <b className="now">0.0000052</b>
        </span>
        <span>
          <small>Max price</small>
          <b>0.0000067</b>
        </span>
      </div>
    </div>
  );
}

function ShowZap() {
  return (
    <div className="lx-show lx-show--zap">
      <span className="lx-zap__in">
        <small>You deposit</small>
        <b>10 NEAR</b>
      </span>
      <svg className="lx-zap__split" viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 30 C 40 30, 50 8, 100 8" />
        <path d="M0 30 C 40 30, 50 52, 100 52" />
      </svg>
      <span className="lx-zap__out">
        <span>
          <small>NEAR</small>
          <b>5.02</b>
        </span>
        <span>
          <small>KINU</small>
          <b>1.19M</b>
        </span>
      </span>
      <em className="lx-zap__sig">One signature</em>
    </div>
  );
}

function ShowRebalance() {
  return (
    <div className="lx-show lx-show--rebalance">
      <div className="lx-reb">
        <small>Out of range</small>
        <span className="lx-range lx-range--out">
          <i className="lx-range__fill" />
          <i className="lx-range__now" />
        </span>
      </div>
      <div className="lx-reb">
        <small className="up">Re-centered</small>
        <span className="lx-range">
          <i className="lx-range__fill" />
          <i className="lx-range__now" />
        </span>
      </div>
      <div className="lx-show__actions">
        <i>⟲ Rebalance</i>
        <i>↻ Compound $12.40</i>
      </div>
    </div>
  );
}

function ShowPnl() {
  return (
    <div className="lx-show lx-show--pnl">
      <div className="lx-show__stats">
        {[
          ['Realized', '+$96.20', 'up'],
          ['Unrealized', '+$41.80', 'up'],
          ['Fees', '$34.60']
        ].map(([label, value, tone]) => (
          <span key={label}>
            <small>{label}</small>
            <b className={tone}>{value}</b>
          </span>
        ))}
      </div>
      <AreaChart id="lx-g-pnl" values={[0.1, 0.16, 0.13, 0.2, 0.28, 0.25, 0.36, 0.42, 0.4, 0.5, 0.58, 0.55, 0.66, 0.74, 0.8, 0.9]} />
    </div>
  );
}

// Each stage: its name, a line for the sticky list, and its cards (title, text, link, visual, wide?).
const STAGES = [
  [
    'Find',
    'See where fees are earned, and who is earning them.',
    [
      ['Smart LP', 'The wallets that actually earn as LPs: PnL, fees and win rate, read on-chain.', SMART_LP_PATH, ShowSmartLp, true],
      ['Top Yields', 'The pools that paid LPs the most, next to how far the price moved.', '/discover?tab=lp', ShowYields]
    ]
  ],
  [
    'Enter',
    'Draw your range on the chart, or zap in with a single token.',
    [
      ['Zap in / Zap out', 'Enter or leave a pool with one token. KINU splits it for you.', '/pools', ShowZap],
      ['Set your range', 'Drag Min and Max over the pool’s real liquidity. Spot, Curve or Bid-Ask.', '/pools', ShowRange, true]
    ]
  ],
  [
    'Manage',
    'Re-center, compound, and know exactly where you stand.',
    [
      ['Portfolio PnL', 'Every position valued at what you paid: realized, unrealized and fees.', '/portfolio', ShowPnl, true],
      ['Rebalance & Compound', 'Out of range? Re-center it. Fees waiting? Put them back to work.', '/portfolio', ShowRebalance]
    ]
  ]
];

function ProductStory() {
  const groups = useRef([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    // The stage whose cards cross the middle of the screen is the active one.
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(Number(e.target.dataset.stage))),
      { rootMargin: '-45% 0px -45% 0px' }
    );
    groups.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="lx-story">
      <aside className="lx-story__side">
        <span className="lx-kicker lx-kicker--plain">Product</span>
        <h2>
          One place. <em>Every LP move.</em>
        </h2>
        <ol className="lx-story__stages">
          {STAGES.map(([name, line], i) => (
            <li key={name} className={i === active ? 'is-active' : ''}>
              <button type="button" onClick={() => groups.current[i]?.scrollIntoView({ block: 'center' })}>
                <small>0{i + 1}</small>
                <b>{name}</b>
                <span>{line}</span>
              </button>
            </li>
          ))}
        </ol>
      </aside>
      <div className="lx-story__main">
        {STAGES.map(([name, line, cards], i) => (
          <div key={name} className="lx-bento" data-stage={i} ref={(el) => (groups.current[i] = el)}>
            <span className="lx-bento__label">
              <small>0{i + 1}</small> {name} <em>{line}</em>
            </span>
            {cards.map(([title, text, to, Show, wide]) => (
              <Link key={title} to={to} className={`lx-card${wide ? ' lx-card--wide' : ''}`}>
                <Show />
                <h3>{title}</h3>
                <p>{text}</p>
                <span className="lx-feature__go">Open →</span>
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* KINU Agent: the LP co-pilot, with example calls                      */
/* ------------------------------------------------------------------ */

// Example calls only (the real ones come from live data on /agent). The verdicts and what they
// mean are the agent's own; the pools and numbers here are illustrations.
const AGENT_PERSONAS = [
  {
    key: 'guardian',
    name: 'Guardian',
    icon: '◈',
    tagline: 'Steady fees, low risk',
    calls: [
      ['HOLD', 'USDC / NEAR', 'In range, and fees cover the swing 3.1×.'],
      ['COMPOUND', 'RHEA / NEAR', '$12.40 in unclaimed fees, worth putting back to work.'],
      ['WATCH', 'QTC / NEAR', 'Price is 8% from the edge of your range.'],
      ['AVOID', 'A new meme pool', '900% APR, but fees lose to the swing.']
    ]
  },
  {
    key: 'hunter',
    name: 'Hunter',
    icon: '◎',
    tagline: 'High yield, eyes open',
    calls: [
      ['ENTER · CONSIDER', 'QTC / NEAR', 'Fees beat the 24h swing, and the pool fits the persona.'],
      ['REBALANCE', 'NEARLY / NEAR', 'Out of range: earning nothing until it is moved.'],
      ['COMPOUND', 'BATMAN / NEAR', '$31.80 waiting to be reinvested.'],
      ['AVOID', 'A 2-hour-old pool', 'Thin liquidity, and fees lose to the swing.']
    ]
  },
  {
    key: 'surfer',
    name: 'Surfer',
    icon: '≋',
    tagline: 'Rides the volume',
    calls: [
      ['ENTER · CONSIDER', 'USDC / NEAR', 'Volume up 2.4× today, fees follow.'],
      ['HOLD', 'RHEA / NEAR', 'Still in range while the volume lasts.'],
      ['WATCH', 'KINU / NEAR', 'Volume cooling: fee coverage is slipping.'],
      ['REBALANCE', 'QTC / NEAR', 'Price ran past your range.']
    ]
  }
];

const AGENT_POINTS = [
  ['Reads, never holds', 'Public data only. No keys, no deposits, no custody.'],
  ['Explains every call', 'Rules on live data, with the reason shown. No black box.'],
  ['You decide, you sign', 'Each suggestion opens the normal KINU flow in your wallet.']
];

function AgentShowcase() {
  const ref = useRef(null);
  const [on, setOn] = useState(false);
  const [persona, setPersona] = useState(0);
  const [tick, setTick] = useState(0);
  const calls = AGENT_PERSONAS[persona].calls;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setOn(true);
      return undefined;
    }
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: '100px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // A new call lands every 1.6 s; after the last one the feed rests a moment, then scans again.
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1600);
    return () => clearInterval(t);
  }, [on]);
  useEffect(() => setTick(0), [persona]);

  const cycle = calls.length + 2;
  const shown = Math.min(calls.length, (tick % cycle) + 1);
  const scanning = tick % cycle >= calls.length;

  return (
    <div className="lx-agent">
      <div className="lx-agent__console" ref={ref}>
        <div className="lx-agent__top">
          <AgentBot scanning={scanning} />
          <div>
            <b>KINU Agent</b>
            <small className={scanning ? 'is-scanning' : ''}>
              <i /> {scanning ? 'Scanning 60 Rhea pools…' : `${shown} call${shown === 1 ? '' : 's'} · persona ${AGENT_PERSONAS[persona].name}`}
            </small>
          </div>
        </div>
        <div className="lx-agent__personas" role="tablist" aria-label="Agent persona">
          {AGENT_PERSONAS.map((p, i) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={i === persona}
              className={i === persona ? 'is-on' : ''}
              onClick={() => setPersona(i)}
            >
              <span aria-hidden="true">{p.icon}</span>
              <b>{p.name}</b>
              <small>{p.tagline}</small>
            </button>
          ))}
        </div>
        <ul className="lx-agent__feed" aria-live="polite">
          {calls.slice(0, shown).map(([verdict, pool, reason]) => (
            <li key={`${persona}-${verdict}-${pool}`}>
              <span className={`ag-verdict ag-verdict--${verdict.split(' ')[0].toLowerCase()}`}>{verdict}</span>
              <span>
                <b>{pool}</b>
                <small>{reason}</small>
              </span>
            </li>
          ))}
        </ul>
        <p className="lx-agent__note">Example calls. The live agent reads real pools and your own positions.</p>
      </div>

      <div className="lx-agent__copy">
        <span className="lx-kicker lx-kicker--plain">KINU Agent</span>
        <h2>
          Your LP co-pilot. <em>Always watching.</em>
        </h2>
        <p>
          While it’s open, the agent scans Rhea’s 60 most active pools and your own positions every 90 seconds, then tells you what it
          sees: hold, compound, rebalance, or stay away. Every call comes with its reason.
        </p>
        <ul className="lx-agent__points">
          {AGENT_POINTS.map(([title, text]) => (
            <li key={title}>
              <i aria-hidden="true">✓</i>
              <span>
                <b>{title}</b>
                <small>{text}</small>
              </span>
            </li>
          ))}
        </ul>
        <Link className="lx-btn lx-btn--primary" to={AGENT_PATH}>
          Meet the agent →
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Markets: three lanes of tokens, and a swap that keeps changing pairs */
/* ------------------------------------------------------------------ */

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const ETH = 'eth.bridge.near';
const BTC = 'btc.omft.near';
const SOL = 'sol.omft.near';
const ZEC = 'zec.omft.near';
const QTC = 'qtc.omft.near';
const NEARLY = 'nearly-993927.nearlytrade.near';
const BATMAN = 'batman-4.nearlytrade.near';
const WNEAR = CONTRACTS.wrapNear;

const FIELD_TOKENS = [
  WNEAR,
  USDC,
  RHEA,
  KINU,
  NEARLY,
  ETH,
  QTC,
  BTC,
  BATMAN,
  'usdt.tether-token.near',
  SOL,
  ZEC,
  'meta-pool.near',
  'linear-protocol.near',
  'dragon-3.nearlytrade.near',
  'token.0xshitzu.near',
  'token.intear.near',
  'blackdragon.tkn.near',
  'jambo-1679.meme-cooking.near',
  'ninu-4.nearlytrade.near',
  'diarhea.nearlytrade.near',
  '1f9840a85d5af5bf1d1762f925bdaddc4201f984.factory.bridge.near', // UNI
  '514910771af9ca656af840dff83e8264ecf986ca.factory.bridge.near', // LINK
  'aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near', // AURORA
  '2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near', // WBTC
  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near', // DAI
  'xrp.omft.near',
  'sui.omft.near',
  'token.v2.ref-finance.near',
  'token.burrow.near',
  'token.sweat',
  'game.hot.tg',
  'ftv2.nekotoken.near',
  'token.lonkingnearbackto2024.near',
  'mpdao-token.near',
  'f5cfbc74057c610c8ef151a439252680ac68c6dc.factory.bridge.near', // OCT
  'purge-558.meme-cooking.near',
  'gear.enleap.near',
  'd9c2d319cd7e6177336b0a9c93c21cb48d84fb54.factory.bridge.near', // HAPI
  'intel.tkn.near'
];

const PAIRS = [
  [WNEAR, KINU],
  [USDC, ETH],
  [RHEA, NEARLY],
  [BTC, USDC],
  [WNEAR, BATMAN],
  [QTC, WNEAR],
  [SOL, USDC],
  [ZEC, WNEAR]
];

// Three lanes of tokens: the top and bottom run right to left, the middle left to right, behind the
// swap card. Each lane fades in and out of the dark at both ends.
const LANES = [0, 1, 2].map((lane) => FIELD_TOKENS.filter((_, i) => i % 3 === lane));

const swapSide = (id) => (id === WNEAR ? NATIVE_NEAR.id : id);

function Markets({ pools }) {
  const ref = useRef(null);
  const [on, setOn] = useState(false);
  const [pair, setPair] = useState(0);
  const [meta, setMeta] = useState(() => new Map());
  const tokenOf = (id) => (id === WNEAR ? NATIVE_NEAR : meta.get(id) || { id, symbol: '…' });

  // Token metadata starts loading well before the section is reached; each token joins the field as
  // soon as its own metadata arrives (it is cached for the next visit).
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let alive = true;
    const load = () =>
      FIELD_TOKENS.forEach((id) =>
        (id === WNEAR ? Promise.resolve(NATIVE_NEAR) : getToken(id)).then((t) => alive && t && setMeta((prev) => new Map(prev).set(id, t)))
      );
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        alive = false;
      };
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        load();
      },
      { rootMargin: '1500px 0px' }
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, []);

  // Animate only while the section is on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setOn(true);
      return undefined;
    }
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: '100px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setPair((p) => (p + 1) % PAIRS.length), 2600);
    return () => clearInterval(t);
  }, [on]);

  const [from, to] = PAIRS[pair];
  return (
    <div className="lx-markets">
      <div className="lx-head lx-head--center">
        <span className="lx-kicker lx-kicker--plain">Markets</span>
        <h2>
          Trade anything. <em>Pair everything.</em>
        </h2>
        <p>
          Stables, majors and memes, all on NEAR. Swap any token on the best route across Rhea and Intear DEX, or provide liquidity to any pair.
        </p>
      </div>

      <div className={`lx-field${on ? ' is-on' : ''}`} ref={ref}>
        <div className="lx-lanes" aria-hidden="true">
          {LANES.map((lane, i) => {
            const chips = (copy) =>
              lane
                .filter((id) => meta.has(id))
                .map((id) => (
                  <span key={`${copy}-${id}`} className="lx-field__token">
                    <TokenIcon token={tokenOf(id)} size={44} />
                    <b>{tokenOf(id).symbol}</b>
                  </span>
                ));
            return (
              <div key={i} className={`lx-lane lx-lane--${i === 1 ? 'right' : 'left'}`}>
                <div className="lx-lane__track">
                  <div className="lx-lane__set">{chips(0)}</div>
                  <div className="lx-lane__set">{chips(1)}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="lx-swapcard">
          <small>Swap</small>
          <div className="lx-swapcard__pair" key={pair}>
            <span>
              <TokenIcon token={tokenOf(from)} size={30} />
              <b>{tokenOf(from).symbol}</b>
            </span>
            <i aria-hidden="true">⇄</i>
            <span>
              <TokenIcon token={tokenOf(to)} size={30} />
              <b>{tokenOf(to).symbol}</b>
            </span>
          </div>
          <Link className="lx-btn lx-btn--primary lx-btn--sm" to={`/swap?from=${swapSide(from)}&to=${swapSide(to)}`}>
            Swap this pair
          </Link>
        </div>
      </div>

      <div className="lx-markets__foot">
        <span>
          <b>{pools ? pools.toLocaleString() : '—'}</b> pools on NEAR
        </span>
        <span>
          <b>Best route</b> Rhea + Intear DEX, compared live
        </span>
        <span>
          <b>Any token</b> paste a contract to trade it
        </span>
        <div className="lx-markets__cta">
          <Link className="lx-btn lx-btn--ghost lx-btn--sm" to="/swap">
            Open swap
          </Link>
          <Link className="lx-btn lx-btn--ghost lx-btn--sm" to="/pools">
            Browse pools
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hero: flow lines and the app preview                                 */
/* ------------------------------------------------------------------ */

const MAIN_TOKENS = FEATURED[0][1];
const NO_LPS = { lps: [], profitable: [], valueUsd: 0 };
const KS = { compactAbove: 1e3 };

/** A steady colour per wallet, for its avatar (as in the app). */
function hue(account) {
  let h = 0;
  for (let i = 0; i < account.length; i += 1) h = (h * 31 + account.charCodeAt(i)) % 360;
  return h;
}

function Change({ value }) {
  if (!Number.isFinite(value)) return null;
  return (
    <small className={value > 0 ? 'up' : value < 0 ? 'down' : ''}>
      {value > 0 ? '+' : ''}
      {value.toFixed(1)}%
    </small>
  );
}

/** A window onto the real app: Smart Money In, the Main tokens in their set order, live. */
function AppPreview({ board }) {
  const ref = useRef(null);
  const visible = useInView(ref);
  const market = useAsync(() => enrichTokens(MAIN_TOKENS), [], { enabled: visible });
  const lps = useAsync(() => loadSmartLps(board), [board?.generatedAt], { enabled: visible && Boolean(board) });
  const rows = useMemo(() => {
    if (!market.data) return null;
    const byId = new Map(market.data.map((m) => [m.id, m]));
    return MAIN_TOKENS.map((id) => byId.get(id))
      .filter(Boolean)
      .map((m) => (m.id === CONTRACTS.wrapNear ? { ...m, token: { ...m.token, symbol: 'NEAR', icon: NATIVE_NEAR.icon || m.token.icon } } : m));
  }, [market.data]);

  return (
    <div className={`lx-preview${visible ? ' is-in' : ''}`} ref={ref}>
      <div className="lx-preview__bar">
        <span className="lx-preview__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="lx-preview__url">kinudefi.com/discover</span>
        <Link className="lx-preview__open" to={SMART_MONEY_PATH}>
          Open ↗
        </Link>
      </div>
      <div className="lx-preview__tabs">
        <span>Top Yields</span>
        <span>Smart LP</span>
        <b>Smart Money In</b>
      </div>
      <div className="lx-preview__table" role="table" aria-label="Smart Money In: where the Smart LPs hold liquidity">
        <div className="lx-preview__row lx-preview__row--head" role="row">
          <span>Token</span>
          <span>Price 24h</span>
          <span className="lx-hide-sm">Liquidity</span>
          <span className="lx-hide-sm">Vol 24h</span>
          <span>Smart LPs</span>
          <span className="lx-hide-md">Smart LP value</span>
        </div>
        {(rows || MAIN_TOKENS.map(() => null)).map((m, i) => {
          if (!m)
            return (
              <div key={i} className="lx-preview__row" role="row">
                <i className="lx-skel" />
              </div>
            );
          const smart = lps.data?.get(m.id) || NO_LPS;
          const ours = m.id === KINU;
          return (
            <Link key={m.id} to={SMART_MONEY_PATH} className={`lx-preview__row${ours ? ' lx-preview__row--ours' : ''}`} role="row">
              <span className="lx-preview__wallet">
                <TokenIcon token={m.token} size={28} />
                <span>
                  <b>
                    {m.token.symbol}
                    {ours && <em className="lx-ours">Our token</em>}
                  </b>
                  <small>{m.id}</small>
                </span>
              </span>
              <span className="lx-preview__price">
                {m.price ? formatPrice(m.price) : '—'}
                <Change value={m.change24h} />
              </span>
              <span className="lx-hide-sm">{m.liquidityUsd ? formatUsd(m.liquidityUsd, KS) : '—'}</span>
              <span className="lx-hide-sm">{m.volume24hUsd ? formatUsd(m.volume24hUsd, KS) : '—'}</span>
              <span className="lx-preview__lps">
                {!lps.data ? (
                  <i className="lx-skel" />
                ) : smart.lps.length ? (
                  <>
                    <span className="lx-avatars" aria-hidden="true">
                      {smart.lps.slice(0, 3).map((a) => (
                        <u key={a} style={{ '--h': hue(a) }}>
                          {a.replace(/[^a-z0-9]/gi, '').slice(0, 1).toUpperCase()}
                        </u>
                      ))}
                    </span>
                    <b>{smart.lps.length}</b>
                    {smart.profitable.length > 0 && <small className="lx-star">★{smart.profitable.length}</small>}
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span className="lx-hide-md">{smart.valueUsd > 0 ? formatUsd(smart.valueUsd, KS) : '—'}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function Welcome() {
  const [menuOpen, setMenuOpen] = useState(false);
  // Each section's animations (feeds, tickers, the agent's radar…) rest while it is off screen.
  const pageRef = useRef(null);
  useEffect(() => pauseWhenOffscreen(pageRef.current?.querySelectorAll('.lx-hero, .lx-section, .lx-final') || []), []);
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.scrollBehavior;
    root.style.scrollBehavior = 'smooth';
    return () => {
      root.style.scrollBehavior = before;
    };
  }, []);

  // Hero numbers: Rhea's 100 most traded pools (volume) and the pool count; the Smart LP board.
  const pools = useAsync(() => searchPools({ sort: 'volume_24h', limit: 100 }), [], { refreshMs: 120_000 });
  const volume = pools.data?.list.reduce((s, p) => s + p.volume24h, 0);
  const board = useAsync(loadBoard, []);
  const kinu = useAsync(() => fetchTokenInfo(KINU), [], { refreshMs: 120_000 });

  const stats = [
    ['Pools tracked', pools.data ? pools.data.total.toLocaleString() : null],
    ['24h volume', volume !== undefined ? formatUsd(volume, K) : null],
    ['Smart LP wallets', board.data ? board.data.wallets.length.toLocaleString() : null]
  ];

  return (
    <div className="lx" ref={pageRef}>
      <div className="lx-aurora" aria-hidden="true">
        <i className="lx-aurora__a" />
        <i className="lx-aurora__b" />
        <i className="lx-aurora__c" />
      </div>

      <header className="lx-nav-wrap">
        <nav className="lx-nav">
          <a className="lx-brand" href="#top">
            <img src={EMBLEM} alt="" width="28" height="28" />
            <span>KINU</span>
          </a>
          <div className={`lx-nav__links${menuOpen ? ' is-open' : ''}`} onClick={() => setMenuOpen(false)}>
            <a href="#product">Product</a>
            <a href="#agent">Agent</a>
            <a href="#markets">Markets</a>
            <a href="#security">Security</a>
            <a href="#token">$KINU</a>
            <Link to="/docs">Docs</Link>
          </div>
          <div className="lx-nav__end">
            <Link className="lx-btn lx-btn--primary lx-btn--sm" to={APP_PATH}>
              Launch app
            </Link>
            <button
              type="button"
              className="lx-nav__toggle"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span aria-hidden="true">{menuOpen ? '×' : '☰'}</span>
            </button>
          </div>
        </nav>
      </header>

      <main>
        <section className="lx-hero" id="top">
          <FlowLines />
          <div className="lx-hero__glow" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="lx-kicker">
            <i /> Manage liquidity made simple · Built on NEAR
          </div>
          <h1 className="lx-hero__title">
            Liquidity, with a <em>sense of direction.</em>
          </h1>
          <p className="lx-hero__sub">Earn where liquidity actually works.</p>
          <p className="lx-hero__text">
            KINU finds the pools that pay, shows you the LPs who are winning, and gets you in with one click. Non-custodial, on
            NEAR.
          </p>
          <div className="lx-hero__cta">
            <Link className="lx-btn lx-btn--primary" to={APP_PATH}>
              Launch app
            </Link>
            <Link className="lx-btn lx-btn--ghost" to={SMART_LP_PATH}>
              Explore Smart LP
            </Link>
          </div>
          <dl className="lx-stats">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value ?? <i className="lx-skel" />}</dd>
              </div>
            ))}
          </dl>
          <AppPreview board={board.data} />
        </section>

        <div className="lx-marquee" aria-label="Why it’s safe to use">
          <div className="lx-marquee__track">
            {[0, 1].map((copy) => (
              <div className="lx-marquee__set" key={copy} aria-hidden={copy ? 'true' : undefined}>
                {TRUST.map((t) => (
                  <span key={t}>
                    <i>✓</i> {t}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>

        <section className="lx-section" id="product">
          <ProductStory />
        </section>

        <section className="lx-section" id="agent">
          <AgentShowcase />
        </section>

        <section className="lx-section" id="markets">
          <Markets pools={pools.data?.total} />
        </section>

        <section className="lx-section" id="security">
          <div className="lx-head lx-head--row">
            <div>
              <span className="lx-kicker lx-kicker--plain">Security</span>
              <h2>
                Your keys. Your signature. <em>Every time.</em>
              </h2>
            </div>
            <Link className="lx-btn lx-btn--ghost" to="/security">
              Security &amp; transparency →
            </Link>
          </div>
          <div className="lx-safety">
            {SAFETY.map(([title, text], i) => (
              <div key={title}>
                <span className="lx-safety__icon" aria-hidden>
                  {SAFETY_ICONS[i]}
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lx-section lx-token" id="token">
          <div className="lx-token__copy">
            <span className="lx-kicker lx-kicker--plain">$KINU</span>
            <h2>
              The dog that <em>follows the flow.</em>
            </h2>
            <p>
              KINU started as a community dog on NEAR and grew a working product around it. $KINU is the pack’s token, fair
              launched on Nearly and paired with RHEA, and the pack keeps building in the open.
            </p>
            <div className="lx-contract">
              <span>Contract</span>
              <code>{KINU}</code>
              <CopyButton text={KINU} label="Copy" />
            </div>
            <dl className="lx-token__stats">
              <div>
                <dt>Price</dt>
                <dd>{kinu.data?.price ? formatPrice(kinu.data.price) : '—'}</dd>
              </div>
              <div>
                <dt>Holders</dt>
                <dd>{kinu.data?.holders ? kinu.data.holders.toLocaleString() : '—'}</dd>
              </div>
              <div>
                <dt>Pool</dt>
                <dd>
                  <Link to={poolPath(KINU_RHEA_POOL)}>KINU / RHEA</Link>
                </dd>
              </div>
            </dl>
            <div className="lx-hero__cta">
              <Link className="lx-btn lx-btn--primary" to={BUY_PATH}>
                Buy $KINU
              </Link>
              <a className="lx-btn lx-btn--ghost" href={X_URL} {...ext}>
                Join the pack ↗
              </a>
            </div>
          </div>
          <div className="lx-token__art" aria-hidden="true">
            <img src={EMBLEM} alt="" width="512" height="512" />
          </div>
        </section>

        <section className="lx-final">
          <h2>
            The flow is already moving. <em>Follow it.</em>
          </h2>
          <ol className="lx-start">
            {START.map(([title, text], i) => (
              <li key={title} style={{ '--i': i }}>
                <i aria-hidden="true" />
                <b>{title}</b>
                <small>{text}</small>
              </li>
            ))}
          </ol>
          <div className="lx-wallets">
            <small>Works with</small>
            {WALLETS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <Link className="lx-btn lx-btn--primary" to={APP_PATH}>
            Launch app
          </Link>
        </section>
      </main>

      <footer className="lx-footer">
        <div className="lx-footer__grid">
          <div className="lx-footer__brand">
            <a className="lx-brand" href="#top">
              <img src={EMBLEM} alt="" width="28" height="28" />
              <span>KINU</span>
            </a>
            <p>Liquidity, with a sense of direction. Built on NEAR.</p>
          </div>
          <div>
            <h4>Product</h4>
            <Link to={APP_PATH}>App</Link>
            <Link to="/swap">Swap</Link>
            <Link to="/pools">Pools</Link>
            <Link to={SMART_LP_PATH}>Smart LP</Link>
            <Link to="/portfolio">Portfolio</Link>
          </div>
          <div>
            <h4>Resources</h4>
            <Link to="/docs">Docs</Link>
            <Link to="/docs/whitepaper">Whitepaper</Link>
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
          </div>
        </div>
        <div className="lx-footer__legal">
          <span>© 2026 KINU. Liquidity and routing by Rhea Finance and Intear DEX.</span>
          <span>Non-custodial software. DeFi carries risk, including loss of funds. Not financial advice.</span>
        </div>
      </footer>
    </div>
  );
}

