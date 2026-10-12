// "Share" button + preview modal for a PnL card (lib/shareCard.js). X's web intent
// can't attach images, so the image is shared natively where the browser supports it
// (mobile), and otherwise downloaded for the user to attach to the prepared post.

import { useEffect, useState } from 'react';
import { drawShareCard, SITE_URL } from '../lib/shareCard.js';
import { Modal, Spinner } from './ui.jsx';

const FILE_NAME = 'kinu-pnl.png';

/** build(hideUsd) returns the card for lib/shareCard.js plus `text` for the post. */
function ShareModal({ build, onClose }) {
  const [hideUsd, setHideUsd] = useState(false);
  const [image, setImage] = useState(null); // { blob, url }
  const [error, setError] = useState(null);
  const card = build(hideUsd);

  useEffect(() => {
    let url = null;
    let cancelled = false;
    setImage(null);
    setError(null);
    drawShareCard(card)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImage({ blob, url });
      })
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // The card is rebuilt each render; redraw only when its content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(card)]);

  const file = image ? new File([image.blob], FILE_NAME, { type: 'image/png' }) : null;
  const canShareFile = Boolean(file && navigator.canShare?.({ files: [file] }));
  const postText = `${card.text}\n\nTracked on https://${SITE_URL}`;

  const download = () => {
    const a = document.createElement('a');
    a.href = image.url;
    a.download = FILE_NAME;
    a.click();
  };

  return (
    <Modal title="Share your PnL" subtitle="A card for X — no wallet address on it." onClose={onClose} width={640}>
      <div className="share-card">
        <div className="share-card__preview">
          {image ? <img src={image.url} alt="PnL card preview" /> : error ? <span className="muted">{error.message}</span> : <Spinner />}
        </div>
        <label className="share-card__toggle">
          <input type="checkbox" checked={hideUsd} onChange={(e) => setHideUsd(e.target.checked)} />
          Hide dollar amounts (show % only)
        </label>
        <div className="share-card__actions">
          {canShareFile && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => navigator.share({ files: [file], text: postText }).catch(() => {})}
            >
              Share image…
            </button>
          )}
          <a
            className={`button ${canShareFile ? 'button--outline' : 'button--primary'}`}
            href={`https://x.com/intent/post?text=${encodeURIComponent(postText)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => !canShareFile && image && download()}
          >
            Post on X
          </a>
          <button type="button" className="button button--ghost" onClick={download} disabled={!image}>
            Download image
          </button>
        </div>
        {!canShareFile && <p className="muted small">“Post on X” also downloads the image — attach it to your post.</p>}
      </div>
    </Modal>
  );
}

export default function ShareButton({ build, label = 'Share', className = 'button button--ghost button--sm' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Share to X">
        ↗ {label}
      </button>
      {open && <ShareModal build={build} onClose={() => setOpen(false)} />}
    </>
  );
}
