import { Page } from '../components/ui.jsx';

const RISKS = [
  ['Issuer', 'The issuer can pause a token, block an address, or fail. NOSTOK cannot override an issuer block. Release can be aimed at a recipient who still passes the token policy.'],
  ['Oracle', 'The oracle can be closed, stale, frozen, or disputed. Liquidation does not run in those states. Repay and top-up do. A weekend gap is carried by the LTV, not by a sale on a stale price.'],
  ['Corporate actions', 'Dividends and splits on these stock tokens move a multiplier. The feed already includes it. Escrow accounts in raw units and does not apply the multiplier again. An unexpected change freezes the asset.'],
  ['Default', 'A Dutch auction sells collateral. Surplus returns to the borrower. If the sale falls short, the lender bears the loss. The safety reserve is not insurance.'],
  ['Contracts', 'Smart contract risk remains. Escrow and the Position NFT are specified as immutable. Logic contracts sit behind a timelock. A pause cannot trap a repayment.'],
  ['Collateral use', 'Yield on the locked stock is off unless both sides turn it on. The lender then earns what the venue pays and bears any venue loss. That is not a promised rate. If it stays off, the stock is not lent on.'],
  ['Eligibility', 'The product is for eligible non-US persons. This interface blocks US and sanctioned jurisdictions. Terms have to be accepted before an order.'],
  ['The claim', 'The Position NFT is a claim to USDC. The stock does not move with it. Transfer is locked during an auction.'],
];

export function Terms() {
  return (
    <Page
      kicker="Terms"
      title="Risks, in plain words."
      lede="This is the disclosure a borrower or lender has to be able to read. It is not a legal opinion. Counsel comes before mainnet."
    >
      <div className="stack block">
        {RISKS.map(([title, body]) => (
          <article key={title}>
            <h2>{title}</h2>
            <p className="lede">{body}</p>
          </article>
        ))}
      </div>
      <section className="block">
        <h2>Records and contact</h2>
        <p className="lede">Your orders, fills, and loans can be downloaded from the loans desk. A public complaints contact is published before mainnet. Assets and terms can be turned off by region at this interface.</p>
      </section>
    </Page>
  );
}
