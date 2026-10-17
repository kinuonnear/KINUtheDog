// Portfolio: the viewed account's liquid staking (LiNEAR, stNEAR) as staking — NEAR value, APY and
// any delayed unstake — with a link to /stake. Renders nothing when the account has none.

import { useAsync } from '../hooks.js';
import { Link } from '../router.jsx';
import { formatWait, getEpochClock, getPosition, getStakingApy, priceOf, secondsUntilEpoch, STAKING } from '../lib/staking.js';
import { getTokens } from '../lib/tokens.js';
import { formatAmount, formatUnits } from '../lib/format.js';
import '../stake.css';

const KEYS = ['linear', 'stnear'];
const near = (yocto) => formatAmount(Number(formatUnits(yocto, 24)));

export default function StakingSummary({ account, readOnly }) {
  const data = useAsync(
    async () => {
      const rows = await Promise.all(
        KEYS.map(async (k) => {
          const price = await priceOf(k);
          return { key: k, ...(await getPosition(k, account, price)) };
        })
      );
      return rows.filter((r) => r.shares > 0n || r.unstaked > 0n);
    },
    [account],
    { enabled: Boolean(account), refreshMs: 60_000 }
  );
  const apy = useAsync(() => getStakingApy(), []);
  const clock = useAsync(() => getEpochClock(), [], { enabled: Boolean(data.data?.some((r) => r.unlockEpoch)) });
  const tokens = useAsync(() => getTokens(KEYS.map((k) => STAKING[k].contract)), []);

  if (!data.data?.length) return null;
  return (
    <section className="card stk-summary">
      <div className="stk-summary__head">
        <span className="eyebrow">Staking</span>
        <Link to="/stake" className="link-button">
          {readOnly ? 'Open Stake →' : 'Manage on Stake →'}
        </Link>
      </div>
      <div className="stk-summary__rows">
        {data.data.map((r) => {
          const s = STAKING[r.key];
          const icon = tokens.data?.[s.contract]?.icon;
          const wait = r.unlockEpoch && clock.data ? formatWait(secondsUntilEpoch(r.unlockEpoch, clock.data)) : null;
          return (
            <div key={r.key} className="stk-summary__row">
              {icon ? <img className="stk-icon" src={icon} alt="" width={28} height={28} /> : <span className="stk-icon stk-icon--blank" style={{ width: 28, height: 28 }} />}
              <div>
                <b>
                  {near(r.shares)} {s.symbol}
                </b>
                <small className="muted">
                  ≈ {near(r.valueNear)} NEAR{apy.data?.[r.key] != null ? ` · ${apy.data[r.key].toFixed(2)}% APY` : ''}
                </small>
                {r.unstaked > 0n && (
                  <small className={r.canWithdraw ? 'up' : 'muted'}>
                    {near(r.unstaked)} NEAR unstaking · {r.canWithdraw ? 'ready to withdraw' : wait ? `ready in ~${wait}` : 'unlocking'}
                  </small>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
