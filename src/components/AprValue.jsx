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
 */
export default function AprValue({ apr, move, tokenIds }) {
  const baseId = tokenIds?.find((id) => !isQuoteToken(id)) || tokenIds?.[0];
  const lookup = move === undefined && Boolean(baseId) && apr >= 200;
  const info = useAsync(() => getTokenInfoCached(baseId), [baseId], { enabled: lookup });
  const warning = aprWarning(apr, move !== undefined ? move : info.data?.change24h);
  return (
    <span className={warning ? 'apr-spike' : ''} title={warning || undefined}>
      {formatPercent(apr)}
      {warning && <i aria-label="One-day spike">⚠</i>}
    </span>
  );
}
