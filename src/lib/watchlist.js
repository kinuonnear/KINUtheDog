// Lists the viewer keeps in this browser only (no account needed):
//   Watchlist — starred token ids;   Following — trader accounts followed in the Live feed;
//   LP watchlist — LP wallets starred on Smart LP.
// One shared store per list so every star on the page updates together.

import { useSyncExternalStore } from 'react';

function createListStore(key, max) {
  const event = `${key}:change`;

  const read = () => {
    try {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  };

  let cache = read();

  const write = (list) => {
    cache = list;
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch {
      // private mode / blocked storage: the list still works for this visit
    }
    window.dispatchEvent(new Event(event));
  };

  const subscribe = (callback) => {
    const onStorage = (e) => {
      if (e.key === key) {
        cache = read();
        callback();
      }
    };
    window.addEventListener(event, callback);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(event, callback);
      window.removeEventListener('storage', onStorage);
    };
  };

  return function useList() {
    const list = useSyncExternalStore(subscribe, () => cache);
    return {
      list,
      has: (id) => list.includes(id),
      toggle: (id) => write(list.includes(id) ? list.filter((x) => x !== id) : [id, ...list].slice(0, max))
    };
  };
}

export const useWatchlist = createListStore('kinu.watchlist', 100);
export const useFollowing = createListStore('kinu.following', 200);
export const useLpWatchlist = createListStore('kinu.smartlp.watch', 200);
