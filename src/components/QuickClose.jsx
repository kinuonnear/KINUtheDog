// /pools?connect=1 — the bot's 🔐 Connect HOT Wallet (ConnectFromBot, below).
// /pools?close=<pool> — the KINU LP bot's "✖ Close" on 📊 LP positions: the Remove liquidity form
// for the connected account's positions in that pool (DclRemoveModal, as on the pool page: 25–100%,
// both tokens back or zapped out to one, signed in the wallet).

import { useEffect, useState } from 'react';
import { useApp } from '../state.jsx';
import { navigate, poolPath } from '../router.jsx';
import { getDclPositions } from '../lib/rhea.js';
import { getToken } from '../lib/tokens.js';
import { refreshDclGraphFor } from '../lib/dclRouter.js';
import { DclRemoveModal } from './DclPositions.jsx';
import { Modal, Spinner } from './ui.jsx';
import { linkBotWallet } from '../lib/telegram.js';

const POOL_ID = /^[^|]{2,80}\|[^|]{2,80}\|\d{1,6}$/;

/**
 * /pools?connect=1 — the bot's "🔐 Connect HOT Wallet": once the wallet has loaded, open its
 * connect window unless an account is already connected. Either way the account then reaches the
 * bot (state.jsx → linkBotWallet), which pins it in the chat.
 */
export function ConnectFromBot() {
  const { accountId, walletReady, connect, toast } = useApp();
  const [asked] = useState(() => new URLSearchParams(window.location.search).has('connect'));
  useEffect(() => {
    if (!asked || !walletReady) return;
    const params = new URLSearchParams(window.location.search);
    params.delete('connect');
    navigate(`/pools${params.toString() ? `?${params}` : ''}`, { replace: true });
    if (accountId) {
      // Asked again from the bot: send the account even if this session already did.
      try {
        sessionStorage.removeItem('kinu.tg.wallet');
      } catch {
        // storage unavailable: linkBotWallet sends it anyway
      }
      linkBotWallet(accountId);
      toast('success', 'Wallet connected', `${accountId} is linked to the KINU LP bot. Head back to Telegram.`);
    } else connect();
    // once, when the wallet has loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, walletReady]);
  return null;
}

export function QuickCloseHost() {
  const { accountId, walletReady, connect } = useApp();
  const [poolId, setPoolId] = useState(null);
  const [found, setFound] = useState(null); // { positions, x, y } · 'none' · 'error' · null while reading
  const [reads, setReads] = useState(0);
  const [names, setNames] = useState(null); // the pool's token symbols, for the title before positions load

  useEffect(() => {
    if (!poolId) return undefined;
    let live = true;
    Promise.all(poolId.split('|').slice(0, 2).map((id) => getToken(id).catch(() => null))).then(
      (tokens) => live && setNames(tokens.map((t, i) => (poolId.split('|')[i] === 'wrap.near' ? 'NEAR' : t?.symbol || null)))
    );
    return () => {
      live = false;
    };
  }, [poolId]);

  // Read the link once, then drop it from the address.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('close') || '';
    if (!POOL_ID.test(id)) return;
    params.delete('close');
    navigate(`/pools${params.toString() ? `?${params}` : ''}`, { replace: true });
    setPoolId(id);
  }, []);

  useEffect(() => {
    if (!poolId || !accountId) return undefined;
    let live = true;
    setFound(null);
    const [xId, yId] = poolId.split('|');
    Promise.all([getDclPositions(accountId), getToken(xId), getToken(yId)])
      .then(([all, x, y]) => {
        if (!live) return;
        const positions = all.filter((p) => p.poolId === poolId);
        setFound(positions.length ? { positions, x, y } : 'none');
      })
      .catch(() => live && setFound('error'));
    return () => {
      live = false;
    };
  }, [poolId, accountId, reads]);

  if (!poolId) return null;
  const close = () => setPoolId(null);
  const [xId, yId] = poolId.split('|');
  const name = [xId, yId].map((t, i) => names?.[i] || (t === 'wrap.near' ? 'NEAR' : t.split('.')[0].slice(0, 10).toUpperCase())).join(' / ');

  if (found && typeof found === 'object') {
    return (
      <DclRemoveModal
        positions={found.positions}
        x={found.x}
        y={found.y}
        onClose={close}
        onDone={() => {
          refreshDclGraphFor(poolId);
          setReads((n) => n + 1);
        }}
      />
    );
  }
  return (
    <Modal title="Close position" subtitle={name} onClose={close}>
      {!walletReady ? (
        <p className="muted">
          <Spinner /> Loading your wallet…
        </p>
      ) : !accountId ? (
        <>
          <p className="muted">Connect the wallet that holds the position to close it.</p>
          <button type="button" className="button button--primary qlp__go" onClick={connect}>
            Connect wallet
          </button>
        </>
      ) : found === null ? (
        <p className="muted">
          <Spinner /> Reading your positions…
        </p>
      ) : (
        <>
          <p className="muted">
            {found === 'none' ? `${accountId} has no positions left in this pool.` : 'Your positions could not be read right now. Try again in a moment.'}
          </p>
          <button type="button" className="button button--outline qlp__go" onClick={() => (close(), navigate(poolPath(poolId)))}>
            View pool →
          </button>
        </>
      )}
    </Modal>
  );
}
