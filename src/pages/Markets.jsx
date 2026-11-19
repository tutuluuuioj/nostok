import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Field, Page, Rows, Sheet, TextInput } from '../components/ui.jsx';
import { OracleState, USDC_DECIMALS } from '../lib/contracts.js';
import {
  evaluateAssetOriginationStatus,
  fetchLoanQuote,
  fetchMarketsAndLiveContracts,
  formatApiAmount,
  formatAssetOraclePrice,
  formatBpsPercent,
  parseDecimalToRaw,
  parsePercentToBps,
} from '../lib/marketsApi.js';
import { shortAddress } from '../lib/web3.js';
import { useStore } from '../store.jsx';

const ORDER_STATUS_FILTERS = [
  ['all', 'All statuses'],
  ['open', 'Open (signed)'],
  ['partially_filled', 'Partially filled'],
  ['unfunded', 'Unfunded'],
  ['filled', 'Filled'],
  ['cancelled', 'Cancelled'],
  ['expired', 'Expired'],
  ['nonce_bumped', 'Nonce bumped'],
  ['unknown', 'Unfilled / unknown'],
];

const INACTIVE_STATUS_FILTERS = new Set([
  'unfunded',
  'filled',
  'cancelled',
  'expired',
  'nonce_bumped',
  'unknown',
]);

export function Markets() {
  const { web3 } = useStore();
  const [snapshot, setSnapshot] = useState({
    loading: true,
    data: null,
    onChain: null,
    assets: [],
    discrepancies: [],
  });
  const [assetFilter, setAssetFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showInactive, setShowInactive] = useState(false);
  const [copiedOrderHash, setCopiedOrderHash] = useState('');
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

  const shouldIncludeInactive =
    showInactive || INACTIVE_STATUS_FILTERS.has(statusFilter);

  const updateQuoteField = useCallback((setter) => (value) => {
    quoteSeqRef.current += 1;
    setQuoteLoading(false);
    setQuoteResult(null);
    setQuoteError('');
    setter(value);
  }, []);

  const loadMarkets = useCallback(async () => {
    const requestId = ++reqSeqRef.current;
    setSnapshot((prev) => ({
      loading: true,
      data: prev.data,
      onChain: prev.onChain,
      assets: prev.assets,
      discrepancies: prev.discrepancies,
    }));
    const combined = await fetchMarketsAndLiveContracts({
      cfg: web3?.config,
      includeInactive: shouldIncludeInactive,
      requestId,
      includeLoans: false,
      includeAuctions: false,
    });
    if (requestId !== reqSeqRef.current) return;
    setSnapshot({
      loading: false,
      data: combined.market,
      onChain: combined.onChain,
      assets: combined.assets,
      discrepancies: combined.discrepancies,
    });
    if (combined.assets.length > 0) {
      const firstVerified =
        combined.assets.find((a) => a.onchain_verified !== false && !a.unavailable) ??
        combined.assets[0];
      setQuoteAsset((prev) => {
        if (prev && combined.assets.some((a) => a.token === prev)) return prev;
        return firstVerified.token;
      });
    }
  }, [shouldIncludeInactive, web3?.config]);

  async function copySignedOrderPayload(item) {
    if (!item?.signed_order || !item?.signature) return;
    const isLend = item.order_type === 'lend' || item.order_type === 'LendOffer';
    const payload = isLend
      ? { orderHash: item.order_hash, offer: item.signed_order, signature: item.signature }
      : { orderHash: item.order_hash, order: item.signed_order, signature: item.signature };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopiedOrderHash(item.order_hash);
    } catch {
      setCopiedOrderHash('');
    }
  }

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  const data = snapshot.data;
  const onChain = snapshot.onChain;
  const assets = snapshot.assets ?? [];
  const discrepancies = snapshot.discrepancies ?? [];

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
    () =>
      assets.find((a) => a.token === quoteAsset) ??
      assets.find((a) => a.onchain_verified !== false && !a.unavailable) ??
      assets[0] ??
      null,
    [assets, quoteAsset]
  );

  const selectedOriginationStatus = useMemo(
    () => evaluateAssetOriginationStatus(selectedAssetObj, onChain?.protocol ?? null),
    [onChain?.protocol, selectedAssetObj]
  );

  async function runQuoteSimulation(event) {
    event.preventDefault();
    setQuoteError('');
    setQuoteResult(null);

    if (!selectedAssetObj) {
      setQuoteError('No registered assets available to quote.');
      return;
    }
    if (selectedAssetObj.unavailable || selectedAssetObj.source === 'api_only') {
      setQuoteError(
        selectedAssetObj.unavailable
          ? 'Selected asset contract read is unavailable on Base RPC.'
          : 'Selected asset is not verified on-chain in AssetRegistry.'
      );
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
      lede="Live Base Mainnet order book activity, direct AssetRegistry & OracleRouter collateral readings from Base RPC, and on-chain loan quotes — select any open BorrowOrder or LendOffer below to fill on /lend or /borrow."
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
        <Link className="btn secondary" to="/borrow">Open BorrowOrder</Link>
        <Link className="btn secondary" to="/lend">Post LendOffer / Fill Borrow</Link>
        {onChain?.ok || data?.health ? (
          <span className="hint">
            {onChain?.ok
              ? `Base RPC #${onChain.blockNumber} · ${
                  onChain.protocol?.paused ? 'LoanCore PAUSED (blocks new loans only)' : 'LoanCore active'
                } · ${
                  onChain.protocol?.marketOpen === null || onChain.protocol?.marketOpen === undefined
                    ? 'Market unavailable'
                    : onChain.protocol.marketOpen
                      ? 'Market open'
                      : 'Market closed'
                }`
              : ''}
            {onChain?.ok && data?.health ? ' · ' : ''}
            {data?.health
              ? `Indexed #${data.health.last_indexed_block ?? '—'} (lag ${data.health.lag_blocks ?? '—'}) · Updated ${data.fetchedAt}`
              : ''}
          </span>
        ) : null}
      </div>

      {snapshot.loading && !data && !onChain ? (
        <p className="hint block">Loading live asset parameters and indexed order activity from Base contracts &amp; api/…</p>
      ) : null}

      {onChain && !onChain.ok ? (
        <p className="err block" role="alert">
          Direct Base RPC contract read unavailable — {onChain.error}
        </p>
      ) : null}

      {data && (data.stale || data.degraded || data.error) ? (
        <p className={onChain?.ok && assets.length > 0 ? 'hint block' : 'err block'} role="alert">
          {onChain?.ok && assets.length > 0
            ? `api/ orderbook feed degraded or unreachable (${data.error || 'Indexer unavailable'}) — displaying live AssetRegistry & OracleRouter contract readings from Base RPC; orderbook & quote queries require api/.`
            : `Live market state degraded or unavailable — ${data.error || 'Indexer or RPC health check failed.'} No preview or cached fallback prices are displayed.`}
        </p>
      ) : null}

      {discrepancies.length > 0 ? (
        <p className="err block" role="alert">
          Contract vs api/ mismatch detected (Base RPC values shown): {discrepancies.join(' · ')}
        </p>
      ) : null}

      {onChain?.protocol?.paused ? (
        <p className="err block" role="alert">
          LoanCore is paused on-chain (blocks new loans only; repay, top-up, extensions &amp; auctions remain active).
        </p>
      ) : null}

      {data?.ordersTruncated ? (
        <div className="note block" role="status">
          <strong>Public orderbook display truncated (&gt;1,000 rows).</strong>{' '}
          Filter by collateral or open a specific order by hash via /lend or /borrow.
        </div>
      ) : null}

      <section className="block">
        <h2>Registered collateral assets (AssetRegistry &amp; OracleRouter)</h2>
        <p className="hint">
          Live risk parameters and validity states read directly from Base contracts alongside api/ GET /assets (
          {onChain?.ok
            ? `Base RPC block #${onChain.blockNumber}`
            : `api/ block #${data?.health?.live_block_number ?? data?.health?.block_number ?? '—'}`}
          ).
        </p>
        {assets.length === 0 ? (
          <p className="lede">
            {onChain?.error && data?.error
              ? 'Assets unavailable while both Base RPC and api/ are unreachable.'
              : 'No registered collateral assets discovered on-chain or indexed yet.'}
          </p>
        ) : (
          assets.map((item) => {
            const isApiOnly = item.source === 'api_only';
            const isUnavailable = Boolean(item.unavailable);
            return (
              <article className="order-row" key={item.token}>
                <div>
                  <strong>
                    {item.symbol || shortAddress(item.token)} · {item.status_name || 'unavailable'}
                  </strong>
                  {isUnavailable ? (
                    <span className="quiet">
                      {item.token} · Live Base contract read unavailable ({item.error || 'RPC error'}) — state not shown as valid.
                    </span>
                  ) : isApiOnly ? (
                    <span className="quiet">
                      {item.token} · api/ entry is not verified on-chain (Base AssetRegistry/OracleRouter did not confirm this asset).
                    </span>
                  ) : (
                    <>
                      <span className="quiet">
                        {item.token} ({item.decimals ?? '—'} dec) · {item.tier_name ?? `Tier ${item.tier ?? '—'}`} · Oracle{' '}
                        {item.oracle?.state_name ?? 'unavailable'}
                        {item.multiplier?.ui
                          ? ` · uiMult drift ${
                              item.multiplier.drift_bps !== null && item.multiplier.drift_bps !== undefined
                                ? `${item.multiplier.drift_bps} bps`
                                : 'unrecorded'
                            }`
                          : ''}
                      </span>
                      <span className="quiet">
                        Init {item.ltv ? formatBpsPercent(item.ltv.max_init_ltv_bps) : 'unavailable'} · Margin{' '}
                        {item.ltv ? formatBpsPercent(item.ltv.margin_call_ltv_bps) : 'unavailable'} · Liq{' '}
                        {item.ltv ? formatBpsPercent(item.ltv.liq_ltv_bps) : 'unavailable'} · Haircut{' '}
                        {item.ltv ? formatBpsPercent(item.ltv.closed_market_haircut_bps) : 'unavailable'} · Cap remaining{' '}
                        {item.caps?.asset_remaining
                          ? formatApiAmount(item.caps.asset_remaining, { prefixUsd: true })
                          : 'unavailable'}
                      </span>
                      {item.oracle ? (
                        <span className="quiet">
                          1 {item.symbol || 'token'} value: gross{' '}
                          {item.oracle.gross_unit_value_usdc
                            ? formatApiAmount(item.oracle.gross_unit_value_usdc, { prefixUsd: true })
                            : 'unavailable'}{' '}
                          / effective{' '}
                          {item.oracle.effective_unit_value_usdc
                            ? formatApiAmount(item.oracle.effective_unit_value_usdc, { prefixUsd: true })
                            : 'unavailable'}{' '}
                          · Feed age {item.oracle.feed_age_seconds ?? 'unavailable'}s / open max{' '}
                          {item.oracle.max_stale_open_secs ?? 'unavailable'}s
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className="numline">
                    {formatAssetOraclePrice(item.oracle, { maxFractionDigits: 2 })}
                  </span>
                  <div style={{ marginTop: 6 }}>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={isUnavailable || isApiOnly}
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
            );
          })
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
          <button
            type="button"
            aria-pressed={showInactive}
            onClick={() => setShowInactive((v) => !v)}
          >
            {showInactive ? 'Showing inactive/unfunded' : 'Include inactive/unfunded'}
          </button>
        </div>
      </div>

      {(() => {
        const renderOrderBookSection = (title, hint, rows, emptyText, isLend) => (
          <section className="block">
            <h2>{title}</h2>
            <p className="hint">{hint}</p>
            {rows.length === 0 ? (
              <p className="lede">{emptyText}</p>
            ) : (
              rows.map((item) => {
                const isFillable =
                  (item.status === 'open' || item.status === 'partially_filled') &&
                  Boolean(item.signed_order) &&
                  Boolean(item.signature);
                const allowedAddr = isLend ? item.signed_order?.allowedCollateral : item.collateral_token;
                const fillHref = isLend
                  ? `/borrow?lendOffer=${encodeURIComponent(item.order_hash)}${allowedAddr && allowedAddr !== '0x0000000000000000000000000000000000000000' ? `&asset=${encodeURIComponent(allowedAddr)}` : ''}`
                  : `/lend?borrowOrder=${encodeURIComponent(item.order_hash)}`;
                return (
                  <article className="order-row" key={item.order_hash}>
                    <div>
                      <strong>
                        {item.collateral_symbol || (item.collateral_token ? shortAddress(item.collateral_token) : isLend ? 'Multi-asset' : 'Asset')} · {item.status}
                      </strong>
                      <span className="quiet">
                        Maker {shortAddress(item.maker)} · Order {item.order_hash.slice(0, 14)}… · Fills {item.fills_count} · Block #{item.last_updated_block}
                      </span>
                      <span className="quiet">
                        Filled {formatApiAmount(item.filled_usdc, { prefixUsd: true })} of{' '}
                        {formatApiAmount(item.min_usdc, { prefixUsd: true })}
                        {item.remaining_usdc ? ` · ${formatApiAmount(item.remaining_usdc, { prefixUsd: true })} remaining` : ''}
                      </span>
                      {Array.isArray(item.fills) && item.fills.length > 0 ? (
                        <span className="quiet">
                          Loans:{' '}
                          {item.fills.map((f, fIdx) => (
                            <span key={`${f.loan_id}-${fIdx}`}>
                              {fIdx > 0 ? ', ' : ''}
                              <Link to={`/loans/${f.loan_id}`}>#{f.loan_id}</Link>
                            </span>
                          ))}
                        </span>
                      ) : null}
                      {isFillable || (item.signed_order && item.signature) ? (
                        <div className="actions" style={{ marginTop: 8 }}>
                          {isFillable ? (
                            <Link className="btn secondary" to={fillHref}>
                              {isLend ? 'Fill on /borrow' : 'Fill on /lend'}
                            </Link>
                          ) : null}
                          {item.signed_order && item.signature ? (
                            <button
                              className="btn secondary"
                              type="button"
                              onClick={() => void copySignedOrderPayload(item)}
                            >
                              {copiedOrderHash === item.order_hash ? 'Copied JSON' : 'Copy JSON'}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <span className="numline">
                      {formatApiAmount(item.remaining_usdc ?? item.min_usdc, { prefixUsd: true, showSymbol: true })}
                    </span>
                  </article>
                );
              })
            )}
          </section>
        );
        return (
          <>
            {renderOrderBookSection(
              'Borrow orders',
              'Live signed BorrowOrders and historical OrderSettlement fills (select an open order to fill on /lend).',
              borrows,
              'No borrow orders match the current filter.',
              false
            )}
            {renderOrderBookSection(
              'Lend offers',
              'Live signed LendOffers and historical OrderSettlement fills (select an open offer to fill on /borrow).',
              lends,
              'No lend offers match the current filter.',
              true
            )}
          </>
        );
      })()}

      <form className="block" onSubmit={runQuoteSimulation}>
        <Sheet
          title="Live on-chain loan quote calculator (GET /quote)"
          note="Displays live AssetRegistry & OracleRouter readiness directly from Base RPC alongside LoanCore/OrderSettlement simulation via api/ /quote. Read-only simulation; does not submit transactions."
        >
          {selectedAssetObj ? (
            <p
              className={
                selectedOriginationStatus.severity === 'err'
                  ? 'err'
                  : 'hint'
              }
              role={selectedOriginationStatus.severity === 'err' ? 'alert' : undefined}
            >
              Live Base contract status ({selectedAssetObj.symbol || shortAddress(selectedAssetObj.token)}):{' '}
              {selectedOriginationStatus.message}
            </p>
          ) : null}

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
                      {a.symbol || shortAddress(a.token)} ({a.oracle?.state_name ?? 'unavailable'})
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
                disabled={
                  quoteLoading ||
                  assets.length === 0 ||
                  Boolean(selectedAssetObj?.unavailable) ||
                  selectedAssetObj?.source === 'api_only'
                }
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
              {onChain?.ok &&
              selectedAssetObj?.onchain_verified &&
              selectedAssetObj.oracle?.state !== null &&
              selectedAssetObj.oracle?.state !== undefined &&
              Number(quoteResult.asset?.oracle_state) !== Number(selectedAssetObj.oracle.state) ? (
                <p className="err" role="alert">
                  Base OracleRouter state changed vs /quote reply: chain reports{' '}
                  {selectedAssetObj.oracle.state_name} while /quote reported{' '}
                  {quoteResult.asset.oracle_state_name}.
                </p>
              ) : null}
              {quoteResult.warnings?.length > 0 ? (
                <p className="hint">
                  Warnings: {quoteResult.warnings.map((w) => `${w.code}: ${w.message}`).join('; ')}
                </p>
              ) : null}
              <Rows
                items={[
                  {
                    label: 'Asset & oracle',
                    value: `${quoteResult.asset.symbol} · ${formatAssetOraclePrice({
                      price: quoteResult.asset.oracle_price,
                      state: quoteResult.asset.oracle_state,
                      state_name: quoteResult.asset.oracle_state_name,
                    })} (${quoteResult.asset.oracle_state_name})`,
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
