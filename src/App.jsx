import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useApp } from './state.jsx';
import { useClickOutside } from './hooks.js';
import { Link, matchRoute, useLocation } from './router.jsx';
import { formatAmount, shortAccount, toNumber } from './lib/format.js';
import { ENDPOINTS } from './config.js';
import { EmptyState, Spinner, Toasts } from './components/ui.jsx';
import GlobalSearch from './components/GlobalSearch.jsx';
import InstallPrompt from './components/InstallPrompt.jsx';
import Welcome from './pages/Welcome.jsx';
import Home from './pages/Home.jsx';
import Pools from './pages/Pools.jsx';
import MoreMenu from './components/MoreMenu.jsx';
import RangeAlerts from './components/RangeAlerts.jsx';
import './theme.css';
import './topbar.css';

// The landing pages (Welcome, Home, Pools) ship in the main bundle; every other page loads its own
// code when first opened, so a visitor only downloads the pages they use.
const Swap = lazy(() => import('./pages/Swap.jsx'));
const PoolDetail = lazy(() => import('./pages/PoolDetail.jsx'));
const Portfolio = lazy(() => import('./pages/Portfolio.jsx'));
const CreatePool = lazy(() => import('./pages/CreatePool.jsx'));
const StartLp = lazy(() => import('./pages/StartLp.jsx'));
const Security = lazy(() => import('./pages/Security.jsx'));
const Docs = lazy(() => import('./pages/Docs.jsx'));
const Discover = lazy(() => import('./pages/Discover.jsx'));
const Token = lazy(() => import('./pages/Token.jsx'));
const Agent = lazy(() => import('./pages/Agent.jsx'));
const LpProfile = lazy(() => import('./pages/LpProfile.jsx'));
const IntearPools = lazy(() => import('./pages/IntearPools.jsx'));

// Liquidity first: Pools (and Create) right after Home. Docs and the rest live under More.
const NAV = [
  { to: '/app', label: 'Home', match: ['app'] },
  { to: '/pools', label: 'Pools', match: ['pools', 'pool', 'starter'] },
  { to: '/discover', label: 'Discover', match: ['discover', 'new', 'token', 'lp'] },
  { to: '/swap', label: 'Swap', match: ['swap'] },
  { to: '/portfolio', label: 'Portfolio', match: ['portfolio'] },
  { to: '/agent', label: 'Agent', match: ['agent'] }
];
const MORE_ROUTES = new Set(['docs', 'security']);

// Trading screens use the full window width (like Meteora / Intear). CLMM pool
// pages are an app-style workspace that fills the viewport, so they have no footer.
const FULL_WIDTH_ROUTES = new Set(['app', 'pool', 'pools', 'swap', 'portfolio', 'new', 'discover', 'token', 'agent', 'lp', 'intear']);

const TITLES = {
  home: 'KINU — The Dog That Follows the Flow',
  app: 'KINU — Liquidity on NEAR',
  swap: 'Swap · KINU',
  pools: 'Pools · KINU',
  pool: 'Pool · KINU',
  portfolio: 'Portfolio · KINU',
  create: 'Create pool · KINU',
  starter: 'How to start LP · KINU',
  agent: 'KINU Agent · LP co-pilot',
  security: 'Security & transparency · KINU',
  new: 'New on NEAR · KINU',
  discover: 'Discover · KINU',
  token: 'Token · KINU',
  lp: 'LP wallet · Smart LP · KINU',
  intear: 'Intear DEX pools · KINU',
  notfound: 'Not found · KINU'
};

function AccountMenu() {
  const { accountId, walletReady, connect, disconnect, nearBalance } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);

  if (!accountId) {
    return (
      <button type="button" className="button button--primary button--sm" onClick={connect} disabled={!walletReady}>
        {walletReady ? 'Connect wallet' : 'Loading…'}
      </button>
    );
  }

  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="account-button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="account-button__dot" />
        <span className="account-button__balance">
          {nearBalance ? `${formatAmount(toNumber(nearBalance.available, 24))} NEAR` : '…'}
        </span>
        <span className="account-button__id">{shortAccount(accountId)}</span>
      </button>
      {open && (
        <div className="popover popover--right">
          <span className="eyebrow">Connected</span>
          <strong className="mono break">{accountId}</strong>
          <Link to="/portfolio" className="menu-item" onClick={() => setOpen(false)}>
            Portfolio
          </Link>
          <a className="menu-item" href={`${ENDPOINTS.explorer}/address/${accountId}`} target="_blank" rel="noopener noreferrer">
            View on explorer ↗
          </a>
          <button
            type="button"
            className="menu-item menu-item--danger"
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { pathname } = useLocation();
  const route = matchRoute(pathname);

  const appView = route.name === 'pool' && route.params[0]?.includes('|');

  useEffect(() => {
    // Docs and token pages set their own title.
    if (route.name !== 'docs' && route.name !== 'token') document.title = TITLES[route.name] || TITLES.home;
  }, [route.name]);

  let page;
  switch (route.name) {
    case 'app':
      page = <Home />;
      break;
    case 'swap':
      page = <Swap />;
      break;
    case 'pools':
      page = <Pools />;
      break;
    case 'pool':
      // Keyed by pool: going straight to another pool (search, back / forward) starts clean
      // instead of showing the previous pool's tokens, chart and form.
      page = <PoolDetail key={route.params[0]} poolId={route.params[0]} />;
      break;
    case 'portfolio':
      page = <Portfolio />;
      break;
    case 'create':
      page = <CreatePool />;
      break;
    case 'starter':
      page = <StartLp />;
      break;
    case 'agent':
      page = <Agent />;
      break;
    case 'security':
      page = <Security />;
      break;
    case 'docs':
      page = <Docs slug={route.params[0]} />;
      break;
    case 'new':
      page = <Discover defaultTab="new" />;
      break;
    case 'discover':
      page = <Discover />;
      break;
    case 'lp':
      page = <LpProfile key={route.params[0]} account={route.params[0]} />;
      break;
    case 'intear':
      page = <IntearPools />;
      break;
    case 'token':
      page = <Token key={route.params[0]} id={route.params[0]} />;
      break;
    default:
      page = (
        <div className="page">
          <EmptyState
            icon="?"
            title="Page not found"
            action={
              <Link to="/" className="button button--primary">
                Back home
              </Link>
            }
          />
        </div>
      );
  }

  // The welcome page (kinudefi.com) is a full-screen landing with its own nav.
  if (route.name === 'home') {
    return (
      <>
        <Welcome />
        <Toasts />
        <InstallPrompt />
      </>
    );
  }

  return (
    <div className={`shell ${appView ? 'shell--app' : ''} ${route.name === 'app' ? 'shell--home' : ''} ${route.name === 'pools' ? 'shell--pools' : ''}`}>
      <header className="topbar">
        {/* Brand and wallet share one row: on phones only this row stays pinned (topbar.css). */}
        <div className="topbar__bar">
          <Link to="/" className="brand" aria-label="KINU — landing page">
            <img src="/site/kinu-emblem.svg" alt="" width="30" height="30" />
            <span>KINU</span>
          </Link>
          <AccountMenu />
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <Fragment key={item.to}>
              <Link to={item.to} className={item.match.includes(route.name) ? 'nav__link nav__link--active' : 'nav__link'}>
                {item.label}
              </Link>
              {/* Create sits right next to Pools. */}
              {item.to === '/pools' && (
                <Link to="/create-pool" className={`nav__link nav__create ${route.name === 'create' ? 'nav__link--active' : ''}`}>
                  Create
                </Link>
              )}
            </Fragment>
          ))}
          <MoreMenu active={MORE_ROUTES.has(route.name)} />
        </nav>
        <GlobalSearch />
      </header>

      <main className={FULL_WIDTH_ROUTES.has(route.name) ? 'main main--full' : 'main'}>
        <Suspense
          fallback={
            <div className="page-loading">
              <Spinner size={22} />
            </div>
          }
        >
          {page}
        </Suspense>
      </main>

      {!appView && (
      <footer className="footer">
        <Link to="/">KINU · the dog that follows the flow</Link>
        <span>
          Liquidity &amp; routing by{' '}
          <a href={ENDPOINTS.rheaApp} target="_blank" rel="noopener noreferrer">
            Rhea Finance
          </a>{' '}
          · Non-custodial · <Link to="/docs">Docs</Link> · <Link to="/security">Security</Link>
        </span>
      </footer>
      )}

      <Toasts />
      <RangeAlerts />
      <InstallPrompt />
    </div>
  );
}
