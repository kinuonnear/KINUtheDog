import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Run an async loader whenever `deps` change. Stale responses are ignored.
 * `reload()` re-runs it keeping current data visible (silent refresh).
 */
export function useAsync(loader, deps, { enabled = true, refreshMs = 0 } = {}) {
  const [state, setState] = useState({ data: undefined, error: null, loading: enabled });
  const runId = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(
    async (silent) => {
      const id = ++runId.current;
      if (!silent) setState((s) => ({ data: s.data, error: null, loading: true }));
      try {
        const data = await loaderRef.current();
        if (id === runId.current) setState({ data, error: null, loading: false });
      } catch (error) {
        if (id === runId.current) {
          setState((s) => ({ data: silent ? s.data : undefined, error, loading: false }));
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!enabled) {
      runId.current += 1;
      setState({ data: undefined, error: null, loading: false });
      return undefined;
    }
    run(false);
    if (!refreshMs) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') run(true);
    }, refreshMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshMs, ...deps]);

  const reload = useCallback(() => run(true), [run]);
  return { ...state, reload };
}

export function useDebounced(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function readStored(key, initial) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : JSON.parse(stored);
  } catch {
    return initial;
  }
}

/**
 * State persisted in localStorage. If `key` changes, the value for the new key
 * is loaded (instead of the old value being written under the new key).
 */
export function useLocalStorage(key, initial) {
  const [state, setState] = useState(() => ({ key, value: readStored(key, initial) }));
  let current = state;
  if (state.key !== key) {
    current = { key, value: readStored(key, initial) };
    setState(current);
  }
  useEffect(() => {
    try {
      localStorage.setItem(current.key, JSON.stringify(current.value));
    } catch {
      // ignore quota / privacy mode
    }
  }, [current.key, current.value]);
  const setValue = useCallback(
    (next) => setState((s) => ({ key: s.key, value: typeof next === 'function' ? next(s.value) : next })),
    []
  );
  return [current.value, setValue];
}

/** Close a popover when clicking outside of `ref`. */
export function useClickOutside(ref, onOutside, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const handler = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onOutside, active]);
}
