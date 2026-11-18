import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatUnits } from 'viem';
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
import {
  DEFAULT_COLLATERAL_BUFFER_BPS,
  approveCollateralForBorrow,
  bumpMakerNonceOnChain,
  cancelSignedBorrowOrder,
  computeRemainingBorrowCollateralRequirement,
  fillLendOfferAsBorrower,
  formatTokenUnitsDisplay,
  formatWeb3Error,
  loadPersistedSignedOrders,
  parseBorrowOrderFromJson,
  prepareAndSignBorrowOrder,
  readBorrowAllowanceAndNonce,
  refreshSignedBorrowOrdersState,
  resolveExactBorrowAmounts,
  setCollateralAllowanceForBorrow,
  shortAddress,
  verifyAndPreviewLendOfferFill,
} from '../lib/web3.js';
import { useStore } from '../store.jsx';

function computeOpenBorrowOrdersCollateralTotal(
  walletAddress,
  collateralToken,
  persistedList = [],
  marketOrders = [],
  excludeHashes = null
) {
  if (!walletAddress || !collateralToken) return { totalRaw: 0n, hasUnknown: false };
  const addrLower = walletAddress.toLowerCase();
  const tokLower = collateralToken.toLowerCase();
  const seenHashes = new Set();
  if (excludeHashes) {
    for (const h of excludeHashes) {
      if (h) seenHashes.add(String(h).toLowerCase());
    }
  }
  let totalRaw = 0n;
  let hasUnknown = false;

  for (const item of persistedList ?? []) {
    const ord = item?.orderJson ?? item?.order ?? {};
    const maker = String(ord?.borrower ?? '').toLowerCase();
    const tok = String(ord?.collateralToken ?? '').toLowerCase();
    if (maker !== addrLower || tok !== tokLower) continue;
    const h = String(item?.orderHash ?? '').toLowerCase();
    const st = item?.onchainStatus;
    if (st === 'unknown') hasUnknown = true;
    if (st !== 'open' && st !== 'partially_filled' && st !== 'unknown') {
      if (h) seenHashes.add(h);
      continue;
    }
    if (h && seenHashes.has(h)) continue;
    if (h) seenHashes.add(h);
    totalRaw += computeRemainingBorrowCollateralRequirement(
      ord.collateralAmount,
      ord.minUsdc,
      ord.minFill,
      item.remainingRaw ?? ord.minUsdc
    );
  }

  for (const row of marketOrders ?? []) {
    if (row.order_type !== 'borrow' && row.order_type !== 'BorrowOrder') continue;
    if (!row?.signed_order || !row?.signature) continue;
    if (String(row.maker ?? '').toLowerCase() !== addrLower) continue;
    const ord = row.signed_order;
    const tok = String(row.collateral_token ?? ord?.collateralToken ?? '').toLowerCase();
    if (tok !== tokLower) continue;
    const st = row.status;
    if (st === 'unknown') hasUnknown = true;
    if (st !== 'open' && st !== 'partially_filled' && st !== 'unknown') continue;
    const h = String(row.order_hash ?? '').toLowerCase();
    if (h && seenHashes.has(h)) continue;
    if (h) seenHashes.add(h);
    totalRaw += computeRemainingBorrowCollateralRequirement(
      ord?.collateralAmount ?? row?.collateral_amount?.raw,
      ord?.minUsdc ?? row?.min_usdc?.raw,
      ord?.minFill ?? row?.min_fill?.raw,
      row?.remaining_usdc?.raw ?? ord?.minUsdc ?? row?.min_usdc?.raw
    );
  }
  return { totalRaw, hasUnknown };
}

export function Borrow() {
  const { web3 } = useStore();
  const [marketState, setMarketState] = useState({ loading: true, data: null });
  const reqSeqRef = useRef(0);

  const [selectedAsset, setSelectedAsset] = useState('');
  const [principalStr, setPrincipalStr] = useState('1000');
  const [collateralStr, setCollateralStr] = useState('');
  const [bufferPctStr, setBufferPctStr] = useState('5.00');
  const [ratePct, setRatePct] = useState('8.00');
  const [termDaysStr, setTermDaysStr] = useState('30');
  const [maxLtvPct, setMaxLtvPct] = useState('60.00');
  const [minFillStr, setMinFillStr] = useState('500');
  const [expiryDaysStr, setExpiryDaysStr] = useState('2');
  const [yieldOn, setYieldOn] = useState(false);

  const [tokenMeta, setTokenMeta] = useState({ loading: false, data: null, error: '' });
  const tokenMetaSeqRef = useRef(0);

  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteResult, setQuoteResult] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const quoteSeqRef = useRef(0);

  const [txBusy, setTxBusy] = useState('');
  const txBusyRef = useRef(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [latestSignedOrder, setLatestSignedOrder] = useState(null);
  const [copiedHash, setCopiedHash] = useState('');

  // Persisted & on-chain synced signed BorrowOrders (survives field edits)
  const [persistedOrders, setPersistedOrders] = useState(() => loadPersistedSignedOrders());
  const [ordersRefreshing, setOrdersRefreshing] = useState(false);
  const [pasteCancelJson, setPasteCancelJson] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [cancelNotice, setCancelNotice] = useState('');
  const [collateralReductionState, setCollateralReductionState] = useState(null);

  // LendOffer fill workflow (Step 1 verify & simulate -> review terms -> Step 2 confirm & fill)
  const [lendOfferJsonStr, setLendOfferJsonStr] = useState('');
  const [selectedLendRemainingRaw, setSelectedLendRemainingRaw] = useState('');
  const [lendFillUsdcStr, setLendFillUsdcStr] = useState('500');
  const [lendPreviewBusy, setLendPreviewBusy] = useState(false);
  const [lendPreview, setLendPreview] = useState(null);
  const lendPreviewSeqRef = useRef(0);
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

  const openLendOffers = useMemo(() => {
    const all = marketState.data?.orders ?? [];
    return all.filter(
      (o) =>
        (o.order_type === 'lend' || o.order_type === 'LendOffer') &&
        (o.status === 'open' || o.status === 'partially_filled') &&
        o.signed_order &&
        o.signature
    );
  }, [marketState.data?.orders]);

  const syncPersistedOrders = useCallback(async () => {
    const stored = loadPersistedSignedOrders();
    if (stored.length === 0) {
      setPersistedOrders([]);
      return;
    }
    setOrdersRefreshing(true);
    try {
      const enriched = await refreshSignedBorrowOrdersState({
        orders: stored,
        cfg: web3?.config,
      });
      setPersistedOrders(enriched);
    } finally {
      setOrdersRefreshing(false);
    }
  }, [web3?.config]);

  useEffect(() => {
    void syncPersistedOrders();
  }, [syncPersistedOrders]);

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
        attestationHex: web3.attestationHex,
      });
      if (seq !== tokenMetaSeqRef.current) return null;
      setTokenMeta({ loading: false, data: res, error: '' });
      return res;
    } catch (err) {
      if (seq !== tokenMetaSeqRef.current) return null;
      setTokenMeta({ loading: false, data: null, error: formatWeb3Error(err) });
      return null;
    }
  }, [assetObj?.token, web3?.address, web3?.attestationHex, web3?.config, web3?.connected, web3?.wrongNetwork]);

  useEffect(() => {
    void loadAllowanceAndNonce();
  }, [loadAllowanceAndNonce]);

  useEffect(() => {
    quoteSeqRef.current += 1;
    lendPreviewSeqRef.current += 1;
    setQuoteLoading(false);
    setQuoteResult(null);
    setQuoteError('');
    setActionError('');
    setActionNotice('');
    setLatestSignedOrder(null);
    setCancelError('');
    setCancelNotice('');
    setCollateralReductionState(null);
    setLendPreviewBusy(false);
    setLendPreview(null);
    setLendFillResult(null);
    setLendFillError('');
  }, [web3?.address, web3?.chainId, web3?.wrongNetwork]);

  useEffect(() => {
    setCollateralReductionState(null);
  }, [assetObj?.token]);

  const existingOpenBorrowCollateralSumRaw = useMemo(
    () =>
      computeOpenBorrowOrdersCollateralTotal(
        web3?.address,
        assetObj?.token,
        persistedOrders,
        marketState.data?.orders
      ).totalRaw,
    [assetObj?.token, marketState.data?.orders, persistedOrders, web3?.address]
  );

  // Notice: field edits clear the stale quote preview & action banners,
  // but NEVER delete persisted signed orders from state/storage.
  const updateField = useCallback((setter) => (value) => {
    quoteSeqRef.current += 1;
    setQuoteLoading(false);
    setQuoteResult(null);
    setQuoteError('');
    setActionError('');
    setActionNotice('');
    setLendPreview(null);
    setter(value);
  }, []);

  const parsedBufferBps = useMemo(() => {
    const clean = bufferPctStr.trim();
    if (!clean) return DEFAULT_COLLATERAL_BUFFER_BPS;
    const bps = parsePercentToBps(clean);
    if (bps === null || bps < 0 || bps > 5000) return null;
    return bps;
  }, [bufferPctStr]);

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
    if (parsedBufferBps === null) {
      return { error: 'Collateral buffer must be between 0.00% and 50.00% (recommended 5.00%–10.00%).' };
    }
    const aprBps = parsePercentToBps(ratePct);
    if (aprBps === null || aprBps > 4000) {
      return { error: 'Fixed APR must be between 0.00% and 40.00%.' };
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
      bufferBps: parsedBufferBps,
      aprBps,
      termDays,
      maxLtvBps,
      minFillRaw,
      expiryDays,
    };
  }, [assetObj, collateralStr, expiryDaysStr, maxLtvPct, minFillStr, parsedBufferBps, principalStr, ratePct, termDaysStr]);

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
      const minFillRawParsed = minFillStr.trim()
        ? parseDecimalToRaw(minFillStr, USDC_DECIMALS)
        : null;
      const safeMinFillRaw =
        minFillRawParsed && BigInt(minFillRawParsed) > 0n ? minFillRawParsed : null;
      return resolveExactBorrowAmounts(quoteResult, {
        userCollateralRaw: userCol,
        bufferBps: parsedBufferBps ?? DEFAULT_COLLATERAL_BUFFER_BPS,
        minFillRaw: safeMinFillRaw,
        existingOpenCollateralRaw: existingOpenBorrowCollateralSumRaw,
      });
    } catch {
      return null;
    }
  }, [assetObj, collateralStr, existingOpenBorrowCollateralSumRaw, minFillStr, parsedBufferBps, quoteResult]);

  const partialRemainderWarning = useMemo(() => {
    const prinRawStr = exactQuoteAmounts
      ? exactQuoteAmounts.principalRaw.toString()
      : principalStr.trim()
        ? parseDecimalToRaw(principalStr, USDC_DECIMALS)
        : null;
    const minRawStr = parseDecimalToRaw(minFillStr, USDC_DECIMALS);
    if (!prinRawStr || !minRawStr) return '';
    const prin = BigInt(prinRawStr);
    const minFill = BigInt(minRawStr);
    if (prin > minFill && prin - minFill < 500_000_000n) {
      return `Warning (PARTIAL_REMAINDER_BELOW_500): Filling $${formatTokenUnitsDisplay(minFill, USDC_DECIMALS, 2)} leaves $${formatTokenUnitsDisplay(prin - minFill, USDC_DECIMALS, 2)} (< $500.00), which is unfillable on-chain (LoanCore PRINCIPAL_BELOW_MINIMUM) and can only be cancelled or expire.`;
    }
    return '';
  }, [exactQuoteAmounts, minFillStr, principalStr]);

  const eligibilityInfo = tokenMeta.data?.eligibility ?? null;
  const eligibilityStatusText = eligibilityInfo
    ? eligibilityInfo.isEligible
      ? eligibilityInfo.permissionlessMode
        ? 'Eligible (Permissionless mode)'
        : 'Eligible (Allowlisted)'
      : eligibilityInfo.isRevoked
        ? 'Ineligible (Revoked in EligibilityGate)'
        : 'Ineligible (Not allowlisted / missing attestation)'
    : web3?.connected
      ? 'Checking EligibilityGate…'
      : 'Connect wallet to check on-chain EligibilityGate';

  const allowanceRawBig = tokenMeta.data ? BigInt(tokenMeta.data.allowanceRaw) : 0n;
  const balanceRawBig = tokenMeta.data ? BigInt(tokenMeta.data.balanceRaw) : 0n;
  const needsApproval = Boolean(
    exactQuoteAmounts && allowanceRawBig < exactQuoteAmounts.requiredApprovalRaw
  );
  const insufficientBalance = Boolean(
    exactQuoteAmounts && tokenMeta.data && balanceRawBig < exactQuoteAmounts.requiredApprovalRaw
  );

  async function handleApproveCollateral() {
    if (txBusyRef.current) return;
    setActionError('');
    setActionNotice('');
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setActionError('Connect your wallet on Base before approving collateral.');
      return;
    }
    if (!quoteResult || !quoteResult.accepted) {
      setActionError('Click "1. Simulate live quote" and obtain an accepted quote before approving collateral.');
      return;
    }
    const parsed = parseValidatedInputs();
    if (parsed.error) {
      setActionError(parsed.error);
      return;
    }
    txBusyRef.current = true;
    setTxBusy('approve');
    try {
      const exact = resolveExactBorrowAmounts(quoteResult, {
        userCollateralRaw: parsed.collateralRaw,
        bufferBps: parsed.bufferBps,
        minFillRaw: parsed.minFillRaw,
        existingOpenCollateralRaw: existingOpenBorrowCollateralSumRaw,
      });
      const res = await approveCollateralForBorrow({
        address: web3.address,
        collateralToken: assetObj.token,
        requiredCollateralRaw: exact.requiredApprovalRaw,
        cfg: web3.config,
      });
      await loadAllowanceAndNonce();
      setActionNotice(
        res.alreadyApproved
          ? `CollateralEscrow already approved for ${res.allowanceRaw} raw units.`
          : `Approved CollateralEscrow for ${exact.requiredApprovalRaw.toString()} raw ${assetObj.symbol} units (open ${existingOpenBorrowCollateralSumRaw.toString()} + signed ${exact.collateralAmountRaw.toString()} + ${exact.approvalSlackRaw.toString()} wei slack, tx ${res.txHash}).`
      );
    } catch (err) {
      setActionError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setTxBusy('');
    }
  }

  async function handleSignBorrowOrder(event) {
    event.preventDefault();
    if (txBusyRef.current) return;
    setActionError('');
    setActionNotice('');
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setActionError('Connect your wallet on Base before signing a BorrowOrder.');
      return;
    }
    if (eligibilityInfo && !eligibilityInfo.isEligible) {
      setActionError('IneligibleCounterparty: Wallet is not eligible in EligibilityGate on-chain.');
      return;
    }
    if (!quoteResult || !quoteResult.accepted) {
      setActionError('Click "1. Simulate live quote" and review an accepted quote before signing a BorrowOrder.');
      return;
    }
    const parsed = parseValidatedInputs();
    if (parsed.error) {
      setActionError(parsed.error);
      return;
    }
    txBusyRef.current = true;
    setTxBusy('sign');
    try {
      const signed = await prepareAndSignBorrowOrder({
        address: web3.address,
        collateralToken: assetObj.token,
        principalRaw: parsed.principalRaw,
        collateralAmountRaw: parsed.collateralRaw,
        collateralBufferBps: parsed.bufferBps,
        expectedQuote: quoteResult,
        requireExpectedQuote: true,
        maxRateBps: parsed.aprBps,
        termDays: parsed.termDays,
        maxLtvBps: parsed.maxLtvBps,
        minFillRaw: parsed.minFillRaw,
        existingOpenCollateralRaw: existingOpenBorrowCollateralSumRaw,
        expiryDays: parsed.expiryDays,
        yieldMode: yieldOn ? 1 : 0,
        allowInKindSettlement: false,
        attestationHex: web3.attestationHex,
        autoApprove: true,
        cfg: web3.config,
      });
      setQuoteResult(signed.quote);
      setLatestSignedOrder(signed);
      setCollateralReductionState(null);
      await Promise.all([loadAllowanceAndNonce(), syncPersistedOrders(), loadMarkets()]);
      setActionNotice(
        `Signed EIP-712 BorrowOrder ${signed.orderHash} with ${signed.exactAmounts.collateralAmountRaw} raw ${assetObj.symbol} (${signed.exactAmounts.bufferBps / 100}% buffer)${signed.publishedToApi ? ' and published to api/ orderbook.' : '.'}`
      );
    } catch (err) {
      setActionError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setTxBusy('');
    }
  }

  async function refreshPostCancelCollateralAllowance(cancelledHash = null, allInvalidated = false) {
    if (!web3?.address || !assetObj?.token) return;
    const stored = loadPersistedSignedOrders();
    const [freshMeta, freshPersisted, freshMarkets] = await Promise.all([
      loadAllowanceAndNonce(),
      stored.length > 0
        ? refreshSignedBorrowOrdersState({ orders: stored, cfg: web3?.config }).then((enriched) => {
            setPersistedOrders(enriched);
            return enriched;
          })
        : Promise.resolve([]).then(() => {
            setPersistedOrders([]);
            return [];
          }),
      fetchMarketSnapshot({
        cfg: web3?.config,
        includeLoans: false,
        includeAuctions: false,
      }),
    ]);
    if (freshMarkets) {
      setMarketState({ loading: false, data: freshMarkets });
    }
    const exclude = cancelledHash ? new Set([String(cancelledHash).toLowerCase()]) : null;
    const remainingSummary = allInvalidated
      ? { totalRaw: 0n, hasUnknown: false }
      : computeOpenBorrowOrdersCollateralTotal(
          web3.address,
          assetObj.token,
          freshPersisted,
          freshMarkets?.orders,
          exclude
        );
    const blockedByUnknown =
      !allInvalidated &&
      (remainingSummary.hasUnknown || !freshMarkets || Boolean(freshMarkets?.stale));
    const liveAllowanceRaw = freshMeta ? BigInt(freshMeta.allowanceRaw) : allowanceRawBig;
    if (
      liveAllowanceRaw > remainingSummary.totalRaw ||
      (blockedByUnknown && liveAllowanceRaw > 0n)
    ) {
      setCollateralReductionState({
        collateralToken: assetObj.token,
        symbol: assetObj.symbol ?? 'collateral',
        decimals: Number(assetObj.decimals ?? 18),
        currentAllowanceRaw: liveAllowanceRaw.toString(),
        targetAllowanceRaw: remainingSummary.totalRaw.toString(),
        blockedByUnknown,
      });
    } else {
      setCollateralReductionState(null);
    }
  }

  async function handleReduceCollateralAfterCancel() {
    if (txBusyRef.current || !web3?.address || !collateralReductionState) return;
    if (collateralReductionState.blockedByUnknown) {
      setCancelError(
        'Cannot reduce CollateralEscrow allowance while an open BorrowOrder has unknown on-chain status or RPC is degraded; refresh order statuses first.'
      );
      return;
    }
    setCancelError('');
    txBusyRef.current = true;
    setTxBusy('reduce-collateral-allowance');
    try {
      const targetRaw = collateralReductionState.targetAllowanceRaw;
      const res = await setCollateralAllowanceForBorrow({
        address: web3.address,
        collateralToken: collateralReductionState.collateralToken,
        targetAllowanceRaw: targetRaw,
        cfg: web3.config,
      });
      await loadAllowanceAndNonce();
      const dec = collateralReductionState.decimals;
      const sym = collateralReductionState.symbol;
      setCollateralReductionState(null);
      setCancelNotice(
        res.unchanged
          ? `CollateralEscrow ${sym} allowance is already ${formatTokenUnitsDisplay(targetRaw, dec, 6)} (${targetRaw} raw).`
          : `Reduced CollateralEscrow ${sym} allowance to ${formatTokenUnitsDisplay(res.allowanceRaw, dec, 6)} (${res.allowanceRaw} raw) (tx ${res.txHash}).`
      );
    } catch (err) {
      setCancelError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setTxBusy('');
    }
  }

  async function handleCancelOrder(orderObj) {
    if (txBusyRef.current || !web3?.address) return;
    setCancelError('');
    setCancelNotice('');
    setCollateralReductionState(null);
    txBusyRef.current = true;
    setTxBusy('cancel');
    try {
      const res = await cancelSignedBorrowOrder({
        address: web3.address,
        order: orderObj,
        cfg: web3.config,
      });
      await refreshPostCancelCollateralAllowance(res.orderHash, false);
      setCancelNotice(`Cancelled order ${res.orderHash} on-chain (tx ${res.txHash}).`);
    } catch (err) {
      setCancelError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setTxBusy('');
    }
  }

  async function handleCancelPastedJson(event) {
    event.preventDefault();
    if (txBusyRef.current) return;
    setCancelError('');
    setCancelNotice('');
    setCollateralReductionState(null);
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setCancelError('Connect your wallet on Base before cancelling an order.');
      return;
    }
    let parsed;
    try {
      parsed = parseBorrowOrderFromJson(pasteCancelJson);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
      return;
    }
    txBusyRef.current = true;
    setTxBusy('cancel-paste');
    try {
      const res = await cancelSignedBorrowOrder({
        address: web3.address,
        order: parsed.order,
        cfg: web3.config,
      });
      await refreshPostCancelCollateralAllowance(res.orderHash, false);
      setCancelNotice(`Cancelled pasted BorrowOrder ${res.orderHash} on-chain (tx ${res.txHash}).`);
    } catch (err) {
      setCancelError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setTxBusy('');
    }
  }

  async function handleBumpAllNonces() {
    if (txBusyRef.current) return;
    setCancelError('');
    setCancelNotice('');
    setCollateralReductionState(null);
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setCancelError('Connect your wallet on Base before bumping your maker nonce.');
      return;
    }
    txBusyRef.current = true;
    setTxBusy('bump-nonce');
    try {
      const res = await bumpMakerNonceOnChain({
        address: web3.address,
        cfg: web3.config,
      });
      await refreshPostCancelCollateralAllowance(null, true);
      setCancelNotice(
        `Called OrderSettlement.bumpNonce() (tx ${res.txHash}). Maker nonce is now ${res.newNonce}; all open orders signed at earlier nonces are invalidated on-chain.`
      );
    } catch (err) {
      setCancelError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setTxBusy('');
    }
  }

  async function copyOrderPayload(item) {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            orderHash: item.orderHash,
            order: item.orderJson,
            signature: item.signature,
          },
          null,
          2
        )
      );
      setCopiedHash(item.orderHash);
    } catch {
      setCopiedHash('');
    }
  }

  function parseLendOfferPayload(rawText) {
    let parsedJson;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      throw new Error('Paste valid JSON containing { "offer": { ... }, "signature": "0x..." }.');
    }
    const offer = parsedJson?.offer ?? parsedJson?.signed_order ?? parsedJson;
    const signature = parsedJson?.signature;
    if (!offer || !signature || typeof signature !== 'string') {
      throw new Error('Lend offer JSON must include both "offer" (or "signed_order") and "signature".');
    }
    return { offer, signature };
  }

  function resolveLendFillUsdcRaw() {
    if (
      selectedLendRemainingRaw &&
      lendFillUsdcStr.trim() === formatUnits(BigInt(selectedLendRemainingRaw), USDC_DECIMALS)
    ) {
      return selectedLendRemainingRaw;
    }
    return parseDecimalToRaw(lendFillUsdcStr, USDC_DECIMALS);
  }

  async function handleVerifyLendOffer(event) {
    if (event) event.preventDefault();
    if (txBusyRef.current) return;
    setLendFillError('');
    setLendFillResult(null);
    setLendPreview(null);
    if (!assetObj?.token) {
      setLendFillError('Select a collateral token above first.');
      return;
    }
    if (parsedBufferBps === null) {
      setLendFillError('Enter a valid collateral buffer percentage (0.00%–50.00%).');
      return;
    }
    const fillUsdcRaw = resolveLendFillUsdcRaw();
    if (!fillUsdcRaw) {
      setLendFillError('Enter a valid positive USDC fill amount (up to 6 decimals).');
      return;
    }
    let payload;
    try {
      payload = parseLendOfferPayload(lendOfferJsonStr);
    } catch (err) {
      setLendFillError(err instanceof Error ? err.message : String(err));
      return;
    }

    const previewSeq = ++lendPreviewSeqRef.current;
    setLendPreviewBusy(true);
    try {
      const preview = await verifyAndPreviewLendOfferFill({
        offer: payload.offer,
        signature: payload.signature,
        collateralToken: assetObj.token,
        fillUsdcRaw,
        collateralBufferBps: parsedBufferBps,
        existingOpenCollateralRaw: existingOpenBorrowCollateralSumRaw,
        borrowerAddress: web3?.connected && !web3?.wrongNetwork ? web3.address : null,
        borrowerAttestation: web3?.attestationHex ?? '0x',
        cfg: web3?.config,
      });
      if (previewSeq !== lendPreviewSeqRef.current) return;
      setLendPreview(preview);
    } catch (err) {
      if (previewSeq !== lendPreviewSeqRef.current) return;
      setLendFillError(formatWeb3Error(err));
    } finally {
      if (previewSeq === lendPreviewSeqRef.current) {
        setLendPreviewBusy(false);
      }
    }
  }

  async function handleConfirmFillLendOffer() {
    if (txBusyRef.current || !lendPreview) return;
    setLendFillError('');
    setLendFillResult(null);
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setLendFillError('Connect your wallet on Base before filling a LendOffer.');
      return;
    }
    txBusyRef.current = true;
    setLendFillBusy(true);
    try {
      const res = await fillLendOfferAsBorrower({
        address: web3.address,
        offer: lendPreview.offer,
        signature: lendPreview.signature,
        collateralToken: lendPreview.collateralToken,
        fillUsdcRaw: lendPreview.fillAmountRaw,
        collateralBufferBps: parsedBufferBps ?? DEFAULT_COLLATERAL_BUFFER_BPS,
        existingOpenCollateralRaw: existingOpenBorrowCollateralSumRaw,
        expectedPreview: lendPreview,
        borrowerAttestation: web3.attestationHex,
        autoApprove: true,
        cfg: web3.config,
      });
      setLendFillResult(res);
      setLendPreview(null);
      await Promise.all([loadAllowanceAndNonce(), loadMarkets(), web3.refresh()]);
    } catch (err) {
      setLendFillError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setLendFillBusy(false);
    }
  }

  return (
    <Page
      kicker="Borrow · WS3.3"
      title="Quote, approve & sign a BorrowOrder."
      lede="Quotes come directly from api/ GET /quote using live Base AssetRegistry, OracleRouter, FeeCollector, and EligibilityGate reads. Approvals and EIP-712 order signatures always use exact/rounded-up raw token integers (with default +5.00% collateral buffer for partial fills and price ticks)."
    >
      {marketState.data && (marketState.data.stale || marketState.data.degraded || marketState.data.error) ? (
        <p className="err block" role="alert">
          Live market telemetry degraded or unavailable — {marketState.data.error}
        </p>
      ) : null}

      {!web3?.connected ? (
        <div className="note block">
          <p className="hint">Connect a Base wallet to read your B20 balance, CollateralEscrow allowance, EligibilityGate status, and OrderSettlement maker nonce.</p>
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

          <div className="split">
            <Field
              id="borrow-buffer"
              label="Collateral buffer (%)"
              hint="Default +5.00% above minimum required so partial fills ($800/$500) & minor price ticks do not hit LtvExceeded."
            >
              {(props) => (
                <TextInput
                  id="borrow-buffer"
                  value={bufferPctStr}
                  onChange={updateField(setBufferPctStr)}
                  {...props}
                />
              )}
            </Field>
            <Field
              id="borrow-collateral"
              label={`Optional collateral override (${assetObj?.symbol ?? 'tokens'})`}
              hint="Leave empty to use exact quote min + buffer above."
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
          </div>

          <div className="split">
            <Field id="borrow-rate" label="Fixed APR (%)" hint="0.00% to 40.00% fixed loan APR if filled.">
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

          {partialRemainderWarning ? (
            <p className="hint" role="note">
              {partialRemainderWarning}
            </p>
          ) : null}

          {quoteResult?.warnings?.length > 0 ? (
            <div className="hint" role="note">
              {quoteResult.warnings.map((w) => (
                <p key={w.code}>
                  Warning ({w.code}): {w.message}
                </p>
              ))}
            </div>
          ) : null}

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
              disabled={
                !web3?.connected ||
                web3?.wrongNetwork ||
                Boolean(txBusy) ||
                !assetObj ||
                quoteLoading ||
                !quoteResult ||
                !quoteResult.accepted
              }
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
              disabled={
                !web3?.connected ||
                web3?.wrongNetwork ||
                Boolean(txBusy) ||
                !assetObj ||
                quoteLoading ||
                !quoteResult ||
                !quoteResult.accepted ||
                Boolean(eligibilityInfo && !eligibilityInfo.isEligible)
              }
            >
              {txBusy === 'sign' ? '3. Signing EIP-712 order…' : '3. Sign & publish BorrowOrder'}
            </button>
          </div>
        </div>

        <Sheet
          sticky
          title="On-chain quote & wallet readiness"
          note="Approval and EIP-712 BorrowOrder use exact raw integers from quote.amounts.*.raw + buffer, never rounded display strings."
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
              {
                label: 'EligibilityGate (on-chain)',
                value: eligibilityStatusText,
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
                    label: `Min required collateral (${quoteResult.asset.decimals} dec)`,
                    value: `${formatTokenUnitsDisplay(exactQuoteAmounts.minRequiredCollateralRaw, quoteResult.asset.decimals, 6)} ${quoteResult.asset.symbol} (${exactQuoteAmounts.minRequiredCollateralRaw.toString()} raw)`,
                  }
                : null,
              exactQuoteAmounts
                ? {
                    label: `Buffered collateral (+${(exactQuoteAmounts.bufferBps / 100).toFixed(2)}%)`,
                    value: `${formatTokenUnitsDisplay(exactQuoteAmounts.collateralAmountRaw, quoteResult.asset.decimals, 6)} ${quoteResult.asset.symbol} (${exactQuoteAmounts.collateralAmountRaw.toString()} raw)`,
                  }
                : null,
              tokenMeta.data
                ? {
                    label: 'Open BorrowOrders collateral reserve',
                    value: `${formatTokenUnitsDisplay(existingOpenBorrowCollateralSumRaw, tokenMeta.data.decimals, 6)} ${tokenMeta.data.symbol} (${existingOpenBorrowCollateralSumRaw.toString()} raw)`,
                  }
                : null,
              exactQuoteAmounts
                ? {
                    label: `Approval required (open + signed + ${exactQuoteAmounts.approvalSlackRaw.toString()} wei slack)`,
                    value: `${exactQuoteAmounts.requiredApprovalRaw.toString()} raw (covers ${exactQuoteAmounts.maxFills.toString()} max fill(s))`,
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
              Wallet {assetObj?.symbol} balance ({tokenMeta.data.balanceRaw} raw) is below required {exactQuoteAmounts.requiredApprovalRaw.toString()} raw (signed collateral + {exactQuoteAmounts.approvalSlackRaw.toString()} wei fill slack).
            </p>
          ) : null}
          {quoteResult && !quoteResult.accepted ? (
            <p className="err" style={{ marginTop: 12 }}>
              {quoteResult.rejection_reasons.map((r) => `${r.code}: ${r.message}`).join('; ')}
            </p>
          ) : null}
        </Sheet>
      </form>

      {latestSignedOrder ? (
        <section className="block">
          <h2>Latest signed EIP-712 BorrowOrder</h2>
          <p className="hint">
            Order hash: <code>{latestSignedOrder.orderHash}</code>
            {latestSignedOrder.approvalTxHash ? ` · Approval tx: ${latestSignedOrder.approvalTxHash}` : ''}
            {latestSignedOrder.publishedToApi ? ' · Published to live api/ orderbook' : latestSignedOrder.publishError ? ` · Relay note: ${latestSignedOrder.publishError}` : ''}
          </p>
          <pre className="json">
            {JSON.stringify(
              {
                orderHash: latestSignedOrder.orderHash,
                order: latestSignedOrder.orderJson,
                signature: latestSignedOrder.signature,
              },
              null,
              2
            )}
          </pre>
        </section>
      ) : null}

      <section className="block">
        <h2>Manage &amp; cancel your BorrowOrders</h2>
        <p className="hint">
          Signed orders stay persisted locally across field edits and are published to api/ POST /orders. You can cancel individual orders on-chain, cancel from pasted JSON, or bump your maker nonce to invalidate every open order at your current nonce.
        </p>

        <div className="actions">
          <button
            className="btn secondary"
            type="button"
            onClick={() => void syncPersistedOrders()}
            disabled={ordersRefreshing || Boolean(txBusy)}
          >
            {ordersRefreshing ? 'Checking on-chain status…' : 'Refresh order statuses'}
          </button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => void handleBumpAllNonces()}
            disabled={!web3?.connected || web3?.wrongNetwork || Boolean(txBusy)}
          >
            {txBusy === 'bump-nonce'
              ? 'Bumping maker nonce…'
              : `Cancel all open orders (bumpNonce${tokenMeta.data ? ` · current nonce ${tokenMeta.data.makerNonce}` : ''})`}
          </button>
          <Link className="btn secondary" to="/markets">
            View live order book
          </Link>
        </div>

        {cancelError ? <p className="err block" role="alert">{cancelError}</p> : null}
        {cancelNotice ? <p className="note block" role="status">{cancelNotice}</p> : null}
        {collateralReductionState ? (
          <div className="err block" role="status" style={{ marginTop: 10 }}>
            <p>
              Warning: CollateralEscrow {collateralReductionState.symbol} allowance is still{' '}
              {formatTokenUnitsDisplay(
                collateralReductionState.currentAllowanceRaw,
                collateralReductionState.decimals,
                6
              )}{' '}
              ({collateralReductionState.currentAllowanceRaw} raw), above remaining open BorrowOrders (
              {formatTokenUnitsDisplay(
                collateralReductionState.targetAllowanceRaw,
                collateralReductionState.decimals,
                6
              )}{' '}
              / {collateralReductionState.targetAllowanceRaw} raw).{' '}
              {collateralReductionState.blockedByUnknown
                ? 'One or more BorrowOrders currently have unknown on-chain status; allowance reduction is blocked until "Refresh order statuses" reads cleanly.'
                : 'Reduce or revoke excess allowance to limit contract exposure.'}
            </p>
            <div className="actions" style={{ marginTop: 8 }}>
              <button
                className="btn secondary"
                type="button"
                onClick={() => void handleReduceCollateralAfterCancel()}
                disabled={Boolean(txBusy) || Boolean(collateralReductionState.blockedByUnknown)}
              >
                {collateralReductionState.blockedByUnknown
                  ? 'Reduction blocked (unknown order status)'
                  : txBusy === 'reduce-collateral-allowance'
                    ? 'Updating CollateralEscrow allowance…'
                    : `Reduce CollateralEscrow ${collateralReductionState.symbol} allowance to ${formatTokenUnitsDisplay(collateralReductionState.targetAllowanceRaw, collateralReductionState.decimals, 6)}`}
              </button>
            </div>
          </div>
        ) : null}

        {persistedOrders.length === 0 ? (
          <p className="hint block">No persisted BorrowOrders saved in this browser yet.</p>
        ) : (
          <div className="block">
            {persistedOrders.map((item) => {
              const ord = item.orderJson ?? {};
              const statusLabel = item.onchainStatus ?? (item.cancelledTxHash ? 'cancelled' : 'saved');
              const isCancelable =
                statusLabel === 'open' || statusLabel === 'partially_filled' || statusLabel === 'saved';
              return (
                <article className="order-row" key={item.orderHash}>
                  <div>
                    <strong>
                      Order {String(item.orderHash).slice(0, 14)}… · Status: {statusLabel}
                    </strong>
                    <span className="quiet">
                      Principal ${formatTokenUnitsDisplay(ord.minUsdc ?? '0', USDC_DECIMALS, 2)} · Collateral raw{' '}
                      {ord.collateralAmount ?? '0'} · Fixed APR {formatBpsPercent(ord.maxRateBps)} · Term {ord.termDays}d · Nonce {ord.nonce}
                    </span>
                    <span className="quiet">
                      Maker {shortAddress(ord.borrower)} · Remaining $
                      {formatTokenUnitsDisplay(item.remainingRaw ?? ord.minUsdc ?? '0', USDC_DECIMALS, 2)} ·{' '}
                      {item.publishedToApi ? 'Published to api/' : 'Local only'}
                    </span>
                  </div>
                  <div className="actions">
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => void copyOrderPayload(item)}
                    >
                      {copiedHash === item.orderHash ? 'Copied JSON' : 'Copy JSON'}
                    </button>
                    {isCancelable && web3?.address && ord.borrower?.toLowerCase() === web3.address.toLowerCase() ? (
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => void handleCancelOrder(ord)}
                        disabled={Boolean(txBusy)}
                      >
                        {txBusy === 'cancel' ? 'Cancelling…' : 'Cancel on-chain'}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <form className="fields block" onSubmit={handleCancelPastedJson}>
          <div className="field">
            <label htmlFor="cancel-paste-json">Cancel a BorrowOrder from pasted JSON</label>
            <textarea
              id="cancel-paste-json"
              rows={3}
              value={pasteCancelJson}
              onChange={(e) => setPasteCancelJson(e.target.value)}
              placeholder='Paste { "order": { ... }, "signature": "0x..." } or raw BorrowOrder JSON'
              style={{
                width: '100%',
                padding: 12,
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--sheet)',
              }}
            />
          </div>
          <div className="actions">
            <button
              className="btn secondary"
              type="submit"
              disabled={!web3?.connected || web3?.wrongNetwork || Boolean(txBusy) || !pasteCancelJson.trim()}
            >
              {txBusy === 'cancel-paste' ? 'Cancelling pasted order…' : 'Cancel pasted BorrowOrder on-chain'}
            </button>
          </div>
        </form>
      </section>

      <section className="block">
        <h2>Fill a signed LendOffer (as borrower)</h2>
        <p className="hint">
          Select an open signed LendOffer from api/ or paste JSON (`{`{ "offer": ..., "signature": "0x..." }`}`). We verify the signature, expiry, nonce, remaining capacity, lender USDC allowance, and simulate the fill via eth_call BEFORE asking for an ERC-20 approve transaction.
        </p>

        {openLendOffers.length > 0 ? (
          <div className="chips block" role="group" aria-label="Open relayed lend offers">
            {openLendOffers.map((row) => (
              <button
                key={row.order_hash}
                type="button"
                onClick={() => {
                  const rawRemaining = String(row.remaining_usdc?.raw ?? row.min_usdc?.raw ?? '500000000');
                  setLendOfferJsonStr(
                    JSON.stringify(
                      {
                        orderHash: row.order_hash,
                        offer: row.signed_order,
                        signature: row.signature,
                      },
                      null,
                      2
                    )
                  );
                  setSelectedLendRemainingRaw(rawRemaining);
                  setLendFillUsdcStr(formatUnits(BigInt(rawRemaining), USDC_DECIMALS));
                  setLendPreview(null);
                  setLendFillError('');
                  setLendFillResult(null);
                }}
              >
                LendOffer {row.order_hash.slice(0, 10)}… · $
                {formatTokenUnitsDisplay(row.remaining_usdc?.raw ?? row.min_usdc?.raw ?? '0', USDC_DECIMALS, 2)} @{' '}
                {formatBpsPercent(row.min_rate_bps ?? row.rate_bps)}
              </button>
            ))}
          </div>
        ) : null}

        <form className="fields" onSubmit={handleVerifyLendOffer}>
          <div className="field">
            <label htmlFor="lend-offer-json">Signed LendOffer JSON</label>
            <textarea
              id="lend-offer-json"
              rows={4}
              value={lendOfferJsonStr}
              onChange={(e) => {
                setLendOfferJsonStr(e.target.value);
                setLendPreview(null);
                setLendFillError('');
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
          <Field id="lend-fill-usdc" label="USDC to borrow from offer (up to 6 decimals)">
            {(props) => (
              <TextInput
                id="lend-fill-usdc"
                value={lendFillUsdcStr}
                onChange={(v) => {
                  setLendFillUsdcStr(v);
                  setSelectedLendRemainingRaw('');
                  setLendPreview(null);
                  setLendFillError('');
                }}
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
              disabled={lendPreviewBusy || lendFillBusy || !assetObj || !lendOfferJsonStr.trim()}
            >
              {lendPreviewBusy ? 'Verifying & simulating fill…' : '1. Verify & preview LendOffer fill'}
            </button>
          </div>
        </form>

        {lendPreview ? (
          <Sheet
            title="LendOffer fill review (pre-approval simulation verified)"
            note="Signature, expiry, nonce, cancellation status, lender USDC allowance, EligibilityGate, and OrderSettlement.fillLendOffer() eth_call all passed. Confirm below to approve exact collateral (if needed) and fill."
          >
            {lendPreview.warnings?.length > 0 ? (
              <div className="err block" role="note">
                {lendPreview.warnings.map((w) => (
                  <p key={w.code}>
                    Warning ({w.code}): {w.message}
                  </p>
                ))}
              </div>
            ) : null}
            <Rows
              items={[
                { label: 'Lender', value: lendPreview.lender },
                { label: 'Order hash', value: lendPreview.orderHash },
                { label: 'Fixed APR', value: formatBpsPercent(lendPreview.rateBps) },
                { label: 'Term / Max LTV', value: `${lendPreview.termDays} days · ${formatBpsPercent(lendPreview.maxLtvBps)}` },
                { label: 'Offer expiry (UTC)', value: new Date(lendPreview.expiry * 1000).toISOString() },
                {
                  label: 'Remaining / Min fill (USDC)',
                  value: `$${formatTokenUnitsDisplay(lendPreview.remainingRaw, USDC_DECIMALS, 2)} / $${formatTokenUnitsDisplay(lendPreview.minFillRaw, USDC_DECIMALS, 2)}`,
                },
                {
                  label: 'Requested fill USDC (6 dec)',
                  value: `$${formatTokenUnitsDisplay(lendPreview.fillAmountRaw, USDC_DECIMALS, 2)} (${lendPreview.fillAmountRaw} raw)`,
                },
                {
                  label: `Min required / Buffered collateral (+${(lendPreview.exact.bufferBps / 100).toFixed(2)}%)`,
                  value: `${formatTokenUnitsDisplay(lendPreview.exact.collateralAmountRaw, lendPreview.collateralDecimals, 6)} ${lendPreview.collateralSymbol} (${lendPreview.exact.collateralAmountRaw.toString()} raw · min ${lendPreview.exact.minRequiredCollateralRaw.toString()} raw)`,
                },
                {
                  label: 'Origination fee / Net USDC proceeds',
                  value: `$${formatTokenUnitsDisplay(lendPreview.exact.originationFeeRaw, USDC_DECIMALS, 2)} / $${formatTokenUnitsDisplay(lendPreview.exact.netProceedsRaw, USDC_DECIMALS, 2)}`,
                },
                {
                  label: 'Total repayment at maturity',
                  value: `$${formatTokenUnitsDisplay(lendPreview.exact.totalRepaymentAtMaturityRaw, USDC_DECIMALS, 2)} (${lendPreview.exact.totalRepaymentAtMaturityRaw.toString()} raw)`,
                },
                {
                  label: 'Open BorrowOrders collateral / Required CollateralEscrow allowance',
                  value: `${formatTokenUnitsDisplay(lendPreview.existingOpenCollateralRaw ?? '0', lendPreview.collateralDecimals, 6)} ${lendPreview.collateralSymbol} (${lendPreview.existingOpenCollateralRaw ?? '0'} raw) · Need ${formatTokenUnitsDisplay(lendPreview.requiredApprovalRaw ?? lendPreview.exact.collateralAmountRaw, lendPreview.collateralDecimals, 6)} ${lendPreview.collateralSymbol} (${(lendPreview.requiredApprovalRaw ?? lendPreview.exact.collateralAmountRaw).toString()} raw)`,
                },
                {
                  label: 'Pre-approval eth_call simulation',
                  value: lendPreview.simulationVerified
                    ? lendPreview.needsApproval
                      ? `Verified (ERC-20 approval required: ${formatTokenUnitsDisplay(lendPreview.requiredApprovalRaw ?? lendPreview.exact.collateralAmountRaw, lendPreview.collateralDecimals, 6)} ${lendPreview.collateralSymbol})`
                      : 'Verified (allowance sufficient)'
                    : 'Pending wallet connection',
                },
              ]}
            />
            <div className="actions" style={{ marginTop: 14 }}>
              <button
                className="btn"
                type="button"
                onClick={() => void handleConfirmFillLendOffer()}
                disabled={lendFillBusy || !web3?.connected || web3?.wrongNetwork}
              >
                {lendFillBusy
                  ? '2. Approving & filling LendOffer…'
                  : '2. Confirm: Approve & fill LendOffer on-chain'}
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() => setLendPreview(null)}
                disabled={lendFillBusy}
              >
                Clear preview
              </button>
            </div>
          </Sheet>
        ) : null}
      </section>
    </Page>
  );
}
