// Minimal History-API router: client-side navigation without full reloads.

import { useSyncExternalStore } from 'react';

const NAVIGATE_EVENT = 'kinu:navigate';

function subscribe(callback) {
  window.addEventListener('popstate', callback);
  window.addEventListener(NAVIGATE_EVENT, callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener(NAVIGATE_EVENT, callback);
  };
}

const getPath = () => window.location.pathname + window.location.search;

export function navigate(to, { replace = false } = {}) {
  if (to === getPath()) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  if (!replace) window.scrollTo({ top: 0 });
}

export function useLocation() {
  const full = useSyncExternalStore(subscribe, getPath);
  const url = new URL(full, window.location.origin);
  return { pathname: url.pathname.replace(/\/+$/, '') || '/', search: url.searchParams };
}

const ROUTES = [
  { name: 'home', pattern: /^\/$/ },
  { name: 'app', pattern: /^\/app$/ },
  { name: 'swap', pattern: /^\/swap$/ },
  { name: 'pools', pattern: /^\/pools$/ },
  { name: 'pool', pattern: /^\/pools\/([^/]+)$/ },
  { name: 'create', pattern: /^\/create-pool$/ },
  { name: 'starter', pattern: /^\/start-lp$/ },
  { name: 'agent', pattern: /^\/agent$/ },
  { name: 'portfolio', pattern: /^\/portfolio$/ },
  { name: 'security', pattern: /^\/security$/ },
  { name: 'docs', pattern: /^\/docs(?:\/([^/]+))?$/ },
  { name: 'new', pattern: /^\/new$/ },
  { name: 'discover', pattern: /^\/discover$/ },
  { name: 'token', pattern: /^\/token\/([^/]+)$/ }
];

export function matchRoute(pathname) {
  for (const route of ROUTES) {
    const match = pathname.match(route.pattern);
    if (match) {
      // Optional groups that did not match stay undefined (not the string "undefined").
      return { name: route.name, params: match.slice(1).map((p) => (p === undefined ? undefined : decodeURIComponent(p))) };
    }
  }
  return { name: 'notfound', params: [] };
}

export function Link({ to, children, className, onClick, ...rest }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export const poolPath = (poolId) => `/pools/${encodeURIComponent(poolId)}`;

// The pools list a pool page's ← returns to (e.g. /pools?view=mine), kept for this tab.
const POOLS_RETURN_KEY = 'kinu.poolsReturn';

export function rememberPoolsPath(path) {
  try {
    sessionStorage.setItem(POOLS_RETURN_KEY, path);
  } catch {
    // storage unavailable: ← goes to /pools
  }
}

export function poolsReturnPath() {
  try {
    const path = sessionStorage.getItem(POOLS_RETURN_KEY);
    return path && path.startsWith('/pools') ? path : '/pools';
  } catch {
    return '/pools';
  }
}
