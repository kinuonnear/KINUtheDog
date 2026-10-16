// "How to start LP?" — a beginner's guide to providing liquidity on KINU (Rhea pools on NEAR):
// what LP-ing is, a step-by-step walkthrough of the KINU flow, the pool types, the risks and a FAQ.

import { useMemo } from 'react';
import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { searchPools } from '../lib/rhea.js';
import { formatUsd } from '../lib/format.js';
import { Skeleton } from '../components/ui.jsx';

const WHY = [
  {
    icon: '◈',
    title: 'Put idle tokens to work',
    text: 'Tokens sitting in a wallet earn nothing. In a pool they earn a share of every swap that passes through it.'
  },
  {
    icon: '⟳',
    title: 'Earn from every trade',
    text: 'Traders pay a small fee on each swap. That fee goes to the liquidity providers, in proportion to their share of the pool.'
  },
  {
    icon: '◎',
    title: 'Stay in control',
    text: 'Your liquidity stays yours. Add, rebalance, compound or withdraw at any time — every action is signed by your own wallet.'
  }
];

const STEPS = [
  {
    title: 'Connect your NEAR wallet',
    text: 'Press Connect wallet in the top bar and pick your wallet (Meteor, Intear, HOT and more). KINU never holds your funds.',
    tip: 'Keep a little NEAR for gas — a few cents per transaction.'
  },
  {
    title: 'Pick a pool',
    text: 'Open Pools. Compare TVL, volume, fees and APR, and check the 24h move: Calm pools carry less impermanent-loss risk than Volatile ones.',
    tip: 'Top Performers shows the pools earning the most fees right now; Trending shows where trading is heating up.'
  },
  {
    title: 'Choose your range',
    text: 'Classic pools spread your liquidity over every price. CLMM pools let you choose a price range — more fees while the price stays inside it. Smart LP setup suggests a range for you.',
    tip: 'New to CLMM? Start with a wider range: it earns a little less but stays in range longer.'
  },
  {
    title: 'Deposit',
    text: 'Add both tokens, or Zap in with just one: KINU swaps part of it for you and adds the liquidity in the same flow. Review, then approve in your wallet.',
    tip: 'Start small on your first position until the flow feels familiar.'
  },
  {
    title: 'Track and manage',
    text: 'Portfolio shows your positions, fees and PnL. While KINU is open, it alerts you when a position goes out of range — and you can rebalance or compound in one click.',
    tip: 'Proud of a result? Share PnL turns it into a card for X.'
  }
];

const TYPES = [
  {
    key: 'amm',
    name: 'Classic (AMM)',
    best: 'Passive LPs',
    text: 'Liquidity across the full price range (x·y=k). Set it and forget it: it always earns while the pool trades.'
  },
  {
    key: 'clmm',
    name: 'CLMM',
    best: 'Active LPs',
    text: 'Concentrated liquidity inside a range you choose. Far more fees per dollar while in range — none while out of range.'
  },
  {
    key: 'stable',
    name: 'Stable',
    best: 'Low-risk yield',
    text: 'For assets that track each other, like stablecoins or NEAR and its staked versions. Little price movement, steady fees.'
  }
];

const RISKS = [
  ['Impermanent loss', 'When the two token prices drift apart, you end up with more of the one that fell. The bigger the move, the bigger the gap versus simply holding.'],
  ['Out of range', 'A CLMM position earns nothing while the price is outside its range. Watch the alerts and rebalance when it happens.'],
  ['New and thin pools', 'Young tokens (see Token age) and pools with low TVL can swing hard. Size your position accordingly.'],
  ['One-day APR spikes', 'APR is annualised from the last 24h. A ⚠ next to it means one busy day is inflating the number — don’t expect it to last.']
];

const FAQ = [
  ['What is liquidity?', 'The tokens available in a pool for traders to swap against. The more liquidity, the smaller the price impact of each trade.'],
  [
    'What is a liquidity provider (LP)?',
    'Anyone who deposits tokens into a pool. In return, LPs earn the trading fees that swappers pay, in proportion to their share.'
  ],
  ['What is a liquidity pool?', 'A smart contract holding two (or more) tokens. Traders swap one token for the other, and the pool’s formula sets the price.'],
  [
    'How is the price set in a pool?',
    'By the ratio of the tokens in it. Each swap changes that ratio and so moves the price; arbitrage traders keep it in line with the wider market.'
  ],
  [
    'What is impermanent loss?',
    'The difference between keeping your tokens in a pool and simply holding them, caused by price changes. It shrinks again if prices return, and fees earned help offset it.'
  ],
  ['Can I withdraw at any time?', 'Yes. Remove your liquidity from the pool page or from Portfolio whenever you like; your tokens and earned fees come back to your wallet.'],
  [
    'Does KINU take a cut?',
    'KINU adds no extra fee on liquidity. You pay NEAR network gas, and the pools’ own swap fees go to the LPs — including you.'
  ],
  ['Is it safe?', 'KINU is non-custodial: every transaction is built in your browser and signed by your own wallet, on Rhea Finance contracts. DeFi always carries risk — only provide what you can afford to have exposed.']
];

export default function StartLp() {
  // A live number for the hero: what Rhea LPs earned in the last 24h.
  const overview = useAsync(() => searchPools({ limit: 300, hideLow: true }), []);
  const fees = useMemo(() => (overview.data?.list || []).reduce((s, p) => s + p.feeVolume24h, 0), [overview.data]);

  return (
    <div className="page page--starter">
      <section className="st-hero">
        <span className="st-eyebrow">New to LP-ing?</span>
        <h1>
          Earn trading fees with the
          <br />
          tokens you already hold.
        </h1>
        <p>A five-minute guide to providing liquidity on NEAR — from your first deposit to managing it like a pro.</p>
        <div className="st-hero__actions">
          <Link to="/pools" className="button button--primary button--lg">
            Find your first pool →
          </Link>
          <a href="#st-steps" className="button button--ghost button--lg">
            Walk me through it
          </a>
        </div>
        <div className="st-stat">
          <strong>{overview.data ? formatUsd(fees) : <Skeleton width={110} height={26} />}</strong>
          <span>paid to liquidity providers on NEAR in the last 24 hours</span>
        </div>
      </section>

      <section className="st-section">
        <span className="st-label">Why LP</span>
        <h2>If you can trade, you can LP.</h2>
        <div className="st-why">
          {WHY.map((w) => (
            <article key={w.title} className="st-card">
              <span className="st-card__icon" aria-hidden>
                {w.icon}
              </span>
              <h3>{w.title}</h3>
              <p>{w.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="st-section" id="st-steps">
        <span className="st-label">Step by step</span>
        <h2>Your first position in five steps.</h2>
        <ol className="st-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="st-step">
              <span className="st-step__num">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
                <small>
                  <b>Tip</b> {s.tip}
                </small>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="st-section">
        <span className="st-label">Pool types</span>
        <h2>Which pool suits you?</h2>
        <div className="st-types">
          {TYPES.map((t) => (
            <article key={t.key} className={`st-card st-type st-type--${t.key}`}>
              <div className="st-type__head">
                <h3>{t.name}</h3>
                <small>Best for · {t.best}</small>
              </div>
              <p>{t.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="st-section">
        <span className="st-label">Know the risks</span>
        <h2>LP with your eyes open.</h2>
        <div className="st-risks">
          {RISKS.map(([title, text]) => (
            <div key={title} className="st-risk">
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="st-section">
        <span className="st-label">FAQ</span>
        <h2>Frequently asked questions.</h2>
        <div className="st-faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="st-cta">
        <h2>Ready for your first position?</h2>
        <p>Pick a pool, choose your range, and start earning from every swap.</p>
        <div className="st-hero__actions">
          <Link to="/pools" className="button button--primary button--lg">
            Explore pools →
          </Link>
          <Link to="/docs/getting-started" className="button button--ghost button--lg">
            Read the docs
          </Link>
        </div>
      </section>
    </div>
  );
}
