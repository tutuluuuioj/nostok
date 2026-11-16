import { Link } from 'react-router-dom';
import { Sheet } from '../components/ui.jsx';
import { formatHundredths, formatUsd } from '../lib/format.js';
import { termSheet } from '../lib/money.js';

const EXAMPLE = termSheet({ principalCents: 500000, rateBps: 800, termDays: 30 });

export function Home() {
  return (
    <>
      <header className="hero">
        <p className="kicker">Base · USDC · Tokenized stock</p>
        <h1>
          <span>Fixed rate.</span>
          <span>Fixed date.</span>
          <span>Your stock comes back when you repay.</span>
        </h1>
        <p className="lede">
          Borrow USDC against a tokenized stock for a term you agree up front. The stock sits in escrow until you repay. The lender holds a claim they can keep or sell.
        </p>
        <div className="actions">
          <Link className="btn" to="/borrow">Borrow</Link>
          <Link className="btn secondary" to="/lend">Lend</Link>
        </div>
        <dl className="meta">
          <div><dt>Term</dt><dd>7 to 90 days</dd></div>
          <div><dt>Currency</dt><dd>USDC on Base</dd></div>
          <div><dt>Collateral</dt><dd>One named stock</dd></div>
          <div><dt>Default</dt><dd>Surplus comes back</dd></div>
        </dl>
      </header>

      <section className="section">
        <h2>One loan. One stock. One date.</h2>
        <div className="cols">
          <article>
            <p className="num">01</p>
            <h3>Escrow</h3>
            <p>The stock can leave only by the rules of the loan. The lender cannot take it, sell it, or lend it on.</p>
          </article>
          <article>
            <p className="num">02</p>
            <h3>A claim, not a pool</h3>
            <p>The lender gets a Position NFT for that loan. Whoever holds the NFT is repaid. The stock does not move with it.</p>
          </article>
          <article>
            <p className="num">03</p>
            <h3>A known end</h3>
            <p>Repay by the date and the stock comes back. If the loan fails, an auction sells only enough. Surplus returns to the borrower.</p>
          </article>
        </div>
      </section>

      <section className="section">
        <h2>For borrowers</h2>
        <p className="lede">Fixed rate and a fixed date. The stock comes back when you repay. If you do not, an auction can sell it. You are not in a pool that can move the rate on a short swing.</p>
        <div className="actions">
          <Link className="btn" to="/borrow">Open a borrow order</Link>
        </div>
      </section>

      <section className="section">
        <h2>For lenders</h2>
        <p className="lede">Fixed-term USDC, with the stock named on the loan and a claim you can sell. You are not lending into a pool.</p>
        <div className="actions">
          <Link className="btn" to="/lend">Open a lend offer</Link>
        </div>
      </section>

      <section className="section">
        <h2>A 30-day loan, in numbers (illustrative formula).</h2>
        <p className="lede">Illustrative math example: $10,000 of a Tier A stock, $5,000 borrowed at 8.00% APR. Simple interest, actual/365. Amounts owed round up. Payouts round down.</p>
        <Sheet
          title="Example term sheet (static math illustration)"
          items={[
            { label: 'Interest at maturity', value: formatUsd(EXAMPLE.interest) },
            { label: 'You receive', value: formatUsd(EXAMPLE.proceeds) },
            { label: 'Origination, paid by you', value: formatUsd(EXAMPLE.fee) },
            { label: 'You repay', value: formatUsd(EXAMPLE.repay) },
            { label: 'Your cost', value: `${formatHundredths(EXAMPLE.borrowerApr)} APR` },
            { label: 'Lender receives', value: formatUsd(EXAMPLE.holder) },
            { label: 'Lender yield', value: `${formatHundredths(EXAMPLE.lenderApr)} APR` },
          ]}
          note="The protocol keeps $5.00 origination (10 bps) and $3.29 of interest (10% cut). Use the live Markets quote simulator for current Base prices and caps."
        />
        <div className="actions">
          <Link className="btn secondary" to="/markets">Open live quote simulator</Link>
        </div>
      </section>

      <section className="section">
        <h2>Oracle states & collateral rules.</h2>
        <p className="lede">Live Chainlink oracle LTV is enforced by AssetRegistry and OracleRouter. Closed-market hours apply a haircut to new originations while pausing automated liquidations.</p>
        <div className="actions">
          <Link className="btn secondary" to="/risk">Inspect live risk parameters</Link>
        </div>
      </section>

      <section className="section">
        <h2>What this is not.</h2>
        <div className="stack" style={{ marginTop: 28 }}>
          <p>Not a perpetual, and not a pool. Each loan is one stock, one rate, and one date.</p>
          <p>Yield on the locked stock is off unless both sides turn it on. The lender then earns what the venue pays, and bears any venue loss. That is not a promised rate.</p>
          <p>Not the only place to borrow. Aave and Morpho already lend USDC against these stocks. NOSTOK is the fixed term, the named collateral, and a claim you can sell.</p>
        </div>
      </section>
    </>
  );
}
