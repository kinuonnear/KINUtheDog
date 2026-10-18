// Security & Transparency: the official contract, how KINU protects users, the audit history (with
// the PDF report in public/security), official accounts, the incident response plan, how to report a
// problem, and the risks that remain. Laid out like Rhea's security pages (guide.rhea.finance:
// Audits, Bug Bounty, Guardians, Incident Response). Everything stated here must match the code
// (lib/txGuard.js, lib/swap.js, lib/intents.js, lib/earn.js, api/, vercel.json).

import { Link, poolPath } from '../router.jsx';
import { CopyButton } from '../components/ui.jsx';
import { CONTRACTS, ENDPOINTS, FEE_SUMMARY } from '../config.js';

const KINU = 'kinu-3.nearlytrade.near';
const RHEA = 'token.rhealab.near';
const NOT_OFFICIAL = ['kinu.nearlytrade.near', 'kinu-2.nearlytrade.near'];
// Public treasury wallet (null hides the address and says it will be announced).
const TREASURY = 'kinu-treasury.near';
const SOURCE_URL = 'https://github.com/kinuonnear/KINUtheDog/tree/kinu-platform';
const X_URL = 'https://x.com/KINUonNEAR';
const REPORT_PDF = '/security/KINU-Security-Report-2026-10.pdf';
// A dedicated security mailbox; null until it exists (reports then go to X DMs only).
const SECURITY_EMAIL = null;

const ext = { target: '_blank', rel: 'noopener noreferrer' };
const explorer = (account) => `${ENDPOINTS.explorer}/address/${account}`;

const GUARD = [
  ['Only known contracts and methods', 'Every transaction is checked against an allow-list of Rhea contracts (plus Intear DEX for Intear Aggregator routes) and the exact methods KINU uses.'],
  ['Tokens only go to the DEX', 'Tokens can only be sent into Rhea’s exchange, CLMM or router contracts, or into Intear DEX on an Intear Aggregator route, and the swap output must come back to you — never to any other account.'],
  ['No transfers, keys or deploys', 'Plain NEAR transfers, access-key changes and contract deploys are always refused.'],
  ['Fees are capped', 'A token’s registration fee is capped at 0.05 NEAR, and all fees in one request at 2 NEAR (wrapping NEAR excluded).'],
  ['Quotes must match', 'A router quote that would spend a different amount or trade a different pair than you typed is rejected.'],
  ['Bridge and Earn quotes are signed', 'Every NEAR Intents quote must carry a valid 1Click signature and match exactly what you asked for; a deposit address is only shown, and tokens only sent to it, for that verified quote and amount.'],
  ['NEAR Intents balance stays yours', 'On intents.near KINU only registers a key after checking your wallet’s signature and that it is your full-access key, and only withdraws to your own account.'],
  ['You sign everything', 'KINU never holds keys or funds. Every action opens in your own wallet with the full details.']
];

const SITE = [
  'Strict Content-Security-Policy: scripts only from kinudefi.com, no plugins, no framing',
  'HTTPS only (HSTS), clickjacking protection, no MIME sniffing',
  'No API keys or secrets in the app: the NEAR Intents partner key stays on the server; no source maps published',
  'The server functions only answer KINU’s own pages, accept only the fields KINU uses, and are rate-limited per IP',
  'Wallet results in the URL are shown only for redirects KINU started — crafted links cannot show fake messages',
  'Open source: the code running on this site is public'
];

// Newest first. Every review is internal (by the KINU team) until a third-party audit is published.
const AUDITS = [
  {
    date: '18 Oct 2026',
    scope: 'Earn and Treasury withdrawals from NEAR Intents, server functions',
    findings: [
      ['Medium', 'A key could be registered on intents.near without proof that it belongs to the account', 'Fixed — the wallet’s signature is verified and the key must be a full-access key of the account'],
      ['Medium', 'Scripts could fake the Origin header and use KINU’s NEAR Intents quota', 'Fixed — per-IP rate limits on the quote and intent functions'],
      ['Low', 'Transitive advisories in wallet libraries (npm audit)', 'Accepted — no path to user funds; updated with wallet library releases']
    ]
  },
  {
    date: '17 Oct 2026',
    scope: 'Bridge (NEAR Intents 1Click)',
    findings: [
      ['High', 'A genuine signed quote made for another recipient, refund address or amount would still verify', 'Fixed — the quoted request must match what KINU sent, field by field'],
      ['Medium', 'A withdrawal transfer was not bound to its quote', 'Fixed — a verified deposit address can only receive that quote’s token and exact amount'],
      ['Low', 'A typed NEAR account was not checked to exist', 'Fixed — a missing account blocks the deposit']
    ]
  },
  {
    date: '12 Oct 2026',
    scope: 'Platform: swaps, liquidity, wallet redirects',
    findings: [
      ['Medium', 'Router quotes were used as returned', 'Fixed — amount and pair must match what you typed'],
      ['Medium', 'A hostile token could ask for a large registration fee', 'Fixed — 0.05 NEAR per token, 2 NEAR per request'],
      ['Low–medium', 'Crafted links could show fake wallet messages', 'Fixed — only redirects KINU started are shown']
    ]
  }
];

// Accounts KINU owns, and the contracts it builds transactions for (owned by their own teams).
const OFFICIAL = [
  ['KINU treasury', 'kinu-treasury.near', 'Platform fees, Bridge and Earn fees; public on-chain'],
  ['Website', 'kinudefi.com', 'The only KINU app. Check the address bar before you connect a wallet'],
  ['X', '@KINUonNEAR', 'Official announcements'],
  ['Telegram bot', '@Kinu_LPbot', 'Opens KINU inside Telegram; never asks for your seed phrase']
];
const THIRD_PARTY = [
  [CONTRACTS.exchange, 'Rhea classic pools'],
  [CONTRACTS.dcl, 'Rhea concentrated liquidity (CLMM)'],
  [CONTRACTS.boostFarm, 'Rhea farms'],
  [CONTRACTS.aggregator, 'Rhea swap router'],
  [CONTRACTS.intearDex, 'Intear DEX (Intear aggregator routes)'],
  ['intents.near', 'NEAR Intents (Bridge, Earn)'],
  [CONTRACTS.wrapNear, 'Wrapped NEAR']
];

// Incident response: what KINU commits to, and the levers it actually has (it holds no funds).
const SEVERITY = [
  ['Critical', 'User funds at risk through KINU', 'Within 1 hour'],
  ['High', 'A feature behaves unsafely or a partner is under incident', 'Within 4 hours'],
  ['Medium', 'Wrong data shown, degraded service', 'Within 24 hours'],
  ['Low', 'Cosmetic or minor bugs', 'Within 3 days']
];
const RESPONSE = [
  ['Stop', 'Turn the affected feature off and redeploy, or roll the site back to the last safe version (minutes on Vercel). Bridge and Earn can be stopped at once by withdrawing KINU’s NEAR Intents key from the server.'],
  ['Warn', 'Post on X and in Telegram what is affected and what to avoid. KINU never asks anyone to “validate” or “migrate” a wallet.'],
  ['Escalate', 'Report contract-level issues to the team that owns the contract: Rhea (whose Guardians can pause its exchange), Intear, or NEAR Intents (whose Shield pauses chains).'],
  ['Report', 'Publish a post-incident report within 7 days: timeline, impact, the fix and what changes.']
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
          <h2>Audits</h2>
          <a className="button button--outline button--sm" href={REPORT_PDF} {...ext}>
            Security report (PDF) ↓
          </a>
        </div>
        {AUDITS.map((audit, i) => (
          <details className="sec-audit" key={audit.date} open={i === 0}>
            <summary>
              <b>{audit.date}</b>
              <span>{audit.scope}</span>
              <small className="muted">Internal review · {audit.findings.length} findings, all addressed</small>
            </summary>
            <div className="sec-table">
              <div className="sec-table__row sec-table__row--head">
                <span>Severity</span>
                <span>Finding</span>
                <span>Status</span>
              </div>
              {audit.findings.map(([severity, finding, status]) => (
                <div className="sec-table__row" key={finding}>
                  <span data-label="Severity">
                    <i className={`sev sev--${severity.toLowerCase().replace(/[^a-z]/g, '')}`}>{severity}</i>
                  </span>
                  <span data-label="Finding">{finding}</span>
                  <span data-label="Status">{status}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
        <p className="muted small">
          Internal reviews of KINU’s app and server functions by the KINU team, not third-party audits. KINU has no smart
          contracts of its own; Rhea Finance’s contracts are audited by Trail of Bits, BlockSec and Resonance (see{' '}
          <a href="https://guide.rhea.finance/developers/audits" {...ext}>
            Rhea’s audits ↗
          </a>
          ). A third-party review of KINU will be published here, and any KINU contract will be audited before launch.
        </p>
      </section>

      <section className="sec-grid">
        <div className="card sec-section">
          <h2>Official accounts</h2>
          <div className="sec-official">
            {OFFICIAL.map(([label, value, note]) => (
              <div key={label}>
                <span className="eyebrow">{label}</span>
                <code>{value}</code>
                <small className="muted">{note}</small>
              </div>
            ))}
          </div>
          <p className="muted small">Anything else using the KINU name — other sites, tokens, bots or “support” accounts — is not KINU.</p>
        </div>
        <div className="card sec-section">
          <h2>Contracts KINU uses</h2>
          <p className="muted">KINU owns no contracts. Your wallet signs transactions for these, run by their own teams:</p>
          <ul className="sec-contracts">
            {THIRD_PARTY.map(([account, label]) => (
              <li key={account}>
                <a href={explorer(account)} {...ext}>
                  <code>{account}</code>
                </a>
                <span className="muted">{label}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="card sec-section">
        <h2>Incident response</h2>
        <p className="muted">
          KINU never holds your funds, so it can’t freeze or move them. What it can do, and commits to, if something goes wrong:
        </p>
        <div className="sec-table sec-table--severity">
          <div className="sec-table__row sec-table__row--head">
            <span>Severity</span>
            <span>Example</span>
            <span>First response</span>
          </div>
          {SEVERITY.map(([severity, example, time]) => (
            <div className="sec-table__row" key={severity}>
              <span data-label="Severity">
                <i className={`sev sev--${severity.toLowerCase()}`}>{severity}</i>
              </span>
              <span data-label="Example">{example}</span>
              <span data-label="First response">{time}</span>
            </div>
          ))}
        </div>
        <ol className="sec-steps">
          {RESPONSE.map(([title, text]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span className="muted">{text}</span>
            </li>
          ))}
        </ol>
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
          <p className="muted small">{FEE_SUMMARY}</p>
        </div>
        <div className="card sec-section">
          <h2>Report a security issue</h2>
          <p className="muted">
            Found a bug or a vulnerability? Send it privately to{' '}
            <a href={X_URL} {...ext}>
              @KINUonNEAR
            </a>{' '}
            on X
            {SECURITY_EMAIL && (
              <>
                {' '}
                or <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>
              </>
            )}
            : what you found, the steps to reproduce it, and the page or transaction. You get a reply within 48 hours.
          </p>
          <p className="muted small">
            Please don’t post a working exploit publicly or use it beyond what proves the issue. With your permission we credit you
            in the fix. There is no paid bug bounty yet.
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
