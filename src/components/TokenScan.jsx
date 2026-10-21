// KINU Scan card: the verdict, score and each check of lib/tokenScan.js, with a plain disclaimer.
// `compact` shows the verdict only (a badge that links to the token page's full scan).

import { useEffect, useState } from 'react';
import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { scanToken, VERDICT_LABEL } from '../lib/tokenScan.js';
import { Skeleton } from './ui.jsx';

const ICON = { pass: '✓', info: 'i', warn: '!', fail: '✕' };

export function useTokenScan(tokenId) {
  return useAsync(() => scanToken(tokenId), [tokenId], { enabled: Boolean(tokenId), refreshMs: 5 * 60_000 });
}

/** A small "KINU Scan: Caution" badge; `compact` drops the "Scan:" prefix (tight headers). */
export function ScanBadge({ tokenId, compact = false }) {
  const scan = useTokenScan(tokenId);
  if (!scan.data) return null;
  const { verdict, score } = scan.data;
  return (
    <Link className={`scan-badge scan-badge--${verdict}`} to={`/token/${encodeURIComponent(tokenId)}#scan`} title={`KINU Scan score ${score}/100: open the checks`}>
      <i aria-hidden="true">{verdict === 'ok' ? '✓' : '!'}</i>
      {compact ? '' : 'Scan: '}
      {VERDICT_LABEL[verdict]}
    </Link>
  );
}

/**
 * A closed "KINU Scan · 65/100 Caution ›" row (as Jupiter's Token Info): the checks open only when
 * the user clicks it. Used under the Swap form.
 */
export function ScanDisclosure({ tokenId, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const scan = useTokenScan(tokenId);
  const d = scan.data;
  useEffect(() => setOpen(defaultOpen), [tokenId, defaultOpen]);
  return (
    <div className={`scan-fold ${open ? 'is-open' : ''}`}>
      <button type="button" className="scan-fold__row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <strong>KINU Scan</strong>
        {d ? (
          <span className={`scan__verdict scan__verdict--${d.verdict}`}>
            <b>{d.score}</b>
            <small>/100</small> {VERDICT_LABEL[d.verdict]}
          </span>
        ) : (
          <span className="muted small">{scan.error ? 'unavailable' : 'checking…'}</span>
        )}
        <i aria-hidden="true">›</i>
      </button>
      {open && <TokenScan tokenId={tokenId} />}
    </div>
  );
}

const SEVERITY = { fail: 0, warn: 1, info: 2, pass: 3 };

/**
 * The full scan card. With `preview` (a number) it lists that many checks, problems first, and a
 * "Show all" button for the rest.
 */
export default function TokenScan({ tokenId, preview = 0 }) {
  const scan = useTokenScan(tokenId);
  const d = scan.data;
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [tokenId]);
  const ordered = d ? (preview ? [...d.checks].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]) : d.checks) : [];
  const shown = preview && !all ? ordered.slice(0, preview) : ordered;
  const hidden = ordered.length - shown.length;
  return (
    <section className="card scan" id="scan" aria-label="KINU Scan">
      <header className="scan__head">
        <h2>
          KINU Scan <span className="muted">safety checks</span>
        </h2>
        {d && (
          <span className={`scan__verdict scan__verdict--${d.verdict}`}>
            <b>{d.score}</b>
            <small>/100</small> {VERDICT_LABEL[d.verdict]}
          </span>
        )}
      </header>
      {!d ? (
        scan.error ? (
          <p className="muted small">Scan unavailable right now.</p>
        ) : (
          <div className="scan__list">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} width="100%" height={34} radius={10} />
            ))}
          </div>
        )
      ) : (
        <>
          <div className="scan__bar" aria-hidden="true">
            <span className={`scan__fill scan__fill--${d.verdict}`} style={{ width: `${d.score}%` }} />
          </div>
          <ul className="scan__list">
            {shown.map((c) => (
              <li key={c.key} className={`scan__check scan__check--${c.status}`}>
                <i aria-hidden="true">{ICON[c.status]}</i>
                <div>
                  <strong>{c.label}</strong>
                  <span>{c.detail}</span>
                </div>
              </li>
            ))}
          </ul>
          {preview > 0 && (hidden > 0 || all) && (
            <button type="button" className="link-button scan__more" onClick={() => setAll(!all)}>
              {all ? 'Show less' : `Show all ${ordered.length} checks`}
            </button>
          )}
          <p className="scan__note">
            Automated on-chain and market checks{d.missing.length ? ` (${d.missing.join(', ')} unavailable)` : ''}: signals, not a guarantee or financial advice.
          </p>
        </>
      )}
    </section>
  );
}
