// PnL of a classic pool (AMM / Stable / ALMM) position, under "Your position" on the pool page:
// deposited vs. value now (plus anything withdrawn), against simply holding the tokens, and the
// fees compounded into the shares. Rebuilt from the wallet's add / remove logs (lib/ammHistory.js).

import { useApp } from '../state.jsx';
import { useAsync } from '../hooks.js';
import { Link, poolPath } from '../router.jsx';
import { ammPositionPnl, loadAmmEvents } from '../lib/ammHistory.js';
import { getClassicPositions, getPool } from '../lib/rhea.js';
import { asPoolToken, getTokens } from '../lib/tokens.js';
import { formatUsd } from '../lib/format.js';
import { EmptyState, PairIcons, Skeleton, Spinner } from './ui.jsx';

const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const signed = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatUsd(Math.abs(v))}` : '—');
const pct = (v, digits = 2) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%` : '—');

export default function AmmPnl({ accountId, pool, tokens, userAmounts, userShares, prices }) {
  const events = useAsync(() => loadAmmEvents(accountId), [accountId], { enabled: Boolean(accountId) });
  const pnl = useAsync(
    () => ammPositionPnl({ events: events.data.events, pool, tokens, userAmounts, userShares, prices }),
    [events.data, pool.id, pool.sharesTotalSupply, userShares, Boolean(prices)],
    { enabled: Boolean(events.data && prices) }
  );

  if (events.error) return <p className="muted small">PnL unavailable right now: {events.error.message}</p>;
  if (!events.data || pnl.loading) {
    return (
      <p className="muted small amm-pnl__loading">
        <Spinner size={12} /> Reading your deposits…
      </p>
    );
  }
  const r = pnl.data;
  if (!r) {
    return <p className="muted small">No deposits found in your recent history for this pool, so PnL can&apos;t be computed.</p>;
  }
  return (
    <dl className="kv amm-pnl">
      <div>
        <dt>Deposited</dt>
        <dd>{formatUsd(r.deposited)}</dd>
      </div>
      {r.withdrawn > 0 && (
        <div>
          <dt>Withdrawn</dt>
          <dd>{formatUsd(r.withdrawn)}</dd>
        </div>
      )}
      <div>
        <dt title="Value now + withdrawn − deposited, each valued in USD at its time">PnL</dt>
        <dd className={tone(r.pnl)}>
          {signed(r.pnl)} <small>({pct(r.pnlPct)})</small>
        </dd>
      </div>
      <div>
        <dt title="Against simply holding the tokens you deposited: the price effect of providing liquidity (impermanent loss), fees included">vs. holding</dt>
        <dd className={tone(r.vsHold)}>{signed(r.vsHold)}</dd>
      </div>
      {r.feeGrowth !== null && (
        <div>
          <dt title="How much the pool's value per share grew from fees since your deposits; it is already part of your position">Fees earned</dt>
          <dd className={tone(r.feeGrowth)}>{pct(r.feeGrowth * 100, r.feeGrowth < 0.01 ? 3 : 2)}</dd>
        </div>
      )}
    </dl>
  );
}

/**
 * Every classic pool position of a wallet (open, and closed ones still in its recent history) with
 * its PnL, for the LP wallet page's AMM view.
 */
export function AmmPositions({ account }) {
  const { prices } = useApp();
  const data = useAsync(
    async () => {
      const [{ events, complete }, open] = await Promise.all([loadAmmEvents(account), getClassicPositions(account)]);
      const openIds = new Set(open.map((p) => p.pool.id));
      // Pools the wallet left: their PnL is final (value 0, everything withdrawn).
      const closedIds = [...new Set(events.map((e) => e.pool))].filter((id) => !openIds.has(id));
      const closed = await Promise.all(closedIds.map((id) => getPool(id).then((pool) => ({ pool, amounts: pool.amounts.map(() => '0'), totalShares: '0' })).catch(() => null)));
      const all = [...open, ...closed.filter(Boolean)];
      const meta = await getTokens([...new Set(all.flatMap((p) => p.pool.tokenIds))]);
      const rows = await Promise.all(
        all.map(async (p) => {
          const tokens = p.pool.tokenIds.map((id) => asPoolToken(meta[id] || { id, symbol: id.slice(0, 6), decimals: 0 }));
          const pnl = await ammPositionPnl({ events, pool: p.pool, tokens, userAmounts: p.amounts, userShares: p.totalShares, prices }).catch(() => null);
          return { pool: p.pool, tokens, open: Number(p.totalShares) > 0, pnl };
        })
      );
      return { rows: rows.sort((a, b) => (b.pnl?.value || 0) - (a.pnl?.value || 0)), complete };
    },
    [account, Boolean(prices)],
    { enabled: Boolean(prices) }
  );

  if (data.error) {
    return (
      <div className="card">
        <EmptyState icon="⚠" title="Couldn't read AMM positions">
          {data.error.message}
        </EmptyState>
      </div>
    );
  }
  if (!data.data) {
    return (
      <div className="card">
        <Skeleton height={60} />
      </div>
    );
  }
  const { rows, complete } = data.data;
  if (!rows.length) {
    return (
      <div className="card">
        <EmptyState icon="◎" title="No AMM positions">
          This wallet has no liquidity in Rhea classic, Stable or ALMM pools{complete ? '' : ' in its recent history'}.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="card amm-table">
      <div className="amm-table__row amm-table__row--head">
        <span>Pool</span>
        <span>Value</span>
        <span>Deposited</span>
        <span>PnL</span>
        <span>vs. holding</span>
        <span>Fees earned</span>
      </div>
      {rows.map(({ pool, tokens, open, pnl }) => (
        <Link key={pool.id} to={poolPath(pool.id)} className="amm-table__row">
          <span className="amm-table__pool">
            <PairIcons tokens={tokens} size={20} />
            <b>{tokens.map((t) => t.symbol).join('/')}</b>
            <small className="muted">
              {pool.label} {pool.feePercent}% · {open ? 'open' : 'closed'}
            </small>
          </span>
          <span>{pnl ? formatUsd(pnl.value) : '—'}</span>
          <span>{pnl ? formatUsd(pnl.deposited) : '—'}</span>
          <span className={pnl ? tone(pnl.pnl) : ''}>
            {pnl ? (
              <>
                {signed(pnl.pnl)} <small>({pct(pnl.pnlPct)})</small>
              </>
            ) : (
              <small className="muted">no deposit in history</small>
            )}
          </span>
          <span className={pnl ? tone(pnl.vsHold) : ''}>{pnl ? signed(pnl.vsHold) : '—'}</span>
          <span className={pnl?.feeGrowth != null ? tone(pnl.feeGrowth) : ''}>
            {pnl?.feeGrowth != null ? pct(pnl.feeGrowth * 100, pnl.feeGrowth < 0.01 ? 3 : 2) : '—'}
          </span>
        </Link>
      ))}
      <p className="muted small amm-table__note">
        PnL = value now + withdrawn − deposited, each valued in USD at its time. Fees in these pools compound into the shares.
        {complete ? '' : ' Only the most recent 200 transactions to Rhea classic are read.'}
      </p>
    </div>
  );
}
