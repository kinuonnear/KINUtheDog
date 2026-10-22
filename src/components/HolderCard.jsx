// KINU Holder card on the Portfolio (lib/holder.js): the badge, the wallet's tier and what the next
// one takes. Read-only portfolios show it too (without the price-drop cover, which is remembered in
// the owner's browser only).

import { Link } from '../router.jsx';
import { HOLDER, KINU_TOKEN } from '../config.js';
import { formatAmount, formatUsd } from '../lib/format.js';
import { holderStatus, readQualified, TIERS } from '../lib/holder.js';
import { getCachedToken, getToken } from '../lib/tokens.js';
import { useAsync } from '../hooks.js';
import { KINU_BUY_PATH } from './MoreMenu.jsx';
import { TokenIcon } from './ui.jsx';

const pctOff = (off) => `${Math.round(off * 100)}% off`;

export default function HolderCard({ account, own, kinuRaw, kinuToken, prices }) {
  // The KINU logo also for wallets without KINU (its metadata is usually cached already).
  const kinuMeta = useAsync(() => getToken(KINU_TOKEN), [], { enabled: HOLDER.enabled && !kinuToken && !getCachedToken(KINU_TOKEN) });
  const icon = kinuToken || getCachedToken(KINU_TOKEN) || kinuMeta.data;
  if (!HOLDER.enabled) return null;
  const status = holderStatus(kinuRaw ? { [KINU_TOKEN]: kinuRaw } : {}, prices, own ? readQualified(account) : undefined);
  if (!(status.price > 0)) return null;
  const top = TIERS[TIERS.length - 1];
  // The bar runs to the highest tier, with a mark at each tier's bar.
  const fill = Math.min(100, (status.usd / top.minUsd) * 100);
  const state = status.full ? 'on' : status.grace ? 'cover' : 'off';
  const label = status.isHolder ? `Tier ${status.tier + 1} · ${pctOff(status.off)}${status.grace ? ' · price-drop cover' : ''}` : 'Not yet';

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
        <div className="holder-pass__bar" role="img" aria-label={`${formatUsd(status.usd)} held; tiers at ${TIERS.map((t) => `$${t.minUsd}`).join(', ')}`}>
          <i style={{ width: `${fill}%` }} />
          {TIERS.slice(0, -1).map((t) => (
            <span key={t.minUsd} className="holder-pass__mark" style={{ left: `${(t.minUsd / top.minUsd) * 100}%` }} title={`$${t.minUsd}: ${pctOff(t.off)}`} />
          ))}
        </div>
        <div className="holder-pass__tiers">
          {TIERS.map((t, i) => (
            <span key={t.minUsd} className={i === status.tier ? 'is-on' : i < status.tier ? 'is-past' : ''}>
              ${t.minUsd} · {pctOff(t.off)}
            </span>
          ))}
        </div>
      </div>
      <div className="holder-pass__rule">
        <p>
          Hold $KINU in the wallet for a share off KINU&apos;s own fees: swaps and Quick LP (KINU in LP positions doesn&apos;t count). A tier stays
          through a price drop of up to {HOLDER.grace * 100}% as long as the KINU isn&apos;t sold.
        </p>
        {own && status.next && (
          <Link className="button button--primary button--sm" to={KINU_BUY_PATH}>
            Get $KINU · {formatUsd(status.missingUsd)} to {pctOff(status.next.off)}
          </Link>
        )}
      </div>
    </section>
  );
}
