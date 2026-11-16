import { Link } from 'react-router-dom';
import { Page, PreviewBanner } from '../components/ui.jsx';
import { partyName } from '../lib/data.js';
import { formatApr, formatUsd } from '../lib/format.js';
import { health } from '../lib/health.js';
import { positionFeeCents } from '../lib/money.js';
import { useStore } from '../store.jsx';

export function Positions() {
  const { state } = useStore();
  const mine = state.loans.filter((loan) => loan.lender === 'you' && loan.status !== 'Repaid');
  const open = state.claims.filter((item) => !item.claimed);
  const market = state.listings.filter((item) => item.seller !== 'you');
  const mineLists = state.listings.filter((item) => item.seller === 'you');

  return (
    <Page
      kicker="Positions · Preview"
      title="Position NFTs & claims (preview)."
      lede="The Position NFT is the right to be repaid. Collateral never moves with it. Live Position NFT enumeration, claims, and secondary transfers arrive in WS3.5+."
    >
      <PreviewBanner>
        Position listings and claims below are static preview examples, not your wallet&apos;s Position NFTs or LoanCore claimable USDC. Inspect your live claimable balance on{' '}
        <Link to="/wallet">Wallet</Link>.
      </PreviewBanner>

      {open.length > 0 ? (
        <section className="block">
          <h2>Sample USDC to claim (preview)</h2>
          <p className="hint">Repayments are pull-based, so a blocked recipient does not trap the funds.</p>
          {open.map((item) => (
            <article className="order-row" key={item.id}>
              <div>
                <strong>{formatUsd(item.cents)}</strong>
                <span className="quiet">Sample Loan {item.loanId} · {item.reason}</span>
              </div>
              <span className="quiet">Preview only</span>
            </article>
          ))}
        </section>
      ) : null}

      <section className="block">
        <h2>Sample claims (preview)</h2>
        {mine.length === 0 ? <p>No preview claims.</p> : mine.map((loan) => {
          const view = health(loan);
          const locked = view.phase === 'Auction';
          return (
            <article key={loan.id} className="block" style={{ marginTop: 24 }}>
              <Link className="open-loan" to={`/loans/${loan.id}`}>Sample Loan {loan.id} · {loan.asset}</Link>
              <p className="quiet">{formatUsd(view.remaining)} · {formatApr(loan.rateBps)} APR · borrower {partyName(loan.borrower)}</p>
              {locked ? <p>Transfer is locked while an auction runs.</p> : <p className="hint">Preview only — live listing and transfer actions are coming soon.</p>}
            </article>
          );
        })}
      </section>

      <section className="block">
        <h2>Sample listings (preview)</h2>
        {mineLists.length === 0 ? <p className="hint">No preview listings.</p> : mineLists.map((item) => (
          <article className="order-row" key={item.id}>
            <div>
              <strong>Sample Loan {item.loanId}</strong>
              <span className="quiet">{formatUsd(item.priceCents)}</span>
            </div>
            <span className="quiet">Preview only</span>
          </article>
        ))}
      </section>

      <section className="block">
        <h2>Sample secondary listings (preview)</h2>
        {market.length === 0 ? <p className="hint">No sample secondary claims.</p> : market.map((item) => {
          const loan = state.loans.find((entry) => entry.id === item.loanId);
          return (
            <article className="order-row" key={item.id}>
              <div>
                <strong>{loan?.asset} · {formatUsd(item.priceCents)}</strong>
                <span className="quiet">Sample Loan {item.loanId} · seller {partyName(item.seller)} · fee {formatUsd(positionFeeCents(item.priceCents))} paid by seller</span>
              </div>
              <span className="quiet">Preview only</span>
            </article>
          );
        })}
      </section>
    </Page>
  );
}
