import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Choice, Field, Page, Rows, Sheet, TextInput } from '../components/ui.jsx';
import { USDC_DECIMALS } from '../lib/contracts.js';
import {
  fetchLoanQuote,
  fetchMarketSnapshot,
  formatApiAmount,
  formatBpsPercent,
  parseDecimalToRaw,
  parsePercentToBps,
} from '../lib/marketsApi.js';
import {
  approveCollateralForBorrow,
  cancelSignedBorrowOrder,
  fillLendOfferAsBorrower,
  formatWeb3Error,
  prepareAndSignBorrowOrder,
  readBorrowAllowanceAndNonce,
  resolveExactBorrowAmounts,
  shortAddress,
} from '../lib/web3.js';
import { useStore } from '../store.jsx';

export function Borrow() {
  const { web3 } = useStore();
  const [marketState, setMarketState] = useState({ loading: true, data: null });
  const reqSeqRef = useRef(0);

  const [selectedAsset, setSelectedAsset] = useState('');
  const [principalStr, setPrincipalStr] = useState('1000');
  const [collateralStr, setCollateralStr] = useState('');
  const [ratePct, setRatePct] = useState('8.00');
  const [termDaysStr, setTermDaysStr] = useState('30');
  const [maxLtvPct, setMaxLtvPct] = useState('60.00');
  const [minFillStr, setMinFillStr] = useState('500');
  const [expiryDaysStr, setExpiryDaysStr] = useState('2');
  const [inKind, setInKind] = useState(false);
  const [yieldOn, setYieldOn] = useState(false);
  const [eligibleConfirmed, setEligibleConfirmed] = useState(false);

  const [tokenMeta, setTokenMeta] = useState({ loading: false, data: null, error: '' });
  const tokenMetaSeqRef = useRef(0);

  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteResult, setQuoteResult] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const quoteSeqRef = useRef(0);

  const [txBusy, setTxBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [signedOrder, setSignedOrder] = useState(null);
  const [copiedPayload, setCopiedPayload] = useState(false);

  // Secondary borrower flow: fill a signed LendOffer JSON payload
  const [lendOfferJsonStr, setLendOfferJsonStr] = useState('');
  const [lendFillUsdcStr, setLendFillUsdcStr] = useState('500');
  const [lendFillBusy, setLendFillBusy] = useState(false);
  const [lendFillResult, setLendFillResult] = useState(null);
  const [lendFillError, setLendFillError] = useState('');

  const loadMarkets = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setMarketState((prev) => ({ loading: true, data: prev.data }));
    const next = await fetchMarketSnapshot({
      cfg: web3?.config,
      requestId: seq,
      includeLoans: false,
      includeAuctions: false,
    });
    if (seq !== reqSeqRef.current) return;
    setMarketState({ loading: false, data: next });
    if (next.assets.length > 0) {
      setSelectedAsset((prev) => {
        if (prev && next.assets.some((a) => a.token === prev)) return prev;
        return next.assets[0].token;
      });
    }
  }, [web3?.config]);

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  const assets = marketState.data?.assets ?? [];
  const assetObj = useMemo(
    () => assets.find((a) => a.token === selectedAsset) ?? assets[0] ?? null,
    [assets, selectedAsset]
  );

  const loadAllowanceAndNonce = useCallback(async () => {
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address || !assetObj?.token) {
      setTokenMeta({ loading: false, data: null, error: '' });
      return null;
    }
    const seq = ++tokenMetaSeqRef.current;
    setTokenMeta((prev) => ({ loading: true, data: prev.data, error: '' }));
    try {
      const res = await readBorrowAllowanceAndNonce(web3.address, assetObj.token, {
        cfg: web3.config,
      });
      if (seq !== tokenMetaSeqRef.current) return null;
      setTokenMeta({ loading: false, data: res, error: '' });
      return res;
    } catch (err) {
      if (seq !== tokenMetaSeqRef.current) return null;
      setTokenMeta({ loading: false, data: null, error: formatWeb3Error(err) });
      return null;
    }
  }, [assetObj?.token, web3?.address, web3?.config, web3?.connected, web3?.wrongNetwork]);

  useEffect(() => {
    void loadAllowanceAndNonce();
  }, [loadAllowanceAndNonce]);

  const updateField = useCallback((setter) => (value) => {
    quoteSeqRef.current += 1;
    setQuoteLoading(false);
    setQuoteResult(null);
    setQuoteError('');
    setSignedOrder(null);
    setActionError('');
    setActionNotice('');
    setCopiedPayload(false);
    setter(value);
  }, []);

  const parseValidatedInputs = useCallback(() => {
    if (!assetObj) {
      return { error: 'No registered collateral assets loaded from api/.' };
    }
    const tokenDecimals = Number(assetObj.decimals ?? 18);
    const principalRaw = principalStr.trim() ? parseDecimalToRaw(principalStr, USDC_DECIMALS) : null;
    if (principalStr.trim() && !principalRaw) {
      return { error: 'Enter a positive USDC principal with up to 6 decimals.' };
    }
    const collateralRaw = collateralStr.trim()
      ? parseDecimalToRaw(collateralStr, tokenDecimals)
      : null;
    if (collateralStr.trim() && !collateralRaw) {
      return { error: `Enter a positive ${assetObj.symbol ?? 'token'} amount with up to ${tokenDecimals} decimals.` };
    }
    if (!principalRaw && !collateralRaw) {
      return { error: 'Enter either a USDC principal amount or a collateral token amount.' };
    }
    const aprBps = parsePercentToBps(ratePct);
    if (aprBps === null || aprBps > 4000) {
      return { error: 'Maximum APR must be between 0.00% and 40.00%.' };
    }
    const termDays = Number(termDaysStr.trim());
    if (!Number.isInteger(termDays) || termDays < 7 || termDays > 90) {
      return { error: 'Term days must be an integer between 7 and 90.' };
    }
    const maxLtvBps = parsePercentToBps(maxLtvPct);
    if (maxLtvBps === null || maxLtvBps < 100 || maxLtvBps > 10_000) {
      return { error: 'Maximum LTV must be between 1.00% and 100.00%.' };
    }
    const minFillRaw = parseDecimalToRaw(minFillStr, USDC_DECIMALS);
    if (!minFillRaw || BigInt(minFillRaw) < 500_000_000n) {
      return { error: 'Minimum fill must be at least $500.00 USDC (up to 6 decimals).' };
    }
    if (principalRaw && BigInt(principalRaw) < 500_000_000n) {
      return { error: 'Principal must be at least $500.00 USDC.' };
    }
    if (principalRaw && BigInt(minFillRaw) > BigInt(principalRaw)) {
      return { error: 'Minimum fill cannot exceed principal.' };
    }
    const expiryDays = Number(expiryDaysStr.trim());
    if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 30) {
      return { error: 'Order expiry must be an integer between 1 and 30 days.' };
    }
    return {
      error: '',
      tokenDecimals,
      principalRaw,
      collateralRaw,
      aprBps,
      termDays,
      maxLtvBps,
      minFillRaw,
      expiryDays,
    };
  }, [assetObj, collateralStr, expiryDaysStr, maxLtvPct, minFillStr, principalStr, ratePct, termDaysStr]);

  const handleQuote = useCallback(async (event) => {
    if (event) event.preventDefault();
    setQuoteError('');
    setActionError('');
    setActionNotice('');
    setQuoteResult(null);

    const parsed = parseValidatedInputs();
    if (parsed.error) {
      setQuoteError(parsed.error);
      return null;
    }

    const qSeq = ++quoteSeqRef.current;
    setQuoteLoading(true);
    try {
      const res = await fetchLoanQuote({
        cfg: web3?.config,
        asset: assetObj.token,
        principalRaw: parsed.principalRaw,
        collateralAmountRaw: parsed.collateralRaw,
        termDays: parsed.termDays,
        aprBps: parsed.aprBps,
        maxLtvBps: parsed.maxLtvBps,
        borrower: web3?.connected ? web3.address : undefined,
        borrowerAttestation: web3?.connected ? web3.attestationHex : undefined,
      });
      if (qSeq !== quoteSeqRef.current) return null;
      setQuoteResult(res);
      return res;
    } catch (err) {
      if (qSeq !== quoteSeqRef.current) return null;
      setQuoteError(formatWeb3Error(err));
      return null;
    } finally {
      if (qSeq === quoteSeqRef.current) {
        setQuoteLoading(false);
      }
    }
  }, [assetObj?.token, parseValidatedInputs, web3?.address, web3?.attestationHex, web3?.config, web3?.connected]);

  const exactQuoteAmounts = useMemo(() => {
    if (!quoteResult) return null;
    try {
      const userCol =
        collateralStr.trim() && assetObj
          ? parseDecimalToRaw(collateralStr, Number(assetObj.decimals ?? 18))
          : null;
      return resolveExactBorrowAmounts(quoteResult, { userCollateralRaw: userCol });
    } catch {
      return null;
    }
  }, [assetObj, collateralStr, quoteResult]);

  const allowanceRawBig = tokenMeta.data ? BigInt(tokenMeta.data.allowanceRaw) : 0n;
  const balanceRawBig = tokenMeta.data ? BigInt(tokenMeta.data.balanceRaw) : 0n;
  const needsApproval = Boolean(
    exactQuoteAmounts && allowanceRawBig < exactQuoteAmounts.collateralAmountRaw
  );
  const insufficientBalance = Boolean(
    exactQuoteAmounts && tokenMeta.data && balanceRawBig < exactQuoteAmounts.collateralAmountRaw
  );

  async function handleApproveCollateral() {
    setActionError('');
    setActionNotice('');
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setActionError('Connect your wallet on Base before approving collateral.');
      return;
    }
    const parsed = parseValidatedInputs();
    if (parsed.error) {
      setActionError(parsed.error);
      return;
    }
    setTxBusy('approve');
    try {
      let activeQuote = quoteResult;
      if (!activeQuote) {
        activeQuote = await handleQuote();
      }
      if (!activeQuote || !activeQuote.accepted) {
        throw new Error('Obtain an accepted live quote before approving collateral.');
      }
      const exact = resolveExactBorrowAmounts(activeQuote, { userCollateralRaw: parsed.collateralRaw });
      const res = await approveCollateralForBorrow({
        address: web3.address,
        collateralToken: assetObj.token,
        requiredCollateralRaw: exact.collateralAmountRaw,
        cfg: web3.config,
      });
      await loadAllowanceAndNonce();
      setActionNotice(
        res.alreadyApproved
          ? `CollateralEscrow already approved for ${res.allowanceRaw} raw units.`
          : `Approved CollateralEscrow for ${exact.collateralAmountRaw.toString()} raw ${assetObj.symbol} units (tx ${res.txHash}).`
      );
    } catch (err) {
      setActionError(formatWeb3Error(err));
    } finally {
      setTxBusy('');
    }
  }

  async function handleSignBorrowOrder(event) {
    event.preventDefault();
    setActionError('');
    setActionNotice('');
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setActionError('Connect your wallet on Base before signing a BorrowOrder.');
      return;
    }
    if (!eligibleConfirmed) {
      setActionError('Confirm eligibility before signing an EIP-712 BorrowOrder.');
      return;
    }
    const parsed = parseValidatedInputs();
    if (parsed.error) {
      setActionError(parsed.error);
      return;
    }
    setTxBusy('sign');
    try {
      const signed = await prepareAndSignBorrowOrder({
        address: web3.address,
        collateralToken: assetObj.token,
        principalRaw: parsed.principalRaw,
        collateralAmountRaw: parsed.collateralRaw,
        maxRateBps: parsed.aprBps,
        termDays: parsed.termDays,
        maxLtvBps: parsed.maxLtvBps,
        minFillRaw: parsed.minFillRaw,
        expiryDays: parsed.expiryDays,
        yieldMode: yieldOn ? 1 : 0,
        allowInKindSettlement: inKind,
        attestationHex: web3.attestationHex,
        autoApprove: true,
        cfg: web3.config,
      });
      setQuoteResult(signed.quote);
      setSignedOrder(signed);
      await loadAllowanceAndNonce();
      setActionNotice(
        `Signed EIP-712 BorrowOrder ${signed.orderHash}. Collateral required: ${signed.exactAmounts.collateralAmountRaw} raw ${assetObj.symbol} units.`
      );
    } catch (err) {
      setActionError(formatWeb3Error(err));
    } finally {
      setTxBusy('');
    }
  }

  async function handleCancelSignedOrder() {
    if (!signedOrder || !web3?.address) return;
    setActionError('');
    setActionNotice('');
    setTxBusy('cancel');
    try {
      const res = await cancelSignedBorrowOrder({
        address: web3.address,
        order: signedOrder.order,
        cfg: web3.config,
      });
      setSignedOrder((prev) => (prev ? { ...prev, cancelledTxHash: res.txHash } : null));
      setActionNotice(`Cancelled order ${res.orderHash} on-chain (tx ${res.txHash}).`);
    } catch (err) {
      setActionError(formatWeb3Error(err));
    } finally {
      setTxBusy('');
    }
  }

  async function copySignedOrder() {
    if (!signedOrder) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            order: signedOrder.orderJson,
            signature: signedOrder.signature,
            orderHash: signedOrder.orderHash,
          },
          null,
          2
        )
      );
      setCopiedPayload(true);
    } catch {
      setCopiedPayload(false);
    }
  }

  async function handleFillLendOffer(event) {
    event.preventDefault();
    setLendFillError('');
    setLendFillResult(null);
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setLendFillError('Connect your wallet on Base before filling a lend offer.');
      return;
    }
    if (!assetObj?.token) {
      setLendFillError('Select a collateral token above first.');
      return;
    }
    const fillUsdcRaw = parseDecimalToRaw(lendFillUsdcStr, USDC_DECIMALS);
    if (!fillUsdcRaw) {
      setLendFillError('Enter a valid positive USDC fill amount (up to 6 decimals).');
      return;
    }
    let parsedJson;
    try {
      parsedJson = JSON.parse(lendOfferJsonStr);
    } catch {
      setLendFillError('Paste valid JSON containing { "offer": { ... }, "signature": "0x..." }.');
      return;
    }
    const offer = parsedJson?.offer ?? parsedJson;
    const signature = parsedJson?.signature;
    if (!offer || !signature || typeof signature !== 'string') {
      setLendFillError('Lend offer JSON must include both "offer" fields and "signature".');
      return;
    }
    setLendFillBusy(true);
    try {
      const res = await fillLendOfferAsBorrower({
        address: web3.address,
        offer,
        signature,
        collateralToken: assetObj.token,
        fillUsdcRaw,
        borrowerAttestation: web3.attestationHex,
        autoApprove: true,
        cfg: web3.config,
      });
      setLendFillResult(res);
      await loadAllowanceAndNonce();
      await web3.refresh();
    } catch (err) {
      setLendFillError(formatWeb3Error(err));
    } finally {
      setLendFillBusy(false);
    }
  }

  return (
    <Page
      kicker="Borrow · WS3.3"
      title="Quote, approve & sign a BorrowOrder."
      lede="Quotes come directly from api/ GET /quote using live Base AssetRegistry, OracleRouter, FeeCollector, and EligibilityGate reads. Approvals and EIP-712 order signatures always use exact/rounded-up raw token integers."
    >
      {marketState.data && (marketState.data.stale || marketState.data.degraded || marketState.data.error) ? (
        <p className="err block" role="alert">
          Live market telemetry degraded or unavailable — {marketState.data.error}
        </p>
      ) : null}

      {!web3?.connected ? (
        <div className="note block">
          <p className="hint">Connect a Base wallet to read your B20 balance, CollateralEscrow allowance, and OrderSettlement maker nonce.</p>
          <div className="actions">
            <button className="btn" type="button" onClick={() => void web3?.connect()} disabled={web3?.connecting}>
              {web3?.connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          </div>
        </div>
      ) : web3.wrongNetwork ? (
        <div className="note block">
          <p className="err">Wrong network ({web3.chainId}). Switch to Base ({web3.config.chainId}) to approve and sign.</p>
          <div className="actions">
            <button className="btn" type="button" onClick={() => void web3.switchNetwork()}>
              Switch to Base ({web3.config.chainId})
            </button>
          </div>
        </div>
      ) : null}

      <form className="form-layout" onSubmit={handleSignBorrowOrder}>
        <div className="fields">
          <div className="field">
            <label htmlFor="borrow-asset">Stock collateral (GET /assets)</label>
            <select
              id="borrow-asset"
              value={assetObj?.token ?? ''}
              onChange={(e) => updateField(setSelectedAsset)(e.target.value)}
            >
              {assets.length === 0 ? (
                <option value="">No registered assets loaded</option>
              ) : (
                assets.map((a) => (
                  <option key={a.token} value={a.token}>
                    {a.symbol || shortAddress(a.token)} · {a.status_name} · {a.oracle?.state_name}
                  </option>
                ))
              )}
            </select>
            {assetObj ? (
              <p className="hint">
                {assetObj.token} ({assetObj.decimals} dec) · Max init LTV {formatBpsPercent(assetObj.ltv?.max_init_ltv_bps)} · Cap remaining{' '}
                {formatApiAmount(assetObj.caps?.asset_remaining, { prefixUsd: true })}
              </p>
            ) : null}
          </div>

          <Field
            id="borrow-usdc"
            label="Principal to borrow (USDC, up to 6 decimals)"
            hint="Minimum $500. Leave empty if quoting from collateral units."
          >
            {(props) => (
              <TextInput
                id="borrow-usdc"
                value={principalStr}
                onChange={updateField(setPrincipalStr)}
                {...props}
              />
            )}
          </Field>

          <Field
            id="borrow-collateral"
            label={`Optional collateral override (${assetObj?.symbol ?? 'tokens'}, up to ${assetObj?.decimals ?? 18} decimals)`}
            hint="Leave empty so GET /quote computes exact rounded-up raw units required."
          >
            {(props) => (
              <TextInput
                id="borrow-collateral"
                value={collateralStr}
                onChange={updateField(setCollateralStr)}
                {...props}
              />
            )}
          </Field>

          <div className="split">
            <Field id="borrow-rate" label="Maximum APR (%)" hint="0.00% to 40.00%.">
              {(props) => (
                <TextInput
                  id="borrow-rate"
                  value={ratePct}
                  onChange={updateField(setRatePct)}
                  {...props}
                />
              )}
            </Field>
            <Field id="borrow-term" label="Term (days)" hint="7 to 90 days.">
              {(props) => (
                <TextInput
                  id="borrow-term"
                  inputMode="numeric"
                  value={termDaysStr}
                  onChange={updateField(setTermDaysStr)}
                  {...props}
                />
              )}
            </Field>
          </div>

          <div className="split">
            <Field id="borrow-ltv" label="Maximum LTV (%)" hint="Asset cap ceiling enforced on-chain.">
              {(props) => (
                <TextInput
                  id="borrow-ltv"
                  value={maxLtvPct}
                  onChange={updateField(setMaxLtvPct)}
                  {...props}
                />
              )}
            </Field>
            <Field id="borrow-min-fill" label="Minimum fill (USDC)" hint="At least $500.">
              {(props) => (
                <TextInput
                  id="borrow-min-fill"
                  value={minFillStr}
                  onChange={updateField(setMinFillStr)}
                  {...props}
                />
              )}
            </Field>
          </div>

          <Field id="borrow-expiry" label="Order expiry (days)" hint="1 to 30 days from current block timestamp.">
            {(props) => (
              <TextInput
                id="borrow-expiry"
                inputMode="numeric"
                value={expiryDaysStr}
                onChange={updateField(setExpiryDaysStr)}
                {...props}
              />
            )}
          </Field>

          <fieldset>
            <legend>Yield mode</legend>
            <label className="choice">
              <input type="radio" name="borrow-yield" checked={!yieldOn} onChange={() => updateField(setYieldOn)(false)} />
              <span>0 — Off (collateral remains idle in CollateralEscrow).</span>
            </label>
            <label className="choice">
              <input type="radio" name="borrow-yield" checked={yieldOn} onChange={() => updateField(setYieldOn)(true)} />
              <span>1 — Lender yield mode (requires counterparty match).</span>
            </label>
          </fieldset>

          <Choice id="borrow-inkind" checked={inKind} onChange={updateField(setInKind)}>
            Allow in-kind settlement on default (borrower &amp; lender must both allow).
          </Choice>

          <Choice id="borrow-eligible" checked={eligibleConfirmed} onChange={setEligibleConfirmed}>
            I confirm my connected Base address satisfies EligibilityGate requirements.
          </Choice>

          {quoteError ? <p className="err" role="alert">{quoteError}</p> : null}
          {actionError ? <p className="err" role="alert">{actionError}</p> : null}
          {actionNotice ? <p className="note" role="status">{actionNotice}</p> : null}

          <div className="actions">
            <button
              className="btn secondary"
              type="button"
              onClick={() => void handleQuote()}
              disabled={quoteLoading || !assetObj || Boolean(txBusy)}
            >
              {quoteLoading ? '1. Quoting…' : '1. Simulate live quote'}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => void handleApproveCollateral()}
              disabled={!web3?.connected || web3?.wrongNetwork || Boolean(txBusy) || !assetObj}
            >
              {txBusy === 'approve'
                ? '2. Approving…'
                : needsApproval
                  ? '2. Approve exact B20 to CollateralEscrow'
                  : '2. Approve / verify allowance'}
            </button>
            <button
              className="btn"
              type="submit"
              disabled={!web3?.connected || web3?.wrongNetwork || Boolean(txBusy) || !assetObj}
            >
              {txBusy === 'sign' ? '3. Signing EIP-712 order…' : '3. Sign EIP-712 BorrowOrder'}
            </button>
          </div>
        </div>

        <Sheet
          sticky
          title="On-chain quote & wallet readiness"
          note="Approval and EIP-712 BorrowOrder use exact raw integers from quote.amounts.*.raw, never rounded display strings."
        >
          {tokenMeta.error ? <p className="err">{tokenMeta.error}</p> : null}
          <Rows
            items={[
              {
                label: 'OrderSettlement',
                value: web3?.config?.contracts?.orderSettlement ?? 'Unset',
              },
              {
                label: 'CollateralEscrow',
                value: web3?.config?.contracts?.collateralEscrow ?? 'Unset',
              },
              tokenMeta.data
                ? {
                    label: `${tokenMeta.data.symbol} balance (${tokenMeta.data.decimals} dec)`,
                    value: `${tokenMeta.data.balanceFormatted} (${tokenMeta.data.balanceRaw} raw)`,
                  }
                : null,
              tokenMeta.data
                ? {
                    label: 'CollateralEscrow allowance',
                    value: `${tokenMeta.data.allowanceFormatted} (${tokenMeta.data.allowanceRaw} raw)`,
                  }
                : null,
              tokenMeta.data
                ? { label: 'OrderSettlement maker nonce', value: tokenMeta.data.makerNonce }
                : null,
              quoteResult
                ? {
                    label: `Quote status (block #${quoteResult.block_number})`,
                    value: quoteResult.accepted
                      ? 'Accepted'
                      : `Rejected: ${quoteResult.rejection_reasons.map((r) => r.code).join(', ')}`,
                  }
                : null,
              exactQuoteAmounts
                ? {
                    label: 'Exact principal raw (6 dec)',
                    value: `${formatApiAmount(quoteResult.amounts.principal, { prefixUsd: true })} (${exactQuoteAmounts.principalRaw.toString()} raw)`,
                  }
                : null,
              exactQuoteAmounts
                ? {
                    label: `Exact collateral raw (${quoteResult.asset.decimals} dec)`,
                    value: `${formatApiAmount(quoteResult.amounts.collateral_required, { maxFractionDigits: 6, showSymbol: true })} (${exactQuoteAmounts.collateralAmountRaw.toString()} raw)`,
                  }
                : null,
              exactQuoteAmounts
                ? {
                    label: 'Origination fee / net proceeds',
                    value: `${formatApiAmount(quoteResult.amounts.origination_fee, { prefixUsd: true })} / ${formatApiAmount(quoteResult.amounts.net_proceeds, { prefixUsd: true })}`,
                  }
                : null,
              exactQuoteAmounts
                ? {
                    label: 'Repayment at maturity',
                    value: `${formatApiAmount(quoteResult.amounts.total_repayment_at_maturity, { prefixUsd: true })} (${exactQuoteAmounts.totalRepaymentAtMaturityRaw.toString()} raw)`,
                  }
                : null,
            ]}
          />
          {insufficientBalance ? (
            <p className="err" style={{ marginTop: 12 }}>
              Wallet {assetObj?.symbol} balance ({tokenMeta.data.balanceRaw} raw) is below required {exactQuoteAmounts.collateralAmountRaw.toString()} raw.
            </p>
          ) : null}
          {quoteResult && !quoteResult.accepted ? (
            <p className="err" style={{ marginTop: 12 }}>
              {quoteResult.rejection_reasons.map((r) => `${r.code}: ${r.message}`).join('; ')}
            </p>
          ) : null}
        </Sheet>
      </form>

      {signedOrder ? (
        <section className="block">
          <h2>Signed EIP-712 BorrowOrder</h2>
          <p className="hint">
            Order hash: <code>{signedOrder.orderHash}</code>
            {signedOrder.approvalTxHash ? ` · Approval tx: ${signedOrder.approvalTxHash}` : ''}
            {signedOrder.cancelledTxHash ? ` · Cancelled tx: ${signedOrder.cancelledTxHash}` : ''}
          </p>
          <pre className="json">
            {JSON.stringify(
              {
                orderHash: signedOrder.orderHash,
                order: signedOrder.orderJson,
                signature: signedOrder.signature,
              },
              null,
              2
            )}
          </pre>
          <div className="actions">
            <button className="btn secondary" type="button" onClick={copySignedOrder}>
              {copiedPayload ? 'Copied payload JSON' : 'Copy signed order JSON'}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => void handleCancelSignedOrder()}
              disabled={Boolean(txBusy) || Boolean(signedOrder.cancelledTxHash)}
            >
              {txBusy === 'cancel'
                ? 'Cancelling on-chain…'
                : signedOrder.cancelledTxHash
                  ? 'Order cancelled on-chain'
                  : 'Cancel order on-chain'}
            </button>
            <Link className="btn secondary" to="/markets">
              View indexed book
            </Link>
          </div>
        </section>
      ) : null}

      <section className="block">
        <h2>Fill a signed LendOffer (as borrower)</h2>
        <p className="hint">
          Paste a lender&apos;s signed EIP-712 LendOffer JSON (`{`{ "offer": ..., "signature": "0x..." }`}`). Collateral units are quoted live via GET /quote and approved/submitted in exact raw integers.
        </p>
        <form className="fields" onSubmit={handleFillLendOffer}>
          <div className="field">
            <label htmlFor="lend-offer-json">Signed LendOffer JSON</label>
            <textarea
              id="lend-offer-json"
              rows={4}
              value={lendOfferJsonStr}
              onChange={(e) => setLendOfferJsonStr(e.target.value)}
              style={{
                width: '100%',
                padding: 12,
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--sheet)',
              }}
            />
          </div>
          <Field id="lend-fill-usdc" label="USDC to borrow from offer (up to 6 decimals)">
            {(props) => (
              <TextInput
                id="lend-fill-usdc"
                value={lendFillUsdcStr}
                onChange={setLendFillUsdcStr}
                {...props}
              />
            )}
          </Field>
          {lendFillError ? <p className="err" role="alert">{lendFillError}</p> : null}
          {lendFillResult ? (
            <p className="note" role="status">
              Opened Loan #{lendFillResult.loanId ?? '?'} (tx {lendFillResult.txHash}) · Escrowed{' '}
              {lendFillResult.collateralAmountRaw} raw units for {lendFillResult.fillUsdcRaw} raw USDC.
            </p>
          ) : null}
          <div className="actions">
            <button
              className="btn secondary"
              type="submit"
              disabled={lendFillBusy || !web3?.connected || web3?.wrongNetwork}
            >
              {lendFillBusy ? 'Approving & filling LendOffer…' : 'Approve & fill LendOffer on-chain'}
            </button>
          </div>
        </form>
      </section>
    </Page>
  );
}
