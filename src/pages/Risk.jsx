import { Page, Rows } from '../components/ui.jsx';
import { ASSET_ORDER, ASSETS, FEES, ORACLE_STATES, stateLabel } from '../lib/data.js';
import { formatApr, formatUsd } from '../lib/format.js';

export function Risk() {
  const tierA = ASSET_ORDER.filter((symbol) => ASSETS[symbol].tier === 'A' && ASSETS[symbol].launch);
  const tierB = ASSET_ORDER.filter((symbol) => ASSETS[symbol].tier === 'B');
  const a = ASSETS.NVDAc;
  const b = ASSETS.TSLAc;
  return (
    <Page
      kicker="Risk"
      title="Parameters in public."
      lede="Caps are ceilings, not targets. These launch numbers are a proposal. They are not a measured calibration of weekend gaps."
    >
      <section className="block">
        <h2>Tiers</h2>
        <div className="split">
          <div>
            <h3>Tier A</h3>
            <p className="hint">{tierA.join(', ')}. Mega-cap names. METAc is shown frozen so a corporate-action freeze is visible. It is still a Tier A name.</p>
            <Rows items={[
              { label: 'Max initial LTV', value: formatApr(a.maxInitLtvBps) },
              { label: 'Margin call', value: formatApr(a.marginBps) },
              { label: 'Liquidation', value: formatApr(a.liqBps) },
              { label: 'Bad-debt level', value: formatApr(a.badBps) },
              { label: 'Max auction discount', value: formatApr(a.discountBps) },
              { label: 'Closed-market haircut', value: formatApr(a.haircutBps) },
            ]} />
          </div>
          <div>
            <h3>Tier B</h3>
            <p className="hint">{tierB.join(', ')}. Not at launch.</p>
            <Rows items={[
              { label: 'Max initial LTV', value: formatApr(b.maxInitLtvBps) },
              { label: 'Margin call', value: formatApr(b.marginBps) },
              { label: 'Liquidation', value: formatApr(b.liqBps) },
              { label: 'Bad-debt level', value: formatApr(b.badBps) },
              { label: 'Max auction discount', value: formatApr(b.discountBps) },
              { label: 'Closed-market haircut', value: formatApr(b.haircutBps) },
            ]} />
          </div>
        </div>
      </section>

      <section className="block">
        <h2>Live asset state</h2>
        {ASSET_ORDER.filter((symbol) => ASSETS[symbol].launch).map((symbol) => {
          const asset = ASSETS[symbol];
          return (
            <article className="order-row" key={symbol}>
              <div>
                <strong>{symbol}</strong>
                <span className="quiet">{asset.name} · Tier {asset.tier} · {asset.status} · {stateLabel(asset.state)} · market {formatUsd(asset.marketCents)}</span>
              </div>
              <span className="numline">{formatUsd(asset.oracleCents)}</span>
            </article>
          );
        })}
        <p className="hint">Oracle prices in this preview are illustrative. The registry keys each token by address, never by ticker.</p>
      </section>

      <section className="block">
        <h2>What the oracle allows</h2>
        <p className="lede">The feed already includes dividends and splits. Value is raw units times the feed. A fresh timestamp alone is the wrong test, because a quiet market can be hours old on purpose.</p>
        <div className="stack" style={{ marginTop: 24 }}>
          {ORACLE_STATES.map((item) => (
            <article key={item.id}>
              <h3>{item.label}</h3>
              <p>New loans: {item.loans}. Liquidation: {item.liquidation}. Repay and top-up: {item.repay}.</p>
            </article>
          ))}
        </div>
      </section>

      <section className="block">
        <h2>Auction and surplus</h2>
        <p className="lede">A price starts 1% under the oracle and falls to the asset’s max discount over 30 minutes. Buyers take what they want. If proceeds exceed the debt and fees, the excess returns to the borrower. A shortfall is the lender’s loss. The safety reserve is not insurance.</p>
      </section>

      <section className="block">
        <h2>Fees</h2>
        <div className="stack">
          {FEES.map((fee) => (
            <article key={fee.name}>
              <h3>{fee.name}</h3>
              <p>{fee.payer}. {fee.rate}. Hard cap {fee.cap}. {fee.when}.</p>
            </article>
          ))}
        </div>
      </section>

      <section className="block">
        <h2>Guarded launch</h2>
        <p className="lede">Allowlisted users, two or three Tier A names, about $10,000 per loan, about $250,000 outstanding, and terms of 7 to 30 days. Yield on the locked stock stays off unless both sides of an order turn it on. A pause can stop new loans. It cannot stop repay, top-up, or claim.</p>
      </section>
    </Page>
  );
}
