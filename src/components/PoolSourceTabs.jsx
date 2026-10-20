import { useState } from 'react';
import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { searchPools } from '../lib/rhea.js';
import { fetchIntearPools } from '../lib/intearDex.js';
import { getToken } from '../lib/tokens.js';
import { formatUsd } from '../lib/format.js';

// Pools by DEX: one card per DEX with its pool count and liquidity. Rhea opens the full pools
// page, Intear DEX the read-only list (liquidity is added on Intear). A page passes the numbers
// it already has for its own DEX (undefined while loading); the other DEX's numbers are loaded here.
const INTEAR_LOGO = 'https://docs.intear.tech/intear-logo.svg';
const RHEA_TOKEN = 'token.rhealab.near';
const K = { compactAbove: 1e3 };

// The other DEX's numbers: the last ones seen show at once (this browser keeps them), fresh ones
// replace them when they arrive. A source that doesn't answer within 8s shows "Unavailable"
// (with a retry) instead of "Loading…" forever.
const TIMEOUT_MS = 8000;
const cacheKey = (name) => `kinu.poolSource.${name}`;

function readCached(name) {
  try {
    const v = JSON.parse(localStorage.getItem(cacheKey(name)) || 'null');
    return v && Number.isFinite(v.pools) && Number.isFinite(v.tvl) ? v : null;
  } catch {
    return null;
  }
}

function withTimeout(load) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return Promise.race([
    load(ctrl.signal),
    new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(new Error('timeout'))))
  ]).finally(() => clearTimeout(timer));
}

const cached = (name, load) => async () => {
  const stats = await withTimeout(load);
  try {
    localStorage.setItem(cacheKey(name), JSON.stringify(stats));
  } catch {
    // ignore quota / privacy mode
  }
  return stats;
};

const rheaStats = cached('rhea', async () => {
  const data = await searchPools({ limit: 300, hideLow: true });
  const list = data?.list || [];
  return { pools: data?.total || list.length, tvl: list.reduce((s, p) => s + p.tvl, 0) };
});

const intearStats = cached('intear', async (signal) => {
  const list = await fetchIntearPools({ signal });
  return { pools: list.length, tvl: list.reduce((s, p) => s + p.tvl, 0) };
});

function SourceCard({ to, on, logo, name, stats, failed, onRetry }) {
  return (
    <Link to={to} className={`pool-source ${on ? 'pool-source--on' : ''}`} aria-current={on ? 'page' : undefined}>
      <span className="pool-source__logo" aria-hidden>
        {logo ? <img src={logo} alt="" width="32" height="32" /> : name[0]}
      </span>
      <span className="pool-source__body">
        <strong>{name}</strong>
        <small>
          {stats ? (
            `${stats.pools.toLocaleString()} pools · ${formatUsd(stats.tvl, K)} TVL`
          ) : failed ? (
            <>
              Unavailable ·{' '}
              <span
                role="button"
                tabIndex={0}
                className="link-button"
                onClick={(e) => {
                  e.preventDefault();
                  onRetry?.();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onRetry?.();
                  }
                }}
              >
                retry
              </span>
            </>
          ) : (
            'Loading…'
          )}
        </small>
      </span>
      {on && (
        <span className="pool-source__check" aria-hidden>
          ✓
        </span>
      )}
    </Link>
  );
}

export default function PoolSourceTabs({ active, rhea, intear }) {
  const rheaLoaded = useAsync(rheaStats, [], { enabled: active !== 'rhea' });
  const intearLoaded = useAsync(intearStats, [], { enabled: active !== 'intear' });
  const rheaLogo = useAsync(() => getToken(RHEA_TOKEN).then((t) => t?.icon || null), []);
  const [rheaCached] = useState(() => readCached('rhea'));
  const [intearCached] = useState(() => readCached('intear'));
  return (
    <nav className="pool-sources" aria-label="Pools by DEX">
      <SourceCard
        to="/pools"
        on={active === 'rhea'}
        logo={rheaLogo.data}
        name="Rhea"
        stats={rhea || rheaLoaded.data || (active !== 'rhea' ? rheaCached : null)}
        failed={Boolean(rheaLoaded.error)}
        onRetry={rheaLoaded.reload}
      />
      <SourceCard
        to="/intear-dex"
        on={active === 'intear'}
        logo={INTEAR_LOGO}
        name="Intear DEX"
        stats={intear || intearLoaded.data || (active !== 'intear' ? intearCached : null)}
        failed={Boolean(intearLoaded.error)}
        onRetry={intearLoaded.reload}
      />
    </nav>
  );
}
