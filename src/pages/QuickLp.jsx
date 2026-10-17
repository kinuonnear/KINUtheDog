// /quick-lp?token=<contract>&pair=NEAR&range=10&in=NEAR&amount=5 — the Telegram bot's "Open in
// KINU" target: picks the token's deepest CLMM pool on Rhea (with `pair`, the deepest one paired
// with that token) and opens its Create position form filled in (lib/lpLink.js).

import { useEffect } from 'react';
import { navigate, poolPath, useLocation, Link } from '../router.jsx';
import { useAsync } from '../hooks.js';
import { searchPools } from '../lib/rhea.js';
import { lpLinkQuery, parseLpLink } from '../lib/lpLink.js';
import { CONTRACTS } from '../config.js';
import { EmptyState, Spinner } from '../components/ui.jsx';

/** `pair` as a contract: NEAR means wNEAR, anything else is taken as given. */
const pairContract = (pair) => (!pair ? '' : pair.toLowerCase() === 'near' ? CONTRACTS.wrapNear : pair.toLowerCase());

export default function QuickLp() {
  const { search } = useLocation();
  const token = (search.get('token') || '').trim().toLowerCase();
  const pair = pairContract((search.get('pair') || '').trim());
  const pool = useAsync(
    async () => {
      const { list } = await searchPools({ type: 'dcl', tokenList: token, hideLow: false, sort: 'tvl', order: 'desc', limit: 50 });
      const pools = list.filter((p) => p.isDcl && p.tokenIds.includes(token) && (!pair || p.tokenIds.includes(pair)));
      return pools.sort((a, b) => b.tvl - a.tvl)[0] || null;
    },
    [token, pair],
    { enabled: Boolean(token) }
  );

  useEffect(() => {
    if (!pool.data) return;
    const query = lpLinkQuery(parseLpLink(search) || {});
    navigate(`${poolPath(pool.data.id)}${query ? `?${query}` : ''}`, { replace: true });
  }, [pool.data, search]);

  if (!token || pool.error || (pool.data === null && !pool.loading)) {
    return (
      <div className="page">
        <EmptyState
          icon="◎"
          title={!token ? 'No token in this link' : pool.error ? "Couldn't load pools" : 'No CLMM pool for this token yet'}
          action={
            <Link to="/pools" className="button button--primary">
              Browse pools
            </Link>
          }
        >
          {pool.error ? pool.error.message : token ? `Rhea has no concentrated liquidity pool for ${token}${pair ? ` paired with ${pair}` : ''}.` : 'Open a pool from the Pools page instead.'}
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="page">
      <EmptyState icon={<Spinner size={18} />} title="Finding the best pool…">
        The deepest concentrated liquidity pool for this token on Rhea.
      </EmptyState>
    </div>
  );
}
