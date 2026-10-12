// Live feed (Discover): every swap on Rhea as "trader bought $X of $TOKEN", with Everyone /
// Big buys / Following views, a minimum size and a Trade button (lib/liveFeed.js).

import { useEffect, useMemo, useState } from 'react';
import { Link } from '../router.jsx';
import {
  BIG_BUY_TOKENS,
  BIG_BUY_USD,
  FEED_MIN_SIZES,
  filterFeed,
  isAccountId,
  MAX_FOLLOW_POLL,
  mergeTrades,
  useBigBuys,
  useFollowedTrades,
  useLiveTrades
} from '../lib/liveFeed.js';
import { BASE_TOKENS } from '../lib/trending.js';
import { getTokenInfoCached } from '../lib/intear.js';
import { getTokens } from '../lib/tokens.js';
import { useFollowing } from '../lib/watchlist.js';
import { formatUsd, shortAccount, toNumber } from '../lib/format.js';
import { ENDPOINTS, NATIVE_NEAR } from '../config.js';
import { EmptyState, ErrorNotice, Skeleton, TokenIcon } from './ui.jsx';

const SHOWN = 60;
const BASE = new Set([...BASE_TOKENS, NATIVE_NEAR.id]);

const VIEWS = [
  { key: 'everyone', label: 'Everyone' },
  { key: 'big', label: 'Big buys' },
  { key: 'following', label: 'Following' }
];

function timeAgo(ms, now) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const traderName = (id) => (id.length > 24 ? shortAccount(id, 6, 4) : id);
const sizeLabel = (usd) => (usd < 0.01 ? '<$0.01' : formatUsd(usd));
const poolKind = (poolId) => (String(poolId).startsWith('REFDCL') ? 'CLMM' : 'Rhea');

/** Token metadata (icons, decimals) and circulating supply for the tokens on screen, from shared caches. */
function useFeedTokens(ids) {
  const key = ids.join(',');
  const [meta, setMeta] = useState({});
  const [supply, setSupply] = useState({});
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    const list = key.split(',');
    getTokens(list).then((m) => alive && setMeta((prev) => ({ ...prev, ...m })));
    list
      .filter((id) => !BASE.has(id))
      .forEach((id) =>
        getTokenInfoCached(id).then((info) => {
          if (alive && info?.circulatingSupply) setSupply((prev) => (prev[id] ? prev : { ...prev, [id]: info.circulatingSupply }));
        })
      );
    return () => {
      alive = false;
    };
  }, [key]);
  return { meta, supply };
}

function FollowStar({ trader, following }) {
  const on = following.has(trader);
  return (
    <button
      type="button"
      className={`watch-star feed-follow ${on ? 'watch-star--on' : ''}`}
      onClick={() => following.toggle(trader)}
      aria-pressed={on}
      title={on ? 'Unfollow this trader' : 'Follow this trader'}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

/** Follow a wallet by address, and the followed list (portfolio link, unfollow). */
function FollowBar({ following }) {
  const [input, setInput] = useState('');
  const id = input.trim().toLowerCase();
  const valid = isAccountId(id);
  const add = (e) => {
    e.preventDefault();
    if (!valid || following.has(id)) return;
    following.toggle(id);
    setInput('');
  };
  return (
    <div className="follow-bar">
      <form className="follow-bar__form" onSubmit={add}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Follow a wallet, e.g. whale.near"
          aria-label="Wallet to follow"
          spellCheck={false}
          autoCapitalize="off"
        />
        <button type="submit" className="button button--outline button--sm" disabled={!valid || following.has(id)}>
          {following.has(id) ? 'Following' : '+ Follow'}
        </button>
      </form>
      {following.list.length > 0 && (
        <div className="follow-bar__list">
          {following.list.map((trader, i) => (
            <span key={trader} className={`follow-chip ${i >= MAX_FOLLOW_POLL ? 'follow-chip--idle' : ''}`}>
              <Link to={`/portfolio?account=${encodeURIComponent(trader)}`} title={`${trader} — open portfolio`}>
                {traderName(trader)}
              </Link>
              <button type="button" onClick={() => following.toggle(trader)} aria-label={`Unfollow ${trader}`} title="Unfollow">
                ×
              </button>
            </span>
          ))}
          {following.list.length > MAX_FOLLOW_POLL && (
            <small className="muted">History loads for the first {MAX_FOLLOW_POLL}; the rest show up when they trade live.</small>
          )}
        </div>
      )}
    </div>
  );
}

export default function LiveFeed() {
  const [view, setView] = useState('everyone');
  const [minUsd, setMinUsd] = useState(10);
  const [showBase, setShowBase] = useState(false);
  const following = useFollowing();
  // Each source polls only while its view is open.
  const live = useLiveTrades(true);
  const big = useBigBuys(view === 'big');
  const followed = useFollowedTrades(view === 'following', following.list);
  const source = view === 'big' ? big : view === 'following' ? followed : live;
  const trades = useMemo(
    () => (view === 'everyone' ? mergeTrades(live.trades) : mergeTrades(live.trades, source.trades)),
    [view, live.trades, source.trades]
  );
  const error = source.error;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [trades]);

  const rows = useMemo(
    () => filterFeed(trades, { view, minUsd: view === 'big' ? 0 : minUsd, showBase, following: following.list, baseTokens: BASE }).slice(0, SHOWN),
    [trades, view, minUsd, showBase, following.list]
  );
  const tokenIds = useMemo(() => [...new Set(rows.map((t) => t.token).filter(Boolean))].sort(), [rows]);
  const { meta, supply } = useFeedTokens(tokenIds);

  return (
    <>
      <div className="disc-toolbar">
        <div className="segmented disc-seg">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>
              {v.label}
              {v.key === 'following' && following.list.length > 0 && <em className="feed-count">{following.list.length}</em>}
            </button>
          ))}
        </div>
        <div className="disc-toolbar__right">
          <span className="feed-live">
            <i /> Live
          </span>
          <div className="segmented disc-seg" role="radiogroup" aria-label="Minimum size">
            {FEED_MIN_SIZES.map((v) => (
              <button key={v} type="button" role="radio" aria-checked={minUsd === v} className={minUsd === v ? 'active' : ''} onClick={() => setMinUsd(v)}>
                {v ? `≥ $${v >= 1000 ? `${v / 1000}K` : v}` : 'Any size'}
              </button>
            ))}
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={showBase} onChange={(e) => setShowBase(e.target.checked)} />
            Show NEAR & stablecoins
          </label>
        </div>
      </div>

      {view === 'following' && <FollowBar following={following} />}
      {view === 'big' && (
        <p className="muted small feed-note">
          Buys of ${BIG_BUY_USD} or more in the {BIG_BUY_TOKENS} most active tokens on Rhea (NEAR and stablecoins left out), plus
          any big buy in the live feed. Updates every minute.
        </p>
      )}

      {error && !trades.length ? (
        <ErrorNotice error={error} />
      ) : view === 'following' && !following.list.length ? (
        <EmptyState icon="☆" title="You're not following anyone yet">
          Tap ☆ next to a trader in Everyone or Big buys, or add a wallet above. Their latest trades show up here. The list is
          kept in this browser.
        </EmptyState>
      ) : (
        <section className="card feed">
          {source.loading && !rows.length
            ? Array.from({ length: 8 }, (_, i) => (
                <div className="feed-row" key={i}>
                  <Skeleton width={34} height={34} radius={10} />
                  <Skeleton width="50%" />
                  <Skeleton width={60} />
                </div>
              ))
            : rows.map((t) => {
                const token = meta[t.token] || { id: t.token, symbol: (t.token || '').split('.')[0].slice(0, 10) };
                const amount = token.decimals !== undefined ? toNumber(t.amountRaw, token.decimals) : 0;
                const mcap = amount > 0 && supply[t.token] ? (t.usd / amount) * supply[t.token] : null;
                const buy = t.side === 'buy';
                return (
                  <div className="feed-row feed-row--in" key={t.id}>
                    <Link to={`/token/${encodeURIComponent(t.token)}`} className="feed-row__icon" aria-label={`${token.symbol} token page`}>
                      <TokenIcon token={token} size={34} />
                    </Link>
                    <div className="feed-row__main">
                      <div className="feed-row__line">
                        <FollowStar trader={t.trader} following={following} />
                        <Link className="feed-row__trader" to={`/portfolio?account=${encodeURIComponent(t.trader)}`} title={`${t.trader} — open portfolio`}>
                          {traderName(t.trader)}
                        </Link>
                        <a className="feed-row__ext" href={`${ENDPOINTS.explorer}/address/${t.trader}`} target="_blank" rel="noopener noreferrer" title="Open in NearBlocks">
                          ↗
                        </a>
                        <span className={buy ? 'up' : 'down'}>{buy ? 'bought' : 'sold'}</span>
                        <b>{sizeLabel(t.usd)}</b>
                        <span className="muted">of</span>
                        <Link to={`/token/${encodeURIComponent(t.token)}`} className="feed-row__token">
                          ${token.symbol}
                        </Link>
                        {buy && t.usd >= BIG_BUY_USD && <em className="feed-big">Big buy</em>}
                      </div>
                      <small className="feed-row__sub">
                        {mcap ? `at ${formatUsd(mcap, { compactAbove: 1e3 })} mcap · ` : ''}
                        {poolKind(t.poolId)} pool ·{' '}
                        <a href={`${ENDPOINTS.explorer}/txns/${t.txHash}`} target="_blank" rel="noopener noreferrer">
                          tx ↗
                        </a>
                      </small>
                    </div>
                    <div className="feed-row__side">
                      <span className="muted">{timeAgo(t.time, now)}</span>
                      <Link className="button button--outline button--sm" to={`/swap?from=${NATIVE_NEAR.id}&to=${encodeURIComponent(t.token)}`}>
                        Trade
                      </Link>
                    </div>
                  </div>
                );
              })}
          {!source.loading && !rows.length && (
            <p className="muted small new-table__empty">
              {view === 'following' ? 'No recent trades from the traders you follow.' : 'No trades match these filters right now.'}
            </p>
          )}
        </section>
      )}
    </>
  );
}
