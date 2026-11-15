import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Field, Page, TextInput } from '../components/ui.jsx';
import { partyName } from '../lib/data.js';
import { formatApr, formatUsd, parseDollars } from '../lib/format.js';
import { health } from '../lib/health.js';
import { positionFeeCents } from '../lib/money.js';
import { useStore } from '../store.jsx';

export function Positions() {
  const { state, act } = useStore();
  const [prices, setPrices] = useState({});
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  const mine = state.loans.filter((loan) => loan.lender === 'you' && loan.status !== 'Repaid');
  const open = state.claims.filter((item) => !item.claimed);
  const market = state.listings.filter((item) => item.seller !== 'you');
  const mineLists = state.listings.filter((item) => item.seller === 'you');

  function run(action) {
    const next = act(action);
    setFormError(next.error || '');
    setMessage(next.error ? '' : next.notice);
  }

  return (
    <Page
      kicker="Positions"
      title="Claims you can keep or sell."
      lede="The Position NFT is the right to be repaid. Collateral never moves with it. A transfer is locked during an auction. The seller pays a 0.25% fee, capped at 1% in the contract."
    >
      {open.length > 0 ? (
        <section className="block">
          <h2>USDC to claim</h2>
          <p className="hint">Repayments are pull-based, so a blocked recipient does not trap the funds.</p>
          {open.map((item) => (
            <article className="order-row" key={item.id}>
              <div>
                <strong>{formatUsd(item.cents)}</strong>
                <span className="quiet">Loan {item.loanId} · {item.reason}</span>
              </div>
              <button className="btn" type="button" onClick={() => run({ type: 'claim', id: item.id })}>Claim</button>
            </article>
          ))}
        </section>
      ) : null}

      <section className="block">
        <h2>Your claims</h2>
        {mine.length === 0 ? <p>You hold no open claims.</p> : mine.map((loan) => {
          const view = health(loan);
          const locked = view.phase === 'Auction';
          const price = prices[loan.id] ?? '';
          const cents = parseDollars(price);
          const fee = cents ? positionFeeCents(cents) : 0;
          return (
            <article key={loan.id} className="block" style={{ marginTop: 24 }}>
              <Link className="open-loan" to={`/loans/${loan.id}`}>Loan {loan.id} · {loan.asset}</Link>
              <p className="quiet">{formatUsd(view.remaining)} · {formatApr(loan.rateBps)} APR · borrower {partyName(loan.borrower)}</p>
              {locked ? <p>Transfer is locked while the auction runs.</p> : (
                <form className="fields" style={{ marginTop: 12 }} onSubmit={(event) => {
                  event.preventDefault();
                  run({ type: 'list', id: loan.id, priceCents: cents });
                }}>
                  <Field id={`price-${loan.id}`} label="Ask, USDC" hint={cents ? `You pay a ${formatUsd(fee)} sale fee, 0.25% of the price.` : 'The contract caps this fee at 1%.'}>
                    {(props) => <TextInput id={`price-${loan.id}`} value={price} onChange={(value) => setPrices({ ...prices, [loan.id]: value })} {...props} />}
                  </Field>
                  <button className="btn secondary" type="submit">List this claim</button>
                </form>
              )}
            </article>
          );
        })}
      </section>

      <section className="block">
        <h2>Your listings</h2>
        {mineLists.length === 0 ? <p className="hint">Nothing of yours is offered.</p> : mineLists.map((item) => (
          <article className="order-row" key={item.id}>
            <div>
              <strong>Loan {item.loanId}</strong>
              <span className="quiet">{formatUsd(item.priceCents)}</span>
            </div>
            <button className="btn secondary" type="button" onClick={() => run({ type: 'cancel-list', id: item.id })}>Cancel listing</button>
          </article>
        ))}
      </section>

      <section className="block">
        <h2>For sale</h2>
        {market.length === 0 ? <p className="hint">No other claims are listed.</p> : market.map((item) => {
          const loan = state.loans.find((entry) => entry.id === item.loanId);
          return (
            <article className="order-row" key={item.id}>
              <div>
                <strong>{loan?.asset} · {formatUsd(item.priceCents)}</strong>
                <span className="quiet">Loan {item.loanId} · seller {partyName(item.seller)} · fee {formatUsd(positionFeeCents(item.priceCents))} paid by the seller</span>
              </div>
              <button className="btn" type="button" onClick={() => run({ type: 'buy', id: item.id })}>Buy claim</button>
            </article>
          );
        })}
      </section>
      {formError ? <p className="err" role="alert">{formError}</p> : null}
      {message ? <p className="note" role="status">{message}</p> : null}
    </Page>
  );
}
