// In place of a holder-only part of a page (KINU Holder, lib/holder.js): what it takes to unlock.

import { useApp } from '../state.jsx';
import { Link } from '../router.jsx';
import { HOLDER } from '../config.js';
import { formatUsd } from '../lib/format.js';
import { KINU_BUY_PATH } from './MoreMenu.jsx';

export default function HolderLock({ what }) {
  const { accountId, connect, holder } = useApp();
  return (
    <div className="holder-lock">
      <span className="holder-lock__badge">KINU Holder</span>
      <p>
        {what}: for wallets holding at least ${HOLDER.minUsd} of $KINU.
        {accountId && holder && holder.price > 0 && <> You hold {formatUsd(holder.usd)}: {formatUsd(holder.missingUsd)} to go.</>}
      </p>
      <div className="holder-lock__actions">
        {!accountId && (
          <button type="button" className="button button--outline button--sm" onClick={connect}>
            Connect wallet
          </button>
        )}
        <Link className="button button--primary button--sm" to={KINU_BUY_PATH}>
          Get $KINU
        </Link>
      </div>
    </div>
  );
}
