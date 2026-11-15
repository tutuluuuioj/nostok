import { Link } from 'react-router-dom';
import { Page } from '../components/ui.jsx';
import { records } from '../lib/book.js';
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
      <span className="open-loan">Open</span>
    </Link>
  );
}

export function Loans() {
  const { state } = useStore();
  const borrow = state.loans.filter((loan) => loan.borrower === 'you');
  const lend = state.loans.filter((loan) => loan.lender === 'you');

  function download() {
    const blob = new Blob([JSON.stringify(records(state), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nostok-records.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Page
      kicker="Loans"
      title="Your desk."
      lede="Borrowing and lending are separate. Open a loan to see details, repay, or add more stock."
    >
      <section className="block">
        <h2>You borrow</h2>
        {borrow.length === 0 ? <p>No borrow positions.</p> : borrow.map((loan) => <Row key={loan.id} loan={loan} />)}
      </section>
      <section className="block">
        <h2>You lend</h2>
        {lend.length === 0 ? <p>No claims.</p> : lend.map((loan) => <Row key={loan.id} loan={loan} />)}
      </section>
      <div className="actions">
        <button className="btn secondary" type="button" onClick={download}>Download my records</button>
      </div>
    </Page>
  );
}
