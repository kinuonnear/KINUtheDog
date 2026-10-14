// "Share" button + preview modal for a PnL card (lib/shareCard.js). X's web intent
// can't attach images, so the image is shared natively where the browser supports it
// (mobile), and otherwise downloaded for the user to attach to the prepared post.
// The card's background can be a KINU theme, a KINU picture or the user's own picture
// (read in the browser only — it is never uploaded).

import { useEffect, useMemo, useRef, useState } from 'react';
import { backgroundThumb, CARD_BACKGROUNDS, drawShareCard, SITE_URL } from '../lib/shareCard.js';
import { useLocalStorage } from '../hooks.js';
import { Modal, Spinner } from './ui.jsx';

const FILE_NAME = 'kinu-pnl.png';
const MAX_UPLOAD = 12 * 1024 * 1024;

/** build(hideUsd) returns the card for lib/shareCard.js plus `text` for the post. */
function ShareModal({ build, onClose }) {
  const [hideUsd, setHideUsd] = useState(false);
  const [bgKey, setBgKey] = useLocalStorage('kinu.share.background', 'classic');
  const [upload, setUpload] = useState(null); // data: URL of the user's own picture
  const [uploadError, setUploadError] = useState(null);
  const [image, setImage] = useState(null); // { blob, url }
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  // Privacy: what the card leaves out (the wallet address is never on it).
  const [hidePool, setHidePool] = useState(false);
  const [hideTime, setHideTime] = useState(false);
  const [hiddenStats, setHiddenStats] = useState([]);
  const built = build(hideUsd, { hidePool });
  const allStats = built.stats || [];
  const card = {
    ...built,
    stats: allStats.filter(([label]) => !hiddenStats.includes(label)),
    sub: built.updated && !hideTime ? `${built.sub} · Updated ${built.updated}` : built.sub
  };
  const toggleStat = (label) => setHiddenStats((list) => (list.includes(label) ? list.filter((l) => l !== label) : [...list, label]));
  const poolOption = built.kicker !== 'TOKEN PNL'; // token cards have no pool
  const background =
    bgKey === 'upload' && upload ? { key: 'upload', src: upload } : CARD_BACKGROUNDS.find((b) => b.key === bgKey) || CARD_BACKGROUNDS[0];
  // Small previews of the drawn backgrounds, in the colour of this card's result.
  const thumbs = useMemo(
    () => Object.fromEntries(CARD_BACKGROUNDS.filter((b) => b.art).map((b) => [b.key, backgroundThumb(b.key, card.tone)])),
    [card.tone]
  );

  useEffect(() => {
    let url = null;
    let cancelled = false;
    setImage(null);
    setError(null);
    drawShareCard(card, background)
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
    // The card is rebuilt each render; redraw only when its content or background changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(card), background.key, background.src]);

  const pickFile = (event) => {
    const f = event.target.files?.[0];
    event.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      setUploadError('Choose an image file.');
      return;
    }
    if (f.size > MAX_UPLOAD) {
      setUploadError('That image is over 12 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setUploadError(null);
      setUpload(String(reader.result));
      setBgKey('upload');
    };
    reader.onerror = () => setUploadError('Could not read that image.');
    reader.readAsDataURL(f);
  };

  const file = image ? new File([image.blob], FILE_NAME, { type: 'image/png' }) : null;
  const canShareFile = Boolean(file && navigator.canShare?.({ files: [file] }));
  const postText = `${card.text}\n\nhttps://${SITE_URL}`;

  const download = () => {
    const a = document.createElement('a');
    a.href = image.url;
    a.download = FILE_NAME;
    a.click();
  };

  return (
    <Modal title="Share your PnL" subtitle="Ready for X — your wallet address is never shown." onClose={onClose} width={680}>
      <div className="share-card">
        <div className="share-card__preview">
          {image ? <img src={image.url} alt="PnL card preview" /> : error ? <span className="muted">{error.message}</span> : <Spinner />}
        </div>

        <div className="share-card__backgrounds" role="radiogroup" aria-label="Card background">
          {CARD_BACKGROUNDS.map((b) => (
            <button
              key={b.key}
              type="button"
              role="radio"
              aria-checked={bgKey === b.key}
              className={`share-bg share-bg--${b.key} ${bgKey === b.key ? 'share-bg--on' : ''}`}
              style={b.src || thumbs[b.key] ? { backgroundImage: `url(${b.src || thumbs[b.key]})` } : undefined}
              onClick={() => setBgKey(b.key)}
            >
              <span>{b.label}</span>
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={bgKey === 'upload' && Boolean(upload)}
            className={`share-bg share-bg--upload ${bgKey === 'upload' && upload ? 'share-bg--on' : ''}`}
            style={upload ? { backgroundImage: `url(${upload})` } : undefined}
            onClick={() => (upload && bgKey !== 'upload' ? setBgKey('upload') : fileRef.current?.click())}
            title="Use your own picture — it stays on your device"
          >
            <span>{upload ? 'Your image' : '+ Upload'}</span>
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickFile} />
        </div>
        {uploadError && <p className="small down">{uploadError}</p>}

        <fieldset className="share-custom">
          <legend>Customize what you share</legend>
          <div className="share-custom__toggles">
            <label className="share-card__toggle">
              <input type="checkbox" checked={hideUsd} onChange={(e) => setHideUsd(e.target.checked)} />
              Hide dollar amounts (show % only)
            </label>
            {poolOption && (
              <label className="share-card__toggle">
                <input type="checkbox" checked={hidePool} onChange={(e) => setHidePool(e.target.checked)} />
                Hide pool &amp; pair
              </label>
            )}
            {built.updated && (
              <label className="share-card__toggle">
                <input type="checkbox" checked={hideTime} onChange={(e) => setHideTime(e.target.checked)} />
                Hide update time
              </label>
            )}
          </div>
          {allStats.length > 0 && (
            <div className="share-custom__stats" aria-label="Details on the card">
              <span className="muted small">Details:</span>
              {allStats.map(([label]) => {
                const on = !hiddenStats.includes(label);
                return (
                  <button key={label} type="button" className={`share-chip ${on ? 'share-chip--on' : ''}`} aria-pressed={on} onClick={() => toggleStat(label)}>
                    {on ? '✓ ' : ''}
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>
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

export default function ShareButton({ build, label = 'Share', className = 'button button--ghost button--sm', title = 'Share to X' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title={title}>
        ↗{label ? ` ${label}` : ''}
      </button>
      {open && <ShareModal build={build} onClose={() => setOpen(false)} />}
    </>
  );
}
