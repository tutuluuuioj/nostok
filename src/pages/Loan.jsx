import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Choice, Field, Page, Rows, TextInput } from '../components/ui.jsx';
import { openOrders } from '../lib/book.js';
import { ASSETS, CLOCK, partyName, stateLabel } from '../lib/data.js';
import {
  formatApr,
  formatLeft,
  formatTokens,
  formatUsd,
  formatWhen,
  parseDollars,
  parsePercent,
  parseTokens,
  parseDays,
} from '../lib/format.js';
import { health, releaseTokens } from '../lib/health.js';
import { auctionPriceCents, dueInterestCents } from '../lib/money.js';
import { useStore } from '../store.jsx';

function line(loan, view) {
  const asset = view.asset;
  if (view.phase === 'Repaid') return 'Repaid. The stock has been released.';
  if (view.phase === 'Auction') return 'A Dutch auction is running. The claim cannot be transferred. Surplus returns to the borrower.';
  if (view.phase === 'Grace') return 'Maturity has passed. Repay is still open for 24 hours. Penalty interest is the rate plus 5.00% APR.';
  if (view.phase === 'PastGrace') return 'Grace has ended. A default auction can start while the oracle is valid and the market is open.';
  if (asset?.status === 'Frozen' || asset?.state === 'FROZEN_CORPORATE_ACTION') {
    if (view.atLiq) {
      return `Oracle LTV is above the ${formatApr(loan.liqBps)} liquidation level. It is not being liquidated because ${asset.symbol} is frozen, so the liquidation clock is paused. Repay and adding stock stay open.`;
    }
    return `${asset.symbol} is frozen. Repay and adding stock stay open. Liquidation clocks are paused.`;
  }
  if (view.margin && asset?.state === 'VALID_CLOSED') return 'Margin call. Liquidation cannot start while the market is closed.';
  if (view.margin) return 'Margin call. Add collateral or repay. The loan does not change state until liquidation is allowed.';
  return 'Healthy on the oracle. The market-implied figure is a warning, not a trigger.';
}

export function Loan() {
  const { id } = useParams();
  const { state, act } = useStore();
  const loan = state.loans.find((item) => item.id === id);
  const [part, setPart] = useState('1000');
  const [top, setTop] = useState('1');
  const [term, setTerm] = useState('30');
  const [rate, setRate] = useState('8.00');
  const [capitalize, setCapitalize] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [offerId, setOfferId] = useState('');
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');

  if (!loan) {
    return (
      <Page kicker="Loan" title="Not in this book." lede="That loan is not in the preview.">
        <Link to="/loans">Back to loans</Link>
      </Page>
    );
  }

  const view = health(loan);
  const asset = ASSETS[loan.asset];
  const oracleLtv = view.oracleValue > 0 ? formatApr(Math.round((view.debt * 10000) / view.oracleValue)) : '—';
  const marketLtv = view.marketValue > 0 ? formatApr(Math.round((view.debt * 10000) / view.marketValue)) : '—';
  const portion = parseDollars(part);
  const interest = portion ? dueInterestCents(loan, CLOCK, Math.min(portion, view.remaining)) : 0;
  const release = portion ? releaseTokens(loan, Math.min(portion, view.remaining)) : null;
  const fullInterest = view.remaining ? dueInterestCents(loan, CLOCK, view.remaining) : 0;
  const offers = openOrders(state).filter((order) => order.side === 'lend' && order.assets.includes(loan.asset) && order.maker !== 'you');
  const auction = loan.status === 'Auction' && loan.auctionStarted
    ? auctionPriceCents(asset.oracleCents, asset.discountBps, Math.floor((CLOCK - loan.auctionStarted) / 1000))
    : null;
  const closed = view.phase === 'Repaid' || view.phase === 'Settled';
  const frozen = asset?.status === 'Frozen' || asset?.state === 'FROZEN_CORPORATE_ACTION';
  const titleState = frozen
    ? 'Frozen.'
    : view.phase === 'Active' && view.margin
      ? 'Margin call.'
      : `${view.phase}.`;
  const canChange = loan.borrower === 'you' && !closed && view.phase !== 'Auction' && view.phase !== 'PastGrace' && asset.status === 'Active' && asset.state !== 'FROZEN_CORPORATE_ACTION';

  function run(action) {
    const next = act(action);
    setFormError(next.error || '');
    setMessage(next.error ? '' : next.notice);
  }

  return (
    <Page kicker={`Loan ${loan.id}`} title={`${loan.asset}. ${titleState}`} lede={line(loan, view)}>
      {!closed ? (
        <div className="actions">
          <button className="btn" type="button" onClick={() => run({ type: 'repay', id: loan.id, all: true })}>Repay all</button>
          <button className="btn secondary" type="button" onClick={() => document.getElementById('top')?.focus()}>Add collateral</button>
        </div>
      ) : null}
      {!closed ? (
        <div className="ltv-pair">
          <div>
            <span>Oracle LTV</span>
            <strong>{oracleLtv}</strong>
            <p>Used for margin, liquidation, and new terms.</p>
          </div>
          <div>
            <span>Market-implied</span>
            <strong>{marketLtv}</strong>
            <p>Information only. A closed-market price does not liquidate you.</p>
          </div>
        </div>
      ) : null}

      {!closed ? (
        <section className="block split" aria-label="Repay or add collateral">
          <form className="fields" onSubmit={(event) => { event.preventDefault(); run({ type: 'repay', id: loan.id, principalCents: portion }); }}>
            <h2>Repay part</h2>
            <Field id="part" label="Principal to repay" hint={release ? `Interest on this portion ${formatUsd(interest)}. Collateral released ${formatTokens(release.tokens)} ${loan.asset}.${release.capped ? ' Capped so LTV stays at or below the initial LTV.' : ''}` : 'Anyone can repay. Collateral goes back to the borrower.'}>
              {(props) => <TextInput id="part" value={part} onChange={setPart} {...props} />}
            </Field>
            <button className="btn secondary" type="submit">Repay this portion</button>
          </form>
          <form className="fields" onSubmit={(event) => { event.preventDefault(); run({ type: 'topup', id: loan.id, tokenMicro: parseTokens(top) }); }}>
            <h2>Add collateral</h2>
            <Field id="top" label={`Raw ${loan.asset} to add`} hint="You can add stock when the market is closed, the oracle is stale, or the asset is frozen.">
              {(props) => <TextInput id="top" value={top} onChange={setTop} {...props} />}
            </Field>
            <button className="btn secondary" type="submit">Add this stock</button>
          </form>
        </section>
      ) : null}

      <div className="block">
        <Rows items={[
          { label: 'Borrower', value: partyName(loan.borrower) },
          { label: 'Lender, the NFT holder', value: partyName(loan.lender) },
          { label: 'Principal left', value: formatUsd(view.remaining) },
          { label: 'Accrued interest', value: formatUsd(view.interest) },
          { label: 'Rate', value: `${formatApr(loan.rateBps)} APR` },
          { label: 'Opened', value: formatWhen(loan.start) },
          { label: 'Maturity', value: formatWhen(loan.maturity) },
          {
            label: loan.maturity > CLOCK ? 'Time to maturity' : 'Grace left',
            value: loan.maturity > CLOCK
              ? formatLeft(loan.maturity - CLOCK)
              : formatLeft(loan.maturity + 86400000 - CLOCK),
          },
          { label: 'Oracle', value: stateLabel(asset.state) },
          { label: 'Asset status', value: asset.status },
          { label: 'Initial LTV cap on this loan', value: formatApr(loan.initLtvBps) },
          { label: 'Margin / liquidation', value: `${formatApr(loan.marginBps)} / ${formatApr(loan.liqBps)}` },
          { label: 'Yield on the locked stock', value: loan.yieldMode === 'lender' ? 'On. The lender earns the venue yield and bears a venue loss.' : 'Off. The stock is not lent on.' },
          { label: 'In-kind settlement', value: loan.inKind ? 'Allowed' : 'Off' },
          { label: 'Raw units in escrow', value: formatTokens(loan.tokenMicro) },
        ]} />
        <p className="hint" style={{ marginTop: 12 }}>
          Escrow holds raw units. Value comes from the total-return feed. The multiplier is not applied a second time. Preview clock: {formatWhen(CLOCK)} Asia/Dhaka.
        </p>
      </div>

      {auction ? (
        <section className="block">
          <h2>Auction</h2>
          <p className="lede">
            The price is {formatUsd(auction.priceCents)} per token, {formatApr(auction.offBps)} under the oracle. It falls for 30 minutes, from 1% under the oracle to {formatApr(asset.discountBps)} under. About {formatLeft((30 * 60 - Math.floor((CLOCK - loan.auctionStarted) / 1000)) * 1000)} left in this preview.
          </p>
        </section>
      ) : null}

      {canChange ? (
        <section className="block split">
          <form onSubmit={(event) => {
            event.preventDefault();
            run({ type: 'extend', id: loan.id, termDays: parseDays(term), rateBps: parsePercent(rate), capitalize, agreed });
          }}>
            <h2>Extend</h2>
            <p className="hint">The NFT holder signs a new maturity and rate. You accept. LTV is checked at the current oracle.</p>
            <div className="fields">
              <Field id="new-term" label="New term, days from now">
                {(props) => <TextInput id="new-term" value={term} onChange={setTerm} inputMode="numeric" {...props} />}
              </Field>
              <Field id="new-rate" label="New APR">
                {(props) => <TextInput id="new-rate" value={rate} onChange={setRate} {...props} />}
              </Field>
              <Choice id="cap" checked={capitalize} onChange={setCapitalize}>Add accrued interest to principal instead of paying it now.</Choice>
              <Choice id="agree" checked={agreed} onChange={setAgreed}>The Position NFT holder has signed this extension.</Choice>
              <button className="btn" type="submit">Accept extension</button>
            </div>
          </form>
          <form onSubmit={(event) => { event.preventDefault(); run({ type: 'rollover', id: loan.id, offerId }); }}>
            <h2>Roll</h2>
            <p className="hint">Repay and open the next loan in one step. The stock does not leave escrow. Nobody is rolled without consent.</p>
            <div className="field">
              <label htmlFor="offer">Lend offer</label>
              <select id="offer" value={offerId} onChange={(event) => setOfferId(event.target.value)}>
                <option value="">Choose an offer</option>
                {offers.map((offer) => (
                  <option key={offer.id} value={offer.id}>{offer.id} · {formatApr(offer.rateBps)} · {offer.termDays} days · {formatUsd(offer.remainingCents)} left</option>
                ))}
              </select>
            </div>
            <div className="actions">
              <button className="btn secondary" type="submit">Roll this loan</button>
            </div>
          </form>
        </section>
      ) : null}

      {loan.lender === 'you' && !closed ? (
        <p className="block hint">This claim is yours. <Link to="/positions">Sell it on the position market</Link> unless an auction has locked transfer.</p>
      ) : null}
      {formError ? <p className="err" role="alert">{formError}</p> : null}
      {message ? <p className="note" role="status">{message}</p> : null}
    </Page>
  );
}
