// Deposit from any chain (/deposit): bring USDC, USDT, ETH, SOL, BTC … from Base, Solana, Ethereum,
// Tron and 30+ chains onto NEAR through NEAR Intents (lib/intents.js). The user gets a one-time
// deposit address, sends from any wallet or exchange, and the funds arrive in their NEAR account
// as NEAR or USDC; a failed swap goes back to their refund address. KINU never holds the funds.

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state.jsx';
import { useAsync, useDebounced, useLocalStorage } from '../hooks.js';
import { Link } from '../router.jsx';
import { ADDRESS_HINT, CHAIN_NAMES, depositQuote, depositStatus, FINAL_STATUSES, getDepositAssets, RECEIVE, submitDepositTx } from '../lib/intents.js';
import { formatAmount, formatUsd, toBigInt, tryParseUnits } from '../lib/format.js';
import { ENDPOINTS } from '../config.js';
import { CopyButton, ErrorNotice, Skeleton, Spinner } from '../components/ui.jsx';
import '../deposit.css';

const ACTIVE_KEY = 'kinu.deposit.active';
const STATUS_POLL_MS = 5_000;
// Below this much native NEAR a new account can't pay gas for its first LP or swap.
const LOW_GAS_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

const chainName = (id) => CHAIN_NAMES[id] || id.toUpperCase();
/** "72h 29m" / "9:41" — 1Click deposit addresses can stay open for days. */
const timeLeft = (ms) => {
  const minutes = Math.floor(ms / 60000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
};

const STEPS = [
  { key: 'PENDING_DEPOSIT', label: 'Waiting for your deposit' },
  { key: 'KNOWN_DEPOSIT_TX', label: 'Deposit seen' },
  { key: 'PROCESSING', label: 'Moving it to NEAR' },
  { key: 'SUCCESS', label: 'Arrived on NEAR' }
];

/** The live deposit: where to send, a countdown, its progress, and what arrived. */
function ActiveDeposit({ active, onDone }) {
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
    <section className="card dep-active">
      {!final && !expired && (
        <>
          <p className="dep-active__lead">
            Send exactly <b>{active.amountInFormatted} {active.symbol}</b> on <b>{chainName(active.chain)}</b> to:
          </p>
          <div className="dep-address">
            <code>{active.depositAddress}</code>
            <CopyButton text={active.depositAddress} label="Copy address" />
          </div>
          {active.depositMemo && (
            <div className="dep-address dep-address--memo">
              <span>Memo (required)</span>
              <code>{active.depositMemo}</code>
              <CopyButton text={active.depositMemo} label="Copy memo" />
            </div>
          )}
          <p className="muted small">
            Send only {active.symbol} on {chainName(active.chain)}, from any wallet or exchange. This address is for this deposit only
            {left > 0 ? ` · expires in ${timeLeft(left)}` : ''}.
          </p>
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
          <b>
            {details.amountOutFormatted ? `${formatAmount(Number(details.amountOutFormatted))} ${receive.symbol}` : receive.symbol} arrived in {active.recipient}
          </b>
          {details.amountOutUsd && <span className="muted"> ≈ {formatUsd(Number(details.amountOutUsd))}</span>}
          {receive.key === 'near' && <p className="muted small">It arrives as wNEAR, which KINU's pools and swaps use directly.</p>}
          <div className="dep-next">
            <Link to="/pools" className="button button--primary">
              Provide liquidity
            </Link>
            <Link to="/swap" className="button button--outline">
              Swap
            </Link>
          </div>
        </div>
      )}
      {(state === 'REFUNDED' || state === 'FAILED' || state === 'INCOMPLETE_DEPOSIT') && (
        <div className="dep-result dep-result--warn">
          <b>{state === 'REFUNDED' ? 'Refunded' : state === 'FAILED' ? 'The swap failed' : 'Deposit smaller than quoted'}</b>
          <p className="small">
            {state === 'INCOMPLETE_DEPOSIT'
              ? 'Less than the quoted amount arrived. Send the rest to the same address before it expires, or it is refunded.'
              : `${details.refundedAmountFormatted ? `${details.refundedAmountFormatted} ${active.symbol} ` : 'The deposit '}went back to ${active.refundTo}.${details.refundReason ? ` Reason: ${details.refundReason}.` : ''}`}
          </p>
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
  const [active, setActive] = useLocalStorage(ACTIVE_KEY, null);
  const [chain, setChain] = useState('base');
  const [assetId, setAssetId] = useState('');
  const [amount, setAmount] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [receive, setReceive] = useState('near');
  const [recipientInput, setRecipientInput] = useState('');
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

  // A price preview (dry quote) while the form is complete.
  const key = useDebounced([asset?.assetId, raw, receive, recipient, refundTo.trim()].join('|'), 600);
  const preview = useAsync(() => depositQuote({ asset, amount: raw, receive, recipient, refundTo, dry: true }), [key], {
    enabled: ready && key === [asset?.assetId, raw, receive, recipient, refundTo.trim()].join('|')
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
        chain: asset.blockchain,
        receive,
        recipient,
        refundTo: refundTo.trim(),
        createdAt: Date.now()
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const lowGas = receive === 'near' && accountId && nearBalance && toBigInt(nearBalance.available) < LOW_GAS_YOCTO;
  const q = preview.data;
  const cost = q && usdIn > 0 && q.amountOutUsd ? ((usdIn - Number(q.amountOutUsd)) / usdIn) * 100 : null;

  return (
    <div className="page deposit">
      <header className="dep-head">
        <h1>Deposit from any chain</h1>
        <p className="muted">
          Bring USDC, USDT, ETH, SOL, BTC and more from Base, Solana, Ethereum, Tron and 30+ chains onto NEAR in about a minute, through NEAR Intents. You send from your own wallet or exchange; KINU never holds the funds.
        </p>
      </header>

      <div className="dep-grid">
        {active ? (
          <ActiveDeposit active={active} onDone={() => setActive(null)} />
        ) : (
          <section className="card dep-form">
            {assets.error && <ErrorNotice error={assets.error} onRetry={assets.reload} />}
            {!assets.data && !assets.error && <Skeleton height={220} />}
            {assets.data && (
              <>
                <div className="dep-row">
                  <label>
                    From chain
                    <select
                      value={chain}
                      onChange={(e) => {
                        setChain(e.target.value);
                        setAssetId('');
                      }}
                    >
                      {chains.map((c) => (
                        <option key={c} value={c}>
                          {chainName(c)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Asset
                    <select value={asset?.assetId || ''} onChange={(e) => setAssetId(e.target.value)}>
                      {chainAssets.map((t) => (
                        <option key={t.assetId} value={t.assetId}>
                          {t.symbol}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="dep-field">
                  Amount
                  <div className="dep-amount">
                    <input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))} />
                    <span>{asset?.symbol}</span>
                  </div>
                  {usdIn > 0 && <small className="muted">≈ {formatUsd(usdIn)}</small>}
                </label>

                <label className="dep-field">
                  Refund address on {chainName(chain)}
                  <input
                    placeholder={ADDRESS_HINT[chain] || `Your ${chainName(chain)} address (0x…)`}
                    value={refundTo}
                    onChange={(e) => setRefundTo(e.target.value)}
                    spellCheck={false}
                  />
                  <small className="muted">If the swap can&apos;t complete, the deposit goes back here. Use an address you control (not an exchange deposit address).</small>
                </label>

                <div className="dep-field">
                  Receive on NEAR as
                  <div className="segmented segmented--full">
                    {Object.values(RECEIVE).map((r) => (
                      <button key={r.key} type="button" className={receive === r.key ? 'active' : ''} onClick={() => setReceive(r.key)}>
                        {r.symbol} <small>· {r.note}</small>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="dep-field">
                  To NEAR account
                  {accountId ? (
                    <div className="dep-to">
                      <b>{accountId}</b> <small className="muted">(connected)</small>
                    </div>
                  ) : (
                    <div className="dep-to">
                      <input placeholder="yourname.near" value={recipientInput} onChange={(e) => setRecipientInput(e.target.value)} spellCheck={false} />
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
                    <dl className="kv">
                      <div>
                        <dt>You receive</dt>
                        <dd>
                          <b>
                            ≈ {formatAmount(Number(q.amountOutFormatted))} {RECEIVE[receive].symbol}
                          </b>{' '}
                          <small className="muted">{formatUsd(Number(q.amountOutUsd))}</small>
                        </dd>
                      </div>
                      <div>
                        <dt>Time</dt>
                        <dd>≈ {q.timeEstimate || 60} s after your deposit confirms</dd>
                      </div>
                      {cost !== null && (
                        <div>
                          <dt title="Bridge and swap fees plus price difference, from the quote">All-in cost</dt>
                          <dd>≈ {cost.toFixed(2)}%</dd>
                        </div>
                      )}
                    </dl>
                  )}
                </div>

                {lowGas && (
                  <p className="dep-note">
                    Your account has under 0.05 NEAR for gas. The deposit arrives as wNEAR, so keep a little native NEAR to sign your first LP or swap.
                  </p>
                )}
                {error && <p className="down small">{error.message}</p>}

                <button type="button" className="button button--primary button--block button--lg" disabled={!ready || busy || Boolean(preview.error)} onClick={start}>
                  {busy && <Spinner size={14} />} {ready ? 'Get deposit address' : 'Fill in the form'}
                </button>
              </>
            )}
          </section>
        )}

        <aside className="card dep-info">
          <h3>How it works</h3>
          <ol>
            <li>Pick what you have and where it is, and where it should land on NEAR.</li>
            <li>KINU asks NEAR Intents for a one-time deposit address on that chain.</li>
            <li>Send the exact amount from your wallet or exchange. It arrives in your NEAR account in about a minute.</li>
          </ol>
          <h3>Good to know</h3>
          <ul>
            <li>Non-custodial: the funds go from you, through NEAR Intents, to your NEAR account. KINU never holds them.</li>
            <li>If anything goes wrong the deposit is refunded to your refund address.</li>
            <li>Each chain has a minimum (a few dollars on Base, Solana and Arbitrum; more on Tron and Bitcoin). The quote tells you if you are under it.</li>
            <li>Fees are in the quote: NEAR Intents&apos; 0.2% plus 0.25% while KINU uses the public API, and the bridge.</li>
          </ul>
          <p className="muted small">
            Powered by{' '}
            <a href="https://docs.near-intents.org" target="_blank" rel="noopener noreferrer">
              NEAR Intents ↗
            </a>
          </p>
        </aside>
      </div>
    </div>
  );
}
