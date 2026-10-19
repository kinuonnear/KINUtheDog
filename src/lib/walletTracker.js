// Wallet Tracker: the wallets the viewer follows (the Live feed's Following list, kinu.following)
// plus, per wallet, a name, emoji, colour, group and whether it shows on the swap chart; and the
// groups, each with a minimum size for chart markers and its own alerts (kinu.tracker).
// Kept in this browser only; no account needed. Import / export moves it between devices.

import { useSyncExternalStore } from 'react';
import { useFollowing } from './watchlist.js';
import { shortAccount } from './format.js';
import { isAccountId } from './liveFeed.js';

export const TRACKER_COLORS = ['#4fb3ff', '#f5b942', '#b98cff', '#ff8ad8', '#5ee6d0', '#ff9f5a', '#9be15d', '#e2e8f0'];
export const TRACKER_EMOJIS = ['🐋', '🦈', '🧠', '👀', '🔥', '💎', '🚀', '🐕', '🎯', '💰', '🧙', '⭐'];
export const DEFAULT_GROUP = { id: 'default', name: 'Default', emoji: '★', minUsd: 0, alerts: false, sound: 'chime', volume: 80, seconds: 6 };

const KEY = 'kinu.tracker';
const EVENT = `${KEY}:change`;
const EMPTY = { wallets: {}, groups: [DEFAULT_GROUP] };

const clean = (raw) => {
  const wallets = raw && typeof raw.wallets === 'object' && !Array.isArray(raw.wallets) ? raw.wallets : {};
  const groups = Array.isArray(raw?.groups) ? raw.groups.filter((g) => g && typeof g.id === 'string') : [];
  if (!groups.some((g) => g.id === DEFAULT_GROUP.id)) groups.unshift(DEFAULT_GROUP);
  return { wallets, groups: groups.map((g) => ({ ...DEFAULT_GROUP, ...g })) };
};

const read = () => {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY) || 'null') || EMPTY);
  } catch {
    return EMPTY;
  }
};

let cache = read();

const write = (next) => {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / blocked storage: works for this visit
  }
  window.dispatchEvent(new Event(EVENT));
};

const subscribe = (callback) => {
  const onStorage = (e) => {
    if (e.key === KEY) {
      cache = read();
      callback();
    }
  };
  window.addEventListener(EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener('storage', onStorage);
  };
};

/** A stable colour for a wallet without one (followed from the Live feed's ☆). */
function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TRACKER_COLORS[h % TRACKER_COLORS.length];
}

export const defaultName = (id) => (id.length > 20 ? shortAccount(id, 6, 4) : id.replace(/\.near$/, ''));

/** Every NEAR account id in a piece of text (a pasted list, a CSV, …). */
export const accountsIn = (text) => [...new Set(String(text).toLowerCase().split(/[\s,;"'[\]{}]+/).filter(isAccountId))];

/**
 * The tracked wallets, newest first: [{ id, label, emoji, color, group, onChart, minUsd }], the
 * groups, and what can be done with them. Following a trader in the Live feed tracks it here too.
 */
export function useTrackedWallets() {
  const following = useFollowing();
  const store = useSyncExternalStore(subscribe, () => cache);
  const groupOf = (id) => store.groups.find((g) => g.id === id) || store.groups[0];
  const wallets = following.list.map((id) => {
    const m = store.wallets[id] || {};
    const group = groupOf(m.group);
    return {
      id,
      label: m.label || defaultName(id),
      emoji: m.emoji || '',
      color: m.color || colorFor(id),
      group: group.id,
      onChart: m.onChart !== false,
      minUsd: Number(group.minUsd) || 0
    };
  });
  const setWallet = (id, patch) => write({ ...cache, wallets: { ...cache.wallets, [id]: { ...cache.wallets[id], ...patch } } });
  const nextColor = () => {
    const used = new Set(wallets.map((w) => w.color));
    return TRACKER_COLORS.find((c) => !used.has(c));
  };

  return {
    wallets,
    groups: store.groups,
    groupOf,
    has: following.has,
    /** Tracks a wallet (or updates it): { label, emoji, group }. */
    add: (id, patch = {}) => {
      setWallet(id, { color: cache.wallets[id]?.color || nextColor() || colorFor(id), ...patch });
      if (!following.has(id)) following.toggle(id);
    },
    update: setWallet,
    remove: (id) => {
      if (following.has(id)) following.toggle(id);
      const { [id]: _gone, ...rest } = cache.wallets;
      write({ ...cache, wallets: rest });
    },
    toggleChart: (id) => setWallet(id, { onChart: !(cache.wallets[id]?.onChart !== false) }),
    /** Creates or updates a group; returns its id. */
    saveGroup: (group) => {
      const id = group.id || `g${Date.now().toString(36)}`;
      const next = { ...DEFAULT_GROUP, ...group, id, name: String(group.name || 'Group').slice(0, 24), minUsd: Math.max(0, Number(group.minUsd) || 0) };
      const exists = cache.groups.some((g) => g.id === id);
      write({ ...cache, groups: exists ? cache.groups.map((g) => (g.id === id ? next : g)) : [...cache.groups, next] });
      return id;
    },
    /** Deletes a group; its wallets move to Default. */
    deleteGroup: (id) => {
      if (id === DEFAULT_GROUP.id) return;
      const moved = Object.fromEntries(Object.entries(cache.wallets).map(([w, m]) => [w, m.group === id ? { ...m, group: DEFAULT_GROUP.id } : m]));
      write({ wallets: moved, groups: cache.groups.filter((g) => g.id !== id) });
    },
    /** Everything, for a backup file. */
    exportData: () => ({ app: 'kinu-wallet-tracker', version: 1, groups: cache.groups, wallets: following.list.map((id) => ({ id, ...cache.wallets[id] })) }),
    /**
     * Imports a backup (from exportData) or a plain list of addresses (into `groupId`).
     * Returns how many wallets were added.
     */
    importData: (text, groupId = DEFAULT_GROUP.id) => {
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        // not JSON: a list of addresses
      }
      const groups = [...cache.groups];
      const walletsMeta = { ...cache.wallets };
      let entries;
      const backup = Boolean(data && Array.isArray(data.wallets));
      if (backup) {
        for (const g of Array.isArray(data.groups) ? data.groups : []) {
          if (g?.id && !groups.some((x) => x.id === g.id)) groups.push({ ...DEFAULT_GROUP, ...g });
        }
        entries = data.wallets.filter((w) => w && isAccountId(String(w.id || '').toLowerCase()));
      } else {
        entries = accountsIn(text).map((id) => ({ id, group: groupId }));
      }
      let added = 0;
      const ids = [...following.list];
      for (const w of entries) {
        const id = String(w.id).toLowerCase();
        const { id: _id, ...meta } = w;
        // A backup restores each wallet as saved; a pasted list only adds new ones.
        if (backup || !ids.includes(id)) walletsMeta[id] = { color: colorFor(id), ...walletsMeta[id], ...meta };
        if (!ids.includes(id)) {
          ids.push(id);
          added += 1;
        }
      }
      write({ wallets: walletsMeta, groups });
      following.addMany(ids.filter((id) => !following.has(id)));
      return added;
    }
  };
}
