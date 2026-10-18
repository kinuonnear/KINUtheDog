// Portfolio: the viewed account's Earn vault positions (lib/earn.js), held in its NEAR Intents
// balance, with value and APY and a link to /earn. Renders nothing when the account has none.

import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { getEarnPositions, getVaultStats, VAULTS } from '../lib/earn.js';
import { formatUsd } from '../lib/format.js';
import '../stake.css';

export default function EarnSummary({ account, readOnly }) {
  const positions = useAsync(() => getEarnPositions(account), [account], { enabled: Boolean(account), refreshMs: 60_000 });
  const held = positions.data ? VAULTS.filter((v) => positions.data[v.key]?.shares > 0n) : [];
  const stats = useAsync(() => getVaultStats(), [], { enabled: held.length > 0 });
  if (!held.length) return null;
  return (
    <section className="card stk-summary">
      <div className="stk-summary__head">
        <span className="eyebrow">Earn</span>
        <Link to="/earn" className="link-button">
          {readOnly ? 'Open Earn →' : 'Manage on Earn →'}
        </Link>
      </div>
      <div className="stk-summary__rows">
        {held.map((v) => {
          const p = positions.data[v.key];
          const apy = stats.data?.[v.key]?.apy;
          return (
            <div key={v.key} className="stk-summary__row">
              <img className="stk-icon" src={v.icon} alt="" width={28} height={28} />
              <div>
                <b>{formatUsd(p.usd)}</b>
                <small className="muted">
                  {v.name} · {v.chainName}
                  {apy != null ? ` · ${apy.toFixed(2)}% APY` : ''}
                </small>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
