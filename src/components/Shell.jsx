import { useEffect, useLayoutEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
  const { alerts } = useStore();
  const { pathname } = useLocation();
  const [menu, setMenu] = useState(false);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    setMenu(false);
    const name = TITLES[pathname] || (pathname.startsWith('/loans/') ? 'Loan' : 'NOSTOK');
    document.title = pathname === '/' ? 'NOSTOK' : `${name} · NOSTOK`;
  }, [pathname]);

  function item(path, label) {
    const current = pathname === path;
    const alertLabel = path === '/alerts' ? `Alerts, ${alerts.length} open` : undefined;
    return (
      <Link key={path} to={path} aria-current={current ? 'page' : undefined} aria-label={alertLabel}>
        {label}
        {path === '/alerts' ? <span className="count" aria-hidden="true">{alerts.length}</span> : null}
      </Link>
    );
  }

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
              <Link to="/wallet" aria-current={pathname === '/wallet' ? 'page' : undefined}>Wallet</Link>
              <button className="menu-btn" type="button" aria-expanded={menu} onClick={() => { setMenu((open) => !open); setAccount(false); }}>
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
          </nav>
        </div>
      </header>
      <div className="wrap">
        <p className="preview-line">Illustrative preview. Contracts are not deployed, and no funds move.</p>
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
          <p className="hint">Fixed-term repo for tokenized stocks on Base. The stock comes back when the loan is repaid. Yield on it is off unless both sides turn it on.</p>
        </div>
      </footer>
    </>
  );
}
