import { useEffect, useRef, useState } from 'react';
import { useApp } from './state.jsx';
import { useClickOutside } from './hooks.js';
import { Link, matchRoute, useLocation } from './router.jsx';
import { formatAmount, shortAccount, toNumber } from './lib/format.js';
import { ENDPOINTS } from './config.js';
import { EmptyState, Toasts } from './components/ui.jsx';
import Home from './pages/Home.jsx';
import Swap from './pages/Swap.jsx';
import Pools from './pages/Pools.jsx';
import PoolDetail from './pages/PoolDetail.jsx';
import Portfolio from './pages/Portfolio.jsx';

const NAV = [
  { to: '/swap', label: 'Swap', match: ['swap'] },
  { to: '/pools', label: 'Pools', match: ['pools', 'pool'] },
  { to: '/portfolio', label: 'Portfolio', match: ['portfolio'] }
];

const TITLES = {
  home: 'KINU — DeFi terminal on NEAR',
  swap: 'Swap · KINU',
  pools: 'Pools · KINU',
  pool: 'Pool · KINU',
  portfolio: 'Portfolio · KINU',
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

  useEffect(() => {
    document.title = TITLES[route.name] || TITLES.home;
  }, [route.name]);

  let page;
  switch (route.name) {
    case 'home':
      page = <Home />;
      break;
    case 'swap':
      page = <Swap />;
      break;
    case 'pools':
      page = <Pools />;
      break;
    case 'pool':
      page = <PoolDetail poolId={route.params[0]} />;
      break;
    case 'portfolio':
      page = <Portfolio />;
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

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="KINU home">
          <img src="/kinu-logo.png" alt="KINU" />
        </Link>
        <nav className="nav">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={item.match.includes(route.name) ? 'nav__link nav__link--active' : 'nav__link'}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <AccountMenu />
      </header>

      <main className="main">{page}</main>

      <footer className="footer">
        <span>KINU · two dogs, one NEAR</span>
        <span>
          Liquidity &amp; routing by{' '}
          <a href={ENDPOINTS.rheaApp} target="_blank" rel="noopener noreferrer">
            Rhea Finance
          </a>{' '}
          · Non-custodial
        </span>
      </footer>

      <Toasts />
    </div>
  );
}
