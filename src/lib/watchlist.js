// Watchlist: token ids the viewer starred, kept in this browser only (no account needed).
// One shared store so every star on the page updates together.

import { useSyncExternalStore } from 'react';

const KEY = 'kinu.watchlist';
const EVENT = 'kinu:watchlist';

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

let cache = read();

function write(list) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // private mode / blocked storage: the list still works for this visit
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(callback) {
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
}

export function useWatchlist() {
  const list = useSyncExternalStore(subscribe, () => cache);
  return {
    list,
    has: (id) => list.includes(id),
    toggle: (id) => write(list.includes(id) ? list.filter((x) => x !== id) : [id, ...list].slice(0, 100))
  };
}
