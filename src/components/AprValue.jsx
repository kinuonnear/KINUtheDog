// An APR with a ⚠ mark when it is a one-day spike (lib/poolRadar.js aprWarning). Used wherever a
// pool APR is shown: Pools, Discover, pool pages and the Portfolio.

import { useAsync } from '../hooks.js';
import { aprWarning } from '../lib/poolRadar.js';
import { getTokenInfoCached, isQuoteToken } from '../lib/intear.js';
import { formatPercent } from '../lib/format.js';

/**
 * @param apr       APR in %
 * @param move      the pool's 24h price move in % when the page already knows it
 * @param tokenIds  the pool's tokens: without `move`, the main (non-quote) token's 24h move is
 *                  looked up (only for APRs high enough to need it)
 * @param estimated Rhea gave no APR for the pool: it is the last 24h of fees annualised (≈)
 */
export default function AprValue({ apr, move, tokenIds, estimated = false }) {
  const baseId = tokenIds?.find((id) => !isQuoteToken(id)) || tokenIds?.[0];
  const lookup = move === undefined && Boolean(baseId) && apr >= 200;
  const info = useAsync(() => getTokenInfoCached(baseId), [baseId], { enabled: lookup });
  const warning = aprWarning(apr, move !== undefined ? move : info.data?.change24h);
  const note = estimated ? 'Estimated: the last 24h of LP fees ÷ TVL, annualised (Rhea gives no APR for this pool).' : null;
  const exact = apr >= 1000 ? `APR ${formatPercent(apr)}` : null;
  return (
    <span className={warning ? 'apr-spike' : ''} title={[exact, note, warning].filter(Boolean).join('\n') || undefined}>
      {/* The ⚠ comes first so every APR number ends on the same right edge. */}
      {warning && <i aria-label="One-day spike">⚠</i>}
      {estimated && '≈'}
      {formatApr(apr)}
    </span>
  );
}

/** APR text, short for big numbers: 6249.92% → 6.25K%, 12,400% → 12.4K%. */
export function formatApr(apr) {
  const n = Number(apr);
  if (Number.isFinite(n) && n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 1 : 2)}K%`;
  return formatPercent(apr);
}
