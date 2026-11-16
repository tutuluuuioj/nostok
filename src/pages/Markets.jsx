import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Field, Page, Rows, Sheet, TextInput } from '../components/ui.jsx';
import { USDC_DECIMALS } from '../lib/contracts.js';
import {
  fetchLoanQuote,
  fetchMarketSnapshot,
  formatApiAmount,
  formatBpsPercent,
  parseDecimalToRaw,
  parsePercentToBps,
} from '../lib/marketsApi.js';
import { shortAddress } from '../lib/web3.js';
import { useStore } from '../store.jsx';

const ORDER_STATUS_FILTERS = [
  ['all', 'All statuses'],
  ['partially_filled', 'Partially filled'],
  ['filled', 'Filled'],
  ['cancelled', 'Cancelled'],
  ['unknown', 'Unfilled / unknown'],
];

export function Markets() {
  const { web3 } = useStore();
  const [snapshot, setSnapshot] = useState({ loading: true, data: null });
  const [assetFilter, setAssetFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('all');
  const reqSeqRef = useRef(0);

  // Live on-chain quote simulator state (read-only GET /quote)
  const [quoteAsset, setQuoteAsset] = useState('');
  const [quotePrincipal, setQuotePrincipal] = useState('1000');
  const [quoteCollateral, setQuoteCollateral] = useState('');
  const [quoteTermDays, setQuoteTermDays] = useState('30');
  const [quoteAprPct, setQuoteAprPct] = useState('8.00');
  const [quoteMaxLtvPct, setQuoteMaxLtvPct] = useState('60.00');
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteResult, setQuoteResult] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const quoteSeqRef = useRef(0);

  const updateQuoteField = useCallback((setter) => (value) => {
    quoteSeqRef.current += 1;
    setQuoteLoading(false);
    setQuoteResult(null);
    setQuoteError('');
    setter(value);
  }, []);

  const loadMarkets = useCallback(async () => {
    const requestId = ++reqSeqRef.current;
    setSnapshot((prev) => ({ loading: true, data: prev.data }));
    const next = await fetchMarketSnapshot({
      cfg: web3?.config,
      requestId,
      includeLoans: false,
      includeAuctions: false,
    });
    if (requestId !== reqSeqRef.current) return;
    setSnapshot({ loading: false, data: next });
    if (next.assets.length > 0) {
      setQuoteAsset((prev) => {
        if (prev && next.assets.some((a) => a.token === prev)) return prev;
        return next.assets[0].token;
      });
    }
  }, [web3?.config]);

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  const data = snapshot.data;
  const assets = data?.assets ?? [];
  const assetFilters = useMemo(() => {
    const chips = [['All', 'All']];
    for (const a of assets) {
      chips.push([a.token, a.symbol || shortAddress(a.token)]);
    }
    return chips;
  }, [assets]);

  const filteredOrders = useMemo(() => {
    const orders = data?.orders ?? [];
    return orders.filter((order) => {
      if (statusFilter !== 'all' && order.status !== statusFilter) return false;
      if (assetFilter === 'All') return true;
      const target = assetFilter.toLowerCase();
      if (order.collateral_token && order.collateral_token.toLowerCase() === target) return true;
      return Array.isArray(order.fills) &&
        order.fills.some((f) => f.collateral_token && f.collateral_token.toLowerCase() === target);
    });
  }, [assetFilter, data?.orders, statusFilter]);

  const borrows = useMemo(
    () => filteredOrders.filter((o) => o.order_type === 'borrow' || o.order_type === 'BorrowOrder'),
    [filteredOrders]
  );
  const lends = useMemo(
    () => filteredOrders.filter((o) => o.order_type === 'lend' || o.order_type === 'LendOffer'),
    [filteredOrders]
  );

  const selectedAssetObj = useMemo(
    () => assets.find((a) => a.token === quoteAsset) ?? assets[0] ?? null,
    [assets, quoteAsset]
  );

  async function runQuoteSimulation(event) {
    event.preventDefault();
    setQuoteError('');
    setQuoteResult(null);

    if (!selectedAssetObj) {
      setQuoteError('No registered assets available to quote.');
      return;
    }

    const tokenDecimals = Number(selectedAssetObj.decimals ?? 18);
    const principalRaw = quotePrincipal.trim()
      ? parseDecimalToRaw(quotePrincipal, USDC_DECIMALS)
      : null;
    if (quotePrincipal.trim() && !principalRaw) {
      setQuoteError('Enter a positive USDC principal with up to 6 decimals.');
      return;
    }

    const collateralRaw = quoteCollateral.trim()
      ? parseDecimalToRaw(quoteCollateral, tokenDecimals)
      : null;
    if (quoteCollateral.trim() && !collateralRaw) {
      setQuoteError(`Enter a positive collateral amount with up to ${tokenDecimals} decimals.`);
      return;
    }

    if (!principalRaw && !collateralRaw) {
      setQuoteError('Enter either a principal USDC amount or a collateral token amount.');
      return;
    }

    const termDays = Number(quoteTermDays.trim());
    if (!Number.isInteger(termDays) || termDays < 7 || termDays > 90) {
      setQuoteError('Term days must be an integer between 7 and 90.');
      return;
    }

    const aprBps = parsePercentToBps(quoteAprPct);
    if (aprBps === null) {
      setQuoteError('Enter a valid APR percentage (up to 2 decimal places).');
      return;
    }

    const maxLtvBps = quoteMaxLtvPct.trim() ? parsePercentToBps(quoteMaxLtvPct) : undefined;
    if (quoteMaxLtvPct.trim() && (maxLtvBps === null || maxLtvBps <= 0 || maxLtvBps > 10_000)) {
      setQuoteError('Max LTV percentage must be between 0.01% and 100.00%.');
      return;
    }

    const qSeq = ++quoteSeqRef.current;
    setQuoteLoading(true);
    try {
      const res = await fetchLoanQuote({
        cfg: web3?.config,
        asset: selectedAssetObj.token,
        principalRaw,
        collateralAmountRaw: collateralRaw,
        termDays,
        aprBps,
        maxLtvBps,
        borrower: web3?.connected ? web3.address : undefined,
        borrowerAttestation: web3?.connected ? web3.attestationHex : undefined,
      });
      if (qSeq !== quoteSeqRef.current) return;
      setQuoteResult(res);
    } catch (err) {
      if (qSeq !== quoteSeqRef.current) return;
      setQuoteError(err instanceof Error ? err.message : String(err));
    } finally {
      if (qSeq === quoteSeqRef.current) {
        setQuoteLoading(false);
      }
    }
  }

  return (
    <Page
      kicker="Markets"
      title="Live markets & order activity."
      lede="Read-only Base Mainnet order book activity, live Chainlink collateral pricing from AssetRegistry/OracleRouter, and exact on-chain loan quotes from api/. Order submission and fills arrive in the next release."
    >
      <div className="actions">
        <button
          className="btn secondary"
          type="button"
          onClick={() => void loadMarkets()}
          disabled={snapshot.loading}
        >
          {snapshot.loading ? 'Refreshing live book…' : 'Refresh market data'}
        </button>
        {data?.health ? (
          <span className="hint">
            Indexed block #{data.health.last_indexed_block ?? '—'} · Chain head #
            {data.health.chain_head_block ?? '—'} · Lag {data.health.lag_blocks ?? '—'} blocks · Updated{' '}
            {data.fetchedAt}
          </span>
        ) : null}
      </div>

      {snapshot.loading && !data ? (
        <p className="hint block">Loading live asset parameters and indexed order activity from api/…</p>
      ) : null}

      {data && (data.stale || data.degraded || data.error) ? (
        <p className="err block" role="alert">
          Live market state degraded or unavailable — {data.error || 'Indexer or RPC health check failed.'} No preview or cached fallback prices are displayed.
        </p>
      ) : null}

      <section className="block">
        <h2>Registered collateral assets</h2>
        <p className="hint">Live prices and risk parameters read from Base contracts and api/ GET /assets.</p>
        {assets.length === 0 ? (
          <p className="lede">
            {data?.error ? 'Assets unavailable while api/ is unreachable.' : 'No registered collateral assets indexed yet.'}
          </p>
        ) : (
          assets.map((item) => (
            <article className="order-row" key={item.token}>
              <div>
                <strong>
                  {item.symbol || shortAddress(item.token)} · {item.status_name}
                </strong>
                <span className="quiet">
                  {item.token} ({item.decimals} dec) · Tier {item.tier ?? '—'} · Oracle {item.oracle?.state_name}
                </span>
                <span className="quiet">
                  Init {formatBpsPercent(item.ltv?.max_init_ltv_bps)} · Margin{' '}
                  {formatBpsPercent(item.ltv?.margin_call_ltv_bps)} · Liq{' '}
                  {formatBpsPercent(item.ltv?.liq_ltv_bps)} · Cap remaining{' '}
                  {formatApiAmount(item.caps?.asset_remaining, { prefixUsd: true })}
                </span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className="numline">
                  {formatApiAmount(item.oracle?.price, { prefixUsd: true, maxFractionDigits: 2 })}
                </span>
                <div style={{ marginTop: 6 }}>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      quoteSeqRef.current += 1;
                      setQuoteLoading(false);
                      setQuoteAsset(item.token);
                      setQuoteResult(null);
                      setQuoteError('');
                    }}
                  >
                    Quote
                  </button>
                </div>
              </div>
            </article>
          ))
        )}
      </section>

      <div className="block">
        <div className="chips" role="group" aria-label="Filter by stock">
          {assetFilters.map(([val, label]) => (
            <button
              key={val}
              type="button"
              aria-pressed={assetFilter === val}
              onClick={() => setAssetFilter(val)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="chips" role="group" aria-label="Filter by order status" style={{ marginTop: 10 }}>
          {ORDER_STATUS_FILTERS.map(([val, label]) => (
            <button
              key={val}
              type="button"
              aria-pressed={statusFilter === val}
              onClick={() => setStatusFilter(val)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <section className="block">
        <h2>Indexed borrow orders</h2>
        <p className="hint">Borrow orders observed in OrderSettlement fills and cancellations (USDC 6 dec).</p>
        {borrows.length === 0 ? (
          <p className="lede">No indexed borrow orders match the current filter.</p>
        ) : (
          borrows.map((item) => (
            <article className="order-row" key={item.order_hash}>
              <div>
                <strong>
                  {item.collateral_symbol || (item.collateral_token ? shortAddress(item.collateral_token) : 'Asset')} · {item.status}
                </strong>
                <span className="quiet">
                  Maker {shortAddress(item.maker)} · Order {item.order_hash.slice(0, 14)}… · Fills {item.fills_count} · Block #{item.last_updated_block}
                </span>
                <span className="quiet">
                  Filled {formatApiAmount(item.filled_usdc, { prefixUsd: true })} of{' '}
                  {formatApiAmount(item.min_usdc, { prefixUsd: true })}
                  {item.remaining_usdc ? ` · ${formatApiAmount(item.remaining_usdc, { prefixUsd: true })} remaining` : ''}
                </span>
              </div>
              <span className="numline">
                {formatApiAmount(item.filled_usdc, { showSymbol: true })}
              </span>
            </article>
          ))
        )}
      </section>

      <section className="block">
        <h2>Indexed lend offers</h2>
        <p className="hint">Lend offers observed in OrderSettlement fills and cancellations (read-only; live fill signing lands in WS3.3–3.4).</p>
        {lends.length === 0 ? (
          <p className="lede">No indexed lend offers match the current filter.</p>
        ) : (
          lends.map((item) => (
            <article className="order-row" key={item.order_hash}>
              <div>
                <strong>
                  {item.collateral_symbol || (item.collateral_token ? shortAddress(item.collateral_token) : 'Multi-asset')} · {item.status}
                </strong>
                <span className="quiet">
                  Maker {shortAddress(item.maker)} · Order {item.order_hash.slice(0, 14)}… · Fills {item.fills_count} · Block #{item.last_updated_block}
                </span>
                <span className="quiet">
                  Filled {formatApiAmount(item.filled_usdc, { prefixUsd: true })} of{' '}
                  {formatApiAmount(item.min_usdc, { prefixUsd: true })}
                  {item.remaining_usdc ? ` · ${formatApiAmount(item.remaining_usdc, { prefixUsd: true })} remaining` : ''}
                </span>
              </div>
              <span className="numline">
                {formatApiAmount(item.filled_usdc, { showSymbol: true })}
              </span>
            </article>
          ))
        )}
      </section>

      <form className="block" onSubmit={runQuoteSimulation}>
        <Sheet
          title="Live on-chain loan quote calculator (GET /quote)"
          note="Queries LoanCore, AssetRegistry, OracleRouter, FeeCollector, and EligibilityGate via api/ at current Base block state. Read-only simulation; does not submit transactions."
        >
          <div className="fields">
            <div className="field">
              <label htmlFor="quote-asset">Collateral token</label>
              <select
                id="quote-asset"
                value={selectedAssetObj?.token ?? ''}
                onChange={(e) => updateQuoteField(setQuoteAsset)(e.target.value)}
              >
                {assets.length === 0 ? (
                  <option value="">No registered assets loaded</option>
                ) : (
                  assets.map((a) => (
                    <option key={a.token} value={a.token}>
                      {a.symbol || shortAddress(a.token)} ({a.oracle?.state_name})
                    </option>
                  ))
                )}
              </select>
            </div>

            <Field
              id="quote-principal"
              label="Principal (USDC, up to 6 decimals)"
              hint="Leave empty if quoting purely from collateral amount, or enter e.g. 1000.00."
            >
              {(props) => (
                <TextInput
                  id="quote-principal"
                  value={quotePrincipal}
                  onChange={updateQuoteField(setQuotePrincipal)}
                  {...props}
                />
              )}
            </Field>

            <Field
              id="quote-collateral"
              label={`Collateral amount (${selectedAssetObj?.symbol ?? 'tokens'}, up to ${selectedAssetObj?.decimals ?? 18} decimals)`}
              hint="Optional when Principal is provided — /quote computes exact required collateral."
            >
              {(props) => (
                <TextInput
                  id="quote-collateral"
                  value={quoteCollateral}
                  onChange={updateQuoteField(setQuoteCollateral)}
                  {...props}
                />
              )}
            </Field>

            <div className="split">
              <Field id="quote-term" label="Term (days)" hint="Protocol allows 7 to 90 days.">
                {(props) => (
                  <TextInput
                    id="quote-term"
                    inputMode="numeric"
                    value={quoteTermDays}
                    onChange={updateQuoteField(setQuoteTermDays)}
                    {...props}
                  />
                )}
              </Field>
              <Field id="quote-apr" label="APR (%)" hint="Annual rate, e.g. 8.00.">
                {(props) => (
                  <TextInput
                    id="quote-apr"
                    value={quoteAprPct}
                    onChange={updateQuoteField(setQuoteAprPct)}
                    {...props}
                  />
                )}
              </Field>
            </div>

            <Field
              id="quote-max-ltv"
              label="Order max LTV (%)"
              hint="Optional counterparty LTV cap (e.g. 60.00); asset ceiling still enforces protocol limit."
            >
              {(props) => (
                <TextInput
                  id="quote-max-ltv"
                  value={quoteMaxLtvPct}
                  onChange={updateQuoteField(setQuoteMaxLtvPct)}
                  {...props}
                />
              )}
            </Field>

            {quoteError ? (
              <p className="err" role="alert">
                {quoteError}
              </p>
            ) : null}

            <div className="actions">
              <button
                className="btn"
                type="submit"
                disabled={quoteLoading || assets.length === 0}
              >
                {quoteLoading ? 'Calculating quote…' : 'Simulate live quote'}
              </button>
              <Link className="btn secondary" to="/risk">
                Risk parameters
              </Link>
            </div>
          </div>

          {quoteResult ? (
            <div className="block">
              <p className={quoteResult.accepted ? 'note' : 'err'}>
                Quote #{quoteResult.block_number}:{' '}
                {quoteResult.accepted
                  ? 'Accepted by on-chain parameters'
                  : `Rejected (${quoteResult.rejection_reasons.map((r) => `${r.code}: ${r.message}`).join('; ')})`}
              </p>
              {quoteResult.warnings?.length > 0 ? (
                <p className="hint">
                  Warnings: {quoteResult.warnings.map((w) => `${w.code}: ${w.message}`).join('; ')}
                </p>
              ) : null}
              <Rows
                items={[
                  {
                    label: 'Asset & oracle',
                    value: `${quoteResult.asset.symbol} · ${formatApiAmount(quoteResult.asset.oracle_price, { prefixUsd: true })} (${quoteResult.asset.oracle_state_name})`,
                  },
                  {
                    label: 'Principal (6 dec)',
                    value: formatApiAmount(quoteResult.amounts.principal, { prefixUsd: true, showSymbol: true }),
                  },
                  {
                    label: `Required collateral (${quoteResult.asset.decimals} dec)`,
                    value: formatApiAmount(quoteResult.amounts.collateral_required, {
                      maxFractionDigits: 6,
                      showSymbol: true,
                    }),
                  },
                  {
                    label: 'Gross / effective collateral',
                    value: `${formatApiAmount(quoteResult.amounts.collateral_gross_value_usdc, { prefixUsd: true })} / ${formatApiAmount(quoteResult.amounts.collateral_effective_value_usdc, { prefixUsd: true })}`,
                  },
                  {
                    label: `Origination fee (${formatBpsPercent(quoteResult.amounts.origination_fee_bps)})`,
                    value: formatApiAmount(quoteResult.amounts.origination_fee, { prefixUsd: true, showSymbol: true }),
                  },
                  {
                    label: 'Net borrower proceeds',
                    value: formatApiAmount(quoteResult.amounts.net_proceeds, { prefixUsd: true, showSymbol: true }),
                  },
                  {
                    label: 'Interest at maturity',
                    value: formatApiAmount(quoteResult.amounts.interest_maturity, { prefixUsd: true, showSymbol: true }),
                  },
                  {
                    label: 'Total repayment at maturity',
                    value: formatApiAmount(quoteResult.amounts.total_repayment_at_maturity, {
                      prefixUsd: true,
                      showSymbol: true,
                    }),
                  },
                  {
                    label: 'Initial LTV / health factor',
                    value: `${formatBpsPercent(quoteResult.risk.initial_ltv_bps)} · HF ${quoteResult.risk.health_factor.formatted}`,
                  },
                  {
                    label: 'Liquidation price (origination / maturity)',
                    value: `${formatApiAmount(quoteResult.risk.liquidation_price_at_origination, { prefixUsd: true })} / ${formatApiAmount(quoteResult.risk.liquidation_price_at_maturity, { prefixUsd: true })}`,
                  },
                  {
                    label: 'Asset remaining / global remaining cap',
                    value: `${formatApiAmount(quoteResult.caps.asset_remaining, { prefixUsd: true })} / ${formatApiAmount(quoteResult.caps.global_remaining, { prefixUsd: true })}`,
                  },
                ]}
              />
            </div>
          ) : null}
        </Sheet>
      </form>
    </Page>
  );
}
