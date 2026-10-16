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

async function rheaStats() {
  const data = await searchPools({ limit: 300, hideLow: true });
  const list = data?.list || [];
  return { pools: data?.total || list.length, tvl: list.reduce((s, p) => s + p.tvl, 0) };
}

async function intearStats() {
  const list = await fetchIntearPools();
  return { pools: list.length, tvl: list.reduce((s, p) => s + p.tvl, 0) };
}

function SourceCard({ to, on, logo, name, stats }) {
  return (
    <Link to={to} className={`pool-source ${on ? 'pool-source--on' : ''}`} aria-current={on ? 'page' : undefined}>
      <span className="pool-source__logo" aria-hidden>
        {logo ? <img src={logo} alt="" width="32" height="32" /> : name[0]}
      </span>
      <span className="pool-source__body">
        <strong>{name}</strong>
        <small>{stats ? `${stats.pools.toLocaleString()} pools · ${formatUsd(stats.tvl, K)} TVL` : 'Loading…'}</small>
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
  return (
    <nav className="pool-sources" aria-label="Pools by DEX">
      <SourceCard to="/pools" on={active === 'rhea'} logo={rheaLogo.data} name="Rhea" stats={rhea || rheaLoaded.data} />
      <SourceCard to="/intear-dex" on={active === 'intear'} logo={INTEAR_LOGO} name="Intear DEX" stats={intear || intearLoaded.data} />
    </nav>
  );
}
