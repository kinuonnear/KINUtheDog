// Deposit from any chain (/deposit): bring USDC, USDT, ETH, SOL, BTC … from Base, Solana, Ethereum,
// Tron and 30+ chains onto NEAR through NEAR Intents (lib/intents.js). The user picks what they have,
// reviews the quote, gets a one-time deposit address (shown only when 1Click's signature on it
// checks out), sends from any wallet or exchange, and the funds arrive in their NEAR account as
// NEAR or USDC; a failed swap goes back to their refund address. KINU never holds the funds.

import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { useApp } from '../state.jsx';
import { useAsync, useClickOutside, useDebounced, useLocalStorage } from '../hooks.js';
import { Link } from '../router.jsx';
import {
  ADDRESS_HINT,
  CHAIN_NAMES,
  assetLogos,
  chainLogos,
  depositQuote,
  depositStatus,
  FINAL_STATUSES,
  getAssetIcons,
  getDepositAssets,
  getShieldStatus,
  getWithdrawAssets,
  SUPPORT,
  buildWithdrawTransactions,
  crossQuote,
  withdrawQuote,
  RECEIVE,
  RECEIVE_ICONS,
  submitDepositTx
} from '../lib/intents.js';
import { formatAmount, formatUnits, formatUsd, toBigInt, tryParseUnits } from '../lib/format.js';
import { wrapNeededFor } from '../lib/tx.js';
import { viewAccount } from '../lib/rpc.js';
import { CONTRACTS, ENDPOINTS, NEAR_GAS_RESERVE } from '../config.js';
import { AmountInput, CopyButton, ErrorNotice, Modal, Skeleton, Spinner } from '../components/ui.jsx';
import { KINU_FEE_BPS, KINU_FEE_STABLE_BPS, feePercent, kinuFeeBps } from '../lib/intentsFees.js';
import DepositHero from '../components/DepositHero.jsx';
import { FlowLines } from '../components/FlowLines.jsx';
import '../deposit.css';
import PageIcon from '../components/PageIcon.jsx';
import PayFromWallet from '../components/PayFromWallet.jsx';

const ACTIVE_KEY = 'kinu.deposit.active';
const ACTIVE_W_KEY = 'kinu.withdraw.active';
const ACTIVE_X_KEY = 'kinu.cross.active';
const MODE_KEY = 'kinu.bridge.mode';
const WNEAR_ID = CONTRACTS.wrapNear;
const STATUS_POLL_MS = 5_000;
// Below this much native NEAR a new account can't pay gas for its first LP or swap.
const LOW_GAS_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
// Above this the page suggests trying a small amount first (a reminder, not a limit).
const LARGE_USD = 1_000;
const TERMS_URL = 'https://docs.near-intents.org/security-compliance/terms-of-service';

const HOW_BRING = [
  { title: 'Pick what you have', text: 'The chain and asset your money is on now, and whether it lands as NEAR or USDC.' },
  { title: 'Review a signed quote', text: 'KINU asks NEAR Intents for a one-time deposit address and checks its signature.' },
  { title: 'Send, and it lands', text: 'Send the exact amount from any wallet or exchange. It reaches your NEAR account in about a minute.' }
];
const HOW_SEND = [
  { title: 'Pick where it goes', text: 'What to send from NEAR, the chain and asset it arrives as, and the address there.' },
  { title: 'Review a signed quote', text: 'When you sign, KINU fetches a fresh quote from NEAR Intents and checks its signature.' },
  { title: 'Sign once, it arrives', text: 'One wallet request sends it to NEAR Intents; it lands on the other chain in about a minute.' }
];

const chainName = (id) => CHAIN_NAMES[id] || id.toUpperCase();
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * Whether a typed NEAR account can receive a deposit: implicit accounts (64-hex, 0x…) always can;
 * a named one must exist. null when the RPC can't tell right now (the form doesn't block on that).
 */
async function nearAccountExists(id) {
  if (/^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id)) return true;
  if (id.length < 2 || id.length > 64 || !NEAR_ACCOUNT.test(id)) return false;
  try {
    await viewAccount(id);
    return true;
  } catch (error) {
    return error.rpc?.cause?.name === 'UNKNOWN_ACCOUNT' || /does not exist/i.test(error.message) ? false : null;
  }
}
const NO_INCIDENTS = { chains: new Set(), items: [] };
const SHIELD_POLL_MS = 60_000;
const sinceText = (iso) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/**
 * NEAR Intents' own incident flag, top right of the page: while Shield has an incident open on a
 * chain or bridge, transfers there are paused until it is resolved. Opens a list of what is paused.
 */
function ShieldBadge({ shield }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const count = shield.items.length;
  if (!count) {
    return (
      <a className="dep-shield dep-shield--ok" href={SUPPORT.status} target="_blank" rel="noopener noreferrer">
        <i /> All networks running
      </a>
    );
  }
  return (
    <div className="dep-shield-wrap" ref={ref}>
      <button type="button" className="dep-shield dep-shield--warn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span aria-hidden="true">⚠</span> {count === 1 ? `${shield.items[0].label} paused` : `${count} networks paused`}
      </button>
      {open && (
        <div className="dep-shield__panel">
          <b>Paused by NEAR Intents</b>
          <p className="muted small">Deposits, withdrawals and swaps on these wait until the incident is resolved. Funds already sent are not lost: they continue or are refunded.</p>
          <ul>
            {shield.items.map((i) => (
              <li key={i.id}>
                <span>
                  <Logo src={i.chain ? chainLogos(i.chain) : []} name={i.label} size={18} />
                  {i.label}
                </span>
                <small className="muted">since {sinceText(i.since)}</small>
              </li>
            ))}
          </ul>
          <a href={SUPPORT.status} target="_blank" rel="noopener noreferrer" className="small">
            Live status on NEAR Intents ↗
          </a>
        </div>
      )}
    </div>
  );
}

/** Shown under the form when the chosen chain is paused. */
function PausedNote({ chain, shield }) {
  if (!shield.chains.has(chain)) return null;
  return (
    <p className="dep-note">
      ⚠ NEAR Intents has paused {chainName(chain)} for now. Transfers there wait until the incident is resolved: pick another chain, or{' '}
      <a href={SUPPORT.status} target="_blank" rel="noopener noreferrer">
        check its status ↗
      </a>
      .
    </p>
  );
}

/** Help for one transfer: follow it on NEAR Intents' explorer, and what to send their support. */
function TransferHelp({ active, state, details }) {
  const report = [
    `KINU Bridge transfer (${active.kind === 'withdraw' ? 'NEAR → ' + chainName(active.toChain) : chainName(active.chain) + ' → ' + (active.to ? chainName(active.to.chain) : 'NEAR')})`,
    `Deposit address: ${active.depositAddress}`,
    active.depositMemo ? `Memo: ${active.depositMemo}` : null,
    active.kind === 'withdraw'
      ? `Amount: ${active.amountInFormatted} ${active.fromSymbol} from ${active.account} → ${active.toSymbol} to ${active.recipient}`
      : `Amount: ${active.amountInFormatted} ${active.symbol} on ${chainName(active.chain)} → ${active.recipient} (refund to ${active.refundTo})`,
    `Status: ${state}`,
    details.originChainTxHashes?.[0]?.hash ? `Origin tx: ${details.originChainTxHashes[0].hash}` : null,
    details.nearTxHashes?.length ? `NEAR tx: ${details.nearTxHashes.join(', ')}` : null,
    `Started: ${new Date(active.createdAt).toISOString()}`,
    `Explorer: ${SUPPORT.explorer(active.depositAddress)}`
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <details className="dep-help">
      <summary>Need help with this transfer?</summary>
      <div className="dep-help__body">
        <p className="muted small">
          KINU never holds your funds, so it can&apos;t move them; NEAR Intents can. Most delays clear on their own: a transfer that can&apos;t complete is refunded
          {active.kind === 'withdraw' ? ' to your NEAR account' : ' to your refund address'}. If it has been over an hour, contact NEAR Intents support with the details below.
        </p>
        <div className="dep-help__links">
          <a className="button button--outline button--sm" href={SUPPORT.explorer(active.depositAddress)} target="_blank" rel="noopener noreferrer">
            Track on NEAR Intents Explorer ↗
          </a>
          <CopyButton text={report} label="Copy support details" />
        </div>
        <ol className="dep-help__steps">
          <li>
            Copy the support details above (deposit address, amounts, transactions).
          </li>
          <li>
            Open{' '}
            <a href={SUPPORT.chat} target="_blank" rel="noopener noreferrer">
              near.com ↗
            </a>{' '}
            and use the chat button (bottom right) → <i>Ask</i>, or search the{' '}
            <a href={SUPPORT.helpCenter} target="_blank" rel="noopener noreferrer">
              NEAR Intents help centre ↗
            </a>
            .
          </li>
          <li>
            Check the{' '}
            <a href={SUPPORT.status} target="_blank" rel="noopener noreferrer">
              network status ↗
            </a>
            : a paused chain explains most delays.
          </li>
        </ol>
      </div>
    </details>
  );
}
/** "72h 29m" / "9:41" — 1Click deposit addresses can stay open for days. */
const timeLeft = (ms) => {
  const minutes = Math.floor(ms / 60000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
};

/**
 * A logo: `src` is one URL or a list tried in order (the next on a failed load), then the name's
 * initial on a soft disc. KINU's vector logos (/logos) show as they are; image fallbacks are round.
 */
function Logo({ src, name, size = 28, badge }) {
  const list = (Array.isArray(src) ? src : [src]).filter(Boolean);
  const listKey = list.join('|');
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [listKey]);
  const url = list[index];
  return (
    <span className="dep-logo" style={{ width: size, height: size }}>
      {url ? (
        <img key={url} src={url} alt="" width={size} height={size} loading="lazy" className={url.startsWith('/logos/') ? 'is-vector' : ''} onError={() => setIndex((i) => i + 1)} />
      ) : (
        <i>{String(name || '?').slice(0, 1)}</i>
      )}
      {badge && (
        <span className="dep-logo__badge" style={{ width: size * 0.48, height: size * 0.48 }}>
          {badge}
        </span>
      )}
    </span>
  );
}

/** A select with logos and search, in a popover. `options`: [{ value, label, sub, icon }]. */
function Picker({ label, value, options, onChange, searchPlaceholder }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const current = options.find((o) => o.value === value) || options[0];
  const shown = q ? options.filter((o) => `${o.label} ${o.sub || ''}`.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <div className="dep-picker" ref={ref}>
      <span className="dep-label">{label}</span>
      <button type="button" className="dep-picker__btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {current && <Logo src={current.icon} name={current.label} size={26} />}
        <span className="dep-picker__text">
          <b>{current?.label}</b>
          {current?.sub && <small>{current.sub}</small>}
        </span>
        <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="dep-picker__panel" role="listbox">
          <input autoFocus placeholder={searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="dep-picker__list">
            {shown.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={o.value === value ? 'is-on' : ''}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  setQ('');
                }}
              >
                <Logo src={o.icon} name={o.label} size={24} />
                <span>
                  <b>{o.label}</b>
                  {o.sub && <small>{o.sub}</small>}
                </span>
                {o.value === value && <em>✓</em>}
              </button>
            ))}
            {!shown.length && <p className="muted small">Nothing matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The deposit address as a QR code, drawn as SVG squares. */
function Qr({ text }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const rects = [];
    for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) rects.push(`M${c} ${r}h1v1h-1z`);
    return { n, d: rects.join('') };
  }, [text]);
  return (
    <svg className="dep-qr" viewBox={`-2 -2 ${cells.n + 4} ${cells.n + 4}`} role="img" aria-label="Deposit address QR code" shapeRendering="crispEdges">
      <rect x="-2" y="-2" width={cells.n + 4} height={cells.n + 4} fill="#fff" rx="1.5" />
      <path d={cells.d} fill="#05080d" />
    </svg>
  );
}

const STEPS = [
  { key: 'PENDING_DEPOSIT', label: 'Waiting for your deposit' },
  { key: 'KNOWN_DEPOSIT_TX', label: 'Deposit seen' },
  { key: 'PROCESSING', label: 'Moving it to NEAR' },
  { key: 'SUCCESS', label: 'Arrived on NEAR' }
];

/** The live deposit: where to send (address, QR), a countdown, its progress, and what arrived. */
function ActiveDeposit({ active, icons, shield, onDone }) {
  const [now, setNow] = useState(Date.now());
  const [txHash, setTxHash] = useState('');
  const [sent, setSent] = useState(null);
  const status = useAsync(() => depositStatus(active.depositAddress, active.depositMemo), [active.depositAddress], {
    refreshMs: STATUS_POLL_MS
  });
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const state = status.data?.status || 'PENDING_DEPOSIT';
  const details = status.data?.swapDetails || {};
  const final = FINAL_STATUSES.has(state);
  const left = Math.max(0, new Date(active.deadline).getTime() - now);
  const expired = left === 0 && state === 'PENDING_DEPOSIT';
  const stepIndex = Math.max(0, STEPS.findIndex((s) => s.key === state));
  // What arrives where: a deposit lands on NEAR as NEAR/USDC; an any-chain transfer on active.to.chain.
  const dest = active.to || { symbol: RECEIVE[active.receive].symbol, logos: [RECEIVE_ICONS[active.receive]], chain: 'near', near: active.receive };
  const steps = dest.chain === 'near' ? STEPS : STEPS.map((s) => (s.key === 'PROCESSING' ? { ...s, label: `Moving it to ${chainName(dest.chain)}` } : s.key === 'SUCCESS' ? { ...s, label: `Arrived on ${chainName(dest.chain)}` } : s));

  const submit = async () => {
    try {
      await submitDepositTx(active.depositAddress, txHash, active.depositMemo);
      setSent('ok');
    } catch (error) {
      setSent(error.message);
    }
  };

  return (
    <section className="card dep-card dep-active">
      {!final && !expired && (
        <>
          <div className="dep-send">
            <Logo src={active.logos || []} name={active.symbol} size={44} badge={<Logo src={chainLogos(active.chain)} name={chainName(active.chain)} size={20} />} />
            <div>
              <span className="dep-label">Send exactly</span>
              <strong>
                {active.amountInFormatted} {active.symbol}
              </strong>
              <small className="muted">on {chainName(active.chain)}</small>
            </div>
          </div>
          <div className="dep-addr-wrap">
            <Qr text={active.depositAddress} />
            <div className="dep-addr-side">
              <span className="dep-label">To this one-time address</span>
              <code className="dep-addr">{active.depositAddress}</code>
              <div className="dep-addr-actions">
                <CopyButton text={active.depositAddress} label="Copy address" />
                <span className="dep-verified" title="1Click's signature on this quote and address checks out">
                  ✓ Verified by NEAR Intents
                </span>
              </div>
              {active.depositMemo && (
                <div className="dep-memo">
                  <span>Memo — required</span>
                  <code>{active.depositMemo}</code>
                  <CopyButton text={active.depositMemo} label="Copy memo" />
                </div>
              )}
              <small className="muted">
                Only {active.symbol} on {chainName(active.chain)}. This address is for this deposit only{left > 0 ? ` · expires in ${timeLeft(left)}` : ''}.
              </small>
            </div>
          </div>
          {state === 'PENDING_DEPOSIT' && (
            <PayFromWallet active={active} chainLabel={chainName(active.chain)} onPaid={(hash) => setSent(hash ? 'ok' : null)} />
          )}
        </>
      )}

      <ol className="dep-steps">
        {steps.map((s, i) => (
          <li key={s.key} className={i < stepIndex || state === 'SUCCESS' ? 'done' : i === stepIndex && !final ? 'on' : ''}>
            <i>{i < stepIndex || state === 'SUCCESS' ? '✓' : i + 1}</i>
            {s.label}
          </li>
        ))}
      </ol>

      {state === 'SUCCESS' && (
        <div className="dep-result dep-result--ok">
          <Logo src={dest.logos} name={dest.symbol} size={36} />
          <div>
            <b>
              {details.amountOutFormatted ? `${formatAmount(Number(details.amountOutFormatted))} ${dest.symbol}` : dest.symbol} landed in {active.recipient}
              {dest.chain !== 'near' ? ` on ${chainName(dest.chain)}` : ''}
            </b>
            <small className="muted">
              {details.amountOutUsd ? `≈ ${formatUsd(Number(details.amountOutUsd))}` : ''}
              {dest.near === 'near' ? ' · as wNEAR, used directly by KINU pools and swaps' : ''}
            </small>
            {dest.chain !== 'near' && (details.destinationChainTxHashes || [])[0]?.explorerUrl && (
              <a href={details.destinationChainTxHashes[0].explorerUrl} target="_blank" rel="noopener noreferrer" className="small">
                View on {chainName(dest.chain)} explorer ↗
              </a>
            )}
            {dest.chain === 'near' && (
            <div className="dep-next">
              <Link to="/pools" className="button button--primary button--sm">
                Put it to work · Provide liquidity
              </Link>
              <Link to="/swap" className="button button--outline button--sm">
                Swap
              </Link>
            </div>
            )}
          </div>
        </div>
      )}
      {(state === 'REFUNDED' || state === 'FAILED' || state === 'INCOMPLETE_DEPOSIT') && (
        <div className="dep-result dep-result--warn">
          <div>
            <b>{state === 'REFUNDED' ? 'Refunded' : state === 'FAILED' ? 'The swap failed' : 'Deposit smaller than quoted'}</b>
            <small>
              {state === 'INCOMPLETE_DEPOSIT'
                ? 'Less than the quoted amount arrived. Send the rest to the same address before it expires, or it is refunded.'
                : `${details.refundedAmountFormatted ? `${details.refundedAmountFormatted} ${active.symbol} ` : 'The deposit '}went back to ${active.refundTo}.${details.refundReason ? ` Reason: ${details.refundReason}.` : ''}`}
            </small>
          </div>
        </div>
      )}
      {expired && <div className="dep-result dep-result--warn">This deposit address expired before anything arrived. Start a new deposit; don&apos;t send to this one.</div>}

      {!final && !expired && (
        <div className="dep-tx">
          <label htmlFor="dep-tx">Already sent? Paste the transaction hash to speed it up (optional)</label>
          <div>
            <input id="dep-tx" value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Transaction hash" spellCheck={false} />
            <button type="button" className="button button--outline button--sm" disabled={!txHash.trim()} onClick={submit}>
              Submit
            </button>
          </div>
          {sent && <small className={sent === 'ok' ? 'up' : 'down'}>{sent === 'ok' ? 'Received: it is being tracked.' : sent}</small>}
        </div>
      )}

      {details.nearTxHashes?.length > 0 && (
        <p className="muted small dep-txs">
          On NEAR:{' '}
          {details.nearTxHashes.slice(-2).map((h) => (
            <a key={h} href={`${ENDPOINTS.explorer}/txns/${h}`} target="_blank" rel="noopener noreferrer">
              {h.slice(0, 8)}… ↗{' '}
            </a>
          ))}
        </p>
      )}
      {status.error && <p className="muted small">Status unavailable right now: {status.error.message}</p>}
      {!final && <PausedNote chain={active.chain} shield={shield} />}
      <TransferHelp active={{ ...active, kind: 'deposit' }} state={expired ? 'EXPIRED' : state} details={details} />

      <button type="button" className="button button--ghost button--sm dep-new" onClick={onDone}>
        {final || expired ? 'New transfer' : 'Cancel and start over (only if you have not sent anything)'}
      </button>
    </section>
  );
}

const W_STEPS = [
  { key: 'PENDING_DEPOSIT', label: 'Waiting for your transfer on NEAR' },
  { key: 'KNOWN_DEPOSIT_TX', label: 'Transfer seen' },
  { key: 'PROCESSING', label: 'Moving it to the other chain' },
  { key: 'SUCCESS', label: 'Arrived' }
];

/** A withdrawal after signing: where it goes and its progress. */
function ActiveWithdraw({ active, shield, onDone }) {
  const status = useAsync(() => depositStatus(active.depositAddress, active.depositMemo), [active.depositAddress], {
    refreshMs: STATUS_POLL_MS
  });
  const state = status.data?.status || 'PENDING_DEPOSIT';
  const details = status.data?.swapDetails || {};
  const final = FINAL_STATUSES.has(state);
  const stepIndex = Math.max(0, W_STEPS.findIndex((s) => s.key === state));
  const out = (details.destinationChainTxHashes || [])[0];
  return (
    <section className="card dep-card dep-active">
      <div className="dep-send">
        <Logo src={active.toLogos || []} name={active.toSymbol} size={44} badge={<Logo src={chainLogos(active.toChain)} name={chainName(active.toChain)} size={20} />} />
        <div>
          <span className="dep-label">Sent from {active.account}</span>
          <strong>
            {active.amountInFormatted} {active.fromSymbol} → ≈ {formatAmount(Number(active.amountOutFormatted))} {active.toSymbol}
          </strong>
          <small className="muted">
            to <span className="dep-mono">{active.recipient}</span> on {chainName(active.toChain)}
          </small>
        </div>
      </div>
      <ol className="dep-steps">
        {W_STEPS.map((s, i) => (
          <li key={s.key} className={i < stepIndex || state === 'SUCCESS' ? 'done' : i === stepIndex && !final ? 'on' : ''}>
            <i>{i < stepIndex || state === 'SUCCESS' ? '✓' : i + 1}</i>
            {s.label}
          </li>
        ))}
      </ol>
      {state === 'SUCCESS' && (
        <div className="dep-result dep-result--ok">
          <Logo src={active.toLogos || []} name={active.toSymbol} size={36} />
          <div>
            <b>
              {details.amountOutFormatted ? formatAmount(Number(details.amountOutFormatted)) : '≈ ' + formatAmount(Number(active.amountOutFormatted))} {active.toSymbol} arrived on {chainName(active.toChain)}
            </b>
            <small className="muted">
              at {active.recipient}
              {details.amountOutUsd ? ` · ≈ ${formatUsd(Number(details.amountOutUsd))}` : ''}
            </small>
            {out?.explorerUrl && (
              <a href={out.explorerUrl} target="_blank" rel="noopener noreferrer" className="small">
                View on {chainName(active.toChain)} explorer ↗
              </a>
            )}
          </div>
        </div>
      )}
      {(state === 'REFUNDED' || state === 'FAILED' || state === 'INCOMPLETE_DEPOSIT') && (
        <div className="dep-result dep-result--warn">
          <div>
            <b>{state === 'REFUNDED' ? 'Refunded to your NEAR account' : state === 'FAILED' ? 'The withdrawal failed' : 'Less than quoted arrived'}</b>
            <small>
              {state === 'INCOMPLETE_DEPOSIT'
                ? 'The transfer was smaller than the quote; it will be refunded to your NEAR account if not completed.'
                : `${details.refundedAmountFormatted ? `${details.refundedAmountFormatted} ${active.fromSymbol} ` : 'The amount '}went back to ${active.account}.${details.refundReason ? ` Reason: ${details.refundReason}.` : ''}`}
            </small>
          </div>
        </div>
      )}
      {status.error && <p className="muted small">Status unavailable right now: {status.error.message}</p>}
      {details.nearTxHashes?.length > 0 && (
        <p className="muted small dep-txs">
          On NEAR:{' '}
          {details.nearTxHashes.slice(-2).map((h) => (
            <a key={h} href={`${ENDPOINTS.explorer}/txns/${h}`} target="_blank" rel="noopener noreferrer">
              {h.slice(0, 8)}… ↗{' '}
            </a>
          ))}
        </p>
      )}
      {!final && <PausedNote chain={active.toChain} shield={shield} />}
      <TransferHelp active={active} state={state} details={details} />
      <button type="button" className="button button--ghost button--sm dep-new" onClick={onDone}>
        {final ? 'New transfer' : 'Hide (it keeps going; you can track it on NEAR Intents)'}
      </button>
    </section>
  );
}

/** Spendable raw balance of a NEAR asset (NEAR counts native NEAR, minus a gas reserve, plus wNEAR). */
function spendableOf(asset, balances, nearBalance) {
  if (!asset) return 0n;
  const token = toBigInt(balances?.[asset.contractAddress] || '0');
  if (asset.contractAddress !== WNEAR_ID) return token;
  const native = nearBalance ? toBigInt(nearBalance.available) - toBigInt(NEAR_GAS_RESERVE) : 0n;
  return token + (native > 0n ? native : 0n);
}

/** Withdraw: from the connected NEAR account to an address on another chain. */
function WithdrawForm({ destinations, icons, shield, onStarted }) {
  const { accountId, connect, balances, nearBalance, execute } = useApp();
  const sources = useAsync(() => getWithdrawAssets(), []);
  const [fromId, setFromId] = useState('');
  const [amount, setAmount] = useState('');
  const [chain, setChain] = useState('base');
  const [toId, setToId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  const fromList = sources.data || [];
  const from = fromList.find((t) => t.assetId === fromId) || fromList[0] || null;
  const chains = useMemo(() => [...new Set(destinations.map((t) => t.blockchain))], [destinations]);
  const chainAssets = useMemo(() => destinations.filter((t) => t.blockchain === chain), [destinations, chain]);
  const to = chainAssets.find((t) => t.assetId === toId) || chainAssets[0] || null;
  const raw = from ? tryParseUnits(amount || '0', from.decimals) || '0' : '0';
  const spendable = spendableOf(from, balances, nearBalance);
  const tooMuch = accountId && toBigInt(raw) > spendable;
  const paused = shield.chains.has(chain);
  const ready = Boolean(accountId && from && to && toBigInt(raw) > 0n && !tooMuch && recipient.trim() && !paused);
  const formKey = [from?.assetId, raw, to?.assetId, recipient.trim(), accountId].join('|');
  useEffect(() => {
    setReviewing(false);
    setAgreed(false);
  }, [formKey]);
  const key = useDebounced(formKey, 600);
  const preview = useAsync(() => withdrawQuote({ fromAsset: from, toAsset: to, amount: raw, recipient, account: accountId, dry: true }), [key], {
    enabled: ready && key === formKey
  });
  const q = preview.data;
  const usdIn = from ? Number(amount || 0) * (from.price || 0) : 0;
  const feeBps = kinuFeeBps(from?.symbol, to?.symbol);

  if (!accountId) {
    return (
      <div className="dep-connect">
        <p>Connect your NEAR wallet to send NEAR, USDC or other tokens to Base, Solana, Ethereum and 30+ chains.</p>
        <button type="button" className="button button--primary button--lg" onClick={connect}>
          Connect wallet
        </button>
      </div>
    );
  }
  if (sources.error) return <ErrorNotice error={sources.error} onRetry={sources.reload} />;
  if (!sources.data) return <Skeleton height={260} />;

  const sign = async () => {
    setBusy(true);
    let live = null;
    const outcomes = await execute(
      async () => {
        // A fresh, signed quote at the moment of signing; its deposit address is the only place
        // the guard lets these tokens go.
        live = await withdrawQuote({ fromAsset: from, toAsset: to, amount: raw, recipient, account: accountId, dry: false });
        const wrap = from.contractAddress === WNEAR_ID ? await wrapNeededFor(accountId, String(live.amountIn), balances?.[WNEAR_ID]) : '0';
        return buildWithdrawTransactions({ quote: live, fromAsset: from, accountId, wrap });
      },
      { pending: `Sending ${amount} ${from.symbol} to ${chainName(chain)}`, success: 'Sent: on its way to the other chain' }
    );
    setBusy(false);
    if (!outcomes || !live) return;
    const hash = outcomes[outcomes.length - 1]?.transaction?.hash;
    if (hash) submitDepositTx(live.depositAddress, hash, live.depositMemo).catch(() => {});
    onStarted({
      kind: 'withdraw',
      depositAddress: live.depositAddress,
      depositMemo: live.depositMemo || null,
      amountInFormatted: live.amountInFormatted,
      amountOutFormatted: live.amountOutFormatted,
      fromSymbol: from.symbol,
      toSymbol: to.symbol,
      toChain: to.blockchain,
      toLogos: assetLogos(to, icons),
      recipient: recipient.trim(),
      account: accountId,
      createdAt: Date.now()
    });
  };

  const fromOptions = fromList.map((t) => ({
    value: t.assetId,
    label: t.symbol,
    sub: `${formatAmount(Number(formatUnits(spendableOf(t, balances, nearBalance), t.decimals)))} on NEAR`,
    icon: t.contractAddress === WNEAR_ID ? [RECEIVE_ICONS.near] : assetLogos(t, icons)
  }));
  const chainOptions = chains.map((c) => ({ value: c, label: chainName(c), sub: shield.chains.has(c) ? '⚠ Paused by NEAR Intents' : '', icon: chainLogos(c) }));
  const toOptions = chainAssets.map((t) => ({ value: t.assetId, label: t.symbol, sub: t.price ? formatUsd(t.price) : '', icon: assetLogos(t, icons) }));
  const fromLogo = from?.contractAddress === WNEAR_ID ? [RECEIVE_ICONS.near] : assetLogos(from, icons);

  if (reviewing && q) {
    return (
      <div className="dep-review">
        <h3>Review your withdrawal</h3>
        <div className="dep-review__flow">
          <div>
            <Logo src={fromLogo} name={from.symbol} size={40} badge={<Logo src={chainLogos('near')} name="NEAR" size={18} />} />
            <b>
              {amount} {from.symbol}
            </b>
            <small>from {accountId}</small>
          </div>
          <span className="dep-review__arrow">→</span>
          <div>
            <Logo src={assetLogos(to, icons)} name={to.symbol} size={40} badge={<Logo src={chainLogos(chain)} name={chainName(chain)} size={18} />} />
            <b>
              ≈ {formatAmount(Number(q.amountOutFormatted))} {to.symbol}
            </b>
            <small>on {chainName(chain)}</small>
          </div>
        </div>
        <div className="dep-recipient">
          <span className="dep-label">Recipient on {chainName(chain)}</span>
          <code>{recipient.trim()}</code>
        </div>
        <dl className="kv">
          <div>
            <dt>Minimum received</dt>
            <dd>
              {q.minAmountOut ? formatAmount(Number(q.minAmountOut) / 10 ** to.decimals) : '—'} {to.symbol}
            </dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>≈ {q.timeEstimate || 60}s after your NEAR transaction</dd>
          </div>
          <div>
            <dt>Fees</dt>
            <dd>
              Included in the quote: {feePercent(feeBps)} service fee (shared by KINU and NEAR Intents)
            </dd>
          </div>
          <div>
            <dt>If it can&apos;t complete</dt>
            <dd>Refunded to {accountId}</dd>
          </div>
        </dl>
        <label className="dep-agree">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            The recipient above is my {chainName(chain)} address and can receive {to.symbol}. A transfer to a wrong address can&apos;t be undone.{' '}
            I accept the <Link to="/docs/terms">Terms</Link>, including the Bridge section.
          </span>
        </label>
        <div className="dep-review__actions">
          <button type="button" className="button button--outline" onClick={() => setReviewing(false)}>
            Back
          </button>
          <button type="button" className="button button--primary button--lg" disabled={!agreed || busy} onClick={sign}>
            {busy && <Spinner size={14} />} Sign in wallet
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="dep-field">
        <span className="dep-label">Send from NEAR</span>
        <div className="dep-amount">
          <Logo src={fromLogo} name={from?.symbol} size={30} badge={<Logo src={chainLogos('near')} name="NEAR" size={14} />} />
          <AmountInput placeholder="0.00" value={amount} onChange={(v) => setAmount(v.replace(/[^\d.]/g, ''))} />
          <button type="button" className="mini-button" onClick={() => setAmount(formatUnits(spendable, from.decimals))}>
            Max
          </button>
        </div>
        <div className="dep-amount-meta">
          <small className="muted">{usdIn > 0 ? `≈ ${formatUsd(usdIn)}` : ' '}</small>
          <small className={tooMuch ? 'down' : 'muted'}>
            Balance {formatAmount(Number(formatUnits(spendable, from.decimals)))} {from.symbol}
            {from.contractAddress === WNEAR_ID ? ' (keeps a little NEAR for gas)' : ''}
          </small>
        </div>
        <Picker label="Asset on NEAR" value={from?.assetId} options={fromOptions} searchPlaceholder="Search assets" onChange={setFromId} />
      </div>

      <div className="dep-row">
        <Picker
          label="To chain"
          value={chain}
          options={chainOptions}
          searchPlaceholder="Search chains"
          onChange={(c) => {
            setChain(c);
            setToId('');
          }}
        />
        <Picker label="Receive as" value={to?.assetId} options={toOptions} searchPlaceholder="Search assets" onChange={setToId} />
      </div>

      <label className="dep-field">
        <span className="dep-label">Recipient address on {chainName(chain)}</span>
        <input
          className="dep-input"
          placeholder={ADDRESS_HINT[chain] || `Your ${chainName(chain)} address (0x…)`}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          spellCheck={false}
        />
        <small className="muted">Where the {to?.symbol} arrives. Double-check it: a transfer to a wrong address can&apos;t be undone.</small>
      </label>

      <div className="dep-quote">
        {!ready && (
          <span className="muted small">
            {paused ? `${chainName(chain)} is paused by NEAR Intents.` : tooMuch ? 'More than your balance.' : 'Pick an asset, an amount and the recipient address to see the quote.'}
          </span>
        )}
        {ready && preview.loading && (
          <span className="muted small">
            <Spinner size={12} /> Getting a quote…
          </span>
        )}
        {ready && preview.error && <span className="down small">{/internal server error/i.test(preview.error.message)
            ? `NEAR Intents can't quote this. Check that both addresses are normal wallet addresses on their chains.`
            : /no liquidity/i.test(preview.error.message)
              ? `NEAR Intents can't swap ${from?.symbol} on ${chainName(fromChain)} into ${to?.symbol} right now. Try USDC, USDT or the chain's own coin.`
              : /not available/i.test(preview.error.message)
                ? 'This pair isn’t available right now. Try another token or chain.'
                : preview.error.message}</span>}
        {ready && q && !preview.loading && (
          <div className="dep-quote__row">
            <Logo src={assetLogos(to, icons)} name={to.symbol} size={34} />
            <div>
              <span className="dep-label">They receive</span>
              <strong>
                ≈ {formatAmount(Number(q.amountOutFormatted))} {to.symbol}
              </strong>
              <small className="muted">
                {formatUsd(Number(q.amountOutUsd))} on {chainName(chain)} · ≈ {q.timeEstimate || 60}s
                {` · incl. ${feePercent(feeBps)} fee`}
              </small>
            </div>
          </div>
        )}
      </div>

      <PausedNote chain={chain} shield={shield} />

      <button type="button" className="button button--primary button--block button--lg" disabled={!ready || !q || Boolean(preview.error) || preview.loading} onClick={() => setReviewing(true)}>
        {paused
          ? `${chainName(chain)} is paused for now`
          : !(toBigInt(raw) > 0n)
          ? 'Enter an amount'
          : tooMuch
            ? 'More than your balance'
            : !recipient.trim()
              ? `Add the ${chainName(chain)} recipient address`
              : preview.loading || !q
                ? 'Getting a quote…'
                : 'Review withdrawal'}
      </button>
    </>
  );
}

/** Any chain → any chain: send from one chain (not NEAR), receive on another, through a one-time deposit address. */
function CrossForm({ assets, icons, shield, onStarted }) {
  const [fromChain, setFromChain] = useState('base');
  const [fromId, setFromId] = useState('');
  const [toChain, setToChain] = useState('sol');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const fromList = useMemo(() => assets.filter((t) => t.blockchain === fromChain), [assets, fromChain]);
  const toList = useMemo(() => assets.filter((t) => t.blockchain === toChain), [assets, toChain]);
  const from = fromList.find((t) => t.assetId === fromId) || fromList[0] || null;
  const to = toList.find((t) => t.assetId === toId) || toList[0] || null;
  const raw = from ? tryParseUnits(amount || '0', from.decimals) || '0' : '0';
  const usdIn = from ? Number(amount || 0) * (from.price || 0) : 0;
  const paused = shield.chains.has(fromChain) || shield.chains.has(toChain);
  const sameAsset = Boolean(from && to && from.assetId === to.assetId);
  const ready = Boolean(from && to && !sameAsset && toBigInt(raw) > 0n && recipient.trim() && refundTo.trim() && !paused);

  const formKey = [from?.assetId, raw, to?.assetId, recipient.trim(), refundTo.trim()].join('|');
  useEffect(() => {
    setReviewing(false);
    setAgreed(false);
  }, [formKey]);
  const key = useDebounced(formKey, 600);
  const preview = useAsync(() => crossQuote({ fromAsset: from, toAsset: to, amount: raw, recipient, refundTo, dry: true }), [key], {
    enabled: ready && key === formKey
  });
  const q = preview.data;
  const feeBps = kinuFeeBps(from?.symbol, to?.symbol);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const live = await crossQuote({ fromAsset: from, toAsset: to, amount: raw, recipient, refundTo, dry: false });
      if (!live.depositAddress) throw new Error('No deposit address came back. Try again.');
      onStarted({
        depositAddress: live.depositAddress,
        depositMemo: live.depositMemo || null,
        deadline: live.deadline || live.request?.deadline,
        amountInFormatted: live.amountInFormatted,
        amountIn: String(live.amountIn),
        asset: { contractAddress: from.contractAddress || null, decimals: from.decimals },
        symbol: from.symbol,
        logos: assetLogos(from, icons),
        chain: from.blockchain,
        to: { symbol: to.symbol, logos: assetLogos(to, icons), chain: to.blockchain },
        recipient: recipient.trim(),
        refundTo: refundTo.trim(),
        createdAt: Date.now()
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (reviewing && q) {
    return (
      <div className="dep-review">
        <h3>Review your swap</h3>
        <div className="dep-review__flow">
          <div>
            <Logo src={assetLogos(from, icons)} name={from.symbol} size={40} badge={<Logo src={chainLogos(fromChain)} name={chainName(fromChain)} size={18} />} />
            <b>
              {amount} {from.symbol}
            </b>
            <small>on {chainName(fromChain)}</small>
          </div>
          <span className="dep-review__arrow">→</span>
          <div>
            <Logo src={assetLogos(to, icons)} name={to.symbol} size={40} badge={<Logo src={chainLogos(toChain)} name={chainName(toChain)} size={18} />} />
            <b>
              ≈ {formatAmount(Number(q.amountOutFormatted))} {to.symbol}
            </b>
            <small>on {chainName(toChain)}</small>
          </div>
        </div>
        <div className="dep-recipient">
          <span className="dep-label">Recipient on {chainName(toChain)}</span>
          <code>{recipient.trim()}</code>
        </div>
        <dl className="kv">
          <div>
            <dt>Refund to</dt>
            <dd className="dep-mono">{refundTo.trim()}</dd>
          </div>
          <div>
            <dt>Minimum received</dt>
            <dd>
              {q.minAmountOut ? formatAmount(Number(q.minAmountOut) / 10 ** to.decimals) : '—'} {to.symbol}
            </dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>≈ {q.timeEstimate || 60}s after your deposit confirms</dd>
          </div>
          <div>
            <dt>Fees</dt>
            <dd>Included in the quote: {feePercent(feeBps)} service fee (shared by KINU and NEAR Intents)</dd>
          </div>
        </dl>
        <label className="dep-agree">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            I&apos;ll send exactly {amount} {from.symbol}, only on {chainName(fromChain)}, to the one-time address shown next. The recipient can receive {to.symbol} on{' '}
            {chainName(toChain)} and the refund address is mine. I accept the <Link to="/docs/terms">Terms</Link>, including the Bridge section.
          </span>
        </label>
        {error && <p className="down small">{error.message}</p>}
        <div className="dep-review__actions">
          <button type="button" className="button button--outline" onClick={() => setReviewing(false)}>
            Back
          </button>
          <button type="button" className="button button--primary button--lg" disabled={!agreed || busy} onClick={start}>
            {busy && <Spinner size={14} />} Get deposit address
          </button>
        </div>
      </div>
    );
  }

  const pickFrom = (t) => {
    if (t.blockchain !== fromChain) setRefundTo('');
    setFromChain(t.blockchain);
    setFromId(t.assetId);
  };
  const pickTo = (t) => {
    if (t.blockchain !== toChain) setRecipient('');
    setToChain(t.blockchain);
    setToId(t.assetId);
  };
  const flip = () => {
    if (!from || !to) return;
    setFromChain(to.blockchain);
    setFromId(to.assetId);
    setToChain(from.blockchain);
    setToId(from.assetId);
    setRefundTo(recipient);
    setRecipient(refundTo);
    setAmount('');
  };
  // Until both addresses are in (1Click needs them for a quote), an estimate from the listed prices.
  const estimate = from?.price && to?.price && Number(amount) > 0 ? ((Number(amount) * from.price) / to.price) * (1 - feeBps / 10_000) : 0;
  const outText = q && ready && !preview.loading ? formatAmount(Number(q.amountOutFormatted)) : estimate ? formatAmount(estimate) : '';
  const outUsd = q && ready ? Number(q.amountOutUsd) : estimate * (to?.price || 0);

  return (
    <div className="xswap">
      <div className="swap-field">
        <div className="swap-field__top">
          <span>You pay</span>
          <span className="muted">on {chainName(fromChain)}</span>
        </div>
        <div className="swap-field__row">
          <AmountInput placeholder="0.0" value={amount} onChange={(v) => setAmount(v.replace(/[^\d.]/g, ''))} aria-label="You pay amount" />
          <AssetChainPicker side="pay" asset={from} assets={assets} icons={icons} shield={shield} onPick={pickFrom} />
        </div>
        <div className="swap-field__bottom">
          <span>{usdIn > 0 ? formatUsd(usdIn) : ' '}</span>
        </div>
      </div>

      <div className="swap-flip-wrap">
        <button type="button" className="swap-flip" onClick={flip} aria-label="Switch sides">
          ↓↑
        </button>
      </div>

      <div className="swap-field swap-field--readonly">
        <div className="swap-field__top">
          <span>You receive</span>
          <span className="muted">on {chainName(toChain)}</span>
        </div>
        <div className="swap-field__row">
          <AmountInput placeholder="0.0" value={outText.replace(/,/g, '')} readOnly aria-label="You receive amount" />
          <AssetChainPicker side="receive" asset={to} assets={assets} icons={icons} shield={shield} onPick={pickTo} />
        </div>
        <div className="swap-field__bottom">
          <span>{ready && preview.loading ? <Spinner size={12} /> : outUsd > 0 ? formatUsd(outUsd) : ' '}</span>
          {!(q && ready) && estimate > 0 && <span className="muted">estimate · add the addresses for a signed quote</span>}
        </div>
      </div>

      {usdIn >= LARGE_USD && <p className="dep-note">First time? Try a small amount first to see it arrive, then send the rest.</p>}

      <div className="xswap__addrs">
        <label className="xswap__addr">
          <span className="dep-label">Recipient on {chainName(toChain)}</span>
          <input className="dep-input" placeholder={ADDRESS_HINT[toChain] || `${chainName(toChain)} address (0x…)`} value={recipient} onChange={(e) => setRecipient(e.target.value)} spellCheck={false} />
        </label>
        <label className="xswap__addr">
          <span className="dep-label" title="If the swap can't complete, it goes back here. Use an address you control, not an exchange deposit address.">
            Refund on {chainName(fromChain)} ⓘ
          </span>
          <input className="dep-input" placeholder={ADDRESS_HINT[fromChain] || `Your ${chainName(fromChain)} address (0x…)`} value={refundTo} onChange={(e) => setRefundTo(e.target.value)} spellCheck={false} />
        </label>
      </div>

      {ready && preview.error && (
        <p className="down small">
          {/internal server error/i.test(preview.error.message) ? `NEAR Intents can't quote this. Check that both addresses are normal wallet addresses on their chains.` : preview.error.message}
        </p>
      )}
      {(q && ready) || estimate > 0 ? (
        <dl className="xswap__info">
          <div>
            <dt>Rate</dt>
            <dd>
              1 {from?.symbol} ≈ {formatAmount(q && ready ? Number(q.amountOutFormatted) / Number(amount) : estimate / Number(amount))} {to?.symbol}
            </dd>
          </div>
          <div>
            <dt>Fee</dt>
            <dd>{feePercent(feeBps)} (included)</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>≈ {(q && ready && q.timeEstimate) || 60}s</dd>
          </div>
        </dl>
      ) : null}

      <PausedNote chain={fromChain} shield={shield} />
      {toChain !== fromChain && <PausedNote chain={toChain} shield={shield} />}

      <button type="button" className="button button--primary button--block button--lg" disabled={!ready || !q || Boolean(preview.error) || preview.loading} onClick={() => setReviewing(true)}>
        {paused
          ? 'Paused for now'
          : sameAsset
            ? 'Pick a different asset to receive'
            : !(toBigInt(raw) > 0n)
              ? 'Enter an amount'
              : !recipient.trim()
                ? `Add the ${chainName(toChain)} recipient`
                : !refundTo.trim()
                  ? `Add your ${chainName(fromChain)} refund address`
                  : preview.loading || !q
                    ? 'Getting a quote…'
                    : 'Review swap'}
      </button>
    </div>
  );
}

const POPULAR_CHAINS = ['base', 'eth', 'sol', 'arb', 'bsc', 'btc'];
const QUICK_TOKENS = ['USDC', 'USDT', 'ETH', 'SOL', 'BTC'];
// Chains whose deposits need a mode KINU doesn't build yet (Stellar's memo, Hyperliquid's own rules):
// shown dimmed as "Soon" on that side of the swap.
const NOT_YET = { pay: new Set(['stellar', 'hypercore']), receive: new Set(['hypercore']) };
/** Why a chain can't be used on this side of the swap right now (null when it can). */
const unavailableReason = (chain, side, shield) => (shield.chains.has(chain) ? 'Paused' : NOT_YET[side]?.has(chain) ? 'Soon' : null);
const shortAddress = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');

/**
 * The token button of the swap widget. Opens a token picker like a cross-chain swap app: chains on
 * the left (search, all chains, popular, A–Z), tokens of the chosen chain on the right (search by
 * symbol, chain or contract; quick picks).
 */
function AssetChainPicker({ side, asset, assets, icons, shield, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="token-select xswap-token" onClick={() => setOpen(true)}>
        <Logo src={assetLogos(asset, icons)} name={asset?.symbol} size={26} badge={asset && <Logo src={chainLogos(asset.blockchain)} name={chainName(asset.blockchain)} size={13} />} />
        <span className="xswap-token__text">
          <strong>{asset?.symbol || 'Select'}</strong>
          {asset && <small>{chainName(asset.blockchain)}</small>}
        </span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <Modal title="Select token" onClose={() => setOpen(false)} width={760}>
          <TokenChainList
            side={side}
            current={asset}
            assets={assets}
            icons={icons}
            shield={shield}
            onPick={(t) => {
              onPick(t);
              setOpen(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}

function TokenChainList({ side, current, assets, icons, shield, onPick }) {
  const [chain, setChain] = useState(current?.blockchain || 'all');
  const [chainQ, setChainQ] = useState('');
  const [q, setQ] = useState('');
  const chains = useMemo(() => [...new Set(assets.map((t) => t.blockchain))], [assets]);
  const off = (c) => unavailableReason(c, side, shield);
  const az = [...chains].sort((a, b) => Boolean(off(a)) - Boolean(off(b)) || chainName(a).localeCompare(chainName(b)));
  const chainNeedle = chainQ.trim().toLowerCase();
  const chainHits = chainNeedle ? az.filter((c) => chainName(c).toLowerCase().includes(chainNeedle) || c.includes(chainNeedle)) : null;
  const needle = q.trim().toLowerCase();
  const tokens = assets
    .filter((t) => chain === 'all' || t.blockchain === chain)
    .filter((t) => !needle || `${t.symbol} ${chainName(t.blockchain)} ${t.contractAddress || ''}`.toLowerCase().includes(needle))
    .sort((a, b) => Boolean(off(a.blockchain)) - Boolean(off(b.blockchain)))
    .slice(0, 300);

  const chainRow = (c, group = '') => {
    const why = off(c);
    return (
      <button
        key={`${group}${c}`}
        type="button"
        className={`${c === chain ? 'is-on' : ''} ${why ? 'is-off' : ''}`}
        onClick={() => setChain(c)}
        title={why === 'Paused' ? 'Paused by NEAR Intents for now' : why ? 'Not supported here yet' : chainName(c)}
      >
        <Logo src={chainLogos(c)} name={chainName(c)} size={20} />
        <span>{chainName(c)}</span>
        {why && <em>{why}</em>}
      </button>
    );
  };

  return (
    <div className="tcp">
      <aside className="tcp__chains">
        <input placeholder="Search chains" value={chainQ} onChange={(e) => setChainQ(e.target.value)} />
        <div className="tcp__chain-list">
          {chainHits ? (
            chainHits.length ? chainHits.map((c) => chainRow(c)) : <p className="muted small">No chain matches.</p>
          ) : (
            <>
              <button type="button" className={chain === 'all' ? 'is-on' : ''} onClick={() => setChain('all')}>
                <span className="tcp__all" aria-hidden>
                  ◎
                </span>
                <span>All chains</span>
              </button>
              <small className="tcp__group">Popular</small>
              {POPULAR_CHAINS.filter((c) => chains.includes(c)).map((c) => chainRow(c, 'popular-'))}
              <small className="tcp__group">Chains A–Z</small>
              {az.map((c) => chainRow(c))}
            </>
          )}
        </div>
      </aside>
      <section className="tcp__tokens">
        <input autoFocus placeholder={`Search ${chain === 'all' ? 'all chains' : chainName(chain)}: token or contract`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="tcp__quick">
          {QUICK_TOKENS.map((s) => (
            <button key={s} type="button" className={q.toUpperCase() === s ? 'is-on' : ''} onClick={() => setQ(q.toUpperCase() === s ? '' : s)}>
              <Logo src={assetLogos({ symbol: s }, icons)} name={s} size={16} />
              {s}
            </button>
          ))}
        </div>
        <small className="tcp__group">{chain === 'all' ? 'All chains' : chainName(chain)}</small>
        <div className="tcp__token-list">
          {tokens.map((t) => {
            const why = off(t.blockchain);
            return (
            <button
              key={t.assetId}
              type="button"
              className={`${t.assetId === current?.assetId ? 'is-on' : ''} ${why ? 'is-off' : ''}`}
              disabled={Boolean(why)}
              title={why === 'Paused' ? `${chainName(t.blockchain)} is paused by NEAR Intents for now` : why ? `Not supported on this side yet` : undefined}
              onClick={() => onPick(t)}
            >
              <Logo src={assetLogos(t, icons)} name={t.symbol} size={30} badge={<Logo src={chainLogos(t.blockchain)} name={chainName(t.blockchain)} size={14} />} />
              <span className="tcp__token-name">
                <b>{t.symbol}</b>
                <small>
                  {chainName(t.blockchain)}
                  {t.contractAddress ? ` · ${shortAddress(t.contractAddress)}` : ' · native'}
                </small>
              </span>
              <span className="tcp__token-price">{why ? <em className="tcp__off">{why}</em> : t.price ? formatUsd(t.price) : ''}</span>
            </button>
            );
          })}
          {!tokens.length && <p className="muted small">Nothing matches.</p>}
        </div>
      </section>
    </div>
  );
}

export default function Deposit() {
  const { accountId, connect, nearBalance } = useApp();
  const assets = useAsync(() => getDepositAssets(), []);
  const icons = useAsync(() => getAssetIcons(assets.data), [Boolean(assets.data)], { enabled: Boolean(assets.data) }).data || {};
  const shield = useAsync(() => getShieldStatus(), [], { refreshMs: SHIELD_POLL_MS }).data || NO_INCIDENTS;
  const [active, setActive] = useLocalStorage(ACTIVE_KEY, null);
  const [activeW, setActiveW] = useLocalStorage(ACTIVE_W_KEY, null);
  const [activeX, setActiveX] = useLocalStorage(ACTIVE_X_KEY, null);
  const [mode, setMode] = useLocalStorage(MODE_KEY, 'deposit');
  const [chain, setChain] = useState('base');
  const [assetId, setAssetId] = useState('');
  const [amount, setAmount] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [receive, setReceive] = useState('near');
  const [recipientInput, setRecipientInput] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const list = assets.data || [];
  const chains = useMemo(() => [...new Set(list.map((t) => t.blockchain))], [list]);
  const chainAssets = useMemo(() => list.filter((t) => t.blockchain === chain), [list, chain]);
  const asset = chainAssets.find((t) => t.assetId === assetId) || chainAssets[0] || null;
  const recipient = accountId || recipientInput.trim().toLowerCase();
  const raw = asset ? tryParseUnits(amount || '0', asset.decimals) || '0' : '0';
  const usdIn = asset ? Number(amount || 0) * (asset.price || 0) : 0;
  const paused = shield.chains.has(chain);
  // A typed (not connected) NEAR account is checked to exist: a deposit to a typo can't come back.
  const typed = accountId ? '' : recipient;
  const typedKey = useDebounced(typed, 500);
  const accountCheck = useAsync(() => nearAccountExists(typedKey), [typedKey], { enabled: Boolean(typedKey) && typedKey === typed });
  const badAccount = Boolean(typed) && (typedKey !== typed || accountCheck.loading || accountCheck.data === false);
  const ready = Boolean(asset && toBigInt(raw) > 0n && refundTo.trim() && recipient && !paused && !badAccount);

  // Changing anything after Review goes back to the form.
  const formKey = [asset?.assetId, raw, receive, recipient, refundTo.trim()].join('|');
  useEffect(() => {
    setReviewing(false);
    setAgreed(false);
  }, [formKey]);

  // A price preview (dry quote) while the form is complete.
  const key = useDebounced(formKey, 600);
  const preview = useAsync(() => depositQuote({ asset, amount: raw, receive, recipient, refundTo, dry: true }), [key], {
    enabled: ready && key === formKey
  });

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const q = await depositQuote({ asset, amount: raw, receive, recipient, refundTo, dry: false });
      if (!q.depositAddress) throw new Error('No deposit address came back. Try again.');
      setActive({
        depositAddress: q.depositAddress,
        depositMemo: q.depositMemo || null,
        deadline: q.deadline || q.request?.deadline,
        amountInFormatted: q.amountInFormatted,
        amountIn: String(q.amountIn),
        asset: { contractAddress: asset.contractAddress || null, decimals: asset.decimals },
        symbol: asset.symbol,
        logos: assetLogos(asset, icons),
        chain: asset.blockchain,
        receive,
        recipient,
        refundTo: refundTo.trim(),
        createdAt: Date.now()
      });
      setReviewing(false);
      setAgreed(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const lowGas = receive === 'near' && accountId && nearBalance && toBigInt(nearBalance.available) < LOW_GAS_YOCTO;
  const q = preview.data;
  const feeBps = kinuFeeBps(asset?.symbol, RECEIVE[receive].symbol);
  const chainOptions = chains.map((c) => ({ value: c, label: chainName(c), sub: shield.chains.has(c) ? '⚠ Paused by NEAR Intents' : '', icon: chainLogos(c) }));
  const assetOptions = chainAssets.map((t) => ({
    value: t.assetId,
    label: t.symbol,
    sub: t.price ? formatUsd(t.price) : '',
    icon: assetLogos(t, icons)
  }));

  return (
    <div className="page deposit">
      <header className="pt-hero dep-hero">
        <FlowLines />
        <ShieldBadge shield={shield} />
        <div className="dep-hero__copy">
          <h1 className="pt-title">
            <PageIcon name="bridge" />
            Bridge
          </h1>
          <p>
            Any chain ⇄ NEAR, or any chain ⇄ any chain. Move USDC, USDT, ETH, SOL and BTC across {chains.length || 36} chains in about a minute, through NEAR Intents. Pay straight from MetaMask or Phantom.
          </p>
          <div className="dep-hero__stats">
            <span>
              <b>{chains.length || 36}</b> chains
            </span>
            <span>
              <b>~30s</b> average
            </span>
            <span>
              <b>✓</b> Signed quotes
            </span>
            <span>
              <b>0</b> Custody
            </span>
          </div>
        </div>
        <DepositHero chainCount={chains.length} />
      </header>

      <div className="dep-grid">
        <div className="dep-main">
          <div className="segmented segmented--full dep-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode !== 'withdraw'} className={mode !== 'withdraw' ? 'active' : ''} onClick={() => setMode('deposit')}>
              ↓ Deposit
            </button>
            <button type="button" role="tab" aria-selected={mode === 'withdraw'} className={mode === 'withdraw' ? 'active' : ''} onClick={() => setMode('withdraw')}>
              ↑ Withdraw
            </button>
          </div>
        {mode === 'withdraw' ? (
          activeW ? (
            <ActiveWithdraw active={activeW} shield={shield} onDone={() => setActiveW(null)} />
          ) : (
            <section className="card dep-card dep-form">
              <WithdrawForm destinations={list} icons={icons} shield={shield} onStarted={setActiveW} />
            </section>
          )
        ) : active ? (
          <ActiveDeposit active={active} icons={icons} shield={shield} onDone={() => setActive(null)} />
        ) : (
          <section className="card dep-card dep-form">
            {assets.error && <ErrorNotice error={assets.error} onRetry={assets.reload} />}
            {!assets.data && !assets.error && <Skeleton height={260} />}
            {assets.data && !reviewing && (
              <>
                <div className="dep-row">
                  <Picker
                    label="From"
                    value={chain}
                    options={chainOptions}
                    searchPlaceholder="Search chains"
                    onChange={(c) => {
                      setChain(c);
                      setAssetId('');
                    }}
                  />
                  <Picker label="Asset" value={asset?.assetId} options={assetOptions} searchPlaceholder="Search assets" onChange={setAssetId} />
                </div>

                <div className="dep-field">
                  <span className="dep-label">Amount</span>
                  <div className="dep-amount">
                    <Logo src={assetLogos(asset, icons)} name={asset?.symbol} size={30} badge={<Logo src={chainLogos(chain)} name={chainName(chain)} size={14} />} />
                    <AmountInput autoFocus placeholder="0.00" value={amount} onChange={(v) => setAmount(v.replace(/[^\d.]/g, ''))} />
                    <span>{asset?.symbol}</span>
                  </div>
                  <small className="muted">{usdIn > 0 ? `≈ ${formatUsd(usdIn)}` : ' '}</small>
                  {usdIn >= LARGE_USD && <p className="dep-note">First time? Try a small amount first to see it arrive, then send the rest.</p>}
                </div>

                <label className="dep-field">
                  <span className="dep-label">Refund address on {chainName(chain)}</span>
                  <input
                    className="dep-input"
                    placeholder={ADDRESS_HINT[chain] || `Your ${chainName(chain)} address (0x…)`}
                    value={refundTo}
                    onChange={(e) => setRefundTo(e.target.value)}
                    spellCheck={false}
                  />
                  <small className="muted dep-hint">ⓘ If the swap can&apos;t complete, the deposit goes back here. Use an address you control, not an exchange deposit address.</small>
                </label>

                <div className="dep-field">
                  <span className="dep-label">Receive on NEAR as</span>
                  <div className="dep-receive">
                    {Object.values(RECEIVE).map((r) => (
                      <button key={r.key} type="button" className={receive === r.key ? 'is-on' : ''} onClick={() => setReceive(r.key)}>
                        <Logo src={RECEIVE_ICONS[r.key]} name={r.symbol} size={26} />
                        <span>
                          <b>{r.symbol}</b>
                          <small>{r.note}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="dep-field">
                  <span className="dep-label">To NEAR account</span>
                  {accountId ? (
                    <div className="dep-to">
                      <Logo src={RECEIVE_ICONS.near} name="NEAR" size={22} />
                      <b>{accountId}</b>
                      <small className="dep-connected">connected</small>
                    </div>
                  ) : (
                    <div className="dep-to">
                      <input className="dep-input" placeholder="yourname.near" value={recipientInput} onChange={(e) => setRecipientInput(e.target.value)} spellCheck={false} />
                      <button type="button" className="button button--outline button--sm" onClick={connect}>
                        Connect wallet
                      </button>
                    </div>
                  )}
                  {typed && typedKey === typed && accountCheck.data === false && (
                    <small className="down">There&apos;s no NEAR account called &quot;{typed}&quot;. Check the spelling, or connect your wallet.</small>
                  )}
                </div>

                <div className="dep-quote">
                  {!ready && (
                    <span className="muted small">
                      {paused ? `${chainName(chain)} is paused by NEAR Intents.` : `Enter an amount${refundTo.trim() ? '' : ' and your refund address'} to see what you receive.`}
                    </span>
                  )}
                  {ready && preview.loading && (
                    <span className="muted small">
                      <Spinner size={12} /> Getting a quote…
                    </span>
                  )}
                  {ready && preview.error && <span className="down small">{preview.error.message}</span>}
                  {ready && q && !preview.loading && (
                    <div className="dep-quote__row">
                      <Logo src={RECEIVE_ICONS[receive]} name={RECEIVE[receive].symbol} size={34} />
                      <div>
                        <span className="dep-label">You receive</span>
                        <strong>
                          ≈ {formatAmount(Number(q.amountOutFormatted))} {RECEIVE[receive].symbol}
                        </strong>
                        <small className="muted">
                          {formatUsd(Number(q.amountOutUsd))} · ≈ {q.timeEstimate || 60}s after your deposit confirms
                          {` · incl. ${feePercent(feeBps)} fee`}
                        </small>
                      </div>
                    </div>
                  )}
                </div>

                {lowGas && <p className="dep-note">Your account has under 0.05 NEAR for gas. The deposit arrives as wNEAR, so keep a little native NEAR to sign your first LP or swap.</p>}
                <PausedNote chain={chain} shield={shield} />

                <button type="button" className="button button--primary button--block button--lg" disabled={!ready || !q || Boolean(preview.error) || preview.loading} onClick={() => setReviewing(true)}>
                  {paused
                    ? `${chainName(chain)} is paused for now`
                    : !(toBigInt(raw) > 0n)
                    ? 'Enter an amount'
                    : !refundTo.trim()
                      ? `Add your ${chainName(chain)} refund address`
                      : !recipient
                        ? 'Enter your NEAR account'
                        : badAccount
                        ? accountCheck.data === false
                          ? 'Check the NEAR account'
                          : 'Checking the NEAR account…'
                        : preview.loading || !q
                          ? 'Getting a quote…'
                          : 'Review deposit'}
                </button>
              </>
            )}

            {assets.data && reviewing && q && (
              <div className="dep-review">
                <h3>Review your deposit</h3>
                <div className="dep-review__flow">
                  <div>
                    <Logo src={assetLogos(asset, icons)} name={asset.symbol} size={40} badge={<Logo src={chainLogos(chain)} name={chainName(chain)} size={18} />} />
                    <b>
                      {amount} {asset.symbol}
                    </b>
                    <small>on {chainName(chain)}</small>
                  </div>
                  <span className="dep-review__arrow">→</span>
                  <div>
                    <Logo src={RECEIVE_ICONS[receive]} name={RECEIVE[receive].symbol} size={40} badge={<Logo src={chainLogos('near')} name="NEAR" size={18} />} />
                    <b>
                      ≈ {formatAmount(Number(q.amountOutFormatted))} {RECEIVE[receive].symbol}
                    </b>
                    <small>on NEAR</small>
                  </div>
                </div>
                <dl className="kv">
                  <div>
                    <dt>To</dt>
                    <dd>{recipient}</dd>
                  </div>
                  <div>
                    <dt>Refund to</dt>
                    <dd className="dep-mono">{refundTo.trim()}</dd>
                  </div>
                  <div>
                    <dt>Minimum received</dt>
                    <dd>
                      {q.minAmountOut ? formatAmount(Number(q.minAmountOut) / 10 ** RECEIVE[receive].decimals) : '—'} {RECEIVE[receive].symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Fees</dt>
                    <dd>
              Included in the quote: {feePercent(feeBps)} service fee (shared by KINU and NEAR Intents)
            </dd>
                  </div>
                </dl>
                <label className="dep-agree">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  <span>
                    I&apos;ll send exactly {amount} {asset.symbol}, only on {chainName(chain)}, to the one-time address shown next. The refund address above is mine.{' '}
                    I accept the <Link to="/docs/terms">Terms</Link>, including the Bridge section.
                  </span>
                </label>
                {error && <p className="down small">{error.message}</p>}
                <div className="dep-review__actions">
                  <button type="button" className="button button--outline" onClick={() => setReviewing(false)}>
                    Back
                  </button>
                  <button type="button" className="button button--primary button--lg" disabled={!agreed || busy} onClick={start}>
                    {busy && <Spinner size={14} />} Get deposit address
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
        </div>

        <section className="dep-how">
          {activeX ? (
            <ActiveDeposit active={activeX} icons={icons} shield={shield} onDone={() => setActiveX(null)} />
          ) : (
            <section className="card dep-card dep-swap">
              <header className="dep-swap__head">
                <h3>⇄ Cross-chain swap</h3>
                <small className="muted">Any chain to any chain · pay from your wallet</small>
              </header>
              {assets.error && <ErrorNotice error={assets.error} onRetry={assets.reload} />}
              {!assets.data && !assets.error && <Skeleton height={260} />}
              {assets.data && <CrossForm assets={list} icons={icons} shield={shield} onStarted={setActiveX} />}
            </section>
          )}
          <div className="card dep-how__steps">
            <h3 className="dep-how__title">How it works</h3>
            {(mode === 'withdraw' ? HOW_SEND : HOW_BRING).map((step, i) => (
              <div key={step.title} className="dep-how__step">
                <span className="dep-how__num">{i + 1}</span>
                <b>{step.title}</b>
                <p>{step.text}</p>
              </div>
            ))}
          </div>
          <div className="card dep-faq">
            <details>
              <summary>Does KINU hold my funds?</summary>
              <p>No. Funds go from your wallet, through NEAR Intents, to the account or address you chose. KINU only shows the quote, checks its signature and follows the transfer.</p>
            </details>
            <details>
              <summary>What if something goes wrong?</summary>
              <p>{mode === 'withdraw' ? 'It is refunded to your NEAR account.' : 'The deposit is refunded to your refund address on the chain it came from. Sending more than quoted still goes through; the extra is refunded.'}</p>
            </details>
            <details>
              <summary>My transfer is late or hasn&apos;t arrived</summary>
              <p>
                Most transfers land in about a minute; a busy or paused chain can take longer. Open the transfer and use <i>Need help with this transfer?</i>: it links it on
                the NEAR Intents Explorer and copies the details NEAR Intents support needs (chat at near.com, bottom right). Network incidents are listed{' '}
                <a href={SUPPORT.status} target="_blank" rel="noopener noreferrer">
                  here ↗
                </a>
                . A transfer that can&apos;t complete is refunded, never kept.
              </p>
            </details>
            <details>
              <summary>Is there a minimum?</summary>
              <p>Each chain has one, set by NEAR Intents (a few dollars on Base, Solana and Arbitrum; more on Tron and Bitcoin). The quote tells you when you are under it.</p>
            </details>
            <details>
              <summary>What does it cost?</summary>
              <p>
                One service fee, already inside the quote: {feePercent(KINU_FEE_BPS)} ({feePercent(KINU_FEE_STABLE_BPS)} for stablecoins and the same asset across chains), shared by KINU and NEAR Intents. KINU&apos;s part funds operations, audits and servers. What you see as &quot;receive&quot; is what arrives; the source chain&apos;s own network fee is separate.
              </p>
            </details>
            <details>
              <summary>Who runs the bridge?</summary>
              <p>
                NEAR Intents, operated by Intents Technology under its{' '}
                <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
                  terms ↗
                </a>
                . Not available where sanctions or local law prohibit it.
              </p>
            </details>
          </div>
        </section>
      </div>
    </div>
  );
}
