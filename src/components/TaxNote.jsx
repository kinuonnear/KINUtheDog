// A short notice when a pool token charges a transfer tax (lib/tokenTax.js): deposits arrive
// short by the tax, and tokens the pool pays out (withdrawals, fees) lose it on the way out.

import { useAsync } from '../hooks.js';
import { bpsLabel, dclTax } from '../lib/tokenTax.js';

export default function TaxNote({ tokens }) {
  const ids = tokens.map((t) => t.id).join(',');
  const taxes = useAsync(() => Promise.all(tokens.map((t) => dclTax(t.id))), [ids]);
  const taxed = (taxes.data || []).map((t, i) => ({ token: tokens[i], ...t })).filter((t) => t.into || t.out);
  if (!taxed.length) return null;
  return (
    <div className="notice notice--info tax-note">
      <span>
        {taxed
          .map(({ token, into, out }) =>
            into === out ? `${token.symbol} has a ${bpsLabel(into)} token tax` : `${token.symbol} has a token tax (${bpsLabel(into)} in · ${bpsLabel(out)} out)`
          )
          .join(' · ')}{' '}
        on transfers to and from Rhea pools, set by the token. KINU sizes your deposit to what arrives; withdrawals and fees are paid
        out after the tax.
      </span>
    </div>
  );
}
