// Wallet Tracker (Discover): wallets in groups on the left, their trades live on the right.
// Each group sets the smallest trade marked on the swap chart and its own alerts (TrackerAlerts).
// Same list as the Live feed's Following; kept in this browser, moved with Import / Export.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '../router.jsx';
import { isAccountId, MAX_FOLLOW_POLL, mergeTrades, useFollowedTrades, useLiveTrades } from '../lib/liveFeed.js';
import { accountsIn, DEFAULT_GROUP, TRACKER_EMOJIS, useTrackedWallets } from '../lib/walletTracker.js';
import { formatUsd, toNumber } from '../lib/format.js';
import { ENDPOINTS, NATIVE_NEAR } from '../config.js';
import { EmptyState, ErrorNotice, Modal, Skeleton, TokenIcon } from './ui.jsx';
import { poolKind, sizeLabel, timeAgo, useFeedTokens } from './LiveFeed.jsx';
import { playTrackerSound, soundOf, TRACKER_SOUNDS } from './TrackerAlerts.jsx';

const SHOWN = 80;
const ALL = 'all';
const SIDES = [
  { key: 'all', label: 'All' },
  { key: 'buy', label: 'Buys' },
  { key: 'sell', label: 'Sells' }
];

export function Avatar({ wallet, size = 30 }) {
  return (
    <i className="wt-avatar" style={{ background: wallet.color, width: size, height: size, fontSize: size * (wallet.emoji ? 0.55 : 0.42) }} aria-hidden="true">
      {wallet.emoji || wallet.label[0]?.toUpperCase() || '?'}
    </i>
  );
}

function EmojiPicker({ value, onChange, options = TRACKER_EMOJIS, allowNone = true }) {
  return (
    <div className="wt-emojis" role="radiogroup" aria-label="Emoji">
      {allowNone && (
        <button type="button" role="radio" aria-checked={!value} className={!value ? 'is-on' : ''} onClick={() => onChange('')} title="Initial letter">
          Aa
        </button>
      )}
      {options.map((e) => (
        <button key={e} type="button" role="radio" aria-checked={value === e} className={value === e ? 'is-on' : ''} onClick={() => onChange(e)}>
          {e}
        </button>
      ))}
    </div>
  );
}

/** Add a wallet, or edit one (`wallet`): address, name, emoji, group. */
function WalletModal({ tracker, wallet, draft, defaultGroup, onClose, onNewGroup }) {
  // `draft`: what was typed before "+ Group" opened the group form (and the group it created).
  const [address, setAddress] = useState(draft?.address ?? wallet?.id ?? '');
  const [label, setLabel] = useState(draft?.label ?? wallet?.label ?? '');
  const [emoji, setEmoji] = useState(draft?.emoji ?? wallet?.emoji ?? '');
  const [group, setGroup] = useState(draft?.group || wallet?.group || defaultGroup || DEFAULT_GROUP.id);
  const [error, setError] = useState('');
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setAddress(accountsIn(text)[0] || text.trim());
    } catch {
      setError('Paste is blocked here: type or long-press to paste.');
    }
  };
  const submit = (e) => {
    e.preventDefault();
    const id = address.trim().toLowerCase();
    if (!wallet) {
      if (!isAccountId(id)) return setError('Enter a NEAR account, e.g. whale.near or a 64-character address.');
      if (tracker.has(id)) return setError('Already tracked.');
    }
    const patch = { label: label.trim().slice(0, 20) || undefined, emoji, group };
    if (wallet) tracker.update(wallet.id, patch);
    else tracker.add(id, patch);
    onClose();
    return undefined;
  };
  return (
    <Modal title={wallet ? 'Edit wallet' : 'Add wallet'} subtitle={wallet ? wallet.id : 'Its trades show in the feed and on the swap chart.'} onClose={onClose} width={440}>
      <form className="wt-form" onSubmit={submit}>
        {!wallet && (
          <label>
            <span>Wallet address</span>
            <div className="wt-form__row">
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="whale.near" spellCheck={false} autoCapitalize="off" autoFocus />
              <button type="button" className="button button--ghost button--sm" onClick={paste}>
                Paste
              </button>
            </div>
          </label>
        )}
        <label>
          <span>Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Optional, e.g. Whale" maxLength={20} />
        </label>
        <div className="wt-form__field">
          <span>Emoji</span>
          <EmojiPicker value={emoji} onChange={setEmoji} />
        </div>
        <label>
          <span>Group</span>
          <div className="wt-form__row">
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              {tracker.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.emoji} {g.name}
                </option>
              ))}
            </select>
            <button type="button" className="button button--ghost button--sm" onClick={() => onNewGroup({ address, label, emoji, group })}>
              + Group
            </button>
          </div>
        </label>
        {error && <p className="wt-form__error">{error}</p>}
        <div className="wt-form__actions">
          <button type="button" className="button button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--primary">
            {wallet ? 'Save' : 'Add wallet'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Create or edit a group: name, emoji, min size for chart markers, alerts. */
function GroupModal({ tracker, group, onClose, onSaved }) {
  const [g, setG] = useState(() => ({ ...DEFAULT_GROUP, id: undefined, name: '', emoji: '🐋', ...group }));
  const set = (patch) => setG((cur) => ({ ...cur, ...patch }));
  const submit = (e) => {
    e.preventDefault();
    if (!g.name.trim()) return;
    const id = tracker.saveGroup({ ...g, name: g.name.trim() });
    onSaved?.(id);
    onClose();
  };
  return (
    <Modal title={group ? 'Edit group' : 'Add wallet group'} subtitle="Its own chart marker size and alerts." onClose={onClose} width={440}>
      <form className="wt-form" onSubmit={submit}>
        <label>
          <span>Group</span>
          <input value={g.name} onChange={(e) => set({ name: e.target.value })} placeholder="Group name, e.g. Whales" maxLength={24} autoFocus={!group} />
        </label>
        <div className="wt-form__field">
          <span>Emoji</span>
          <EmojiPicker value={g.emoji} onChange={(emoji) => set({ emoji })} options={['★', ...TRACKER_EMOJIS]} allowNone={false} />
        </div>
        <label>
          <span>Min value for chart marker</span>
          <div className="wt-form__usd">
            <input type="number" min="0" step="1" inputMode="decimal" value={g.minUsd || ''} onChange={(e) => set({ minUsd: e.target.value })} placeholder="0" />
            <b>$</b>
          </div>
          <small>Smaller trades from this group stay off the swap chart (they still show in the feed).</small>
        </label>
        <label className="wt-form__check">
          <input type="checkbox" checked={g.alerts} onChange={(e) => set({ alerts: e.target.checked })} />
          <span>Alert me when a wallet in this group trades</span>
        </label>
        {g.alerts && (
          <div className="wt-form__alerts">
            <div className="wt-form__field">
              <span>Sound</span>
              <div className="wt-sounds" role="radiogroup" aria-label="Alert sound">
                {TRACKER_SOUNDS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    role="radio"
                    aria-checked={soundOf(g) === s.key}
                    className={soundOf(g) === s.key ? 'is-on' : ''}
                    onClick={() => {
                      set({ sound: s.key });
                      playTrackerSound(s.key, g.volume);
                    }}
                  >
                    {s.key === 'none' ? '🔇' : '♪'} {s.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="wt-form__slider">
              <span>🔊</span>
              <input
                type="range"
                min="0"
                max="100"
                value={g.volume}
                disabled={soundOf(g) === 'none'}
                onChange={(e) => set({ volume: Number(e.target.value) })}
                onPointerUp={() => playTrackerSound(soundOf(g), g.volume)}
              />
              <b>{g.volume}%</b>
            </label>
            <label className="wt-form__slider">
              <span>⏱</span>
              <input type="range" min="2" max="15" value={g.seconds} onChange={(e) => set({ seconds: Number(e.target.value) })} />
              <b>{g.seconds}s</b>
            </label>
            <small>A banner shows at the top of any KINU page while it is open, for trades at or above the min value, and closes by itself after {g.seconds} seconds.</small>
          </div>
        )}
        <div className="wt-form__actions">
          {group && group.id !== DEFAULT_GROUP.id && (
            <button
              type="button"
              className="button button--ghost wt-form__danger"
              onClick={() => {
                tracker.deleteGroup(group.id);
                onSaved?.(ALL);
                onClose();
              }}
            >
              Delete group
            </button>
          )}
          <button type="button" className="button button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!g.name.trim()}>
            {group ? 'Save' : 'Create group'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Import a backup file, or paste addresses (one per line, or separated by commas). */
function ImportModal({ tracker, defaultGroup, onClose }) {
  const [text, setText] = useState('');
  const [group, setGroup] = useState(defaultGroup || DEFAULT_GROUP.id);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  const run = (value) => {
    const added = tracker.importData(value, group);
    setResult(added);
    if (added) setText('');
  };
  return (
    <Modal title="Import wallets" subtitle="A KINU backup file, or a list of addresses." onClose={onClose} width={460}>
      <div className="wt-form">
        <label>
          <span>Addresses</span>
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'whale.near\nsmartlp.near, trader.tg'} spellCheck={false} />
        </label>
        <label>
          <span>Into group</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            {tracker.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.emoji} {g.name}
              </option>
            ))}
          </select>
          <small>A backup file keeps its own groups.</small>
        </label>
        {result !== null && <p className={result ? 'wt-form__ok' : 'wt-form__error'}>{result ? `Added ${result} wallet${result === 1 ? '' : 's'}.` : 'No new wallets found.'}</p>}
        <input
          ref={fileRef}
          type="file"
          accept=".json,.txt,.csv,application/json,text/plain"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) run(await file.text());
            e.target.value = '';
          }}
        />
        <div className="wt-form__actions">
          <button type="button" className="button button--ghost" onClick={() => fileRef.current?.click()}>
            Choose file
          </button>
          <button type="button" className="button button--primary" disabled={!text.trim()} onClick={() => run(text)}>
            Import
          </button>
        </div>
      </div>
    </Modal>
  );
}

function exportFile(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kinu-wallets-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function WalletRow({ wallet, group, stats, active, onSelect, onEdit, tracker, idle }) {
  return (
    <li className={`wt-wallet ${active ? 'is-active' : ''} ${idle ? 'is-idle' : ''}`}>
      <button type="button" className="wt-wallet__main" onClick={onSelect} aria-pressed={active} title={active ? 'Show every wallet' : `Show only ${wallet.label}`}>
        <Avatar wallet={wallet} />
        <span className="wt-wallet__id">
          <strong>{wallet.label}</strong>
          <small>
            {group && group.id !== DEFAULT_GROUP.id ? `${group.emoji} ${group.name} · ` : ''}
            {wallet.id.length > 26 ? `${wallet.id.slice(0, 10)}…${wallet.id.slice(-6)}` : wallet.id}
          </small>
        </span>
        <span className="wt-wallet__stats">
          {stats ? (
            <>
              <small>{stats.last ? `${timeAgo(stats.last, Date.now())} ago` : '—'}</small>
              <span>
                <em className="up">{formatUsd(stats.buyUsd, { compactAbove: 1e3 })}</em> / <em className="down">{formatUsd(stats.sellUsd, { compactAbove: 1e3 })}</em>
              </span>
            </>
          ) : (
            <small className="muted">{idle ? 'live only' : 'no recent trades'}</small>
          )}
        </span>
      </button>
      <div className="wt-wallet__tools">
        <button
          type="button"
          className={wallet.onChart ? 'is-on' : ''}
          aria-pressed={wallet.onChart}
          title={wallet.onChart ? 'Shown on the swap chart: click to hide' : 'Hidden on the swap chart: click to show'}
          onClick={() => tracker.toggleChart(wallet.id)}
        >
          ◉
        </button>
        <button type="button" title="Edit name, emoji or group" onClick={onEdit}>
          ✎
        </button>
        <Link to={`/portfolio?account=${encodeURIComponent(wallet.id)}`} title="Open portfolio">
          ▤
        </Link>
        <a href={`${ENDPOINTS.explorer}/address/${wallet.id}`} target="_blank" rel="noopener noreferrer" title="Open in NearBlocks">
          ↗
        </a>
        <button type="button" title="Stop tracking" onClick={() => tracker.remove(wallet.id)}>
          ×
        </button>
      </div>
    </li>
  );
}

export default function WalletTracker() {
  const tracker = useTrackedWallets();
  const { wallets, groups } = tracker;
  const byId = useMemo(() => new Map(wallets.map((w) => [w.id, w])), [wallets]);
  const [groupTab, setGroupTab] = useState(ALL);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [side, setSide] = useState('all');
  const [modal, setModal] = useState(null); // { kind: 'wallet' | 'group' | 'import', wallet?, group? }
  useEffect(() => {
    if (selected && !byId.has(selected)) setSelected(null);
    if (groupTab !== ALL && !groups.some((g) => g.id === groupTab)) setGroupTab(ALL);
  }, [selected, byId, groupTab, groups]);

  const q = query.trim().toLowerCase();
  const inGroup = useMemo(() => wallets.filter((w) => groupTab === ALL || w.group === groupTab), [wallets, groupTab]);
  const listed = useMemo(() => inGroup.filter((w) => !q || w.id.includes(q) || w.label.toLowerCase().includes(q)), [inGroup, q]);
  const ids = wallets.map((w) => w.id);
  const shownIds = useMemo(() => new Set(inGroup.map((w) => w.id)), [inGroup]);

  // History for each wallet, plus every live swap (so new trades show within seconds).
  const live = useLiveTrades(ids.length > 0);
  const followed = useFollowedTrades(ids.length > 0, ids);
  const trades = useMemo(() => mergeTrades(live.trades, followed.trades).filter((t) => byId.has(t.trader)), [live.trades, followed.trades, byId]);

  // Per wallet: last trade and buy / sell volume among the trades loaded.
  const stats = useMemo(() => {
    const out = new Map();
    for (const t of trades) {
      const s = out.get(t.trader) || { last: 0, buyUsd: 0, sellUsd: 0 };
      s.last = Math.max(s.last, t.time);
      if (t.side === 'buy') s.buyUsd += t.usd;
      else s.sellUsd += t.usd;
      out.set(t.trader, s);
    }
    return out;
  }, [trades]);

  const rows = useMemo(
    () =>
      trades
        .filter((t) => (selected ? t.trader === selected : shownIds.has(t.trader)) && (side === 'all' || t.side === side))
        .slice(0, SHOWN),
    [trades, selected, shownIds, side]
  );
  const tokenIds = useMemo(() => [...new Set(rows.map((t) => t.token).filter(Boolean))].sort(), [rows]);
  const { meta, supply } = useFeedTokens(tokenIds);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [trades]);

  const activeGroup = groups.find((g) => g.id === groupTab);
  const count = (id) => wallets.filter((w) => w.group === id).length;

  return (
    <div className="wt">
      <section className="card wt-list">
        <header className="wt-head">
          <h3>
            Wallet manager <span className="muted">{wallets.length}</span>
          </h3>
          <div className="wt-head__tools">
            <button type="button" className="button button--ghost button--sm" onClick={() => setModal({ kind: 'import' })}>
              Import
            </button>
            <button type="button" className="button button--ghost button--sm" onClick={() => exportFile(tracker.exportData())} disabled={!wallets.length}>
              Export
            </button>
          </div>
        </header>

        <div className="wt-groups" role="tablist" aria-label="Groups">
          <button type="button" role="tab" aria-selected={groupTab === ALL} className={groupTab === ALL ? 'is-on' : ''} onClick={() => setGroupTab(ALL)}>
            All <em>{wallets.length}</em>
          </button>
          {groups.map((g) => (
            <button key={g.id} type="button" role="tab" aria-selected={groupTab === g.id} className={groupTab === g.id ? 'is-on' : ''} onClick={() => setGroupTab(g.id)}>
              {g.emoji} {g.name} <em>{count(g.id)}</em>
              {g.alerts && <i className="wt-groups__bell" title="Alerts on">🔔</i>}
            </button>
          ))}
          <button type="button" className="wt-groups__add" onClick={() => setModal({ kind: 'group' })} title="Add wallet group">
            +
          </button>
          {activeGroup && (
            <button type="button" className="wt-groups__edit" onClick={() => setModal({ kind: 'group', group: activeGroup })} title={`Edit ${activeGroup.name}: chart marker size and alerts`}>
              ✎ Settings
            </button>
          )}
        </div>

        {wallets.length > 5 && (
          <input className="wt-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or address" aria-label="Search wallets" />
        )}

        {listed.length ? (
          <ul className="wt-wallets">
            {listed.map((w) => (
              <WalletRow
                key={w.id}
                wallet={w}
                group={tracker.groupOf(w.group)}
                stats={stats.get(w.id)}
                active={selected === w.id}
                idle={ids.indexOf(w.id) >= MAX_FOLLOW_POLL}
                tracker={tracker}
                onEdit={() => setModal({ kind: 'wallet', wallet: w })}
                onSelect={() => setSelected(selected === w.id ? null : w.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="muted small wt-hint">
            {wallets.length
              ? q
                ? 'No wallet matches.'
                : 'No addresses in this group yet.'
              : 'Add a wallet, or tap ☆ next to a trader in the Live feed or on the Swap page. Its trades show here live and on the swap chart. The list is kept in this browser: use Export / Import to move it.'}
          </p>
        )}
        {wallets.length > MAX_FOLLOW_POLL && (
          <small className="muted wt-hint">History loads for the first {MAX_FOLLOW_POLL} wallets; the rest show up when they trade live.</small>
        )}

        <button type="button" className="button button--primary wt-add-btn" onClick={() => setModal({ kind: 'wallet' })}>
          + Add wallet
        </button>
      </section>

      <section className="card wt-feed">
        <header className="wt-head">
          <h3>
            {selected ? `${byId.get(selected)?.label}'s trades` : activeGroup ? `${activeGroup.emoji} ${activeGroup.name} · live trades` : 'Live trades'}
            <span className="feed-live">
              <i /> Live
            </span>
          </h3>
          <div className="segmented disc-seg" role="radiogroup" aria-label="Side">
            {SIDES.map((s) => (
              <button key={s.key} type="button" role="radio" aria-checked={side === s.key} className={side === s.key ? 'active' : ''} onClick={() => setSide(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        </header>
        {selected && (
          <button type="button" className="wt-filter" onClick={() => setSelected(null)}>
            <Avatar wallet={byId.get(selected)} size={18} /> {byId.get(selected)?.label} ×
          </button>
        )}

        {!wallets.length ? (
          <EmptyState icon="◉" title="No wallets tracked yet" action={<button type="button" className="button button--primary button--sm" onClick={() => setModal({ kind: 'wallet' })}>+ Add wallet</button>}>
            Track a wallet to follow its buys and sells here, as they happen.
          </EmptyState>
        ) : followed.error && !rows.length ? (
          <ErrorNotice error={followed.error} />
        ) : followed.loading && !rows.length ? (
          Array.from({ length: 6 }, (_, i) => (
            <div className="feed-row" key={i}>
              <Skeleton width={34} height={34} radius={10} />
              <Skeleton width="50%" />
              <Skeleton width={60} />
            </div>
          ))
        ) : !rows.length ? (
          <p className="muted small new-table__empty">No recent trades from {selected ? 'this wallet' : 'these wallets'}.</p>
        ) : (
          rows.map((t) => {
            const w = byId.get(t.trader);
            const token = meta[t.token] || { id: t.token, symbol: (t.token || '').split('.')[0].slice(0, 10) };
            const amount = token.decimals !== undefined ? toNumber(t.amountRaw, token.decimals) : 0;
            const mcap = amount > 0 && supply[t.token] ? (t.usd / amount) * supply[t.token] : null;
            const buy = t.side === 'buy';
            return (
              <div className="feed-row feed-row--in wt-trade" key={t.id}>
                <Link to={`/token/${encodeURIComponent(t.token)}`} className="feed-row__icon" aria-label={`${token.symbol} token page`}>
                  <TokenIcon token={token} size={34} />
                </Link>
                <div className="feed-row__main">
                  <div className="feed-row__line">
                    <button type="button" className="wt-who" onClick={() => setSelected(t.trader)} title={t.trader}>
                      <Avatar wallet={w} size={18} />
                      {w.label}
                    </button>
                    <span className={buy ? 'up' : 'down'}>{buy ? 'bought' : 'sold'}</span>
                    <b>{sizeLabel(t.usd)}</b>
                    <span className="muted">of</span>
                    <Link to={`/token/${encodeURIComponent(t.token)}`} className="feed-row__token">
                      ${token.symbol}
                    </Link>
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
          })
        )}
      </section>

      {modal?.kind === 'wallet' && (
        <WalletModal
          tracker={tracker}
          wallet={modal.wallet}
          draft={modal.draft}
          defaultGroup={groupTab === ALL ? DEFAULT_GROUP.id : groupTab}
          onClose={() => setModal(null)}
          onNewGroup={(draft) => setModal({ kind: 'group', back: { ...modal, draft } })}
        />
      )}
      {modal?.kind === 'group' && (
        <GroupModal
          tracker={tracker}
          group={modal.group}
          onClose={() => setModal((m) => (m?.kind === 'group' ? modal.back || null : m))}
          onSaved={(id) => {
            if (modal.back) setModal({ ...modal.back, draft: { ...modal.back.draft, group: id } });
            else setGroupTab(id);
          }}
        />
      )}
      {modal?.kind === 'import' && <ImportModal tracker={tracker} defaultGroup={groupTab === ALL ? DEFAULT_GROUP.id : groupTab} onClose={() => setModal(null)} />}
    </div>
  );
}
