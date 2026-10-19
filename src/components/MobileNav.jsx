// Phone navigation, app-style (like Rhea's): a tab bar pinned to the bottom with the five main
// screens, and a ☰ sheet with everything else. Desktop keeps the top navigation (App.jsx); these
// only show under 760px (mobile-nav.css).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '../router.jsx';
import { ENDPOINTS } from '../config.js';
import { GUIDES, LEGAL } from './MoreMenu.jsx';

const ICON = {
  swap: 'M7 4v14M7 4 3.5 7.5M7 4l3.5 3.5M17 20V6M17 20l-3.5-3.5M17 20l3.5-3.5',
  pools: 'M12 3c3.5 4.2 6 7.4 6 10.5a6 6 0 0 1-12 0C6 10.4 8.5 7.2 12 3z',
  bridge: 'M3 17h18M5 17v-4M19 17v-4M5 13c2-4 4.5-6 7-6s5 2 7 6M9 17v-3M15 17v-3',
  earn: 'M12 21V11M12 11c0-4 3-7 7-7 0 4-3 7-7 7zM12 14c0-3-2.5-5.5-6-5.5 0 3.5 2.5 5.5 6 5.5z',
  portfolio: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16',
  home: 'M4 11l8-7 8 7v9H4zM10 20v-6h4v6',
  discover: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z',
  create: 'M12 5v14M5 12h14',
  agent: 'M6 9h12v10H6zM12 4v5M9 13v.01M15 13v.01M9 16h6',
  pulse: 'M3 12h4l2-5 3.5 10 2.5-7 1.5 2H21',
  analysis: 'M4 20v-7M9 20V8M14 20v-5M19 20V10M2.5 11h2M7 11h2M11.5 11h2M16 11h2M20 11h1.5',
  link: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6'
};

function Icon({ name, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[name] || ICON.link} />
    </svg>
  );
}

// Swap sits in the middle as the main action (mtab__item--main).
const TABS = [
  { to: '/discover', label: 'Discover', icon: 'discover', match: ['discover', 'new', 'token', 'lp'] },
  { to: '/pools', label: 'Pools', icon: 'pools', match: ['pools', 'pool', 'starter', 'intear', 'analysis'] },
  { to: '/swap', label: 'Swap', icon: 'swap', match: ['swap'], main: true },
  { to: '/bridge', label: 'Bridge', icon: 'bridge', match: ['deposit'] },
  { to: '/portfolio', label: 'Portfolio', icon: 'portfolio', match: ['portfolio'] }
];

// Everything that isn't a tab, in the ☰ sheet.
const SCREENS = [
  { to: '/app', label: 'Home', icon: 'home', match: ['app'] },
  { to: '/earn', label: 'Earn', icon: 'earn', match: ['earn', 'stake'] },
  { to: '/create-pool', label: 'Create pool', icon: 'create', match: ['create'] },
  { to: '/agent', label: 'Agent', icon: 'agent', match: ['agent'] },
  { to: '/analysis', label: 'Pool Analysis', icon: 'analysis', match: ['analysis'] },
  { to: '/pulse', label: 'NEAR DeFi Pulse', icon: 'pulse', match: ['pulse'] }
];

/** The bottom tab bar. */
export function MobileTabBar({ route }) {
  return (
    <nav className="mtab" aria-label="Main">
      {TABS.map((t) => {
        const on = t.match.includes(route.name);
        return (
          <Link key={t.to} to={t.to} className={'mtab__item' + (t.main ? ' mtab__item--main' : '') + (on ? ' is-on' : '')} aria-current={on ? 'page' : undefined}>
            {t.main ? (
              <i className="mtab__main-icon">
                <Icon name={t.icon} />
              </i>
            ) : (
              <Icon name={t.icon} />
            )}
            <span>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** ☰ in the top bar: a sheet with the other screens, guides and documents. */
export function MobileMenuButton({ route, pathname }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <>
      <button type="button" className="mnav-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
      {open &&
        // On <body>: the top bar's backdrop blur would otherwise pin this sheet inside the bar.
        createPortal(
        <div className="msheet" role="dialog" aria-label="Menu" onClick={(e) => e.target === e.currentTarget && close()}>
          <div className="msheet__panel">
            <div className="msheet__grid">
              {SCREENS.map((s) => (
                <Link key={s.to} to={s.to} className={s.match.includes(route.name) ? 'msheet__tile is-on' : 'msheet__tile'} onClick={close}>
                  <Icon name={s.icon} />
                  <span>{s.label}</span>
                </Link>
              ))}
            </div>
            <div className="msheet__list">
              {[...GUIDES, ...LEGAL].map((it) => (
                <Link key={it.to} to={it.to} onClick={close}>
                  {it.label}
                </Link>
              ))}
              <a href={ENDPOINTS.rheaApp} target="_blank" rel="noopener noreferrer" onClick={close}>
                Rhea Finance ↗
              </a>
              <a href="https://x.com/KINUonNEAR" target="_blank" rel="noopener noreferrer" onClick={close}>
                X · @KINUonNEAR ↗
              </a>
            </div>
          </div>
        </div>,
        document.body
        )}
    </>
  );
}

/** 🔍 in the top bar: shows or hides the search under the bar. */
export function MobileSearchButton({ open, onToggle }) {
  return (
    <button type="button" className={open ? 'mnav-btn is-on' : 'mnav-btn'} aria-label="Search" aria-expanded={open} onClick={onToggle}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
    </button>
  );
}
