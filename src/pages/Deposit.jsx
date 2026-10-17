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
  chainIcon,
  depositQuote,
  depositStatus,
  FINAL_STATUSES,
  getAssetIcons,
  getDepositAssets,
  RECEIVE,
  RECEIVE_ICONS,
  submitDepositTx
} from '../lib/intents.js';
import { formatAmount, formatUsd, toBigInt, tryParseUnits } from '../lib/format.js';
import { ENDPOINTS } from '../config.js';
import { CopyButton, ErrorNotice, Skeleton, Spinner } from '../components/ui.jsx';
import '../deposit.css';

const ACTIVE_KEY = 'kinu.deposit.active';
const STATUS_POLL_MS = 5_000;
// Below this much native NEAR a new account can't pay gas for its first LP or swap.
const LOW_GAS_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
// Above this the page suggests trying a small amount first (a reminder, not a limit).
const LARGE_USD = 1_000;
const TERMS_URL = 'https://docs.near-intents.org/security-compliance/terms-of-service';

const chainName = (id) => CHAIN_NAMES[id] || id.toUpperCase();
/** "72h 29m" / "9:41" — 1Click deposit addresses can stay open for days. */
const timeLeft = (ms) => {
  const minutes = Math.floor(ms / 60000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
};

/** A round logo, or the name's initial on a soft disc when there's no image (or it fails). */
function Logo({ src, name, size = 28, badge }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="dep-logo" style={{ width: size, height: size }}>
      {src && !failed ? <img src={src} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} /> : <i>{String(name || '?').slice(0, 1)}</i>}
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
function ActiveDeposit({ active, icons, onDone }) {
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
  const receive = RECEIVE[active.receive];

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
            <Logo src={icons[active.assetIcon] || null} name={active.symbol} size={44} badge={<Logo src={chainIcon(active.chain)} name={chainName(active.chain)} size={20} />} />
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
        </>
      )}

      <ol className="dep-steps">
        {STEPS.map((s, i) => (
          <li key={s.key} className={i < stepIndex || state === 'SUCCESS' ? 'done' : i === stepIndex && !final ? 'on' : ''}>
            <i>{i < stepIndex || state === 'SUCCESS' ? '✓' : i + 1}</i>
            {s.label}
            {i === stepIndex && !final && !expired && <Spinner size={12} />}
          </li>
        ))}
      </ol>

      {state === 'SUCCESS' && (
        <div className="dep-result dep-result--ok">
          <Logo src={RECEIVE_ICONS[receive.key]} name={receive.symbol} size={36} />
          <div>
            <b>
              {details.amountOutFormatted ? `${formatAmount(Number(details.amountOutFormatted))} ${receive.symbol}` : receive.symbol} arrived
            </b>
            <small className="muted">
              in {active.recipient}
              {details.amountOutUsd ? ` · ≈ ${formatUsd(Number(details.amountOutUsd))}` : ''}
              {receive.key === 'near' ? ' · as wNEAR, used directly by KINU pools and swaps' : ''}
            </small>
            <div className="dep-next">
              <Link to="/pools" className="button button--primary button--sm">
                Provide liquidity
              </Link>
              <Link to="/swap" className="button button--outline button--sm">
                Swap
              </Link>
            </div>
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
        <p className="muted small">
          On NEAR:{' '}
          {details.nearTxHashes.slice(-2).map((h) => (
            <a key={h} href={`${ENDPOINTS.explorer}/txns/${h}`} target="_blank" rel="noopener noreferrer">
              {h.slice(0, 8)}… ↗{' '}
            </a>
          ))}
        </p>
      )}
      {status.error && <p className="muted small">Status unavailable right now: {status.error.message}</p>}

      <button type="button" className="link-button dep-new" onClick={onDone}>
        {final || expired ? 'New deposit' : 'Cancel and start over (only if you have not sent anything)'}
      </button>
    </section>
  );
}

export default function Deposit() {
  const { accountId, connect, nearBalance } = useApp();
  const assets = useAsync(() => getDepositAssets(), []);
  const icons = useAsync(() => getAssetIcons(assets.data), [Boolean(assets.data)], { enabled: Boolean(assets.data) }).data || {};
  const [active, setActive] = useLocalStorage(ACTIVE_KEY, null);
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
  const ready = Boolean(asset && toBigInt(raw) > 0n && refundTo.trim() && recipient);

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
        symbol: asset.symbol,
        assetIcon: asset.coingeckoId || null,
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
  const cost = q && usdIn > 0 && q.amountOutUsd ? ((usdIn - Number(q.amountOutUsd)) / usdIn) * 100 : null;
  const chainOptions = chains.map((c) => ({ value: c, label: chainName(c), icon: chainIcon(c) }));
  const assetOptions = chainAssets.map((t) => ({
    value: t.assetId,
    label: t.symbol,
    sub: t.price ? formatUsd(t.price) : '',
    icon: icons[t.coingeckoId] || null
  }));

  return (
    <div className="page deposit">
      <header className="dep-head">
        <div className="dep-head__title">
          <h1>Deposit from any chain</h1>
          <span className="dep-beta">Beta</span>
        </div>
        <p className="muted">
          Bring USDC, USDT, ETH, SOL, BTC and more from Base, Solana, Ethereum, Tron and 30+ chains onto NEAR in about a minute, through NEAR Intents. You send from your own wallet or exchange; KINU never holds the funds.
        </p>
        <div className="dep-chainstrip" aria-hidden="true">
          {['base', 'sol', 'eth', 'arb', 'bsc', 'tron', 'btc', 'op', 'pol', 'avax', 'ton', 'sui'].map((c) => (
            <Logo key={c} src={chainIcon(c)} name={chainName(c)} size={22} />
          ))}
          <span>+{Math.max(0, chains.length - 12) || 20} more</span>
        </div>
      </header>

      <div className="dep-grid">
        {active ? (
          <ActiveDeposit active={active} icons={icons} onDone={() => setActive(null)} />
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
                    <Logo src={icons[asset?.coingeckoId] || null} name={asset?.symbol} size={30} badge={<Logo src={chainIcon(chain)} name={chainName(chain)} size={14} />} />
                    <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))} />
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
                  <small className="muted">If the swap can&apos;t complete, the deposit goes back here. Use an address you control, not an exchange deposit address.</small>
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
                      <small className="muted">connected</small>
                    </div>
                  ) : (
                    <div className="dep-to">
                      <input className="dep-input" placeholder="yourname.near" value={recipientInput} onChange={(e) => setRecipientInput(e.target.value)} spellCheck={false} />
                      <button type="button" className="button button--outline button--sm" onClick={connect}>
                        Connect wallet
                      </button>
                    </div>
                  )}
                </div>

                <div className="dep-quote">
                  {!ready && <span className="muted small">Pick an asset, an amount and your refund address to see the quote.</span>}
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
                          {cost !== null ? ` · all-in cost ≈ ${cost.toFixed(2)}%` : ''}
                        </small>
                      </div>
                    </div>
                  )}
                </div>

                {lowGas && <p className="dep-note">Your account has under 0.05 NEAR for gas. The deposit arrives as wNEAR, so keep a little native NEAR to sign your first LP or swap.</p>}

                <button type="button" className="button button--primary button--block button--lg" disabled={!ready || !q || Boolean(preview.error) || preview.loading} onClick={() => setReviewing(true)}>
                  {ready ? 'Review deposit' : 'Fill in the form'}
                </button>
              </>
            )}

            {assets.data && reviewing && q && (
              <div className="dep-review">
                <h3>Review your deposit</h3>
                <div className="dep-review__flow">
                  <div>
                    <Logo src={icons[asset.coingeckoId] || null} name={asset.symbol} size={40} badge={<Logo src={chainIcon(chain)} name={chainName(chain)} size={18} />} />
                    <b>
                      {amount} {asset.symbol}
                    </b>
                    <small>on {chainName(chain)}</small>
                  </div>
                  <span className="dep-review__arrow">→</span>
                  <div>
                    <Logo src={RECEIVE_ICONS[receive]} name={RECEIVE[receive].symbol} size={40} badge={<Logo src={chainIcon('near')} name="NEAR" size={18} />} />
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
                    <dd>All included in the quote{cost !== null ? ` (≈ ${cost.toFixed(2)}% all-in)` : ''}</dd>
                  </div>
                </dl>
                <label className="dep-agree">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  <span>
                    I&apos;ll send exactly {amount} {asset.symbol}, only on {chainName(chain)}, to the one-time address shown next. The refund address above is mine.
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

        <aside className="card dep-card dep-info">
          <h3>How it works</h3>
          <ol>
            <li>Pick what you have, where it is, and how it should arrive on NEAR.</li>
            <li>Review the quote. KINU asks NEAR Intents for a one-time deposit address and checks its signature.</li>
            <li>Send the exact amount from your wallet or exchange. It lands in your NEAR account in about a minute.</li>
          </ol>
          <h3>Good to know</h3>
          <ul>
            <li>Non-custodial: funds go from you, through NEAR Intents, to your NEAR account. KINU never holds them.</li>
            <li>If anything goes wrong the deposit is refunded to your refund address.</li>
            <li>Each chain has a minimum; the quote tells you if you are under it.</li>
            <li>All fees (NEAR Intents and bridge) are already inside the quote.</li>
          </ul>
          <p className="dep-legal">
            Deposits run on NEAR Intents, operated by Intents Technology under its{' '}
            <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
              terms ↗
            </a>
            . KINU only shows its quote and follows the deposit. Not available where sanctions or local law prohibit it.
          </p>
        </aside>
      </div>
    </div>
  );
}
