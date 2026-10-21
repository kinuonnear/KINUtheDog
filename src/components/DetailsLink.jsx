// "Details" on Discover rows: opens the token page (chart, KINU Scan, pools, Swap and Quick trade).
// The button only navigates, so it says so — it never buys or swaps by itself.

import { Link } from '../router.jsx';

export default function DetailsLink({ tokenId, symbol }) {
  if (!tokenId) return null;
  return (
    <Link
      className="button button--outline button--sm"
      to={`/token/${encodeURIComponent(tokenId)}`}
      onClick={(event) => event.stopPropagation()}
      title={`${symbol || 'Token'} details: chart, KINU Scan, pools, Swap and Quick trade`}
    >
      Details
    </Link>
  );
}
