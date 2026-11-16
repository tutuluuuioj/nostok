import { useCallback, useEffect, useRef, useState } from 'react';
import { Page, Rows } from '../components/ui.jsx';
import { ORACLE_STATES } from '../lib/data.js';
import {
  buildProtocolFeeCards,
  buildRiskSummaryRows,
  fetchMarketSnapshot,
  fetchRiskSummaryOptional,
  formatApiAmount,
  formatBpsPercent,
} from '../lib/marketsApi.js';
import { shortAddress } from '../lib/web3.js';
import { useStore } from '../store.jsx';

export function Risk() {
  const { web3 } = useStore();
  const [state, setState] = useState({ loading: true, market: null, risk: null, riskError: '' });
  const reqSeqRef = useRef(0);

  const loadRisk = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setState((prev) => ({ ...prev, loading: true }));
    const [market, riskRes] = await Promise.all([
      fetchMarketSnapshot({
        cfg: web3?.config,
        requestId: seq,
        includeLoans: false,
        includeAuctions: false,
      }),
      fetchRiskSummaryOptional(web3?.config),
    ]);
    if (seq !== reqSeqRef.current) return;
    setState({
      loading: false,
      market,
      risk: riskRes.data,
      riskError: riskRes.error || '',
    });
  }, [web3?.config]);

  useEffect(() => {
    void loadRisk();
  }, [loadRisk]);

  const market = state.market;
  const assets = market?.assets ?? [];
  const risk = state.risk;
  const feeCards = buildProtocolFeeCards(market?.fees);

  return (
    <Page
      kicker="Risk"
      title="Live asset risk & parameters."
      lede="Collateral is keyed strictly by token address in AssetRegistry and valued at OracleRouter. Never relies on cached or hardcoded oracle prices."
    >
      <div className="actions">
        <button
          className="btn secondary"
          type="button"
          onClick={() => void loadRisk()}
          disabled={state.loading}
        >
          {state.loading ? 'Refreshing risk state…' : 'Refresh risk state'}
        </button>
      </div>

      {market && (market.stale || market.degraded || market.error) ? (
        <p className="err block" role="alert">
          Live asset &amp; oracle state unavailable or degraded — {market.error}
        </p>
      ) : null}

      {risk && (risk.monitor_degraded || risk.last_scan_error || state.riskError) ? (
        <p className="err block" role="alert">
          Risk monitor degraded (monitor_degraded={String(Boolean(risk.monitor_degraded))}) —{' '}
          {risk.last_scan_error || state.riskError || 'Scan error'} · Last scan {risk.last_scan_timestamp ?? '—'}
        </p>
      ) : null}

      {state.riskError && !risk ? (
        <p className="hint block">
          Risk monitor summary endpoint unavailable ({state.riskError}); showing AssetRegistry and OracleRouter state from api/.
        </p>
      ) : null}

      {risk ? (
        <section className="block">
          <h2>Protocol risk summary (risk/)</h2>
          <Rows items={buildRiskSummaryRows(risk)} />
        </section>
      ) : null}

      <section className="block">
        <h2>Live asset state (GET /assets)</h2>
        {state.loading && !market ? (
          <p className="hint">Loading registered collateral assets from api/…</p>
        ) : assets.length === 0 ? (
          <p className="lede">
            {market?.error
              ? 'Live asset parameters could not be loaded while api/ is unreachable.'
              : 'No registered assets indexed yet.'}
          </p>
        ) : (
          assets.map((asset) => (
            <article className="order-row" key={asset.token}>
              <div>
                <strong>
                  {asset.symbol || shortAddress(asset.token)} · {asset.status_name}
                </strong>
                <span className="quiet">
                  {asset.token} · Tier {asset.tier ?? '—'} · {asset.oracle?.state_name} · Multiplier{' '}
                  {asset.multiplier?.recorded?.formatted ?? '—'}
                </span>
                <span className="quiet">
                  Init {formatBpsPercent(asset.ltv?.max_init_ltv_bps)} · Margin{' '}
                  {formatBpsPercent(asset.ltv?.margin_call_ltv_bps)} · Liq{' '}
                  {formatBpsPercent(asset.ltv?.liq_ltv_bps)} · Bad debt{' '}
                  {formatBpsPercent(asset.ltv?.bad_debt_ltv_bps)} · Haircut{' '}
                  {formatBpsPercent(asset.ltv?.closed_market_haircut_bps)}
                </span>
                <span className="quiet">
                  Per loan {formatApiAmount(asset.caps?.per_loan_cap, { prefixUsd: true })} · Outstanding{' '}
                  {formatApiAmount(asset.caps?.asset_outstanding_principal, { prefixUsd: true })} / Cap{' '}
                  {formatApiAmount(asset.caps?.asset_cap, { prefixUsd: true })} · Escrow{' '}
                  {formatApiAmount(asset.escrow_balance, { maxFractionDigits: 6, showSymbol: true })}
                </span>
              </div>
              <span className="numline">
                {formatApiAmount(asset.oracle?.price, { prefixUsd: true, maxFractionDigits: 2 })}
              </span>
            </article>
          ))
        )}
        <p className="hint">AssetRegistry keys each collateral asset strictly by contract address on Base (block #{market?.health?.live_block_number ?? market?.health?.block_number ?? '—'}).</p>
      </section>

      <section className="block">
        <h2>Oracle state enforcement rules (protocol specification)</h2>
        <p className="lede">Feeds incorporate splits/dividends via AssetRegistry multiplier syncs. Closed equity markets apply an origination haircut while pausing automated liquidations.</p>
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
        <h2>Auction and surplus settlement</h2>
        <p className="lede">Dutch auctions start near oracle price and step toward max auction discount. Buyers take partial or full lots. Any proceeds above debt and fees return to the borrower; uncovered shortfalls fall on the lender position.</p>
      </section>

      <section className="block">
        <h2>Protocol fees &amp; caps (FeeCollector via api/)</h2>
        {feeCards.length === 0 ? (
          <p className="hint">Live protocol fee parameters could not be loaded while api/ is unreachable.</p>
        ) : (
          <div className="stack">
            {feeCards.map((fee) => (
              <article key={fee.name}>
                <h3>{fee.name}</h3>
                <p>{fee.detail}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </Page>
  );
}
