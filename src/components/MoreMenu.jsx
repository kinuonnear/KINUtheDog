// "More" in the top bar (Meteora-style): guides, documents and socials.

import { useRef, useState } from 'react';
import { useClickOutside } from '../hooks.js';
import { Link } from '../router.jsx';
import { ENDPOINTS } from '../config.js';

const X_URL = 'https://x.com/KINUonNEAR';

const ICONS = {
  docs: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  start: 'M5 12h11M12 6l6 6-6 6M5 5v14',
  launch: 'M12 3c3 2 5 6 5 10l-2 3H9l-2-3c0-4 2-8 5-10zM12 9.5v.01M9 16l-2 4M15 16l2 4',
  paper: 'M7 3h10v18H7zM10 7h4M10 11h4M10 15h3',
  faq: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.01',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z M9 12l2 2 4-4',
  terms: 'M7 3h10v18H7zM10 8h4M10 12h4M10 16h4',
  treasury: 'M4 10l8-5 8 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18',
  rhea: 'M4 17c3-6 6-9 8-9s4 2 4 5-2 4-4 4M14 6l3-3M18 10l3-1'
};

function Icon({ name }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const GUIDES = [
  { to: '/docs/introduction', label: 'Documentation', icon: 'docs' },
  { to: '/docs/getting-started', label: 'Get Started', icon: 'start' },
  { to: '/docs/create-pool', label: 'Launch Guide', icon: 'launch' },
  { to: '/docs/whitepaper', label: 'Whitepaper', icon: 'paper' },
  { to: '/docs/faq', label: 'FAQ', icon: 'faq' }
];

const LEGAL = [
  { to: '/docs/terms', label: 'Terms of Service', icon: 'terms' },
  { to: '/security', label: 'Security & Transparency', icon: 'shield' },
  { to: '/treasury', label: 'Treasury', icon: 'treasury' }
];

/** @param active  whether the current page lives under More (docs, security, treasury) */
export default function MoreMenu({ active }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const close = () => setOpen(false);

  const item = (it) => (
    <Link key={it.to} to={it.to} className="more-menu__item" onClick={close}>
      <Icon name={it.icon} />
      {it.label}
    </Link>
  );

  return (
    <div className="popover-anchor more-menu" ref={ref}>
      <button
        type="button"
        className={`nav__link nav__more ${active || open ? 'nav__link--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        More
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={open ? 'is-open' : ''}>
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="popover more-menu__panel" role="menu">
          {GUIDES.map(item)}
          <a className="more-menu__item" href={ENDPOINTS.rheaApp} target="_blank" rel="noopener noreferrer" onClick={close}>
            <Icon name="rhea" />
            Rhea Finance ↗
          </a>
          <hr />
          {LEGAL.map(item)}
          <hr />
          <div className="more-menu__social">
            <span>KINU Socials</span>
            <a href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="KINU on X" title="@KINUonNEAR on X" onClick={close}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z" />
              </svg>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
