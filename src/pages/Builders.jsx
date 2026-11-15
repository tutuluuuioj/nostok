import { Page } from '../components/ui.jsx';
import { useStore } from '../store.jsx';

export function Builders() {
  const { state } = useStore();
  const sample = state.orders.find((order) => order.side === 'borrow' && order.remainingCents > 0) || state.orders[0];
  return (
    <Page
      kicker="Builders"
      title="One order format."
      lede="Wallets and agents use the same signing path and the same eligibility gate as a person. Orders are public. Any interface can fill them. The contracts are the source of truth."
    >
      <section className="block">
        <h2>Borrow order</h2>
        <p>Borrower, stock token, raw collateral amount, minimum USDC, maximum rate, term in days, maximum LTV, minimum fill, expiry, nonce, yield mode, in-kind flag, and an eligibility proof when the gate requires one.</p>
      </section>
      <section className="block">
        <h2>Lend offer</h2>
        <p>Lender, USDC amount, minimum rate, term, allowed stocks, maximum LTV, expiry, nonce, and yield mode. Yield is off unless both the order and the fill turn it on.</p>
      </section>
      <section className="block">
        <h2>A public order</h2>
        <p className="hint">This is the preview book, not a signed EIP-712 payload. A live order carries the signature beside these fields.</p>
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
          inKind: sample.inKind,
        }, null, 2)}</pre>
      </section>
      <section className="block">
        <h2>Read endpoints a desk needs</h2>
        <p>Open orders, a single loan, both LTV figures, oracle validity, asset status, and a user’s claimable USDC. Risk parameters are public with the same numbers the contract enforces.</p>
      </section>
    </Page>
  );
}
