// KINU Docs (/docs, /docs/:slug): the user guide for the KINU Terminal. Content is plain
// JSX so it ships with the app (no fetch, CSP-safe). Keep it in step with the UI labels.

import { useEffect } from 'react';
import { Link, poolPath } from '../router.jsx';
import { WHITEPAPER } from './Whitepaper.jsx';

const KINU = 'kinu-3.nearlytrade.near';
const RHEA = 'token.rhealab.near';
const X_URL = 'https://x.com/KINUonNEAR';
const ext = { target: '_blank', rel: 'noopener noreferrer' };

function Note({ kind = 'info', title, children }) {
  return (
    <div className={`docs-note docs-note--${kind}`}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

function Steps({ items }) {
  return (
    <ol className="docs-steps">
      {items.map((item, i) => (
        <li key={i}>
          <b>{i + 1}</b>
          <div>{item}</div>
        </li>
      ))}
    </ol>
  );
}

function Terms({ items }) {
  return (
    <dl className="docs-terms">
      {items.map(([term, text]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{text}</dd>
        </div>
      ))}
    </dl>
  );
}

const DOCS = [
  {
    group: 'Start here',
    slug: 'whitepaper',
    title: 'Whitepaper',
    summary: 'KINU DeFi: the terminal, the $KINU token, revenue and roadmap.',
    body: WHITEPAPER
  },
  {
    group: 'Start here',
    slug: 'introduction',
    title: 'Introduction',
    summary: 'What the KINU Terminal is and what you can do with it.',
    body: (
      <>
        <p>
          The <strong>KINU Terminal</strong> is a non-custodial DeFi app on NEAR, built by the KINU community on top of{' '}
          <strong>Rhea Finance</strong> liquidity, with market data from <strong>Intear</strong>: Swap &amp; Add Liquidity, made simple — all in one place.
        </p>
        <Terms
          items={[
            ['Swap', 'Best-price swaps: Rhea’s SmartRouter and direct CLMM routes (up to three hops) are quoted side by side.'],
            ['Smart LP', 'Set up concentrated liquidity by dragging a range on the chart, picking a strategy, or zapping in with one token.'],
            ['Pools', 'Every Rhea pool — AMM, CLMM, ALMM, Stable and Farm — with TVL, volume, fees, APR and token age.'],
            ['Discover', 'Top yields, hot pairs, trending tokens, new launches and a live trade feed.'],
            ['Create', 'Open a new CLMM or Classic pool on Rhea.'],
            ['Portfolio', 'Your tokens, liquidity, PnL and history in one place.']
          ]}
        />
        <Note title="Non-custodial">
          KINU never holds your keys or funds. Every action opens in your own wallet, and you sign it there.
        </Note>
      </>
    )
  },
  {
    group: 'Start here',
    slug: 'getting-started',
    title: 'Getting started',
    summary: 'Connect a wallet and make your first trade.',
    body: (
      <>
        <Steps
          items={[
            <>
              <strong>Get a NEAR wallet.</strong> The terminal supports Meteor, Intear, HOT and MyNearWallet.
            </>,
            <>
              <strong>Keep some NEAR for fees.</strong> Every transaction costs a little gas, and the first time you use a
              token a small one-time storage fee registers it for you (usually 0.00125 NEAR).
            </>,
            <>
              <strong>Connect.</strong> Press <em>Connect wallet</em> in the top bar and pick your wallet.
            </>,
            <>
              <strong>Trade or provide liquidity.</strong> Open <Link to="/swap">Swap</Link> or <Link to="/pools">Pools</Link>.
              Every cost is shown before your wallet opens.
            </>
          ]}
        />
        <Note title="New to providing liquidity?">
          <Link to="/start-lp">How to start LP</Link> walks you through your first position in five steps — also linked from the
          top of the Pools page.
        </Note>
        <Note kind="warn" title="Stay safe">
          Only use <strong>kinudefi.com</strong>. The KINU team will never DM you first or ask for your seed phrase.
        </Note>
      </>
    )
  },
  {
    group: 'Trading',
    slug: 'swap',
    title: 'Swap',
    summary: 'How quotes, routes, slippage and fees work.',
    body: (
      <>
        <h3>Best price, every time</h3>
        <p>
          Each quote is requested from Rhea’s <strong>SmartRouter</strong> and from <strong>direct Rhea CLMM routes</strong>{' '}
          (up to three hops). The larger output wins and is marked <em>Best</em>. You can open the route list and pick
          another route yourself.
        </p>
        <h3>Reading a quote</h3>
        <Terms
          items={[
            ['Minimum received', 'The least you can get after slippage. If the price moves further, the swap is cancelled and refunded.'],
            ['Price impact', 'How much your trade moves the pool price. Large impact means the pool is small for your size.'],
            ['Max slippage', 'How far the price may move before the swap fails safely. Default 0.5%, changeable with the ⚙ button.'],
            ['Route / Route provider', 'Which pools the swap passes through, and whether SmartRouter or a direct CLMM route is used.'],
            ['Network fee', 'Estimated NEAR gas for the whole swap, including any one-time token registration.']
          ]}
        />
        <p>Quick buttons fill <strong>25% · 50% · 80% · 100%</strong> of your balance. With NEAR, a small amount is kept for gas.</p>
        <Note kind="warn" title="Unverified tokens">
          Anyone can create a token called “USDC”. The terminal warns you when a token is not on Rhea’s whitelist — always
          check the contract address.
        </Note>
        <h3>Funds waiting in the swap router</h3>
        <p>
          Rarely, a swap’s final transfer does not reach your wallet and the tokens wait in Rhea’s router. The Swap page then
          shows a notice with a <strong>Withdraw</strong> button — one click returns them to your wallet.
        </p>
      </>
    )
  },
  {
    group: 'Trading',
    slug: 'new-tokens',
    title: 'Discover & token pages',
    summary: 'Find yields, hot pairs and new tokens — and check them before you buy.',
    body: (
      <>
        <p>
          <Link to="/discover">Discover</Link> gathers what is moving on Rhea, one tab each:
        </p>
        <Terms
          items={[
            ['Top Yields', 'Pools that paid their LPs the most fees per dollar, next to how much the price moved (the impermanent-loss risk).'],
            ['Hot pairs', 'The most traded pairs over 1h, 6h or 24h.'],
            ['Trending · Gainers', 'Tokens with the most activity, and the biggest 24h risers.'],
            ['New launches', 'The newest tokens launched on Nearly, with the facts below.'],
            ['Live feed · Watchlist', 'Trades as they happen, and the tokens you starred.']
          ]}
        />
        <p>
          Pool tables show each pool’s <strong>Pair age</strong> (how long ago the pool was created), and every column label
          sorts — click again to flip the order.
        </p>
        <p>
          <Link to="/discover?tab=new">New launches</Link> lists the newest tokens launched on Nearly — each one opens a Rhea CLMM
          pool — with age, price, FDV, liquidity, 24h volume and holders, refreshed every minute.
        </p>
        <Terms
          items={[
            ['Official $KINU', 'The token is the official KINU contract.'],
            ['Not the official $KINU / Uses the … name', 'A token copying the name of KINU or a major token. Treat it as a likely impersonation.'],
            ['Name used before', 'Another recent launch uses the same symbol.'],
            ['Under 24h old', 'Launched less than a day ago.'],
            ['Thin liquidity', 'Under $500 of NEAR/RHEA in the pool — what sellers can actually receive. Selling can move the price a lot.'],
            ['Few holders', 'Fewer than 10 holders.']
          ]}
        />
        <p>
          Every token has its own page at <code>kinudefi.com/token/&lt;contract&gt;</code> with its chart, recent trades, Rhea
          pools, launch details and flags — plus Buy / Sell and a link to share. Searching a token in the top bar opens it.
        </p>
        <Note kind="warn" title="Flags are facts, not ratings">
          A listing is not an endorsement. New tokens are extremely risky — check the contract and never invest more than you
          can lose.
        </Note>
      </>
    )
  },
  {
    group: 'Liquidity',
    slug: 'smart-lp',
    title: 'Smart LP setup',
    summary: 'Concentrated liquidity on Rhea CLMM pools, step by step.',
    body: (
      <>
        <p>
          On a <strong>CLMM</strong> pool you choose a price range. While the price is inside it your liquidity earns trading
          fees; outside it, it stops earning until the price returns.
        </p>
        <Steps
          items={[
            <>
              Open a CLMM pool from <Link to="/pools">Pools</Link> (or <strong>+ Add LP</strong> on any row) and use the{' '}
              <strong>Create position</strong> panel. On a phone, the floating <strong>+ Add liquidity</strong> button jumps to it.
            </>,
            <>
              <strong>Set your range</strong> with a preset or by dragging the edges on the chart.
            </>,
            <>
              <strong>Pick a strategy</strong> — how liquidity is spread inside the range:
              <Terms
                items={[
                  ['Spot', 'Even liquidity across the range. Simple and works for any market.'],
                  ['Curve', 'Concentrated around the current price. Highest fees while the price is calm.'],
                  ['Bid-Ask', 'More liquidity at the edges. Captures volatility and DCA-style entries/exits.']
                ]}
              />
            </>,
            <>
              <strong>Enter amounts</strong> — the other side fills in automatically — or <strong>zap in</strong> with a
              single token and let the terminal swap the right share for you.
            </>,
            <>Review the cost breakdown and confirm in your wallet.</>
          ]}
        />
        <h3>Deposits that land</h3>
        <p>
          The terminal watches the <strong>live pool price</strong> while you fill in the form and sizes minimum amounts from
          your slippage. If the price moves beyond your slippage, an <strong>Accept new price</strong> button appears so you
          can confirm the updated amounts instead of sending a deposit that would fail.
        </p>
        <h3>Fees and withdrawing</h3>
        <p>
          Earned fees show as <strong>Claimable fees</strong> and can be claimed any time. <strong>Withdraw</strong> removes
          your liquidity; any unclaimed fees are paid out with it.
        </p>
        <h3>Rebalance your range</h3>
        <p>
          When the price leaves your range, the position shows <strong>Out of range</strong> and stops earning. Press{' '}
          <strong>⟲ Rebalance</strong> (Portfolio → Liquidity, or the pool page) to move your <strong>whole range</strong> —
          every bin — back around the current price, or choose <strong>Out of range only</strong> to move just the bins that
          stopped earning. You can also re-centre a range that is still earning. It all happens in{' '}
          <strong>one wallet request</strong>:
        </p>
        <Steps
          items={[
            <>Withdraw the positions you chose — tokens and earned fees go to your wallet.</>,
            <>Swap the share the new range needs into the other token (best route, one step).</>,
            <>Open the new range — same width or ±5% / ±10% / ±25% / ±50% — with the strategy you pick.</>
          ]}
        />
        <p>
          Amounts are sized from minimums, so a small remainder may stay in your wallet. If the swap would move the pool price
          more than your slippage, or the pool can’t fill it, the terminal stops before anything is signed and tells you why.
        </p>
        <Note kind="warn" title="Impermanent loss">
          Providing liquidity can be worth less than simply holding the two tokens when prices move. Fees can make up for it
          — or not.
        </Note>
        <Note title="Whitelist-only pools">
          Some Rhea pools only accept liquidity from approved accounts. The terminal tells you before you try.
        </Note>
      </>
    )
  },
  {
    group: 'Liquidity',
    slug: 'pools',
    title: 'Pools',
    summary: 'Finding pools and reading their numbers.',
    body: (
      <>
        <Terms
          items={[
            ['AMM', 'Classic pools: liquidity across the full price range.'],
            ['CLMM', 'Concentrated pools: liquidity inside a range you choose (see Smart LP).'],
            ['ALMM', 'Rhea’s liquidity-book pools with liquidity in price bins.'],
            ['Stable', 'Pools of assets meant to trade near the same price (e.g. stablecoins, staked NEAR).'],
            ['Farm', 'Pools with extra rewards for staked liquidity.']
          ]}
        />
        <p>
          Each pool shows <strong>TVL</strong>, <strong>volume</strong>, <strong>fees</strong> and <strong>APR</strong> over
          1h–24h windows, its <strong>24h move</strong> (Calm, Moving or Volatile — the impermanent-loss risk) and the{' '}
          <strong>Token age</strong> of its main token. Every column label sorts.
        </p>
        <Terms
          items={[
            ['Views', 'All pools, Favorites (☆), Top Performers (most fees earned), Trending (most trading for their size) and My positions.'],
            ['Filters', 'Pool type, time window, Hide low TVL and Hide inactive — in the panel on the left (Filters on a phone).'],
            ['+ Add LP', 'Opens the pool straight at its liquidity form.']
          ]}
        />
        <h3>Classic pools</h3>
        <p>
          A Classic (AMM) pool takes both tokens at the pool ratio — or use <strong>⚡ Zap in</strong> with a single token: half
          its value is swapped into the other side and both are deposited in one wallet request. Deposits use each swap’s
          guaranteed minimum, so a small remainder may stay in your wallet.
        </p>
        <Note title="APR is backward-looking">
          Fee APR annualises the last 24h of fees (fees ÷ TVL × 365, no compounding). It changes with trading activity and is
          not a promise. A <strong>≈</strong> before it means Rhea gives no APR for that pool and KINU estimated it from the
          last 24h of fees.
        </Note>
      </>
    )
  },
  {
    group: 'Liquidity',
    slug: 'create-pool',
    title: 'Create a pool',
    summary: 'Open a new CLMM or Classic pool on Rhea.',
    body: (
      <>
        <Steps
          items={[
            <>
              Open <Link to="/create-pool">Create</Link> in the top bar and choose <strong>CLMM</strong> (range liquidity) or{' '}
              <strong>Classic</strong> (full range).
            </>,
            <>
              Pick the two tokens and a fee tier. Pools that already exist are shown per fee tier — pick one and{' '}
              <strong>Go to this pool</strong> takes you there, so you never pay to create a duplicate.
            </>,
            <>
              For CLMM, set the <strong>starting price</strong> (<em>Use market price</em> fills it in). The pool.spec panel
              shows exactly what will be deployed, and how far your price is from the market.
            </>,
            <>Confirm in your wallet, then add liquidity from the new pool’s page.</>
          ]}
        />
        <Terms
          items={[
            ['CLMM pool', '0.1 NEAR to Rhea’s CLMM contract.'],
            ['Classic pool', '0.05 NEAR to Rhea’s exchange.']
          ]}
        />
        <Note kind="warn" title="Starting price matters">
          The first price of a new pool is the one you set. A wrong price is an instant arbitrage opportunity for others.
        </Note>
      </>
    )
  },
  {
    group: 'Your account',
    slug: 'portfolio',
    title: 'Portfolio & PnL',
    summary: 'Tokens, liquidity, history and sharing your results.',
    body: (
      <>
        <Terms
          items={[
            ['Tokens', 'Balances with average buy price, unrealized PnL, realized PnL and allocation. Tokens you sold appear under “Sold tokens”.'],
            ['Liquidity', 'Your open positions and the Total LP PnL dashboard: unrealized and realized PnL, fees earned, win rate.'],
            ['History', 'Closed liquidity positions (newest closed first, with their result and explorer links) and your swaps.'],
            ['Rhea deposits', 'Tokens sitting inside Rhea instead of your wallet (exchange, CLMM balance, lost & found, swap router) — withdraw them here.']
          ]}
        />
        <h3>Where PnL comes from</h3>
        <p>
          For tokens launched on Nearly, PnL comes from Nearly’s own trade records. For everything else it is rebuilt from your
          on-chain trades. Balances that arrived in other ways (transfers, older history) may not have a known cost.
        </p>
        <p>
          Portfolio opens on <strong>Liquidity</strong> when you have positions (else Tokens) and remembers the tab you last
          picked. Any account can be viewed read-only by typing its name.
        </p>
        <h3>Share to X</h3>
        <p>
          On your own portfolio, the ↗ button next to a token’s PnL and <strong>Share PnL</strong> on the LP dashboard or a
          position create a card for X, with a choice of backgrounds or your own picture. It never shows your wallet address;{' '}
          <strong>Hide dollar amounts</strong> shares percentages only, and you can hide the pool or individual details.{' '}
          <strong>Post on X</strong> copies the image and opens your post — paste it there to attach it.
        </p>
      </>
    )
  },
  {
    group: 'KINU',
    slug: 'kinu-token',
    title: '$KINU token',
    summary: 'The official contract and how $KINU trades.',
    body: (
      <>
        <Terms
          items={[
            ['Contract', <code key="ca">{KINU}</code>],
            ['Supply', '1,000,000,000 KINU · fair launch on Nearly'],
            ['Main pool', 'KINU / RHEA on Rhea Finance CLMM, 1% fee'],
            ['Network', 'NEAR Protocol']
          ]}
        />
        <div className="docs-actions">
          <Link className="button button--primary button--sm" to={`/swap?from=${RHEA}&to=${KINU}`}>
            Buy $KINU with RHEA
          </Link>
          <Link className="button button--ghost button--sm" to={poolPath(`${KINU}|${RHEA}|10000`)}>
            KINU / RHEA pool
          </Link>
        </div>
        <Note kind="warn" title="Not official">
          <code>kinu.nearlytrade.near</code> and <code>kinu-2.nearlytrade.near</code> are earlier launches. Only{' '}
          <code>{KINU}</code> is $KINU.
        </Note>
      </>
    )
  },
  {
    group: 'KINU',
    slug: 'security',
    title: 'Security',
    summary: 'How every transaction is protected.',
    body: (
      <>
        <p>Before your wallet opens, the terminal checks every transaction it is about to ask you to sign:</p>
        <ul>
          <li>Only Rhea’s contracts and the exact methods KINU uses are allowed.</li>
          <li>Tokens can only be sent into Rhea — never to any other account.</li>
          <li>NEAR transfers, access-key changes and contract deploys are always refused.</li>
          <li>Registration fees are capped (0.05 NEAR per token, 2 NEAR per request).</li>
          <li>A router quote that doesn’t match what you typed is rejected.</li>
        </ul>
        <p>
          The full picture — audit, treasury and remaining risks — is on <Link to="/security">Security &amp; transparency</Link>.
        </p>
      </>
    )
  },
  {
    group: 'Help',
    slug: 'faq',
    title: 'FAQ & troubleshooting',
    summary: 'Answers to the most common questions.',
    body: (
      <>
        <Terms
          items={[
            ['My transaction failed — where are my tokens?', 'Failed swaps and deposits are refunded by Rhea. If tokens landed inside Rhea instead of your wallet, open Portfolio → Rhea deposits and withdraw them. A router notice on the Swap page means the same for swaps.'],
            ['Why do I pay a storage fee?', 'NEAR charges storage for each token account you hold. It is paid once per token (usually 0.00125 NEAR) and is shown in the cost breakdown.'],
            ['Why does a deposit attach so much gas?', 'Since Rhea’s October 2026 upgrade a CLMM deposit uses about 420–430 TGas; the terminal attaches 600 TGas so it never runs out. You only pay for the gas used (about 0.04 NEAR) — the rest is refunded.'],
            ['The price moved while I was depositing.', 'Use Accept new price to confirm updated amounts, or widen your slippage in ⚙.'],
            ['Does KINU charge a fee?', 'No platform fee today. Pool fees go to liquidity providers. Any future fee will be shown before you sign.'],
            ['Why APR and not APY?', 'APR is the last 24h of fees annualised without compounding (fees ÷ TVL × 365). Rhea labels the same number “APY”, but it is not compounded — so KINU calls it APR. A ≈ in front means KINU estimated it because Rhea gives none for that pool.'],
            ['Why did my position stop earning?', 'A CLMM position earns only while the price is inside its range. While KINU is open it alerts you when a position goes out of range; ⟲ Rebalance moves it back around the current price.'],
            ['Is this financial advice?', 'No. KINU is non-custodial software. DeFi carries risk, including loss of funds — do your own research.']
          ]}
        />
        <p>
          Still stuck? Message{' '}
          <a href={X_URL} {...ext}>
            @KINUonNEAR
          </a>{' '}
          on X.
        </p>
      </>
    )
  },
  {
    group: 'Legal',
    slug: 'terms',
    title: 'Terms of Service',
    summary: 'The terms for using the KINU Terminal. Last updated 14 October 2026.',
    body: (
      <>
        <p>
          These terms apply to your use of the KINU Terminal at kinudefi.com (the “Terminal”). By using the Terminal you agree to
          them. If you do not agree, do not use it.
        </p>

        <h3>1. What the Terminal is</h3>
        <p>
          The Terminal is a free, non-custodial interface to public smart contracts on the NEAR blockchain — mainly the pools of{' '}
          <strong>Rhea Finance</strong>. KINU does not operate those contracts, does not run an exchange and does not hold, move or
          control your funds. Every transaction is built in your browser, shown in your own wallet, and only happens if you sign it
          there.
        </p>

        <h3>2. Your wallet and keys</h3>
        <p>
          You are solely responsible for your wallet, its keys and recovery phrase, and every transaction you sign. KINU never asks for
          your keys or recovery phrase and cannot reverse, cancel or recover a transaction once it is on the blockchain.
        </p>

        <h3>3. No advice</h3>
        <p>
          Nothing on the Terminal — prices, APRs, yields, rankings such as Top Yields, Trending or Hot pairs, or any other content — is
          financial, investment, legal or tax advice, or a recommendation to buy, sell or provide liquidity for any token. A token or
          pool appearing on the Terminal is not an endorsement. Do your own research.
        </p>

        <h3>4. Risks</h3>
        <p>Using DeFi involves significant risk, including the total loss of funds. Among others:</p>
        <Terms
          items={[
            ['Impermanent loss', 'Liquidity you provide changes in value as prices move, and can be worth less than simply holding the tokens.'],
            ['Concentrated liquidity', 'A CLMM range stops earning fees when the price leaves it, and then holds only one of the two tokens.'],
            ['Volatile tokens', 'New and small tokens can lose most of their value quickly, have thin liquidity, or be abandoned by their creators.'],
            ['Token taxes', 'Some tokens (e.g. launched on Nearly) charge a transfer tax on buys and sells; the Terminal accounts for known taxes but cannot guarantee them.'],
            ['Smart contracts', 'Contracts can contain bugs or be upgraded by their operators; KINU does not control or audit third-party contracts.'],
            ['APR and yield', 'APRs are estimates from past fees (often a single day) and are not a promise of future returns.'],
            ['Network', 'Transactions can fail, be delayed or cost gas; wallets and RPC services can be unavailable or rate-limited.']
          ]}
        />

        <h3>5. Data from third parties</h3>
        <p>
          Prices, charts, volumes and other data come from third-party services (such as Rhea Finance, Intear, DexScreener,
          GeckoTerminal and FastNEAR) and from the blockchain. They may be delayed, incomplete or wrong. Always check the amounts in
          your wallet before you sign.
        </p>

        <h3>6. Fees</h3>
        <p>
          KINU charges no platform fee today. Pool fees go to the pool’s liquidity providers; network gas and storage deposits go to
          NEAR. If KINU ever adds a fee, it will be shown before you sign.
        </p>

        <h3>7. Acceptable use</h3>
        <p>
          You may not use the Terminal in breach of any law that applies to you, including sanctions, or to interfere with the
          Terminal or other users. You are responsible for knowing whether using DeFi is allowed where you live, and for any taxes
          you owe.
        </p>

        <h3>8. No warranty and limitation of liability</h3>
        <p>
          The Terminal is provided “as is” and “as available”, without warranties of any kind. To the fullest extent permitted by law,
          the KINU contributors are not liable for any loss or damage arising from your use of the Terminal, the blockchain, third-party
          contracts or third-party data.
        </p>

        <h3>9. Changes</h3>
        <p>
          These terms may be updated; the date above shows the latest version. Continuing to use the Terminal after a change means you
          accept the updated terms.
        </p>

        <Note title="Questions">
          Contact{' '}
          <a href={X_URL} {...ext}>
            @KINUonNEAR
          </a>{' '}
          on X. See also{' '}
          <Link to="/security">Security &amp; transparency</Link>.
        </Note>
      </>
    )
  }
];

export default function Docs({ slug }) {
  // /docs opens the introduction; the whitepaper is listed first in the menu.
  const found = DOCS.findIndex((d) => d.slug === slug);
  const index = found >= 0 ? found : DOCS.findIndex((d) => d.slug === 'introduction');
  const doc = DOCS[index];
  const prev = DOCS[index - 1];
  const next = DOCS[index + 1];
  const groups = [...new Set(DOCS.map((d) => d.group))];

  useEffect(() => {
    document.title = `${doc.title} · KINU Docs`;
  }, [doc.title]);

  return (
    <div className="page docs">
      <aside className="docs-nav" aria-label="Docs">
        <span className="eyebrow">KINU Docs</span>
        {groups.map((group) => (
          <div key={group} className="docs-nav__group">
            <small>{group}</small>
            {DOCS.filter((d) => d.group === group).map((d) => (
              <Link key={d.slug} to={`/docs/${d.slug}`} className={d.slug === doc.slug ? 'active' : ''}>
                {d.title}
              </Link>
            ))}
          </div>
        ))}
      </aside>

      <article className="docs-body">
        <span className="eyebrow">{doc.group}</span>
        <h1>{doc.title}</h1>
        <p className="docs-summary">{doc.summary}</p>
        <div className="docs-content">{doc.body}</div>
        <nav className="docs-pager">
          {prev ? (
            <Link to={`/docs/${prev.slug}`}>
              <small>← Previous</small>
              {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link to={`/docs/${next.slug}`} className="docs-pager__next">
              <small>Next →</small>
              {next.title}
            </Link>
          )}
        </nav>
      </article>
    </div>
  );
}
