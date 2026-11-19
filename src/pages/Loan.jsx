import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ComplianceTxGateBanner,
  formatRegSDeclarationRowValue,
} from '../components/DeclarationPanel.jsx';
import { Field, Page, Rows, Sheet, TextInput, Choice } from '../components/ui.jsx';
import {
  OracleState,
  USDC_DECIMALS,
  getFrontendConfig,
} from '../lib/contracts.js';
import {
  formatBpsPercent,
  parseDecimalToRaw,
  parsePercentToBps,
} from '../lib/marketsApi.js';
import {
  LOAN_CORE_MAX_RATE_BPS,
  executeLoanExtend,
  executeLoanRepay,
  executeLoanTopUp,
  fetchPaginatedApiRows,
  formatTokenUnitsDisplay,
  formatWeb3Error,
  getInjectedProvider,
  parseExtendPayloadFromJson,
  readLoanOnChainState,
  shortAddress,
  signLoanExtension,
  verifyAndPreviewLoanExtend,
  verifyAndPreviewLoanRepay,
  verifyAndPreviewLoanTopUp,
} from '../lib/web3.js';
import { useStore } from '../store.jsx';

function formatUnixIso(secLike) {
  const n = Number(secLike);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function formatDurationDelta(targetSec, baseSec) {
  const diff = Number(targetSec) - Number(baseSec);
  if (!Number.isFinite(diff)) return '—';
  const abs = Math.abs(diff);
  const signLabel = diff >= 0 ? 'remaining' : 'overdue';
  if (abs < 60) return `${abs}s ${signLabel}`;
  if (abs < 3600) return `${Math.floor(abs / 60)}m ${signLabel}`;
  if (abs < 86400 * 2) return `${(abs / 3600).toFixed(1)}h ${signLabel}`;
  return `${(abs / 86400).toFixed(1)}d ${signLabel}`;
}

function loanNarrative(loanState) {
  if (!loanState) return 'Loading live LoanCore & PositionNFT state from Base…';
  if (loanState.storedStatus === 3) return 'Repaid in full. Locked collateral has been released to the borrower and PositionNFT burned.';
  if (loanState.storedStatus === 4) return 'Settled after default auction.';
  if (loanState.storedStatus === 5) return 'Settled via LTV liquidation auction.';
  if (loanState.isAuction || loanState.storedStatus === 2) {
    return `Dutch auction #${loanState.activeAuctionId} is active. PositionNFT transfer is locked; full repay() remains open and cancels the auction.`;
  }
  if (loanState.isOverdueDefaultPending) {
    return 'Overdue - default pending: 24h Grace window ended. Default auction may start when oracle is valid and market is open. Partial repay and extend are disabled; full repay and top-up remain open until auction starts.';
  }
  if (loanState.isGrace) {
    return `Grace period (within 24h after maturity). Penalty interest (+${formatBpsPercent(loanState.penaltySpreadBps)} spread) is accruing. Full repay and collateral top-up stay open; partial repay and extend are closed.`;
  }
  if (loanState.oracleState === OracleState.FROZEN_CORPORATE_ACTION) {
    return `${loanState.collateralSymbol} oracle is frozen for corporate action; liquidation clocks pause while repay and top-up remain open.`;
  }
  if (
    loanState.currentLtvWithInterestBps !== null &&
    loanState.currentLtvWithInterestBps >= loanState.marginCallLtvBps
  ) {
    return 'Margin call zone on oracle valuation. Add collateral via top-up or repay debt cleanly on LoanCore.';
  }
  return 'Active loan on Base LoanCore. Repay, partial-repay, collateral top-up, and bidirectional EIP-712 extend are available.';
}

export function Loan() {
  const { id } = useParams();
  const { web3 } = useStore();
  const cleanId = String(id ?? '').trim().replace(/^#/, '');
  const isValidLoanId = /^[1-9]\d*$/.test(cleanId);

  const loanSeqRef = useRef(0);
  const repaySeqRef = useRef(0);
  const topUpSeqRef = useRef(0);
  const extendVerifySeqRef = useRef(0);

  const [loanLoad, setLoanLoad] = useState({ loading: isValidLoanId, error: '', data: null, auction: null, fetchedAt: null });

  // Repay / Partial Repay state
  const [repayMode, setRepayMode] = useState('full'); // 'full' | 'partial'
  const [partialUsdcStr, setPartialUsdcStr] = useState('');
  const [trimBufferAllowance, setTrimBufferAllowance] = useState(false);
  const [repayPreview, setRepayPreview] = useState(null);
  const [confirmThirdPartyRepay, setConfirmThirdPartyRepay] = useState(false);
  const [repayBusy, setRepayBusy] = useState({ preview: false, submit: false });
  const [repayError, setRepayError] = useState('');
  const [repayResult, setRepayResult] = useState(null);

  // Top-up state
  const [topUpCollateralStr, setTopUpCollateralStr] = useState('');
  const [topUpPreview, setTopUpPreview] = useState(null);
  const [confirmThirdPartyTopUp, setConfirmThirdPartyTopUp] = useState(false);
  const [topUpBusy, setTopUpBusy] = useState({ preview: false, submit: false });
  const [topUpError, setTopUpError] = useState('');
  const [topUpResult, setTopUpResult] = useState(null);

  // Extend EIP-712 state (sign + verify/execute)
  const [extDaysStr, setExtDaysStr] = useState('7');
  const [extAprStr, setExtAprStr] = useState('');
  const [extDeadlineHoursStr, setExtDeadlineHoursStr] = useState('1');
  const [extSignBusy, setExtSignBusy] = useState(false);
  const [extSignError, setExtSignError] = useState('');
  const [signedExtend, setSignedExtend] = useState(null);
  const [extCopied, setExtCopied] = useState(false);

  const [extPayloadJsonStr, setExtPayloadJsonStr] = useState('');
  const [extendPreview, setExtendPreview] = useState(null);
  const [extVerifyBusy, setExtVerifyBusy] = useState({ preview: false, submit: false });
  const [extSubmitError, setExtSubmitError] = useState('');
  const [extResult, setExtResult] = useState(null);

  const loadLoanState = useCallback(async () => {
    if (!isValidLoanId) return null;
    const seq = ++loanSeqRef.current;
    const cfg = getFrontendConfig();
    setLoanLoad((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const state = await readLoanOnChainState(cleanId, { cfg });
      let auctionRow = null;
      if (cfg?.apiUrl && state.activeAuctionId !== '0') {
        try {
          const aucRes = await fetchPaginatedApiRows(`${cfg.apiUrl}/auctions`, { limit: 100, maxPages: 5, cfg });
          auctionRow = (aucRes.rows ?? []).find((a) => String(a.auction_id) === String(state.activeAuctionId)) ?? null;
        } catch {
          auctionRow = null;
        }
      }
      if (seq !== loanSeqRef.current) return null;
      setLoanLoad({
        loading: false,
        error: '',
        data: state,
        auction: auctionRow,
        fetchedAt: new Date().toISOString(),
      });
      setExtAprStr((prev) => (prev ? prev : (state.rateBps / 100).toFixed(2)));
      return state;
    } catch (err) {
      if (seq !== loanSeqRef.current) return null;
      setLoanLoad({
        loading: false,
        error: formatWeb3Error(err),
        data: null,
        auction: null,
        fetchedAt: null,
      });
      return null;
    }
  }, [cleanId, isValidLoanId]);

  useEffect(() => {
    void loadLoanState();
  }, [loadLoanState]);

  useEffect(() => {
    setPartialUsdcStr('');
    setTopUpCollateralStr('');
    setExtAprStr('');
    setExtPayloadJsonStr('');
    setRepayResult(null);
    setTopUpResult(null);
    setExtResult(null);
  }, [cleanId]);

  // Clear signed payloads and stale previews on loan route, account, or chain switch
  useEffect(() => {
    ++repaySeqRef.current;
    ++topUpSeqRef.current;
    ++extendVerifySeqRef.current;
    setRepayPreview(null);
    setConfirmThirdPartyRepay(false);
    setRepayError('');
    setTopUpPreview(null);
    setConfirmThirdPartyTopUp(false);
    setTopUpError('');
    setSignedExtend(null);
    setExtSignError('');
    setExtendPreview(null);
    setExtSubmitError('');
  }, [cleanId, web3?.address, web3?.chainId, web3?.wrongNetwork]);

  const loanState = loanLoad.data;
  const walletLower = web3?.address ? web3.address.toLowerCase() : null;
  const walletIsBorrower = Boolean(walletLower && loanState && walletLower === loanState.borrower.toLowerCase());
  const walletIsHolder = Boolean(
    walletLower && loanState?.positionOwner && walletLower === loanState.positionOwner.toLowerCase()
  );
  const walletIsHolderNotBorrower = walletIsHolder && !walletIsBorrower;
  const walletIsSelfFundedSameParty = walletIsHolder && walletIsBorrower;
  const walletOnBase = Boolean(web3?.connected && web3?.address && !web3?.wrongNetwork);

  const partialAllowed = Boolean(loanState && loanState.isActive && !loanState.isPastMaturity);
  const topUpAllowed = Boolean(loanState && !loanState.isSettled && !loanState.isAuction && Number(loanState.storedStatus) < 2);
  const extendAllowed = Boolean(loanState && loanState.isActive && !loanState.isPastMaturity);

  // Compute exact pre-sign ExtendOrder values & deadline preview (default 1h, max 24h)
  const extendSignCalculation = useMemo(() => {
    if (!loanState) return { error: '', ready: false };
    const daysClean = extDaysStr.trim();
    if (!/^[1-9]\d*$/.test(daysClean)) {
      return { error: 'Additional term days must be a positive integer.', ready: false };
    }
    const newMaturity = BigInt(loanState.maturity) + BigInt(daysClean) * 86_400n;
    if (newMaturity > BigInt(loanState.maxExtendMaturity)) {
      return {
        error: `New maturity (${formatUnixIso(newMaturity)}) exceeds 90-day protocol maximum (${formatUnixIso(loanState.maxExtendMaturity)}).`,
        ready: false,
      };
    }
    const bps = parsePercentToBps(extAprStr);
    if (bps === null || bps > LOAN_CORE_MAX_RATE_BPS) {
      return {
        error: `New APR must be between 0.00% and ${formatBpsPercent(LOAN_CORE_MAX_RATE_BPS)}.`,
        ready: false,
      };
    }
    const hrsClean = extDeadlineHoursStr.trim();
    if (!/^[1-9]\d*$/.test(hrsClean) || Number(hrsClean) > 24) {
      return {
        error: 'Signature deadline must be an integer between 1 and 24 hours.',
        ready: false,
      };
    }
    const deadlineSec = BigInt(loanState.blockTimestamp) + BigInt(hrsClean) * 3600n;
    return {
      ready: true,
      error: '',
      newMaturity,
      newRateBps: bps,
      deadlineSec,
      deadlineIso: formatUnixIso(deadlineSec),
    };
  }, [extAprStr, extDaysStr, extDeadlineHoursStr, loanState]);

  async function handlePreviewRepay(event) {
    event.preventDefault();
    if (!loanState || !walletOnBase) return;
    const seq = ++repaySeqRef.current;
    setRepayError('');
    setRepayResult(null);
    setRepayPreview(null);
    setConfirmThirdPartyRepay(false);

    let principalRepayRaw = null;
    if (repayMode === 'partial') {
      const parsed = parseDecimalToRaw(partialUsdcStr, USDC_DECIMALS);
      if (!parsed) {
        setRepayError('Enter a valid positive USDC partial-repay amount (up to 6 decimals).');
        return;
      }
      principalRepayRaw = parsed;
    }

    setRepayBusy((p) => ({ ...p, preview: true }));
    try {
      const preview = await verifyAndPreviewLoanRepay({
        loanId: loanState.loanId,
        payerAddress: web3.address,
        principalRepayRaw,
        cfg: getFrontendConfig(),
      });
      if (seq !== repaySeqRef.current) return;
      setRepayPreview(preview);
    } catch (err) {
      if (seq !== repaySeqRef.current) return;
      setRepayError(formatWeb3Error(err));
    } finally {
      if (seq === repaySeqRef.current) {
        setRepayBusy((p) => ({ ...p, preview: false }));
      }
    }
  }

  async function handleConfirmRepay() {
    if (!repayPreview || !walletOnBase) return;
    if (repayPreview.isThirdPartyPayer && !confirmThirdPartyRepay) {
      setRepayError('Check the confirmation box before repaying someone else’s loan.');
      return;
    }
    setRepayError('');
    setRepayBusy((p) => ({ ...p, submit: true }));
    try {
      await web3.ensureDeclarationVerifiedForTx();
      const res = await executeLoanRepay({
        address: web3.address,
        loanId: repayPreview.loanId,
        principalRepayRaw: repayPreview.isPartial ? repayPreview.exact.principalRepayRaw : null,
        expectedPreview: repayPreview,
        autoApprove: true,
        allowThirdPartyPayer: confirmThirdPartyRepay,
        trimBufferAllowance,
        provider: getInjectedProvider(),
        cfg: getFrontendConfig(),
      });
      setRepayResult(res);
      setRepayPreview(null);
      setConfirmThirdPartyRepay(false);
      await loadLoanState();
    } catch (err) {
      setRepayError(formatWeb3Error(err));
    } finally {
      setRepayBusy((p) => ({ ...p, submit: false }));
    }
  }

  async function handlePreviewTopUp(event) {
    event.preventDefault();
    if (!loanState || !walletOnBase) return;
    const seq = ++topUpSeqRef.current;
    setTopUpError('');
    setTopUpResult(null);
    setTopUpPreview(null);
    setConfirmThirdPartyTopUp(false);

    const parsed = parseDecimalToRaw(topUpCollateralStr, loanState.collateralDecimals);
    if (!parsed) {
      setTopUpError(
        `Enter a valid positive ${loanState.collateralSymbol} amount (up to ${loanState.collateralDecimals} decimals).`
      );
      return;
    }

    setTopUpBusy((p) => ({ ...p, preview: true }));
    try {
      const preview = await verifyAndPreviewLoanTopUp({
        loanId: loanState.loanId,
        additionalCollateralRaw: parsed,
        payerAddress: web3.address,
        cfg: getFrontendConfig(),
      });
      if (seq !== topUpSeqRef.current) return;
      setTopUpPreview(preview);
    } catch (err) {
      if (seq !== topUpSeqRef.current) return;
      setTopUpError(formatWeb3Error(err));
    } finally {
      if (seq === topUpSeqRef.current) {
        setTopUpBusy((p) => ({ ...p, preview: false }));
      }
    }
  }

  async function handleConfirmTopUp() {
    if (!topUpPreview || !walletOnBase) return;
    if (topUpPreview.isThirdPartyPayer && !confirmThirdPartyTopUp) {
      setTopUpError('Check the confirmation box before topping up someone else’s loan.');
      return;
    }
    setTopUpError('');
    setTopUpBusy((p) => ({ ...p, submit: true }));
    try {
      await web3.ensureDeclarationVerifiedForTx();
      const res = await executeLoanTopUp({
        address: web3.address,
        loanId: topUpPreview.loanId,
        additionalCollateralRaw: topUpPreview.additionalCollateralRaw,
        expectedPreview: topUpPreview,
        autoApprove: true,
        allowThirdPartyPayer: confirmThirdPartyTopUp,
        provider: getInjectedProvider(),
        cfg: getFrontendConfig(),
      });
      setTopUpResult(res);
      setTopUpPreview(null);
      setConfirmThirdPartyTopUp(false);
      await loadLoanState();
    } catch (err) {
      setTopUpError(formatWeb3Error(err));
    } finally {
      setTopUpBusy((p) => ({ ...p, submit: false }));
    }
  }

  async function handleSignExtend(event) {
    event.preventDefault();
    if (!loanState || !walletOnBase || !extendSignCalculation.ready) return;
    setExtSignError('');
    setSignedExtend(null);
    setExtCopied(false);
    setExtSignBusy(true);
    try {
      await web3.ensureDeclarationVerifiedForTx();
      const signed = await signLoanExtension({
        address: web3.address,
        loanId: loanState.loanId,
        newMaturity: extendSignCalculation.newMaturity,
        newRateBps: extendSignCalculation.newRateBps,
        deadline: extendSignCalculation.deadlineSec,
        provider: getInjectedProvider(),
        cfg: getFrontendConfig(),
      });
      setSignedExtend(signed);
    } catch (err) {
      setExtSignError(formatWeb3Error(err));
    } finally {
      setExtSignBusy(false);
    }
  }

  async function copySignedExtension() {
    if (!signedExtend) return;
    try {
      const text = JSON.stringify(
        {
          extendOrder: signedExtend.extendOrderJson,
          signature: signedExtend.signature,
        },
        null,
        2
      );
      await navigator.clipboard.writeText(text);
      setExtCopied(true);
    } catch {
      setExtCopied(false);
    }
  }

  async function handleVerifyExtend(event) {
    event.preventDefault();
    if (!loanState || !walletOnBase) return;
    const seq = ++extendVerifySeqRef.current;
    setExtSubmitError('');
    setExtResult(null);
    setExtendPreview(null);

    let parsed;
    try {
      parsed = parseExtendPayloadFromJson(extPayloadJsonStr);
    } catch (err) {
      setExtSubmitError(formatWeb3Error(err));
      return;
    }

    setExtVerifyBusy((p) => ({ ...p, preview: true }));
    try {
      const preview = await verifyAndPreviewLoanExtend({
        loanId: loanState.loanId,
        newMaturity: parsed.extendOrder.newMaturity,
        newRateBps: parsed.extendOrder.newRateBps,
        deadline: parsed.extendOrder.deadline,
        nonce: parsed.extendOrder.nonce,
        signature: parsed.signature,
        callerAddress: web3.address,
        cfg: getFrontendConfig(),
      });
      if (seq !== extendVerifySeqRef.current) return;
      setExtendPreview(preview);
    } catch (err) {
      if (seq !== extendVerifySeqRef.current) return;
      setExtSubmitError(formatWeb3Error(err));
    } finally {
      if (seq === extendVerifySeqRef.current) {
        setExtVerifyBusy((p) => ({ ...p, preview: false }));
      }
    }
  }

  async function handleConfirmExtend() {
    if (!extendPreview || !walletOnBase) return;
    setExtSubmitError('');
    setExtVerifyBusy((p) => ({ ...p, submit: true }));
    try {
      await web3.ensureDeclarationVerifiedForTx();
      const res = await executeLoanExtend({
        address: web3.address,
        loanId: extendPreview.loanId,
        newMaturity: extendPreview.extendOrder.newMaturity,
        newRateBps: extendPreview.extendOrder.newRateBps,
        deadline: extendPreview.extendOrder.deadline,
        nonce: extendPreview.extendOrder.nonce,
        signature: extendPreview.signature,
        expectedPreview: extendPreview,
        provider: getInjectedProvider(),
        cfg: getFrontendConfig(),
      });
      setExtResult(res);
      setExtendPreview(null);
      await loadLoanState();
    } catch (err) {
      setExtSubmitError(formatWeb3Error(err));
    } finally {
      setExtVerifyBusy((p) => ({ ...p, submit: false }));
    }
  }

  if (!isValidLoanId) {
    return (
      <Page
        kicker="Loan · Invalid ID"
        title={`Loan "${cleanId || '?'}" not found.`}
        lede="On-chain LoanCore loan IDs are positive integers."
      >
        <div className="actions">
          <Link className="btn secondary" to="/loans">
            Back to loans
          </Link>
        </div>
      </Page>
    );
  }

  const cfg = getFrontendConfig();

  return (
    <Page
      kicker={`Loan #${cleanId} · Live Base State`}
      title={
        loanState
          ? `${loanState.collateralSymbol} · ${loanState.statusName}.`
          : `Loan #${cleanId}`
      }
      lede={loanNarrative(loanState)}
    >
      <div className="actions">
        <button
          className="btn secondary"
          type="button"
          onClick={() => void loadLoanState()}
          disabled={loanLoad.loading}
        >
          {loanLoad.loading ? 'Refreshing on-chain state…' : 'Refresh LoanCore state'}
        </button>
        <Link className="btn secondary" to="/loans">
          Back to loans
        </Link>
      </div>

      {loanLoad.error ? (
        <p className="err block" role="alert">
          On-chain read failed for Loan #{cleanId}: {loanLoad.error}
        </p>
      ) : null}

      {!walletOnBase ? (
        <div className="err block" role="note">
          {!web3?.connected ? (
            <>
              Wallet disconnected. <Link to="/wallet">Connect your wallet</Link> to repay, top up collateral, or co-sign an extension.
            </>
          ) : (
            <>
              Wrong network (chainId {web3.chainId}). Switch to Base ({cfg.chainId}) on <Link to="/wallet">Wallet</Link> before submitting loan actions.
            </>
          )}
        </div>
      ) : null}

      <ComplianceTxGateBanner actionLabel="repay, top up collateral, or co-sign/submit extensions" />

      {loanState ? (
        <>
          {!loanState.isSettled ? (
            <div className="ltv-pair">
              <div>
                <span>Oracle LTV (Principal / With Interest)</span>
                <strong>
                  {loanState.currentLtvBps !== null
                    ? `${formatBpsPercent(loanState.currentLtvBps)} / ${formatBpsPercent(loanState.currentLtvWithInterestBps)}`
                    : 'Oracle unavailable'}
                </strong>
                <p>
                  Oracle state: {loanState.oracleStateName ?? 'Unknown (repay stays open)'}.
                </p>
              </div>
              <div>
                <span>Margin / Liquidation Thresholds</span>
                <strong>
                  {formatBpsPercent(loanState.marginCallLtvBps)} / {formatBpsPercent(loanState.liqLtvBps)}
                </strong>
                <p>
                  Effective collateral value:{' '}
                  {loanState.collateralEffectiveValueUsdcRaw
                    ? `$${formatTokenUnitsDisplay(loanState.collateralEffectiveValueUsdcRaw, USDC_DECIMALS, 2)}`
                    : 'Unavailable'}
                </p>
              </div>
            </div>
          ) : null}

          <div className="block">
            <h2>Live LoanCore &amp; PositionNFT telemetry</h2>
            <Rows
              items={[
                {
                  label: 'Effective status',
                  value: `${loanState.statusName} (stored contract status: ${loanState.storedStatusName})`,
                },
                {
                  label: 'EIP-712 Reg S declaration',
                  value: formatRegSDeclarationRowValue(web3),
                },
                {
                  label: 'Borrower',
                  value: `${loanState.borrower}${walletIsBorrower ? ' (Your wallet)' : ''}`,
                },
                {
                  label: 'PositionNFT holder (lender claim)',
                  value: loanState.positionOwner
                    ? `${loanState.positionOwner}${walletIsHolder ? ' (Your wallet)' : ''}`
                    : 'Burned / settled',
                },
                {
                  label: 'Remaining principal',
                  value: `$${loanState.remainingPrincipalFormatted} USDC (${loanState.remainingPrincipalRaw} raw / $${formatTokenUnitsDisplay(loanState.principalRaw, USDC_DECIMALS, 2)} original)`,
                },
                {
                  label: 'Due interest at block',
                  value: `$${loanState.dueInterestFormatted} USDC (${loanState.dueInterestRaw} raw)`,
                },
                {
                  label: 'Spot total debt (principal + interest)',
                  value: `$${loanState.spotTotalDebtFormatted} USDC (${loanState.spotTotalDebtRaw} raw)`,
                },
                {
                  label: 'Locked collateral',
                  value: `${loanState.collateralFormatted} ${loanState.collateralSymbol} (${loanState.collateralRaw} raw)`,
                },
                {
                  label: 'Interest APR / Grace spread',
                  value: `${formatBpsPercent(loanState.rateBps)} / +${formatBpsPercent(loanState.penaltySpreadBps)}`,
                },
                {
                  label: 'Min interest floor / Extension nonce',
                  value: `${loanState.minInterestDays} days (initial APR ${formatBpsPercent(loanState.loanInitialRateBps)}) · Nonce #${loanState.extensionNonce}`,
                },
                {
                  label: 'Maturity',
                  value: `${formatUnixIso(loanState.maturity)} (${formatDurationDelta(loanState.maturity, loanState.blockTimestamp)})`,
                },
                {
                  label: 'Grace deadline / Max 90d extension',
                  value: `${formatUnixIso(loanState.graceEndTimestamp)} / ${formatUnixIso(loanState.maxExtendMaturity)}`,
                },
                loanState.activeAuctionId !== '0'
                  ? {
                      label: 'Active LiquidationAuction',
                      value: `#${loanState.activeAuctionId}${loanState.auctionLocked ? ' (NFT transfer locked)' : ''}${loadAuctionSummary(loanLoad.auction)}`,
                    }
                  : null,
              ]}
            />
            {loanLoad.fetchedAt ? (
              <p className="hint" style={{ marginTop: 10 }}>
                Read at Base block #{loanState.blockNumber} ({formatUnixIso(loanState.blockTimestamp)}).
              </p>
            ) : null}
          </div>

          <div className="split block">
            {/* Repay & Partial Repay Panel (Spender = LoanCore) */}
            <Sheet
              title="Repay / Partial Repay (LoanCore)"
              note={`USDC spender: ${cfg.contracts.loanCore || 'Unconfigured'}. Exact spot + projected buffer ceiling in raw 6-decimal units (no unlimited approvals); preserves open LendOffer allowance.`}
            >
              {walletIsHolderNotBorrower ? (
                <p className="err" role="alert">
                  Connected wallet is the PositionNFT lender/holder — holder cannot repay or partially repay its own loan.
                </p>
              ) : null}

              <div className="actions" style={{ marginBottom: 12 }}>
                <button
                  className={repayMode === 'full' ? 'btn' : 'btn secondary'}
                  type="button"
                  onClick={() => {
                    setRepayMode('full');
                    setRepayPreview(null);
                    setRepayError('');
                  }}
                >
                  Full repay
                </button>
                <button
                  className={repayMode === 'partial' ? 'btn' : 'btn secondary'}
                  type="button"
                  disabled={!partialAllowed}
                  onClick={() => {
                    setRepayMode('partial');
                    setRepayPreview(null);
                    setRepayError('');
                  }}
                >
                  Partial repay
                </button>
              </div>
              {!partialAllowed ? (
                <p className="hint">
                  Partial repay is available only while Active before maturity ({loanState.statusName}). Full repay stays open in Grace, Overdue, and Auction.
                </p>
              ) : null}

              <form className="fields" onSubmit={handlePreviewRepay}>
                {repayMode === 'partial' ? (
                  <Field
                    id="repay-partial-usdc"
                    label="Principal to repay (USDC, up to 6 decimals)"
                    hint={`Must be > 0 and strictly below remaining $${loanState.remainingPrincipalFormatted} USDC.`}
                  >
                    {(props) => (
                      <TextInput
                        id="repay-partial-usdc"
                        value={partialUsdcStr}
                        onChange={(v) => {
                          setPartialUsdcStr(v);
                          setRepayPreview(null);
                          setRepayError('');
                        }}
                        {...props}
                      />
                    )}
                  </Field>
                ) : null}

                <Choice
                  id="trim-repay-buffer-allowance"
                  checked={trimBufferAllowance}
                  onChange={setTrimBufferAllowance}
                >
                  Trim leftover repay buffer USDC allowance back to open LendOffer sum after repay
                </Choice>

                {repayError ? <p className="err" role="alert">{repayError}</p> : null}
                {repayResult ? (
                  <p className="note" role="status">
                    {repayResult.isPartial ? 'Partial repay' : 'Full repay'} settled (tx {repayResult.txHash}). Paid{' '}
                    {repayResult.totalPaidRaw} raw USDC; released {repayResult.collateralReleasedRaw} raw{' '}
                    {loanState.collateralSymbol}.
                    {repayResult.allowanceTrimTxHash
                      ? ` Trimmed leftover LoanCore allowance to ${repayResult.postTrimAllowanceRaw} raw (tx ${repayResult.allowanceTrimTxHash}).`
                      : ''}
                  </p>
                ) : null}

                <div className="actions">
                  <button
                    className="btn secondary"
                    type="submit"
                    disabled={
                      !walletOnBase ||
                      loanState.isSettled ||
                      walletIsHolderNotBorrower ||
                      (repayMode === 'partial' && !partialAllowed) ||
                      repayBusy.preview ||
                      repayBusy.submit
                    }
                  >
                    {repayBusy.preview ? 'Simulating repay…' : '1. Verify & preview repay'}
                  </button>
                </div>
              </form>

              {repayPreview ? (
                <div className="block" style={{ marginTop: 14 }}>
                  {repayPreview.isThirdPartyPayer ? (
                    <div className="err block" role="alert">
                      <p>{repayPreview.thirdPartyWarning}</p>
                      <div style={{ marginTop: 8 }}>
                        <Choice
                          id="confirm-third-party-repay"
                          checked={confirmThirdPartyRepay}
                          onChange={setConfirmThirdPartyRepay}
                        >
                          Pay for someone else: I confirm repaying borrower {loanState.borrower}&apos;s loan
                        </Choice>
                      </div>
                    </div>
                  ) : null}
                  <Rows
                    items={[
                      { label: 'USDC spender', value: `${repayPreview.spender} (LoanCore)` },
                      {
                        label: 'Payer role',
                        value: repayPreview.payerIsBorrower ? 'Borrower' : 'Third-party payer (requires confirm)',
                      },
                      {
                        label: 'Spot total at block',
                        value: `$${formatTokenUnitsDisplay(repayPreview.spotTotalPaymentRaw, USDC_DECIMALS, 6)} USDC (${repayPreview.spotTotalPaymentRaw} raw)`,
                      },
                      {
                        label: `Buffered max (${repayPreview.exact.bufferSeconds}s horizon)`,
                        value: `$${formatTokenUnitsDisplay(repayPreview.maxPaymentRaw, USDC_DECIMALS, 6)} USDC (${repayPreview.maxPaymentRaw} raw)`,
                      },
                      {
                        label: 'Open LendOffers sum / Required LoanCore allowance',
                        value: `${repayPreview.existingOpenSumRaw} raw open · Need ${repayPreview.requiredApprovalRaw} raw`,
                      },
                      repayPreview.isPartial
                        ? {
                            label: 'Pro-rata collateral released',
                            value: `${formatTokenUnitsDisplay(repayPreview.exact.collateralReleasedRaw, loanState.collateralDecimals, 6)} ${loanState.collateralSymbol} (${repayPreview.exact.collateralReleasedRaw} raw)`,
                          }
                        : null,
                    ]}
                  />
                  <div className="actions" style={{ marginTop: 12 }}>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void handleConfirmRepay()}
                      disabled={
                        repayBusy.submit ||
                        !walletOnBase ||
                        !web3?.eligibilityDeclarationValid ||
                        walletIsHolderNotBorrower ||
                        (repayPreview.isThirdPartyPayer && !confirmThirdPartyRepay)
                      }
                    >
                      {repayBusy.submit
                        ? '2. Approving LoanCore USDC & repaying…'
                        : '2. Confirm: Approve LoanCore USDC & Repay'}
                    </button>
                  </div>
                </div>
              ) : null}
            </Sheet>

            {/* Collateral Top-Up Panel (Spender = CollateralEscrow) */}
            <Sheet
              title="Top Up Collateral (CollateralEscrow)"
              note={`Collateral spender: ${cfg.contracts.collateralEscrow || 'Unconfigured'}. Preserves open BorrowOrder collateral allowances (never LoanCore, no unlimited approvals).`}
            >
              {walletIsHolderNotBorrower ? (
                <p className="err" role="alert">
                  Connected wallet is the PositionNFT lender/holder — holder cannot top up collateral on its own loan.
                </p>
              ) : null}
              {!topUpAllowed ? (
                <p className="hint">Collateral top-up is closed once a loan enters Auction or settles ({loanState.statusName}).</p>
              ) : null}

              <form className="fields" onSubmit={handlePreviewTopUp}>
                <Field
                  id="topup-collateral-amount"
                  label={`Additional collateral (${loanState.collateralSymbol}, up to ${loanState.collateralDecimals} decimals)`}
                >
                  {(props) => (
                    <TextInput
                      id="topup-collateral-amount"
                      value={topUpCollateralStr}
                      onChange={(v) => {
                        setTopUpCollateralStr(v);
                        setTopUpPreview(null);
                        setTopUpError('');
                      }}
                      {...props}
                    />
                  )}
                </Field>

                {topUpError ? <p className="err" role="alert">{topUpError}</p> : null}
                {topUpResult ? (
                  <p className="note" role="status">
                    Top-up confirmed (tx {topUpResult.txHash}). Added {topUpResult.addedCollateralRaw} raw{' '}
                    {loanState.collateralSymbol}; total collateral locked: {topUpResult.newCollateralRaw} raw.
                  </p>
                ) : null}

                <div className="actions">
                  <button
                    className="btn secondary"
                    type="submit"
                    disabled={
                      !walletOnBase ||
                      !topUpAllowed ||
                      walletIsHolderNotBorrower ||
                      topUpBusy.preview ||
                      topUpBusy.submit
                    }
                  >
                    {topUpBusy.preview ? 'Simulating top-up…' : '1. Verify & preview top-up'}
                  </button>
                </div>
              </form>

              {topUpPreview ? (
                <div className="block" style={{ marginTop: 14 }}>
                  {topUpPreview.isThirdPartyPayer ? (
                    <div className="err block" role="alert">
                      <p>{topUpPreview.thirdPartyWarning}</p>
                      <div style={{ marginTop: 8 }}>
                        <Choice
                          id="confirm-third-party-topup"
                          checked={confirmThirdPartyTopUp}
                          onChange={setConfirmThirdPartyTopUp}
                        >
                          Top up for someone else: I confirm adding collateral to borrower {loanState.borrower}&apos;s loan
                        </Choice>
                      </div>
                    </div>
                  ) : null}
                  <Rows
                    items={[
                      { label: 'Collateral spender', value: `${topUpPreview.spender} (CollateralEscrow)` },
                      {
                        label: 'Additional / New total collateral',
                        value: `${topUpPreview.additionalCollateralRaw} raw -> ${topUpPreview.newCollateralRaw} raw`,
                      },
                      {
                        label: 'Open BorrowOrders reserve / Required Escrow allowance',
                        value: `${topUpPreview.existingOpenCollateralRaw} raw open · Need ${topUpPreview.requiredApprovalRaw} raw`,
                      },
                      topUpPreview.exact.projectedLtvBps !== null
                        ? {
                            label: 'Projected principal LTV after top-up',
                            value: formatBpsPercent(topUpPreview.exact.projectedLtvBps),
                          }
                        : null,
                    ]}
                  />
                  <div className="actions" style={{ marginTop: 12 }}>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void handleConfirmTopUp()}
                      disabled={
                        topUpBusy.submit ||
                        !walletOnBase ||
                        !web3?.eligibilityDeclarationValid ||
                        walletIsHolderNotBorrower ||
                        (topUpPreview.isThirdPartyPayer && !confirmThirdPartyTopUp)
                      }
                    >
                      {topUpBusy.submit
                        ? '2. Approving CollateralEscrow & topping up…'
                        : '2. Confirm: Approve CollateralEscrow & Top Up'}
                    </button>
                  </div>
                </div>
              ) : null}
            </Sheet>
          </div>

          {/* Extend Loan EIP-712 Section (Zero Approvals) */}
          <section className="block">
            <h2>Extend Loan (NOSTOK Loan Core EIP-712, Zero Token Approvals)</h2>
            <p className="hint">
              Counterparty signature uses LoanCore domain &quot;NOSTOK Loan Core&quot; v1 on {cfg.contracts.loanCore || 'LoanCore'} at Nonce #{loanState.extensionNonce}. Maturity caps at 90 days from start; APR caps at 40.00%; signature deadline defaults to 1h and caps at 24h.
            </p>
            {!extendAllowed ? (
              <p className="err" role="note">
                Loan extension is closed ({loanState.statusName}); both signing and submitting are disabled past maturity.
              </p>
            ) : null}
            {walletIsSelfFundedSameParty ? (
              <p className="err" role="alert">
                Borrower and PositionNFT holder are the same address — self-extension is blocked.
              </p>
            ) : null}

            <div className="split" style={{ marginTop: 14 }}>
              <Sheet title="A. Co-sign Extension Proposal (Borrower or Holder)">
                <form className="fields" onSubmit={handleSignExtend}>
                  <Field
                    id="extend-add-days"
                    label="Additional term days beyond current maturity"
                    hint={`Current maturity: ${formatUnixIso(loanState.maturity)} · Max 90d cap: ${formatUnixIso(loanState.maxExtendMaturity)}`}
                  >
                    {(props) => (
                      <TextInput
                        id="extend-add-days"
                        inputMode="numeric"
                        value={extDaysStr}
                        onChange={(v) => {
                          setExtDaysStr(v);
                          setSignedExtend(null);
                          setExtSignError('');
                        }}
                        {...props}
                      />
                    )}
                  </Field>
                  <Field
                    id="extend-new-apr"
                    label="Proposed new APR (%)"
                    hint="Up to 40.00%. Interest accrued so far locks at old APR before updating."
                  >
                    {(props) => (
                      <TextInput
                        id="extend-new-apr"
                        value={extAprStr}
                        onChange={(v) => {
                          setExtAprStr(v);
                          setSignedExtend(null);
                          setExtSignError('');
                        }}
                        {...props}
                      />
                    )}
                  </Field>
                  <Field
                    id="extend-deadline-hours"
                    label="Signature expiry window (hours, default 1, max 24)"
                    hint={
                      extendSignCalculation.ready
                        ? `Deadline before signing: ${extendSignCalculation.deadlineIso} (Unix ${extendSignCalculation.deadlineSec.toString()})`
                        : extendSignCalculation.error || 'Enter integer hours 1 to 24.'
                    }
                  >
                    {(props) => (
                      <TextInput
                        id="extend-deadline-hours"
                        inputMode="numeric"
                        value={extDeadlineHoursStr}
                        onChange={(v) => {
                          setExtDeadlineHoursStr(v);
                          setSignedExtend(null);
                          setExtSignError('');
                        }}
                        {...props}
                      />
                    )}
                  </Field>

                  {extSignError ? <p className="err" role="alert">{extSignError}</p> : null}

                  <div className="actions">
                    <button
                      className="btn secondary"
                      type="submit"
                      disabled={
                        !walletOnBase ||
                        !web3?.eligibilityDeclarationValid ||
                        !extendAllowed ||
                        (!walletIsBorrower && !walletIsHolder) ||
                        walletIsSelfFundedSameParty ||
                        !extendSignCalculation.ready ||
                        extSignBusy
                      }
                    >
                      {extSignBusy ? 'Signing ExtendOrder…' : 'Sign ExtendOrder (EIP-712, 0 approvals)'}
                    </button>
                  </div>
                </form>

                {signedExtend ? (
                  <div className="block" style={{ marginTop: 12 }}>
                    <Rows
                      items={[
                        { label: 'Signed as role', value: `${signedExtend.signerRole} (${shortAddress(signedExtend.signer)})` },
                        { label: 'Expected submitter', value: signedExtend.expectedSubmitter },
                        { label: 'Signature expires at', value: `${formatUnixIso(signedExtend.deadline)} (Unix ${signedExtend.deadline})` },
                        { label: 'Extension nonce', value: signedExtend.extendOrderJson.nonce },
                      ]}
                    />
                    <div className="actions" style={{ marginTop: 10 }}>
                      <button className="btn secondary" type="button" onClick={() => void copySignedExtension()}>
                        {extCopied ? 'Copied JSON' : 'Copy ExtendOrder JSON'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </Sheet>

              <Sheet title="B. Verify &amp; Submit Counterparty Signature">
                <form className="fields" onSubmit={handleVerifyExtend}>
                  <div className="field">
                    <label htmlFor="extend-payload-json">Signed ExtendOrder JSON (from counterparty)</label>
                    <textarea
                      id="extend-payload-json"
                      rows={5}
                      value={extPayloadJsonStr}
                      onChange={(e) => {
                        setExtPayloadJsonStr(e.target.value);
                        setExtendPreview(null);
                        setExtSubmitError('');
                      }}
                      style={{
                        width: '100%',
                        padding: 12,
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--radius-control)',
                        background: 'var(--sheet)',
                      }}
                    />
                  </div>

                  {extSubmitError ? <p className="err" role="alert">{extSubmitError}</p> : null}
                  {extResult ? (
                    <p className="note" role="status">
                      Loan extended (tx {extResult.txHash}). New maturity: {formatUnixIso(extResult.newMaturity)}; New APR:{' '}
                      {formatBpsPercent(extResult.newRateBps)}.
                    </p>
                  ) : null}

                  <div className="actions">
                    <button
                      className="btn secondary"
                      type="submit"
                      disabled={
                        !walletOnBase ||
                        !extendAllowed ||
                        (!walletIsBorrower && !walletIsHolder) ||
                        walletIsSelfFundedSameParty ||
                        !extPayloadJsonStr.trim() ||
                        extVerifyBusy.preview ||
                        extVerifyBusy.submit
                      }
                    >
                      {extVerifyBusy.preview ? 'Simulating extend()…' : '1. Verify signature & simulate extend()'}
                    </button>
                  </div>
                </form>

                {extendPreview ? (
                  <div className="block" style={{ marginTop: 12 }}>
                    <Rows
                      items={[
                        { label: 'Recovered counterparty', value: extendPreview.counterpartySigner ?? 'Smart wallet (ERC-1271 verified via eth_call)' },
                        { label: 'New maturity', value: formatUnixIso(extendPreview.extendOrderJson.newMaturity) },
                        { label: 'New APR', value: formatBpsPercent(extendPreview.extendOrderJson.newRateBps) },
                        { label: 'Signature deadline', value: formatUnixIso(extendPreview.extendOrderJson.deadline) },
                        { label: 'Token approvals required', value: 'None (0 approvals)' },
                      ]}
                    />
                    <div className="actions" style={{ marginTop: 12 }}>
                      <button
                        className="btn"
                        type="button"
                        onClick={() => void handleConfirmExtend()}
                        disabled={
                          extVerifyBusy.submit ||
                          !walletOnBase ||
                          !web3?.eligibilityDeclarationValid ||
                          !extendAllowed
                        }
                      >
                        {extVerifyBusy.submit ? '2. Submitting LoanCore.extend()…' : '2. Confirm & Execute Extend'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </Sheet>
            </div>
          </section>
        </>
      ) : null}
    </Page>
  );
}

function loadAuctionSummary(auction) {
  if (!auction) return '';
  return auction.active === false ? ' (Settled)' : ' (Live)';
}
