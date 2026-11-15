import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page, Rows } from '../components/ui.jsx';
import { health } from '../lib/health.js';
import { useStore } from '../store.jsx';

const ADDRESS = '0x4E2b8c1d90Aa77C31B0E4f6a91c0d18A91C4e21a';

export function Wallet() {
  const { state } = useStore();
  const [copied, setCopied] = useState(false);
  const borrowing = state.loans.filter((loan) => loan.borrower === 'you' && !health(loan).closed).length;
  const lending = state.loans.filter((loan) => loan.lender === 'you' && !health(loan).closed).length;

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(ADDRESS);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Page
      kicker="Wallet"
      title="This preview desk."
      lede="No wallet extension is connected, and no transaction is sent. This address is the borrower on some loans and the lender on others, so both sides of the desk are visible."
    >
      <p className="addr">{ADDRESS}</p>
      <div className="actions">
        <button className="btn" type="button" onClick={copyAddress}>{copied ? 'Copied' : 'Copy address'}</button>
      </div>
      <div className="block">
        <Rows items={[
          { label: 'Open loans you borrow', value: String(borrowing) },
          { label: 'Open claims you hold', value: String(lending) },
          { label: 'Network', value: 'Base, preview only' },
        ]} />
      </div>
      <div className="actions">
        <Link className="btn" to="/loans">Your loans</Link>
        <Link className="btn secondary" to="/positions">Your claims</Link>
      </div>
    </Page>
  );
}
