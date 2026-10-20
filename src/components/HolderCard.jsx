// KINU Holder card on the Portfolio (lib/holder.js): the badge, the KINU in this wallet and how
// close it is to the bar. Read-only portfolios show it too (without the price-drop cover, which is
// remembered in the owner's browser only).

import { Link } from '../router.jsx';
import { HOLDER, KINU_TOKEN } from '../config.js';
import { formatAmount, formatUsd } from '../lib/format.js';
import { holderStatus, readQualified } from '../lib/holder.js';
import { getCachedToken, getToken } from '../lib/tokens.js';
import { useAsync } from '../hooks.js';
import { KINU_BUY_PATH } from './MoreMenu.jsx';
import { TokenIcon } from './ui.jsx';

export default function HolderCard({ account, own, kinuRaw, kinuToken, prices }) {
  // The KINU logo also for wallets without KINU (its metadata is usually cached already).
  const kinuMeta = useAsync(() => getToken(KINU_TOKEN), [], { enabled: HOLDER.enabled && !kinuToken && !getCachedToken(KINU_TOKEN) });
  const icon = kinuToken || getCachedToken(KINU_TOKEN) || kinuMeta.data;
  if (!HOLDER.enabled) return null;
  const status = holderStatus(kinuRaw ? { [KINU_TOKEN]: kinuRaw } : {}, prices, own ? readQualified(account) : 0);
  if (!(status.price > 0)) return null;
  const floor = HOLDER.minUsd * (1 - HOLDER.grace);
  // Whole dollars for the bar's own numbers ($20, $13).
  const dollars = (v) => '$' + Math.round(v);
  const fill = Math.min(100, (status.usd / HOLDER.minUsd) * 100);
  const state = status.full ? 'on' : status.grace ? 'cover' : 'off';
  const label = { on: 'Active', cover: 'Price-drop cover', off: 'Not yet' }[state];

  return (
    <section className={`card holder-pass holder-pass--${state}`} aria-label="KINU Holder">
      <div className="holder-pass__badge" aria-hidden="true">
        {icon ? <TokenIcon token={icon} size={40} /> : <span>K</span>}
        <b>★</b>
      </div>
      <div className="holder-pass__main">
        <div className="holder-pass__title">
          <strong>KINU Holder</strong>
          <em className={`holder-pass__state holder-pass__state--${state}`}>{label}</em>
        </div>
        <span className="holder-pass__held">
          {formatAmount(status.amount)} KINU in this wallet · <b>{formatUsd(status.usd)}</b>
        </span>
        <div className="holder-pass__bar" role="img" aria-label={`${formatUsd(status.usd)} of the ${dollars(HOLDER.minUsd)} bar`}>
          <i style={{ width: `${fill}%` }} />
          <span className="holder-pass__mark" style={{ left: `${(floor / HOLDER.minUsd) * 100}%` }} title={`Price-drop cover down to ${dollars(floor)}`} />
        </div>
        <div className="holder-pass__scale">
          <span>$0</span>
          <span style={{ left: `${(floor / HOLDER.minUsd) * 100}%` }}>cover {dollars(floor)}</span>
          <span>{dollars(HOLDER.minUsd)}</span>
        </div>
      </div>
      <div className="holder-pass__rule">
        <p>
          Hold {dollars(HOLDER.minUsd)}+ of $KINU in the wallet (KINU in LP positions doesn&apos;t count). Once it qualifies, the badge stays
          through a price drop of up to {HOLDER.grace * 100}% as long as the KINU isn&apos;t sold.
        </p>
        {own && !status.isHolder && (
          <Link className="button button--primary button--sm" to={KINU_BUY_PATH}>
            Get $KINU · {formatUsd(status.missingUsd)} to go
          </Link>
        )}
      </div>
    </section>
  );
}
