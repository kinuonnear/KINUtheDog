// KINU DeFi Whitepaper (v0.2), shown inside Docs at /docs/whitepaper. Keep it factual:
// anything not built is marked Proposed, and it must stay in step with the security page.

import { Link } from '../router.jsx';
import { bpsText, HOLDER, PLATFORM_FEE } from '../config.js';
import { KINU_FEE_BPS, KINU_FEE_STABLE_BPS, feePercent } from '../lib/intentsFees.js';

const KINU = 'kinu-3.nearlytrade.near';

const Live = () => <i className="flag flag--good">Live</i>;
const Proposed = ({ label = 'Proposed' }) => <i className="flag flag--warn">{label}</i>;

function Table({ head, rows }) {
  return (
    <div className="docs-table">
      <table>
        {head && (
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FLOW = [
  ['User', 'opens kinudefi.com'],
  ['KINU app', 'reads prices, pools and history from NEAR RPC, Rhea, Intear, Nearly'],
  ['Transaction guard', 'checks every transaction before the wallet opens'],
  ['User’s wallet', 'Meteor · Intear · HOT · MyNearWallet — the user signs'],
  ['Rhea contracts', 'v2.ref-finance · dclv2.ref-labs · aggregatedex']
];

export const WHITEPAPER = (
  <>
    <p className="wp-meta">Version 0.2 · October 2026 · Draft for community review</p>

    <h3>Abstract</h3>
    <p>
      Rhea Finance holds most of the liquidity on NEAR, but using it well is hard. Concentrated-liquidity (CLMM) positions drift
      out of range and stop earning, deposits fail when the price moves, swap routes are spread across AMM, stable and CLMM
      pools, and new tokens with copied names appear every day.
    </p>
    <p>
      <strong>KINU DeFi</strong> is a web app, live at <code>kinudefi.com</code>, built on top of Rhea’s contracts. It
      compares routes before every swap, opens CLMM positions from a single token (<strong>Zap In</strong>), moves liquidity
      back around the price in one request (<strong>Rebalance</strong>), and reports honest profit and loss for tokens and LP
      positions. Every transaction is checked before the user’s own wallet is asked to sign it.
    </p>
    <p>
      The <strong>$KINU</strong> token (<code>{KINU}</code>) is the project’s community token: a 1,000,000,000 supply fair
      launch on Nearly, paired with RHEA in a Rhea CLMM pool.
    </p>

    <h3>1. The problem</h3>
    <ul>
      <li>
        <strong>Concentrated liquidity is unforgiving.</strong> Outside its range a position stops earning and sits in one token;
        moving it back takes several transactions.
      </li>
      <li>
        <strong>Deposits fail at the worst moment.</strong> Prices move between filling a form and signing it, and Rhea’s CLMM
        deposit uses about 420–430 TGas.
      </li>
      <li>
        <strong>The best price is not in one place.</strong> Rhea’s SmartRouter does not see every community CLMM pool, and
        direct CLMM paths sometimes beat it.
      </li>
      <li>
        <strong>Costs and risks are hard to see.</strong> Fees, storage, price impact and minimum received are often unclear,
        anyone can launch a token called “USDC” or “KINU”, and LP profit and loss is rarely shown.
      </li>
    </ul>

    <h3>2. The KINU app</h3>
    <Table
      head={['Feature', 'What it does', 'Status']}
      rows={[
        ['Smart routes', 'Quotes SmartRouter, direct CLMM (up to 3 hops) and a bridge route side by side; the best output wins', <Live key="a" />],
        ['Smart LP · Zap In', 'Range on the chart, Spot / Curve / Bid-Ask shapes; open a CLMM position — or join a Classic pool — from one token in one request', <Live key="b" />],
        ['Live-price deposits', 'Follows the pool price, sizes minimums from slippage, “Accept new price” instead of a failed deposit', <Live key="c" />],
        ['Rebalance', 'Moves the whole range (or only out-of-range bins) back around the price: withdraw, swap, reopen', <Live key="d" />],
        ['Portfolio & PnL', 'Token and LP PnL with fees, win rate, closed positions, Rhea deposits, share to X', <Live key="e" />],
        ['Pools & discovery', 'Every Rhea pool with sortable yields, trending and token age; Discover (top yields, hot pairs, new launches with risk flags); pool creation; token pages; out-of-range alerts', <Live key="f" />]
      ]}
    />
    <p>
      Details for each feature are in these docs: <Link to="/docs/swap">Swap</Link>, <Link to="/docs/smart-lp">Smart LP</Link>,{' '}
      <Link to="/docs/portfolio">Portfolio</Link>, <Link to="/docs/new-tokens">Discover</Link>, <Link to="/docs/pools">Pools</Link> — and <Link to="/start-lp">How to start LP</Link> for a first position.
    </p>

    <h3>3. Architecture</h3>
    <p>
      KINU is a client-side web app (React and Vite) served as static files from Vercel. There is no KINU backend holding user
      data or funds: the browser reads public data directly and sends transactions only through the user’s wallet.
    </p>
    <ol className="wp-flow">
      {FLOW.map(([name, text]) => (
        <li key={name}>
          <strong>{name}</strong>
          <span>{text}</span>
        </li>
      ))}
    </ol>

    <h3>4. Security model</h3>
    <p>
      KINU is <strong>non-custodial</strong>. Before the wallet opens, a transaction guard allows only Rhea’s contracts and the
      methods KINU uses, sends tokens only into Rhea, refuses NEAR transfers, key changes and deploys, caps fees, and rejects
      router quotes that do not match what the user typed. An internal review on 12 October 2026 found and fixed three issues.
      The full picture is on <Link to="/security">Security &amp; transparency</Link>.
    </p>

    <h3>5. The $KINU token</h3>
    <Table
      rows={[
        ['Contract', <code key="ca">{KINU}</code>],
        ['Supply', '1,000,000,000 KINU · 18 decimals'],
        ['Launch', 'Fair launch on Nearly, 12 October 2026 — the whole supply started in the pool'],
        ['Main pool', 'KINU / RHEA on Rhea CLMM, 1% fee'],
        ['Pool fee share', 'Per the Nearly launch settings, 70% of the 1% pool fee goes to the creator account kinuonnear.near'],
        ['Not official', 'kinu.nearlytrade.near and kinu-2.nearlytrade.near are earlier launches']
      ]}
    />
    <p>
      $KINU is the community token and the app’s flagship pair. It does <strong>not</strong> grant any claim on revenue,
      governance rights or yield. What it does in the app today: swaps that buy or sell $KINU carry no KINU platform fee
      {HOLDER.enabled && HOLDER.perks.feeDiscount && (
        <>
          , and wallets holding $KINU pay less on KINU’s own fees (swaps and Quick LP), applied automatically with no staking
          or lock: {HOLDER.tiers.map(([usd, off]) => `$${usd.toLocaleString('en-US')}+ → ${off * 100}% off`).join(' · ')} of KINU in the wallet,
          at the live price
        </>
      )}
      .
    </p>

    <h3>6. Revenue &amp; treasury</h3>
    <p>
      KINU’s revenue model is simple: <strong>the platform earns when people use it</strong>. Income is paid into a public
      treasury, <code>kinu-treasury.near</code>, and is never hidden from users.
    </p>
    <ul>
      <li>
        <strong>Today</strong> <Live />: {PLATFORM_FEE.enabled ? `a ${bpsText(PLATFORM_FEE.bps)} platform fee on swaps (table below)` : 'no platform fee on swaps or liquidity'}
        ; the creator share of the KINU/RHEA pool fee; and the Bridge&apos;s {feePercent(KINU_FEE_BPS)} service fee (
        {feePercent(KINU_FEE_STABLE_BPS)} for stablecoins and the same asset across chains), shared with NEAR Intents.
      </li>
      <li>
        <strong>Rhea referral</strong> <Proposed label="Proposed · next" />: Rhea keeps 20% of every pool fee as a protocol fee
        (on-chain: <code>admin_fee_bps: 2000</code>, <code>protocol_fee_rate: 2000</code>). Referral front ends approved by the
        Rhea DAO receive part of that share. Users pay nothing extra and see the same price as on Rhea.
      </li>
      <li>
        <strong>Platform fee</strong> {PLATFORM_FEE.enabled ? <Live /> : <Proposed />}: see the table below.
      </li>
    </ul>
    <Table
      head={['Action', PLATFORM_FEE.enabled ? 'Platform fee' : 'Proposed platform fee']}
      rows={[
        ['Swap', '0.1% of the input amount'],
        ['Zap In · Rebalance', '0.1% of the swapped part only'],
        ['Swaps that buy or sell $KINU', 'No platform fee'],
        ['Add / remove liquidity, claim fees', 'No platform fee']
      ]}
    />
    <p>
      The fee would be paid to the treasury in the same transaction. Quoted amounts already include it, the route details say
      “Includes 0.1% KINU fee”, and the wallet shows the transfer before signing. The guard would allow it only to the treasury
      and only up to 0.1% of the swap. A fee paid alongside a swap that fails would be refunded from the treasury on request.
      Any fee is announced in advance on @KINUonNEAR and in these docs before it is switched on.
    </p>
    <p>
      <strong>Use of treasury funds</strong> <Proposed label="Under consideration" />: not decided. Options include development
      and operations, protocol-owned KINU/RHEA liquidity and $KINU buybacks. Holders have no claim on treasury funds, and no
      distribution to holders is planned.
    </p>

    <h3>7. Governance &amp; transparency</h3>
    <ul>
      <li>The $KINU contract, the creator account and the treasury are public and can be checked on any NEAR explorer.</li>
      <li>KINU’s source code is public; reviews and fixes are summarized on the security page.</li>
      <li>Fee changes, treasury decisions and new features are announced on @KINUonNEAR and reflected in these docs.</li>
      <li>
        A treasury page showing balances and fee income from the chain <Proposed />.
      </li>
    </ul>

    <h3>8. Roadmap</h3>
    <Table
      head={['Stage', 'Items']}
      rows={[
        ['Shipped · Oct 2026', 'Smart routes, Smart LP & Zap In (CLMM and Classic), Rebalance, PnL & share to X, pool creation, Discover, token pages, in-app out-of-range alerts, LP guide, security review, docs'],
        ['Next', 'Rhea referral application, limit orders on Rhea CLMM, KINU/RHEA LP leaderboard, Indonesian language, Telegram community'],
        ['Later', 'Price and range alerts while KINU is closed (push), embeddable swap widget, platform fee and treasury page, holder features, CSV export']
      ]}
    />
    <p className="muted small">“Next” and “Later” are plans, not commitments, and have no fixed dates.</p>

    <h3>9. Risks</h3>
    <ul>
      <li><strong>Market:</strong> $KINU is a young token with thin liquidity; small trades can move its price a lot.</li>
      <li><strong>Liquidity:</strong> impermanent loss, and CLMM ranges stop earning outside their range.</li>
      <li><strong>Protocol:</strong> swaps and pools run on Rhea’s contracts, which KINU cannot change.</li>
      <li><strong>Dependencies:</strong> prices and history come from third parties; the wallet shows what is actually signed.</li>
      <li><strong>Operational:</strong> hosting, domain and repository accounts are protected with 2FA, registrar lock and DNSSEC.</li>
      <li><strong>Software:</strong> internal review only, not a third-party audit.</li>
    </ul>

    <h3>10. Disclaimer</h3>
    <p>
      This whitepaper is for information only. It is not an offer to sell or a solicitation to buy any token, and it is not
      financial, investment, legal or tax advice. $KINU is a community token with no promised return, revenue share or
      redemption right. Proposed features may never be built. DeFi carries risk, including the loss of all funds. Do your own
      research, and only use amounts you can afford to lose.
    </p>
  </>
);
