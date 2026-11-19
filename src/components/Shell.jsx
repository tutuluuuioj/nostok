import { useEffect, useLayoutEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { shortAddress } from '../lib/web3.js';
import { useStore } from '../store.jsx';

const LINKS = [
  ['/markets', 'Markets'],
  ['/borrow', 'Borrow'],
  ['/lend', 'Lend'],
  ['/loans', 'Loans'],
  ['/positions', 'Positions'],
  ['/risk', 'Risk'],
];

const TITLES = {
  '/': 'NOSTOK',
  '/markets': 'Markets',
  '/borrow': 'Borrow',
  '/lend': 'Lend',
  '/loans': 'Loans',
  '/positions': 'Positions',
  '/risk': 'Risk',
  '/data': 'Book',
  '/terms': 'Terms',
  '/builders': 'Builders',
  '/alerts': 'Alerts',
  '/wallet': 'Wallet',
};

export function Shell({ children }) {
  const { web3 } = useStore();
  const { pathname } = useLocation();
  const [menu, setMenu] = useState(false);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    setMenu(false);
    const name = TITLES[pathname] || (pathname.startsWith('/loans/') || pathname.startsWith('/loan/') ? 'Loan' : 'NOSTOK');
    document.title = pathname === '/' ? 'NOSTOK' : `${name} · NOSTOK`;
  }, [pathname]);

  function item(path, label) {
    const current = pathname === path;
    return (
      <Link key={path} to={path} aria-current={current ? 'page' : undefined}>
        {label}
      </Link>
    );
  }

  const walletLabel = web3?.connected
    ? `${shortAddress(web3.address)}${web3.siweSession ? ' · SIWE' : ''}`
    : 'Connect wallet';

  const wsMatches =
    web3?.walletState && web3.address && web3.walletState.address === web3.address;

  const networkLabel = !web3?.connected
    ? `Wallet not connected · Target Base (${web3?.config?.chainId ?? 8453})`
    : web3.wrongNetwork
      ? `Wrong network (${web3.chainId}) — switch to Base (${web3.config.chainId})`
      : web3.loadingState
        ? `Base (${web3.chainId ?? web3.config.chainId}) · Refreshing RPC…`
        : wsMatches && !web3.walletState.stale
          ? `Base (${web3.walletState.rpcChainId ?? web3.chainId}) · Live RPC`
          : `Base (${web3.chainId ?? web3.config.chainId}) · Degraded`;

  const degradedMsg =
    web3?.walletError ||
    (wsMatches ? web3?.walletState?.rpcError || web3?.walletState?.apiError : '') ||
    web3?.eligibilityScreening?.error;

  const geoInfo = web3?.eligibilityScreening?.data?.geo;
  const geoLabel = geoInfo
    ? geoInfo.verified
      ? `Geo ${geoInfo.country_code}`
      : geoInfo.status === 'disabled'
        ? 'Geo disabled'
        : geoInfo.status === 'local_unverified'
          ? 'Geo local_unverified'
          : `Geo ${geoInfo.status}`
    : 'Geo pending';

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="site-head">
        <div className="wrap">
          <div className="bar">
            <Link className="mark" to="/">NOSTOK</Link>
            <nav className="nav-desktop" aria-label="Primary">
              {LINKS.map(([path, label]) => item(path, label))}
              {item('/alerts', 'Alerts')}
            </nav>
            <div className="bar-end">
              {!web3?.connected ? (
                <button className="bar-action" type="button" onClick={() => void web3?.connect()} disabled={web3?.connecting}>
                  {web3?.connecting ? 'Connecting…' : 'Connect'}
                </button>
              ) : null}
              <Link to="/wallet" aria-current={pathname === '/wallet' ? 'page' : undefined}>{walletLabel}</Link>
              <button className="menu-btn" type="button" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
                Menu
              </button>
            </div>
          </div>
          <nav className={menu ? 'nav-mobile open' : 'nav-mobile'} aria-label="Mobile">
            {LINKS.map(([path, label]) => item(path, label))}
            {item('/alerts', 'Alerts')}
            {item('/data', 'Book')}
            {item('/builders', 'Builders')}
            {item('/terms', 'Terms')}
            {item('/wallet', walletLabel)}
          </nav>
        </div>
      </header>
      <div className="wrap">
        <div className={web3?.wrongNetwork || degradedMsg ? 'status-line err' : 'status-line'}>
          <span>{networkLabel}</span>
          <span>{geoLabel}</span>
          {web3?.connected ? (
            <>
              <span>
                {web3.siweSession ? `SIWE verified (${shortAddress(web3.address)})` : 'SIWE not signed in'}
              </span>
              <span>
                {web3.eligibilityDeclarationValid
                  ? `Reg S declaration verified (${web3.eligibilityDeclaration?.declarationJson?.jurisdiction})`
                  : 'Reg S declaration required to transact'}
              </span>
            </>
          ) : null}
          {degradedMsg ? <span>{degradedMsg}</span> : null}
        </div>
      </div>
      <main id="main" className="wrap">{children}</main>
      <footer className="site-foot">
        <div className="wrap foot">
          <p className="mark">NOSTOK</p>
          <nav aria-label="Footer">
            <Link to="/terms">Terms and risks</Link>
            <Link to="/risk">Parameters</Link>
            <Link to="/data">Book</Link>
            <Link to="/builders">Builders</Link>
          </nav>
          <p className="hint">Fixed-term repo for tokenized stocks on Base. Collateral remains in escrow until repayment or auction settlement.</p>
        </div>
      </footer>
    </>
  );
}
