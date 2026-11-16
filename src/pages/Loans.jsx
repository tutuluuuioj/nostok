import { Link } from 'react-router-dom';
import { Page, PreviewBanner } from '../components/ui.jsx';
import { health } from '../lib/health.js';
import { formatApr, formatUsd } from '../lib/format.js';
import { useStore } from '../store.jsx';

function label(loan) {
  const view = health(loan);
  if (view.asset?.status === 'Frozen') return 'Frozen';
  if (view.phase === 'Active' && view.margin) return 'Margin call';
  if (view.phase === 'PastGrace') return 'Grace ended';
  return view.phase;
}

function Row({ loan }) {
  const view = health(loan);
  const ltv = view.oracleValue > 0 ? formatApr(Math.round((view.debt * 10000) / view.oracleValue)) : '—';
  return (
    <Link className="loan-row" to={`/loans/${loan.id}`}>
      <span className="numline">{loan.id}</span>
      <span>
        <strong>{loan.asset}</strong>
        <span className="quiet">{label(loan)} · {formatApr(loan.rateBps)} APR · Oracle {ltv}</span>
      </span>
      <span className="numline">{formatUsd(view.remaining)}</span>
      <span className="quiet">Preview</span>
    </Link>
  );
}

export function Loans() {
  const { state } = useStore();
  const borrow = state.loans.filter((loan) => loan.borrower === 'you');
  const lend = state.loans.filter((loan) => loan.lender === 'you');

  return (
    <Page
      kicker="Loans · Preview"
      title="Your desk (preview)."
      lede="Live loan management and repayment transactions arrive in WS3.5. Sample entries below are static illustrations."
    >
      <PreviewBanner>
        Sample loans shown below are static illustrations, not your live on-chain positions. Connect your wallet on{' '}
        <Link to="/wallet">Wallet</Link> to see your live loan count, or visit <Link to="/borrow">Borrow</Link> to sign a live borrow order.
      </PreviewBanner>
      <section className="block">
        <h2>Sample borrower positions (preview)</h2>
        {borrow.length === 0 ? <p>No preview borrow positions.</p> : borrow.map((loan) => <Row key={loan.id} loan={loan} />)}
      </section>
      <section className="block">
        <h2>Sample lender claims (preview)</h2>
        {lend.length === 0 ? <p>No preview claims.</p> : lend.map((loan) => <Row key={loan.id} loan={loan} />)}
      </section>
    </Page>
  );
}
