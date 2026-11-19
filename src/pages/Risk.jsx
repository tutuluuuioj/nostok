import { useCallback, useEffect, useRef, useState } from 'react';
import { Page, Rows } from '../components/ui.jsx';
import { ORACLE_STATES } from '../lib/data.js';
import {
  buildOnChainEnvironmentRows,
  buildProtocolFeeCards,
  buildRiskSummaryRows,
  fetchMarketsAndLiveContracts,
  fetchRiskSummaryOptional,
  formatApiAmount,
  formatBpsPercent,
} from '../lib/marketsApi.js';
import { shortAddress } from '../lib/web3.js';
import { useStore } from '../store.jsx';

export function Risk() {
  const { web3 } = useStore();
  const [state, setState] = useState({
    loading: true,
    market: null,
    onChain: null,
    assets: [],
    discrepancies: [],
    risk: null,
    riskError: '',
  });
  const reqSeqRef = useRef(0);

  const loadRisk = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setState((prev) => ({ ...prev, loading: true }));
    const [combined, riskRes] = await Promise.all([
      fetchMarketsAndLiveContracts({
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
      market: combined.market,
      onChain: combined.onChain,
      assets: combined.assets,
      discrepancies: combined.discrepancies,
      risk: riskRes.data,
      riskError: riskRes.error || '',
    });
  }, [web3?.config]);

  useEffect(() => {
    void loadRisk();
  }, [loadRisk]);

  const market = state.market;
  const onChain = state.onChain;
  const assets = state.assets ?? [];
  const discrepancies = state.discrepancies ?? [];
  const risk = state.risk;
  const feeCards = buildProtocolFeeCards(onChain?.fees ?? market?.fees);

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

      {onChain && !onChain.ok ? (
        <p className="err block" role="alert">
          Direct Base RPC contract read unavailable — {onChain.error}
        </p>
      ) : null}

      {market && (market.stale || market.degraded || market.error) ? (
        <p className={onChain?.ok && assets.length > 0 ? 'hint block' : 'err block'} role="alert">
          {onChain?.ok && assets.length > 0
            ? `api/ asset feed degraded or unreachable (${market.error}) — displaying live AssetRegistry, OracleRouter, LoanCore & FeeCollector contract readings directly from Base RPC.`
            : `Live asset & oracle state unavailable or degraded — ${market.error}`}
        </p>
      ) : null}

      {discrepancies.length > 0 ? (
        <p className="err block" role="alert">
          Contract vs api/ mismatch detected (Base RPC values shown): {discrepancies.join(' · ')}
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
          Risk monitor summary endpoint unavailable ({state.riskError}); showing direct Base contracts &amp; AssetRegistry/OracleRouter state.
        </p>
      ) : null}

      {onChain?.ok ? (
        <section className="block">
          <h2>Live Base contracts (LoanCore &amp; OracleRouter)</h2>
          <Rows items={buildOnChainEnvironmentRows(onChain)} />
        </section>
      ) : null}

      {risk ? (
        <section className="block">
          <h2>Protocol risk summary (risk/)</h2>
          <Rows items={buildRiskSummaryRows(risk)} />
        </section>
      ) : null}

      <section className="block">
        <h2>Live asset state (AssetRegistry &amp; OracleRouter)</h2>
        {state.loading && assets.length === 0 ? (
          <p className="hint">Loading registered collateral assets from Base contracts &amp; api/…</p>
        ) : assets.length === 0 ? (
          <p className="lede">
            {onChain?.error && market?.error
              ? 'Live asset parameters could not be loaded while both Base RPC and api/ are unreachable.'
              : 'No registered assets discovered on-chain or indexed yet.'}
          </p>
        ) : (
          assets.map((asset) => (
            <article className="order-row" key={asset.token}>
              <div>
                <strong>
                  {asset.symbol || shortAddress(asset.token)} · {asset.status_name}
                </strong>
                <span className="quiet">
                  {asset.token} · {asset.tier_name ?? `Tier ${asset.tier ?? '—'}`} · Oracle{' '}
                  {asset.oracle?.state_name ?? '—'} · Recorded mult{' '}
                  {asset.multiplier?.recorded?.formatted ?? '—'}
                  {asset.multiplier?.ui
                    ? ` · uiMultiplier ${asset.multiplier.ui.formatted} (drift ${
                        asset.multiplier.drift_bps !== null && asset.multiplier.drift_bps !== undefined
                          ? `${asset.multiplier.drift_bps} bps`
                          : 'unrecorded'
                      })`
                    : ''}
                </span>
                <span className="quiet">
                  Init {formatBpsPercent(asset.ltv?.max_init_ltv_bps)} · Margin{' '}
                  {formatBpsPercent(asset.ltv?.margin_call_ltv_bps)} · Liq{' '}
                  {formatBpsPercent(asset.ltv?.liq_ltv_bps)} · Bad debt{' '}
                  {formatBpsPercent(asset.ltv?.bad_debt_ltv_bps)} · Max disc{' '}
                  {formatBpsPercent(asset.ltv?.max_discount_bps)} · Haircut{' '}
                  {formatBpsPercent(asset.ltv?.closed_market_haircut_bps)}
                </span>
                <span className="quiet">
                  Per loan {formatApiAmount(asset.caps?.per_loan_cap, { prefixUsd: true })} · Outstanding{' '}
                  {formatApiAmount(asset.caps?.asset_outstanding_principal, { prefixUsd: true })} / Cap{' '}
                  {formatApiAmount(asset.caps?.asset_cap, { prefixUsd: true })} · Escrow{' '}
                  {formatApiAmount(asset.escrow_balance, { maxFractionDigits: 6, showSymbol: true })} · Restricted{' '}
                  {asset.restricted ? 'Yes' : 'No'}
                </span>
                {asset.oracle?.gross_unit_value_usdc ? (
                  <span className="quiet">
                    1 {asset.symbol || 'token'} value: gross{' '}
                    {formatApiAmount(asset.oracle.gross_unit_value_usdc, { prefixUsd: true })} / effective{' '}
                    {formatApiAmount(asset.oracle.effective_unit_value_usdc, { prefixUsd: true })} · Feed age{' '}
                    {asset.oracle.feed_age_seconds ?? '—'}s / open max {asset.oracle.max_stale_open_secs ?? '—'}s
                  </span>
                ) : null}
              </div>
              <span className="numline">
                {formatApiAmount(asset.oracle?.price, { prefixUsd: true, maxFractionDigits: 2 })}
              </span>
            </article>
          ))
        )}
        <p className="hint">
          AssetRegistry keys each collateral asset strictly by contract address on Base (
          {onChain?.ok
            ? `Base RPC block #${onChain.blockNumber}`
            : `api/ block #${market?.health?.live_block_number ?? market?.health?.block_number ?? '—'}`}
          ).
        </p>
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
        <h2>Protocol fees &amp; caps (FeeCollector)</h2>
        {feeCards.length === 0 ? (
          <p className="hint">Live protocol fee parameters could not be loaded from Base RPC or api/.</p>
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
