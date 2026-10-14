// Every Rhea pool for the same two tokens (CLMM fee tiers, AMM, Stable, ALMM) side by side, so an
// LP can see where the pair pays its liquidity providers the most.

import { useMemo, useState } from 'react';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import { searchPools } from '../lib/rhea.js';
import { formatPercent, formatUsd } from '../lib/format.js';
import AprValue from './AprValue.jsx';
import { Skeleton } from './ui.jsx';

const MIN_TVL_FOR_BEST = 1_000; // a near-empty pool's yield says little
const MIN_TVL_SHOWN = 100; // smaller pools (dust, abandoned) are folded away

/** @param tokenIds  the pair (any order)   @param currentId  the pool being viewed */
export default function FeeTiers({ tokenIds, currentId }) {
  const [a, b] = tokenIds;
  const data = useAsync(() => searchPools({ tokenList: a, hideLow: false, limit: 200 }), [a], { refreshMs: 120_000 });
  const rows = useMemo(() => {
    const list = (data.data?.list || []).filter((p) => p.tokenIds.length === 2 && p.tokenIds.includes(a) && p.tokenIds.includes(b));
    return list
      .map((p) => ({ ...p, yieldPct: p.tvl > 0 ? (p.feeVolume24h / p.tvl) * 100 : 0 }))
      .sort((x, y) => y.yieldPct - x.yieldPct);
  }, [data.data, a, b]);
  const best = rows.find((r) => r.tvl >= MIN_TVL_FOR_BEST && r.yieldPct > 0)?.id;
  const [showTiny, setShowTiny] = useState(false);
  const tiny = rows.filter((r) => r.tvl < MIN_TVL_SHOWN && r.id !== currentId);
  const shown = showTiny ? rows : rows.filter((r) => !tiny.includes(r));

  if (data.loading && !data.data) return <Skeleton height={80} />;
  if (!rows.length) return <p className="muted">No other Rhea pools for this pair.</p>;
  return (
    <div className="pair-tiers">
      <div className="pair-tiers__row pair-tiers__row--head">
        <span>Pool</span>
        <span>TVL</span>
        <span>Volume 24h</span>
        <span title="Fees paid to LPs over the last 24h ÷ TVL: what $100 of liquidity earned">Yield 24h</span>
        <span>APR</span>
      </div>
      {shown.map((p) => {
        const here = p.id === currentId;
        return (
          <Link key={p.id} to={poolPath(p.id)} className={`pair-tiers__row ${here ? 'pair-tiers__row--here' : ''}`}>
            <span className="pair-tiers__pool">
              <span className={`kind kind--${p.label.toLowerCase()}`}>{p.label}</span>
              <b>{p.feePercent > 0 ? formatPercent(p.feePercent, p.feePercent < 0.1 ? 3 : 2) : 'No fee'}</b>
              {here && <em>This pool</em>}
              {p.id === best && <em className="pair-tiers__best">Best yield</em>}
            </span>
            <span data-label="TVL">{formatUsd(p.tvl)}</span>
            <span data-label="Volume 24h">{formatUsd(p.volume24h)}</span>
            <span data-label="Yield 24h" className={p.id === best ? 'up' : ''}>
              {formatPercent(p.yieldPct, 2)}
            </span>
            <span data-label="APR">
              <AprValue apr={p.apy + p.farmApy} tokenIds={p.tokenIds} />
            </span>
          </Link>
        );
      })}
      {tiny.length > 0 && (
        <button type="button" className="link-button pair-tiers__more" onClick={() => setShowTiny((v) => !v)}>
          {showTiny ? 'Hide' : 'Show'} {tiny.length} tiny pool{tiny.length === 1 ? '' : 's'} (TVL under $100)
        </button>
      )}
      <p className="hint">Yield 24h = fees paid to LPs over the last 24 hours ÷ TVL. A pool with little liquidity can show a high yield from a few trades.</p>
    </div>
  );
}
