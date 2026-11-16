import { Page, PreviewBanner } from '../components/ui.jsx';
import { useStore } from '../store.jsx';

export function Builders() {
  const { state } = useStore();
  const sample = state.orders.find((order) => order.side === 'borrow' && order.remainingCents > 0) || state.orders[0];
  return (
    <Page
      kicker="Builders"
      title="One order format."
      lede="Wallets and agents use the same EIP-712 signing path and the same EligibilityGate as a person. Orders are public. Any interface can fill them. The contracts are the source of truth."
    >
      <PreviewBanner>
        The JSON example below uses preview book figures for schema illustration, not live orders or your positions.
      </PreviewBanner>
      <section className="block">
        <h2>Borrow order</h2>
        <p>Borrower, stock token, raw collateral amount, minimum USDC, maximum rate, term in days, maximum LTV, minimum fill, expiry, nonce, yield mode, and an eligibility proof when the gate requires one.</p>
      </section>
      <section className="block">
        <h2>Lend offer</h2>
        <p>Lender, USDC amount, minimum rate, term, allowed stocks, maximum LTV, expiry, nonce, and yield mode. Yield is off unless both the order and the fill turn it on.</p>
      </section>
      <section className="block">
        <h2>Illustrative order fields (preview sample)</h2>
        <p className="hint">This is a static preview book sample, not a signed EIP-712 payload. A live signed order uses raw base units (6 decimals for USDC, token decimals for collateral) plus the EIP-712 signature.</p>
        <pre className="json">{JSON.stringify({
          id: sample.id,
          side: sample.side,
          asset: sample.asset,
          assets: sample.assets,
          usdc: sample.remainingCents / 100,
          rateApr: sample.rateBps / 100,
          termDays: sample.termDays,
          maxLtv: sample.maxLtvBps / 100,
          minFill: sample.minFillCents / 100,
          yieldMode: sample.yieldMode,
        }, null, 2)}</pre>
      </section>
      <section className="block">
        <h2>Read endpoints a desk needs</h2>
        <p>Open orders, a single loan, both LTV figures, oracle validity, asset status, and a user’s claimable USDC. Risk parameters are public with the same numbers the contract enforces.</p>
      </section>
    </Page>
  );
}
