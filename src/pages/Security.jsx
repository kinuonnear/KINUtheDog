// Security & Transparency: the official contract, how the terminal protects users,
// the latest audit, the treasury, and the risks that remain. Everything stated here
// must match the code (lib/txGuard.js, lib/swap.js, lib/wallet.js, vercel.json).

import { Link, poolPath } from '../router.jsx';
import { CopyButton } from '../components/ui.jsx';
import { ENDPOINTS } from '../config.js';

const KINU = 'kinu-3.nearlytrade.near';
const RHEA = 'token.rhealab.near';
const NOT_OFFICIAL = ['kinu.nearlytrade.near', 'kinu-2.nearlytrade.near'];
// Public treasury wallet (null hides the address and says it will be announced).
const TREASURY = 'kinu-treasury.near';
const SOURCE_URL = 'https://github.com/kinuonnear/KINUtheDog/tree/kinu-platform';
const X_URL = 'https://x.com/KINUonNEAR';

const ext = { target: '_blank', rel: 'noopener noreferrer' };
const explorer = (account) => `${ENDPOINTS.explorer}/address/${account}`;

const GUARD = [
  ['Only known contracts and methods', 'Every transaction is checked against an allow-list of Rhea contracts (plus Intear DEX for Intear Aggregator routes) and the exact methods KINU uses.'],
  ['Tokens only go to the DEX', 'Tokens can only be sent into Rhea’s exchange, CLMM or router contracts, or into Intear DEX on an Intear Aggregator route, and the swap output must come back to you — never to any other account.'],
  ['No transfers, keys or deploys', 'Plain NEAR transfers, access-key changes and contract deploys are always refused.'],
  ['Fees are capped', 'A token’s registration fee is capped at 0.05 NEAR, and all fees in one request at 2 NEAR (wrapping NEAR excluded).'],
  ['Quotes must match', 'A router quote that would spend a different amount or trade a different pair than you typed is rejected.'],
  ['You sign everything', 'KINU never holds keys or funds. Every action opens in your own wallet with the full details.']
];

const SITE = [
  'Strict Content-Security-Policy: scripts only from kinudefi.com, no plugins, no framing',
  'HTTPS only (HSTS), clickjacking protection, no MIME sniffing',
  'No API keys or secrets in the app; no source maps published',
  'Wallet results in the URL are shown only for redirects KINU started — crafted links cannot show fake messages',
  'Open source: the code running on this site is public'
];

const AUDIT = [
  ['Medium', 'Router quotes were used as returned', 'Fixed — amount and pair must match what you typed'],
  ['Medium', 'A hostile token could ask for a large registration fee', 'Fixed — 0.05 NEAR per token, 2 NEAR per request'],
  ['Low–medium', 'Crafted links could show fake wallet messages', 'Fixed — only redirects KINU started are shown'],
  ['Low', 'Transitive issues in wallet libraries (npm audit)', 'Accepted — no path to user funds; updated with wallet-selector releases']
];

const RISKS = [
  ['Market risk', 'Token prices move. $KINU is a young community token with thin liquidity — trades can move its price a lot.'],
  ['Liquidity risk', 'Providing liquidity can lose value against holding (impermanent loss), and CLMM ranges stop earning when the price leaves them.'],
  ['Protocol risk', 'Swaps and pools run on Rhea Finance’s contracts (and Intear DEX’s, for some swap routes). KINU checks every transaction, but cannot change how those contracts behave.'],
  ['Data providers', 'Prices, charts and history come from Rhea, Intear, FastNEAR and DexScreener. They are shown for information; your wallet shows what is actually signed.']
];

function AccountRow({ label, account, note }) {
  return (
    <div className="sec-account">
      <span className="eyebrow">{label}</span>
      <code>{account}</code>
      <span className="sec-account__actions">
        <CopyButton text={account} />
        <a className="link-button" href={explorer(account)} {...ext}>
          Explorer ↗
        </a>
      </span>
      {note && <small className="muted">{note}</small>}
    </div>
  );
}

export default function Security() {
  return (
    <div className="page page--security">
      <header className="page-head">
        <span className="eyebrow">Security &amp; transparency</span>
        <h1>Safe by design, open by default.</h1>
        <p>
          What $KINU is, how KINU protects every transaction, what was audited, and the risks that remain — in
          plain words.
        </p>
      </header>

      <section className="card sec-section">
        <h2>Official $KINU contract</h2>
        <AccountRow
          label="KINU · NEAR"
          account={KINU}
          note="1B supply · fair launch on Nearly · paired with RHEA on Rhea Finance (CLMM, 1% fee)"
        />
        <div className="sec-links">
          <Link className="button button--primary button--sm" to={`/swap?from=${RHEA}&to=${KINU}`}>
            Buy $KINU
          </Link>
          <Link className="button button--ghost button--sm" to={poolPath(`${KINU}|${RHEA}|10000`)}>
            KINU / RHEA pool
          </Link>
        </div>
        <div className="sec-warning">
          <strong>Not official:</strong> {NOT_OFFICIAL.map((id) => <code key={id}>{id}</code>)} — earlier launches. Only{' '}
          <code>{KINU}</code> is $KINU. Always check the contract before you buy.
        </div>
      </section>

      <section className="sec-grid">
        <div className="card sec-section">
          <h2>How every transaction is protected</h2>
          <p className="muted">Before your wallet ever opens, KINU checks what it is about to ask you to sign.</p>
          <ul className="sec-checks">
            {GUARD.map(([title, text]) => (
              <li key={title}>
                <b>✓</b>
                <div>
                  <strong>{title}</strong>
                  <span>{text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="card sec-section">
          <h2>How the site is protected</h2>
          <ul className="sec-list">
            {SITE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <a className="link-button" href={SOURCE_URL} {...ext}>
            View the source code ↗
          </a>
        </div>
      </section>

      <section className="card sec-section">
        <div className="sec-section__head">
          <h2>Latest audit</h2>
          <span className="muted small">Internal review · 12 Oct 2026</span>
        </div>
        <div className="sec-table">
          <div className="sec-table__row sec-table__row--head">
            <span>Severity</span>
            <span>Finding</span>
            <span>Status</span>
          </div>
          {AUDIT.map(([severity, finding, status]) => (
            <div className="sec-table__row" key={finding}>
              <span data-label="Severity">
                <i className={`sev sev--${severity.toLowerCase().replace(/[^a-z]/g, '')}`}>{severity}</i>
              </span>
              <span data-label="Finding">{finding}</span>
              <span data-label="Status">{status}</span>
            </div>
          ))}
        </div>
        <p className="muted small">
          This is an internal review of the KINU front-end, not a third-party audit of Rhea Finance or NEAR contracts.
        </p>
      </section>

      <section className="sec-grid">
        <div className="card sec-section">
          <h2>Treasury</h2>
          {TREASURY ? (
            <AccountRow label="KINU treasury" account={TREASURY} note="Platform income and protocol-owned liquidity — public on-chain." />
          ) : (
            <p className="muted">
              The treasury wallet will be published here and on{' '}
              <a href={X_URL} {...ext}>
                @KINUonNEAR
              </a>{' '}
              before it receives any platform income.
            </p>
          )}
          <p className="muted small">KINU charges no platform fee today. Any future fee will be shown before you sign.</p>
        </div>
        <div className="card sec-section">
          <h2>Report a problem</h2>
          <p className="muted">
            Found a bug or a security issue? Message{' '}
            <a href={X_URL} {...ext}>
              @KINUonNEAR
            </a>{' '}
            on X. Please share details privately first — never post a working exploit publicly.
          </p>
          <p className="muted small">The KINU team will never DM you first, ask for your seed phrase, or ask you to “validate” a wallet.</p>
        </div>
      </section>

      <section className="card sec-section">
        <h2>Risks that remain</h2>
        <div className="sec-risks">
          {RISKS.map(([title, text]) => (
            <div key={title}>
              <strong>{title}</strong>
              <p className="muted">{text}</p>
            </div>
          ))}
        </div>
        <p className="muted small">KINU is non-custodial software, not financial advice. Do your own research.</p>
      </section>
    </div>
  );
}
