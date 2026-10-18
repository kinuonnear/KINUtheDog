// "Pay from wallet" under a live Bridge deposit (pages/Deposit.jsx): one click sends exactly the
// quoted amount to the verified one-time deposit address from a browser wallet on that chain
// (lib/payFromWallet.js), then tells NEAR Intents the transaction hash so it is picked up sooner.

import { useEffect, useState } from 'react';
import { findEvmWallets, findSolanaWallets, payEvm, paySolana, walletKindFor } from '../lib/payFromWallet.js';
import { submitDepositTx } from '../lib/intents.js';
import { Spinner } from './ui.jsx';

const userRejected = (e) => e?.code === 4001 || /reject|denied|cancel/i.test(String(e?.message || e));

export default function PayFromWallet({ active, chainLabel, onPaid }) {
  const kind = walletKindFor(active.chain);
  const [wallets, setWallets] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    if (kind === 'evm') findEvmWallets().then((w) => live && setWallets(w));
    else if (kind === 'sol') setWallets(findSolanaWallets());
    return () => {
      live = false;
    };
  }, [kind]);

  // Older deposits (saved before this existed) don't carry the raw amount: send manually.
  if (!kind || !active.amountIn || !active.asset) return null;

  const pay = async (wallet) => {
    setBusy(wallet.id);
    setError('');
    try {
      const args = { provider: wallet.provider, chain: active.chain, chainLabel, asset: active.asset, to: active.depositAddress, amount: active.amountIn };
      const hash = kind === 'evm' ? await payEvm(args) : await paySolana(args);
      if (hash) submitDepositTx(active.depositAddress, String(hash), active.depositMemo).catch(() => {});
      onPaid?.(String(hash || ''));
    } catch (e) {
      setError(userRejected(e) ? 'Cancelled in your wallet. Nothing was sent.' : e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dep-pay">
      <span className="dep-label">Pay from wallet</span>
      {wallets === null ? (
        <small className="muted">
          <Spinner size={12} /> Looking for wallets…
        </small>
      ) : wallets.length === 0 ? (
        <small className="muted">
          No {kind === 'evm' ? 'EVM wallet (MetaMask, Rabby, Coinbase Wallet…)' : 'Solana wallet (Phantom, Solflare, Backpack)'} found in this browser. Send manually with the address above, from any wallet or exchange.
        </small>
      ) : (
        <div className="dep-pay__list">
          {wallets.map((w) => (
            <button key={w.id} type="button" className="button button--primary" disabled={Boolean(busy)} onClick={() => pay(w)}>
              {busy === w.id ? <Spinner size={14} /> : w.icon ? <img src={w.icon} alt="" width="18" height="18" /> : null}
              Pay {active.amountInFormatted} {active.symbol} with {w.name}
            </button>
          ))}
        </div>
      )}
      {error && <small className="down">{error}</small>}
      <small className="muted">Your wallet shows the exact amount and the deposit address above before you confirm.</small>
    </div>
  );
}
