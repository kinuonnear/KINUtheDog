import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../state.jsx';
import { Link } from '../router.jsx';
import { groupDigits } from '../lib/format.js';

export function TokenIcon({ token, size = 28 }) {
  const [broken, setBroken] = useState(false);
  const symbol = token?.symbol || '?';
  useEffect(() => setBroken(false), [token?.icon]);

  if (token?.icon && !broken) {
    return (
      <img
        className="token-icon"
        src={token.icon}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
        loading="lazy"
      />
    );
  }
  return (
    <span className="token-icon token-icon--fallback" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {symbol.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function PairIcons({ tokens, size = 28 }) {
  return (
    <span className="pair-icons" style={{ '--icon-size': `${size}px` }}>
      {tokens.slice(0, 3).map((token, i) => (
        <TokenIcon key={`${token?.id || i}-${i}`} token={token} size={size} />
      ))}
    </span>
  );
}

export function Spinner({ size = 16 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Skeleton({ width = '100%', height = 14, radius = 6 }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius }} />;
}

export function Modal({ title, subtitle, onClose, children, width = 440 }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [onClose]);

  // Rendered on <body>, not inside whatever opened it (e.g. a clickable position row): the row's
  // tooltip doesn't show through, and clicks in the modal don't reach the row's handlers.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function EmptyState({ icon = '◇', title, children, action }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// The browser's own network errors (Chrome, Safari, Firefox) say nothing to a user.
const NETWORK_ERROR = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i;

export function ErrorNotice({ error, onRetry }) {
  if (!error) return null;
  const message = error.message || String(error);
  return (
    <div className="notice notice--error">
      <span>{NETWORK_ERROR.test(message) ? 'The service is not answering right now. Check your connection or try again in a minute.' : message}</span>
      {onRetry && (
        <button type="button" className="link-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Tabs({ tabs, value, onChange, size = 'md' }) {
  return (
    <div className={`tabs tabs--${size}`} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          className={value === tab.key ? 'tab tab--active' : 'tab'}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tab__count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint, loading }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <strong className="stat__value">{loading ? <Skeleton width={90} height={22} /> : value}</strong>
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <div className="toast__body">
            <strong>{t.title}</strong>
            {t.message && <span>{t.message}</span>}
            {t.link && (
              <a href={t.link} target="_blank" rel="noopener noreferrer">
                View on explorer ↗
              </a>
            )}
            {t.action && (
              <Link to={t.action.to} className="toast__action" onClick={() => dismissToast(t.id)}>
                {t.action.label} →
              </Link>
            )}
          </div>
          <button type="button" className="icon-button" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard blocked
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * A number field that groups thousands as you type (1000000 -> 1,000,000) and keeps the caret where
 * it was. `value` and `onChange(raw)` use the plain number text ("1000000.5"); the separators are
 * display only. A comma typed on a keypad whose decimal key is "," counts as the decimal point.
 */
export function AmountInput({ value, onChange, ...rest }) {
  const ref = useRef(null);
  const caret = useRef(null); // characters (digits and ".") before the caret after the last edit
  const shown = groupDigits(value ?? '') ?? '';
  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current === null || !el || document.activeElement !== el) return;
    let left = caret.current;
    let pos = 0;
    while (pos < el.value.length && left > 0) {
      if (el.value[pos] !== ',') left -= 1;
      pos += 1;
    }
    el.setSelectionRange(pos, pos);
    caret.current = null;
  });
  return (
    <input
      ref={ref}
      inputMode="decimal"
      autoComplete="off"
      {...rest}
      value={shown}
      onChange={(event) => {
        let text = event.target.value;
        const at = event.target.selectionStart ?? text.length;
        // One new character, and it's a comma: the keypad's decimal key.
        if (text.length === shown.length + 1 && text[at - 1] === ',') text = `${text.slice(0, at - 1)}.${text.slice(at)}`;
        caret.current = text.slice(0, at).replace(/,/g, '').length;
        onChange?.(text.replace(/,/g, ''));
      }}
    />
  );
}
