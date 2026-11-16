import { Link, useParams } from 'react-router-dom';
import { Page, PreviewBanner, Rows } from '../components/ui.jsx';
import { ASSETS, CLOCK, partyName, stateLabel } from '../lib/data.js';
import {
  formatApr,
  formatLeft,
  formatTokens,
  formatUsd,
  formatWhen,
} from '../lib/format.js';
import { health } from '../lib/health.js';
import { auctionPriceCents } from '../lib/money.js';
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
  const { state } = useStore();
  const loan = state.loans.find((item) => item.id === id);

  if (!loan) {
    return (
      <Page kicker="Loan · Preview" title="Not in preview book." lede="That sample loan is not in the preview.">
        <PreviewBanner />
        <Link to="/loans">Back to loans</Link>
      </Page>
    );
  }

  const view = health(loan);
  const asset = ASSETS[loan.asset];
  const oracleLtv = view.oracleValue > 0 ? formatApr(Math.round((view.debt * 10000) / view.oracleValue)) : '—';
  const marketLtv = view.marketValue > 0 ? formatApr(Math.round((view.debt * 10000) / view.marketValue)) : '—';
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

  return (
    <Page kicker={`Sample Loan ${loan.id} · Preview`} title={`${loan.asset}. ${titleState}`} lede={line(loan, view)}>
      <PreviewBanner>
        This is a read-only preview of a sample loan. Live repay, top-up, and extend actions arrive in WS3.5.
      </PreviewBanner>
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
          <h2>Sample auction (preview)</h2>
          <p className="lede">
            The price is {formatUsd(auction.priceCents)} per token, {formatApr(auction.offBps)} under the oracle. It falls for 30 minutes, from 1% under the oracle to {formatApr(asset.discountBps)} under. About {formatLeft((30 * 60 - Math.floor((CLOCK - loan.auctionStarted) / 1000)) * 1000)} left in this preview.
          </p>
        </section>
      ) : null}

      <div className="actions">
        <Link className="btn secondary" to="/loans">Back to loans</Link>
      </div>
    </Page>
  );
}
