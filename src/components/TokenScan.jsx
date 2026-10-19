// KINU Scan card: the verdict, score and each check of lib/tokenScan.js, with a plain disclaimer.
// `compact` shows the verdict only (a badge that links to the token page's full scan).

import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { scanToken, VERDICT_LABEL } from '../lib/tokenScan.js';
import { Skeleton } from './ui.jsx';

const ICON = { pass: '✓', info: 'i', warn: '!', fail: '✕' };

export function useTokenScan(tokenId) {
  return useAsync(() => scanToken(tokenId), [tokenId], { enabled: Boolean(tokenId), refreshMs: 5 * 60_000 });
}

/** A small "KINU Scan: Caution" badge. */
export function ScanBadge({ tokenId }) {
  const scan = useTokenScan(tokenId);
  if (!scan.data) return null;
  const { verdict, score } = scan.data;
  return (
    <Link className={`scan-badge scan-badge--${verdict}`} to={`/token/${encodeURIComponent(tokenId)}#scan`} title={`KINU Scan score ${score}/100: open the checks`}>
      <i aria-hidden="true">{verdict === 'ok' ? '✓' : '!'}</i>
      Scan: {VERDICT_LABEL[verdict]}
    </Link>
  );
}

export default function TokenScan({ tokenId }) {
  const scan = useTokenScan(tokenId);
  const d = scan.data;
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
            {d.checks.map((c) => (
              <li key={c.key} className={`scan__check scan__check--${c.status}`}>
                <i aria-hidden="true">{ICON[c.status]}</i>
                <div>
                  <strong>{c.label}</strong>
                  <span>{c.detail}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="scan__note">
            Automated checks from on-chain and market data{d.missing.length ? ` (${d.missing.join(', ')} unavailable)` : ''}. Signals, not a guarantee and not financial advice:
            a token can pass every check and still lose value.
          </p>
        </>
      )}
    </section>
  );
}
