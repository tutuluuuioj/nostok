import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatUnits, zeroAddress } from 'viem';
import {
  ComplianceTxGateBanner,
  formatRegSDeclarationRowValue,
} from '../components/DeclarationPanel.jsx';
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
  approveUsdcForLend,
  bumpMakerNonceOnChain,
  cancelSignedLendOffer,
  classifyPersistedOrderRemoval,
  fetchRelayOrderByHash,
  fillBorrowOrderAsLender,
  formatTokenUnitsDisplay,
  formatWeb3Error,
  isNonFinalOrderStatus,
  loadPersistedSignedLendOffers,
  parseBorrowOrderFromJson,
  parseLendOfferFromJson,
  prepareAndSignLendOffer,
  readLendAllowanceAndNonce,
  refreshSignedLendOffersState,
  removeSignedLendOffer,
  resolveExactLendAmounts,
  resolveOpenLendOffersSumRaw,
  setUsdcAllowanceForLend,
  shortAddress,
  validateLendPartialFillPlan,
  verifyAndPreviewBorrowOrderFill,
} from '../lib/web3.js';
import { useStore } from '../store.jsx';

function safeFormatUnits(raw, decimals, fracDigits = 2) {
  try {
    return formatTokenUnitsDisplay(raw ?? 0n, decimals, fracDigits);
  } catch {
    return 'Invalid';
  }
}

function parseRawListInput(rawStr, decimals, label) {
  const clean = String(rawStr ?? '').trim();
  if (!clean) return { error: '', list: null };
  const parts = clean.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { error: '', list: null };
  const out = [];
  for (const part of parts) {
    const raw = parseDecimalToRaw(part, decimals);
    if (!raw) {
      return {
        error: `Enter valid positive ${label} amounts separated by commas (up to ${decimals} decimals).`,
        list: null,
      };
    }
    out.push(raw);
  }
  return { error: '', list: out };
}

function computeOpenLendOffersRawTotal(
  walletAddress,
  persistedList = [],
  marketOrders = [],
  excludeHashes = null,
  { ordersTruncated = false } = {}
) {
  if (!walletAddress) return { totalRaw: 0n, hasUnknown: false };
  const addrLower = walletAddress.toLowerCase();
  const seenHashes = new Set();
  if (excludeHashes) {
    for (const h of excludeHashes) {
      if (h) seenHashes.add(String(h).toLowerCase());
    }
  }
  let totalRaw = 0n;
  let hasUnknown = Boolean(ordersTruncated);

  for (const item of persistedList ?? []) {
    const maker = String(item?.offerJson?.lender ?? '').toLowerCase();
    if (maker && maker !== addrLower) continue;
    if (!maker) {
      hasUnknown = true;
      continue;
    }
    const h = String(item?.orderHash ?? '').toLowerCase();
    const st = item?.onchainStatus;
    if (!isNonFinalOrderStatus(st)) {
      if (h) seenHashes.add(h);
      continue;
    }
    if (st === 'unknown') hasUnknown = true;
    if (h && seenHashes.has(h)) continue;
    if (h) seenHashes.add(h);
    try {
      totalRaw += BigInt(item.remainingRaw ?? item.offerJson?.usdcAmount ?? 0n);
    } catch {
      hasUnknown = true;
    }
  }

  for (const row of marketOrders ?? []) {
    if (row.order_type !== 'lend' && row.order_type !== 'LendOffer') continue;
    if (!row?.signed_order || !row?.signature) continue;
    if (String(row.maker ?? '').toLowerCase() !== addrLower) continue;
    const st = row.status;
    if (!isNonFinalOrderStatus(st)) continue;
    if (st === 'unknown') hasUnknown = true;
    const h = String(row.order_hash ?? '').toLowerCase();
    if (h && seenHashes.has(h)) continue;
    if (h) seenHashes.add(h);
    try {
      totalRaw += BigInt(row.remaining_usdc?.raw ?? row.min_usdc?.raw ?? 0n);
    } catch {
      hasUnknown = true;
    }
  }
  return { totalRaw, hasUnknown };
}

export function Lend() {
  const { web3 } = useStore();
  const [searchParams] = useSearchParams();
  const [marketState, setMarketState] = useState({ loading: true, data: null });
  const reqSeqRef = useRef(0);
  const prefilledBorrowHashRef = useRef('');

  const [usdcStr, setUsdcStr] = useState('1000');
  const [ratePct, setRatePct] = useState('8.00');
  const [termDaysStr, setTermDaysStr] = useState('30');
  const [allowedCollateral, setAllowedCollateral] = useState(zeroAddress);
  const [maxLtvPct, setMaxLtvPct] = useState('60.00');
  const [minFillStr, setMinFillStr] = useState('500');
  const [partialPlanStr, setPartialPlanStr] = useState('');
  const [expiryDaysStr, setExpiryDaysStr] = useState('7');
  const [yieldMode, setYieldMode] = useState(0);

  const [lendMeta, setLendMeta] = useState({ loading: false, data: null, error: '' });
  const lendMetaSeqRef = useRef(0);

  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteResult, setQuoteResult] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const quoteSeqRef = useRef(0);

  const [txBusy, setTxBusy] = useState('');
  const txBusyRef = useRef(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [latestSignedOffer, setLatestSignedOffer] = useState(null);
  const [copiedHash, setCopiedHash] = useState('');

  const [persistedOffers, setPersistedOffers] = useState(() => loadPersistedSignedLendOffers());
  const [offersRefreshing, setOffersRefreshing] = useState(false);
  const [pasteCancelJson, setPasteCancelJson] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [cancelNotice, setCancelNotice] = useState('');
  const [allowanceReductionState, setAllowanceReductionState] = useState(null);
  const [makerOpenOffers, setMakerOpenOffers] = useState({
    loading: false,
    sumRaw: 0n,
    error: '',
  });
  const makerOpenSeqRef = useRef(0);

  // BorrowOrder fill workflow (Step 1 verify & simulate -> review terms -> Step 2 approve USDC & fill -> PositionNFT)
  const [borrowOrderJsonStr, setBorrowOrderJsonStr] = useState('');
  const [selectedBorrowRemainingRaw, setSelectedBorrowRemainingRaw] = useState('');
  const [borrowFillUsdcStr, setBorrowFillUsdcStr] = useState('500');
  const [borrowMultiFillPlanStr, setBorrowMultiFillPlanStr] = useState('');
  const [borrowPreviewBusy, setBorrowPreviewBusy] = useState(false);
  const [borrowPreview, setBorrowPreview] = useState(null);
  const borrowPreviewSeqRef = useRef(0);
  const [borrowFillBusy, setBorrowFillBusy] = useState(false);
  const [borrowFillResult, setBorrowFillResult] = useState(null);
  const [borrowFillError, setBorrowFillError] = useState('');

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
  }, [web3?.config]);

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  const assets = marketState.data?.assets ?? [];
  const quoteAssetObj = useMemo(() => {
    if (allowedCollateral && allowedCollateral !== zeroAddress) {
      return assets.find((a) => a.token?.toLowerCase() === allowedCollateral.toLowerCase()) ?? null;
    }
    return assets.find((a) => Number(a.status) === 0) ?? assets[0] ?? null;
  }, [allowedCollateral, assets]);

  const openBorrowOrders = useMemo(() => {
    const all = marketState.data?.orders ?? [];
    return all.filter(
      (o) =>
        (o.order_type === 'borrow' || o.order_type === 'BorrowOrder') &&
        (o.status === 'open' || o.status === 'partially_filled') &&
        o.signed_order &&
        o.signature
    );
  }, [marketState.data?.orders]);

  const applyBorrowOrderSelection = useCallback((row) => {
    const remRaw = String(
      row?.remaining_usdc?.raw ?? row?.min_usdc?.raw ?? row?.signed_order?.minUsdc ?? '500000000'
    );
    setBorrowOrderJsonStr(
      JSON.stringify(
        {
          orderHash: row.order_hash,
          order: row.signed_order,
          signature: row.signature,
        },
        null,
        2
      )
    );
    setSelectedBorrowRemainingRaw(remRaw);
    setBorrowFillUsdcStr(formatUnits(BigInt(remRaw), USDC_DECIMALS));
    setBorrowPreview(null);
    setBorrowFillError('');
    setBorrowFillResult(null);
  }, []);

  useEffect(() => {
    const borrowOrderParam = (searchParams.get('borrowOrder') ?? '').trim();
    if (!borrowOrderParam) return;
    const targetHash = borrowOrderParam.toLowerCase();
    if (prefilledBorrowHashRef.current === targetHash) return;

    const fromBook = (marketState.data?.orders ?? []).find(
      (o) =>
        String(o?.order_hash ?? '').toLowerCase() === targetHash &&
        (o.order_type === 'borrow' || o.order_type === 'BorrowOrder') &&
        o.signed_order &&
        o.signature
    );
    if (fromBook) {
      prefilledBorrowHashRef.current = targetHash;
      applyBorrowOrderSelection(fromBook);
      return;
    }
    if (marketState.loading || !web3?.config?.apiUrl) return;

    let cancelled = false;
    prefilledBorrowHashRef.current = targetHash;
    void fetchRelayOrderByHash(targetHash, { cfg: web3.config })
      .then((row) => {
        if (cancelled) return;
        if (
          row &&
          (row.order_type === 'borrow' || row.order_type === 'BorrowOrder') &&
          row.signed_order &&
          row.signature
        ) {
          applyBorrowOrderSelection(row);
        } else if (row) {
          setBorrowFillError(
            `Order ${row.order_hash} cannot be filled on /lend (type=${row.order_type}, status=${row.status}).`
          );
        } else {
          setBorrowFillError(`BorrowOrder ${borrowOrderParam} was not found in api/ /orders.`);
        }
      })
      .catch((err) => {
        if (!cancelled) setBorrowFillError(formatWeb3Error(err));
      });
    return () => {
      cancelled = true;
    };
  }, [applyBorrowOrderSelection, marketState.data?.orders, marketState.loading, searchParams, web3?.config]);

  const syncPersistedOffers = useCallback(async () => {
    const stored = loadPersistedSignedLendOffers();
    if (stored.length === 0) {
      setPersistedOffers([]);
      return;
    }
    setOffersRefreshing(true);
    try {
      const enriched = await refreshSignedLendOffersState({
        offers: stored,
        cfg: web3?.config,
      });
      setPersistedOffers(enriched);
    } finally {
      setOffersRefreshing(false);
    }
  }, [web3?.config]);

  useEffect(() => {
    void syncPersistedOffers();
  }, [syncPersistedOffers]);

  const loadAllowanceAndNonce = useCallback(async () => {
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setLendMeta({ loading: false, data: null, error: '' });
      return null;
    }
    const seq = ++lendMetaSeqRef.current;
    setLendMeta((prev) => ({ loading: true, data: prev.data, error: '' }));
    try {
      const res = await readLendAllowanceAndNonce(web3.address, {
        cfg: web3.config,
        attestationHex: web3.attestationHex,
      });
      if (seq !== lendMetaSeqRef.current) return null;
      setLendMeta({ loading: false, data: res, error: '' });
      return res;
    } catch (err) {
      if (seq !== lendMetaSeqRef.current) return null;
      setLendMeta({ loading: false, data: null, error: formatWeb3Error(err) });
      return null;
    }
  }, [web3?.address, web3?.attestationHex, web3?.config, web3?.connected, web3?.wrongNetwork]);

  useEffect(() => {
    void loadAllowanceAndNonce();
  }, [loadAllowanceAndNonce]);

  const loadMakerOpenOffers = useCallback(async () => {
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setMakerOpenOffers({ loading: false, sumRaw: 0n, error: '' });
      return null;
    }
    const seq = ++makerOpenSeqRef.current;
    setMakerOpenOffers((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const sumRaw = await resolveOpenLendOffersSumRaw({
        lenderAddress: web3.address,
        existingOpenSumRaw: null,
        cfg: web3?.config,
      });
      if (seq !== makerOpenSeqRef.current) return null;
      setMakerOpenOffers({ loading: false, sumRaw, error: '' });
      return sumRaw;
    } catch (err) {
      if (seq !== makerOpenSeqRef.current) return null;
      setMakerOpenOffers({
        loading: false,
        sumRaw: 0n,
        error: formatWeb3Error(err),
      });
      return null;
    }
  }, [web3?.address, web3?.config, web3?.connected, web3?.wrongNetwork]);

  useEffect(() => {
    void loadMakerOpenOffers();
  }, [loadMakerOpenOffers, persistedOffers]);

  useEffect(() => {
    quoteSeqRef.current += 1;
    borrowPreviewSeqRef.current += 1;
    makerOpenSeqRef.current += 1;
    setQuoteLoading(false);
    setQuoteResult(null);
    setQuoteError('');
    setActionError('');
    setActionNotice('');
    setLatestSignedOffer(null);
    setCancelError('');
    setCancelNotice('');
    setAllowanceReductionState(null);
    setMakerOpenOffers({ loading: false, sumRaw: 0n, error: '' });
    setBorrowPreviewBusy(false);
    setBorrowPreview(null);
    setBorrowFillResult(null);
    setBorrowFillError('');
  }, [web3?.address, web3?.chainId, web3?.wrongNetwork]);

  const updateField = useCallback((setter) => (value) => {
    quoteSeqRef.current += 1;
    setQuoteLoading(false);
    setQuoteResult(null);
    setQuoteError('');
    setActionError('');
    setActionNotice('');
    setter(value);
  }, []);

  const existingOpenUsdcSumRaw = makerOpenOffers.sumRaw;

  const parseValidatedOfferInputs = useCallback(() => {
    if (!quoteAssetObj?.token) {
      return { error: 'No registered collateral assets loaded from api/.' };
    }
    const principalRaw = parseDecimalToRaw(usdcStr, USDC_DECIMALS);
    if (!principalRaw || BigInt(principalRaw) < 500_000_000n) {
      return { error: 'Offered USDC must be at least $500.00 (up to 6 decimals).' };
    }
    const minFillRaw = parseDecimalToRaw(minFillStr, USDC_DECIMALS);
    if (!minFillRaw || BigInt(minFillRaw) < 500_000_000n) {
      return { error: 'Minimum fill must be at least $500.00 USDC (up to 6 decimals).' };
    }
    if (BigInt(minFillRaw) > BigInt(principalRaw)) {
      return { error: 'Minimum fill cannot exceed offered USDC amount.' };
    }
    const planParsed = parseRawListInput(partialPlanStr, USDC_DECIMALS, 'USDC partial fill');
    if (planParsed.error) {
      return { error: planParsed.error };
    }
    if (planParsed.list) {
      try {
        validateLendPartialFillPlan(planParsed.list, principalRaw, minFillRaw);
      } catch (planErr) {
        return { error: planErr instanceof Error ? planErr.message : String(planErr) };
      }
    }
    const aprBps = parsePercentToBps(ratePct);
    if (aprBps === null || aprBps > 4000) {
      return { error: 'Minimum APR must be between 0.00% and 40.00%.' };
    }
    const termDays = Number(termDaysStr.trim());
    if (!Number.isInteger(termDays) || termDays < 7 || termDays > 90) {
      return { error: 'Term days must be an integer between 7 and 90.' };
    }
    const maxLtvBps = parsePercentToBps(maxLtvPct);
    if (maxLtvBps === null || maxLtvBps < 100 || maxLtvBps > 10_000) {
      return { error: 'Maximum LTV must be between 1.00% and 100.00%.' };
    }
    const expiryDays = Number(expiryDaysStr.trim());
    if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 30) {
      return { error: 'Order expiry must be an integer between 1 and 30 days.' };
    }
    return {
      error: '',
      quoteAsset: quoteAssetObj.token,
      principalRaw,
      minFillRaw,
      perFillUsdcRawList: planParsed.list,
      aprBps,
      termDays,
      maxLtvBps,
      expiryDays,
    };
  }, [
    expiryDaysStr,
    maxLtvPct,
    minFillStr,
    partialPlanStr,
    quoteAssetObj,
    ratePct,
    termDaysStr,
    usdcStr,
  ]);

  const handleQuote = useCallback(
    async (event) => {
      if (event) event.preventDefault();
      setQuoteError('');
      setActionError('');
      setActionNotice('');
      setQuoteResult(null);

      const parsed = parseValidatedOfferInputs();
      if (parsed.error) {
        setQuoteError(parsed.error);
        return null;
      }

      const qSeq = ++quoteSeqRef.current;
      setQuoteLoading(true);
      try {
        const res = await fetchLoanQuote({
          cfg: web3?.config,
          asset: parsed.quoteAsset,
          principalRaw: parsed.principalRaw,
          termDays: parsed.termDays,
          aprBps: parsed.aprBps,
          maxLtvBps: parsed.maxLtvBps,
          lender: web3?.connected ? web3.address : undefined,
          lenderAttestation: web3?.connected ? web3.attestationHex : undefined,
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
    },
    [parseValidatedOfferInputs, web3?.address, web3?.attestationHex, web3?.config, web3?.connected]
  );

  const exactOfferAmounts = useMemo(() => {
    if (!quoteResult || makerOpenOffers.error) return null;
    try {
      const minFillRawParsed = parseDecimalToRaw(minFillStr, USDC_DECIMALS);
      const planParsed = parseRawListInput(partialPlanStr, USDC_DECIMALS, 'USDC partial fill');
      if (planParsed.error) return null;
      return resolveExactLendAmounts(quoteResult, {
        minFillRaw: minFillRawParsed && BigInt(minFillRawParsed) > 0n ? minFillRawParsed : null,
        perFillUsdcRawList: planParsed.list,
        existingOpenSumRaw: existingOpenUsdcSumRaw,
      });
    } catch {
      return null;
    }
  }, [existingOpenUsdcSumRaw, makerOpenOffers.error, minFillStr, partialPlanStr, quoteResult]);

  const partialRemainderWarning = useMemo(() => {
    const prinRawStr = exactOfferAmounts
      ? exactOfferAmounts.principalRaw.toString()
      : parseDecimalToRaw(usdcStr, USDC_DECIMALS);
    const minRawStr = parseDecimalToRaw(minFillStr, USDC_DECIMALS);
    if (!prinRawStr || !minRawStr) return '';
    const prin = BigInt(prinRawStr);
    const minFill = BigInt(minRawStr);
    const messages = [];
    if (prin > minFill && prin - minFill < 500_000_000n) {
      messages.push(
        `Warning (PARTIAL_REMAINDER_BELOW_500): Filling $${formatTokenUnitsDisplay(minFill, USDC_DECIMALS, 2)} leaves $${formatTokenUnitsDisplay(prin - minFill, USDC_DECIMALS, 2)} (< $500.00), which is unfillable on-chain (LoanCore PRINCIPAL_BELOW_MINIMUM) and can only be cancelled or expire.`
      );
    }
    const planParsed = parseRawListInput(partialPlanStr, USDC_DECIMALS, 'USDC partial fill');
    if (!planParsed.error && planParsed.list?.length) {
      const planSum = planParsed.list.reduce((acc, item) => acc + BigInt(item), 0n);
      if (prin > planSum && prin - planSum < 500_000_000n) {
        messages.push(
          `Warning (PLAN_REMAINDER_BELOW_500): Planned fills leave $${formatTokenUnitsDisplay(prin - planSum, USDC_DECIMALS, 2)} (< $500.00), which is unfillable on-chain and can only be cancelled or expire.`
        );
      }
    }
    return messages.join(' ');
  }, [exactOfferAmounts, minFillStr, partialPlanStr, usdcStr]);

  const eligibilityInfo = lendMeta.data?.eligibility ?? null;
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

  const allowanceRawBig = lendMeta.data ? BigInt(lendMeta.data.allowanceRaw) : 0n;
  const balanceRawBig = lendMeta.data ? BigInt(lendMeta.data.balanceRaw) : 0n;
  const needsApproval = Boolean(
    exactOfferAmounts && allowanceRawBig < exactOfferAmounts.requiredApprovalRaw
  );
  const insufficientBalance = Boolean(
    exactOfferAmounts && lendMeta.data && balanceRawBig < exactOfferAmounts.requiredApprovalRaw
  );

  async function handleApproveUsdc() {
    if (txBusyRef.current) return;
    setActionError('');
    setActionNotice('');
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setActionError('Connect your wallet on Base before approving USDC.');
      return;
    }
    if (!quoteResult) {
      setActionError('Click "1. Simulate live quote" and review terms before approving USDC.');
      return;
    }
    const parsed = parseValidatedOfferInputs();
    if (parsed.error) {
      setActionError(parsed.error);
      return;
    }
    txBusyRef.current = true;
    setTxBusy('approve');
    try {
      await web3.ensureDeclarationVerifiedForTx();
      const liveOpenUsdcSumRaw = await resolveOpenLendOffersSumRaw({
        lenderAddress: web3.address,
        existingOpenSumRaw: null,
        cfg: web3.config,
      });
      setMakerOpenOffers({ loading: false, sumRaw: liveOpenUsdcSumRaw, error: '' });
      const exact = resolveExactLendAmounts(quoteResult, {
        minFillRaw: parsed.minFillRaw,
        perFillUsdcRawList: parsed.perFillUsdcRawList,
        existingOpenSumRaw: liveOpenUsdcSumRaw,
      });
      const res = await approveUsdcForLend({
        address: web3.address,
        requiredUsdcRaw: exact.requiredApprovalRaw,
        cfg: web3.config,
      });
      await loadAllowanceAndNonce();
      setActionNotice(
        res.alreadyApproved
          ? `LoanCore USDC allowance already covers ${res.allowanceRaw} raw units.`
          : `Approved LoanCore for ${exact.requiredApprovalRaw.toString()} raw USDC units (tx ${res.txHash}).`
      );
    } catch (err) {
      setActionError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setTxBusy('');
    }
  }

  async function handleSignLendOffer(event) {
    event.preventDefault();
    if (txBusyRef.current) return;
    setActionError('');
    setActionNotice('');
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setActionError('Connect your wallet on Base before signing a LendOffer.');
      return;
    }
    if (eligibilityInfo && !eligibilityInfo.isEligible) {
      setActionError('IneligibleCounterparty: Wallet is not eligible in EligibilityGate on-chain.');
      return;
    }
    if (!quoteResult) {
      setActionError('Click "1. Simulate live quote" and review terms before signing a LendOffer.');
      return;
    }
    const parsed = parseValidatedOfferInputs();
    if (parsed.error) {
      setActionError(parsed.error);
      return;
    }
    txBusyRef.current = true;
    setTxBusy('sign');
    try {
      await web3.ensureDeclarationVerifiedForTx();
      const signed = await prepareAndSignLendOffer({
        address: web3.address,
        principalRaw: parsed.principalRaw,
        allowedCollateral,
        quoteAsset: parsed.quoteAsset,
        expectedQuote: quoteResult,
        requireExpectedQuote: true,
        minRateBps: parsed.aprBps,
        termDays: parsed.termDays,
        maxLtvBps: parsed.maxLtvBps,
        minFillRaw: parsed.minFillRaw,
        expiryDays: parsed.expiryDays,
        yieldMode,
        perFillUsdcRawList: parsed.perFillUsdcRawList,
        existingOpenUsdcSumRaw: null,
        attestationHex: web3.attestationHex,
        autoApprove: true,
        cfg: web3.config,
      });
      setQuoteResult(signed.quote);
      setLatestSignedOffer(signed);
      setAllowanceReductionState(null);
      await Promise.all([loadAllowanceAndNonce(), syncPersistedOffers(), loadMarkets(), loadMakerOpenOffers()]);
      setActionNotice(
        `Signed EIP-712 LendOffer ${signed.orderHash} for ${signed.exactAmounts.principalRaw} raw USDC${signed.publishedToApi ? ' and published to api/ orderbook.' : '.'}`
      );
    } catch (err) {
      setActionError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setTxBusy('');
    }
  }

  async function refreshPostCancelAllowance(cancelledHash = null, allInvalidated = false) {
    if (!web3?.address) return;
    const stored = loadPersistedSignedLendOffers();
    const exclude = cancelledHash ? new Set([String(cancelledHash).toLowerCase()]) : null;
    let makerResolveError = false;
    const [freshMeta, freshPersisted, makerRemainingRaw, freshMarkets] = await Promise.all([
      loadAllowanceAndNonce(),
      stored.length > 0
        ? refreshSignedLendOffersState({ offers: stored, cfg: web3?.config }).then((enriched) => {
            setPersistedOffers(enriched);
            return enriched;
          })
        : Promise.resolve([]).then(() => {
            setPersistedOffers([]);
            return [];
          }),
      allInvalidated
        ? Promise.resolve(0n)
        : resolveOpenLendOffersSumRaw({
            lenderAddress: web3.address,
            existingOpenSumRaw: null,
            excludeHashes: exclude,
            cfg: web3?.config,
          }).catch(() => {
            makerResolveError = true;
            return null;
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
    if (makerRemainingRaw !== null) {
      setMakerOpenOffers({ loading: false, sumRaw: makerRemainingRaw, error: '' });
    }
    const localSummary = allInvalidated
      ? { totalRaw: 0n, hasUnknown: false }
      : computeOpenLendOffersRawTotal(
          web3.address,
          freshPersisted,
          [],
          exclude,
          { ordersTruncated: Boolean(freshMarkets?.ordersTruncated) && makerRemainingRaw === null }
        );
    const blockedByUnknown =
      !allInvalidated &&
      (makerResolveError ||
        makerRemainingRaw === null ||
        localSummary.hasUnknown ||
        !freshMarkets ||
        Boolean(freshMarkets?.stale));
    const targetRaw = allInvalidated
      ? 0n
      : makerRemainingRaw !== null
        ? makerRemainingRaw
        : localSummary.totalRaw;
    const liveAllowanceRaw = freshMeta ? BigInt(freshMeta.allowanceRaw) : allowanceRawBig;
    if (
      liveAllowanceRaw > targetRaw ||
      (blockedByUnknown && liveAllowanceRaw > 0n)
    ) {
      setAllowanceReductionState({
        currentAllowanceRaw: liveAllowanceRaw.toString(),
        targetAllowanceRaw: targetRaw.toString(),
        blockedByUnknown,
      });
    } else {
      setAllowanceReductionState(null);
    }
  }

  async function handleReduceAllowanceAfterCancel() {
    if (txBusyRef.current || !web3?.address || !allowanceReductionState) return;
    if (allowanceReductionState.blockedByUnknown) {
      setCancelError(
        'Cannot reduce LoanCore USDC allowance while an open LendOffer has unknown on-chain status or RPC is degraded; refresh offer status first.'
      );
      return;
    }
    setCancelError('');
    txBusyRef.current = true;
    setTxBusy('reduce-allowance');
    try {
      const targetRaw = allowanceReductionState.targetAllowanceRaw;
      const res = await setUsdcAllowanceForLend({
        address: web3.address,
        targetAllowanceRaw: targetRaw,
        cfg: web3.config,
      });
      await loadAllowanceAndNonce();
      setAllowanceReductionState(null);
      setCancelNotice(
        res.unchanged
          ? `LoanCore USDC allowance is already $${formatTokenUnitsDisplay(targetRaw, USDC_DECIMALS, 2)} (${targetRaw} raw).`
          : `Reduced LoanCore USDC allowance to $${formatTokenUnitsDisplay(res.allowanceRaw, USDC_DECIMALS, 2)} (${res.allowanceRaw} raw) (tx ${res.txHash}).`
      );
    } catch (err) {
      setCancelError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setTxBusy('');
    }
  }

  async function handleCancelOffer(offerObj) {
    if (txBusyRef.current || !web3?.address) return;
    setCancelError('');
    setCancelNotice('');
    setAllowanceReductionState(null);
    txBusyRef.current = true;
    setTxBusy('cancel');
    try {
      const res = await cancelSignedLendOffer({
        address: web3.address,
        offer: offerObj,
        cfg: web3.config,
      });
      await refreshPostCancelAllowance(res.orderHash, false);
      setCancelNotice(`Cancelled LendOffer ${res.orderHash} on-chain (tx ${res.txHash}).`);
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
    setAllowanceReductionState(null);
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setCancelError('Connect your wallet on Base before cancelling an offer.');
      return;
    }
    let parsed;
    try {
      parsed = parseLendOfferFromJson(pasteCancelJson);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
      return;
    }
    txBusyRef.current = true;
    setTxBusy('cancel-paste');
    try {
      const res = await cancelSignedLendOffer({
        address: web3.address,
        offer: parsed.order,
        cfg: web3.config,
      });
      await refreshPostCancelAllowance(res.orderHash, false);
      setCancelNotice(`Cancelled pasted LendOffer ${res.orderHash} on-chain (tx ${res.txHash}).`);
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
    setAllowanceReductionState(null);
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
      await refreshPostCancelAllowance(null, true);
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

  async function copyOfferPayload(item) {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            orderHash: item.orderHash,
            order: item.offerJson,
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

  function resolveBorrowFillUsdcRaw() {
    if (
      selectedBorrowRemainingRaw &&
      borrowFillUsdcStr.trim() === formatUnits(BigInt(selectedBorrowRemainingRaw), USDC_DECIMALS)
    ) {
      return selectedBorrowRemainingRaw;
    }
    return parseDecimalToRaw(borrowFillUsdcStr, USDC_DECIMALS);
  }

  async function handleVerifyBorrowOrder(event) {
    if (event) event.preventDefault();
    if (txBusyRef.current) return;
    setBorrowFillError('');
    setBorrowFillResult(null);
    setBorrowPreview(null);

    const fillUsdcRaw = resolveBorrowFillUsdcRaw();
    if (!fillUsdcRaw) {
      setBorrowFillError('Enter a valid positive USDC fill amount (up to 6 decimals).');
      return;
    }
    const multiPlan = parseRawListInput(borrowMultiFillPlanStr, USDC_DECIMALS, 'USDC multi-fill');
    if (multiPlan.error) {
      setBorrowFillError(multiPlan.error);
      return;
    }
    let payload;
    try {
      payload = parseBorrowOrderFromJson(borrowOrderJsonStr);
      if (!payload.signature) {
        throw new Error('BorrowOrder JSON must include "signature".');
      }
    } catch (err) {
      setBorrowFillError(err instanceof Error ? err.message : String(err));
      return;
    }

    const previewSeq = ++borrowPreviewSeqRef.current;
    setBorrowPreviewBusy(true);
    try {
      const preview = await verifyAndPreviewBorrowOrderFill({
        order: payload.order,
        signature: payload.signature,
        fillUsdcRaw,
        perFillUsdcRawList: multiPlan.list,
        existingOpenSumRaw: null,
        lenderAddress: web3?.connected && !web3?.wrongNetwork ? web3.address : null,
        lenderAttestation: web3?.attestationHex ?? '0x',
        cfg: web3?.config,
      });
      if (previewSeq !== borrowPreviewSeqRef.current) return;
      setBorrowPreview({
        ...preview,
        perFillUsdcRawList: multiPlan.list,
      });
    } catch (err) {
      if (previewSeq !== borrowPreviewSeqRef.current) return;
      setBorrowFillError(formatWeb3Error(err));
    } finally {
      if (previewSeq === borrowPreviewSeqRef.current) {
        setBorrowPreviewBusy(false);
      }
    }
  }

  async function handleConfirmFillBorrowOrder() {
    if (txBusyRef.current || !borrowPreview) return;
    setBorrowFillError('');
    setBorrowFillResult(null);
    if (!web3?.connected || web3?.wrongNetwork || !web3?.address) {
      setBorrowFillError('Connect your wallet on Base before filling a BorrowOrder.');
      return;
    }
    txBusyRef.current = true;
    setBorrowFillBusy(true);
    try {
      await web3.ensureDeclarationVerifiedForTx();
      const res = await fillBorrowOrderAsLender({
        address: web3.address,
        order: borrowPreview.order,
        signature: borrowPreview.signature,
        fillUsdcRaw: borrowPreview.fillAmountRaw,
        perFillUsdcRawList: borrowPreview.perFillUsdcRawList ?? null,
        existingOpenSumRaw: null,
        expectedPreview: borrowPreview,
        lenderAttestation: web3.attestationHex,
        autoApprove: true,
        cfg: web3.config,
      });
      setBorrowFillResult(res);
      setBorrowPreview(null);
      await Promise.all([loadAllowanceAndNonce(), loadMarkets(), loadMakerOpenOffers(), web3.refresh()]);
    } catch (err) {
      setBorrowFillError(formatWeb3Error(err));
    } finally {
      txBusyRef.current = false;
      setBorrowFillBusy(false);
    }
  }

  return (
    <Page
      kicker="Lend · Live EIP-712 & OrderSettlement"
      title="Fill open BorrowOrders or sign an EIP-712 LendOffer."
      lede="Approve exact raw USDC amounts to LoanCore (including cumulative open offers or partial-fill sums), sign EIP-712 LendOffers, or fill verified BorrowOrders on-chain to mint a lender PositionNFT."
    >
      {marketState.data?.degraded ? (
        <div className="err block" role="status">
          <strong>Live api/ orderbook read degraded.</strong>{' '}
          {marketState.data?.apiError || 'Ensure api/ is reachable on Base.'}
        </div>
      ) : null}

      {marketState.data?.ordersTruncated ? (
        <div className="note block" role="status">
          <strong>Public orderbook display truncated (&gt;1,000 rows).</strong>{' '}
          Cumulative LoanCore allowance reserves use your full maker-scoped <code>/orders</code> query directly.
        </div>
      ) : null}

      <ComplianceTxGateBanner actionLabel="approve USDC, publish LendOffers, or fill BorrowOrders (cancelling offers, bumping maker nonce, and reducing USDC allowance remain open)" />

      <form className="form-layout" onSubmit={handleSignLendOffer}>
        <div className="fields">
          <div className="split">
            <Field
              id="lend-usdc"
              label="USDC to offer (6 decimals)"
              hint="Minimum $500. Parsed directly to raw 6-decimal bigint; no floats."
            >
              {(props) => (
                <TextInput
                  id="lend-usdc"
                  value={usdcStr}
                  onChange={updateField(setUsdcStr)}
                  {...props}
                />
              )}
            </Field>
            <Field
              id="lend-min-fill"
              label="Minimum fill (USDC)"
              hint="At least $500; partial fills <= per-loan cap."
            >
              {(props) => (
                <TextInput
                  id="lend-min-fill"
                  value={minFillStr}
                  onChange={updateField(setMinFillStr)}
                  {...props}
                />
              )}
            </Field>
          </div>

          <Field
            id="lend-partial-plan"
            label="Planned partial-fill chunks (optional comma-separated USDC)"
            hint="Optional exact/rounded-up per-fill amounts (e.g. 500.50, 500.50) so LoanCore allowance covers sum(per-fill)."
          >
            {(props) => (
              <TextInput
                id="lend-partial-plan"
                value={partialPlanStr}
                onChange={updateField(setPartialPlanStr)}
                {...props}
              />
            )}
          </Field>

          <div className="split">
            <Field id="lend-rate" label="Minimum APR (%)" hint="0.00% to 40.00% APR.">
              {(props) => (
                <TextInput
                  id="lend-rate"
                  value={ratePct}
                  onChange={updateField(setRatePct)}
                  {...props}
                />
              )}
            </Field>
            <Field id="lend-term" label="Term (days)" hint="7 to 90 days.">
              {(props) => (
                <TextInput
                  id="lend-term"
                  inputMode="numeric"
                  value={termDaysStr}
                  onChange={updateField(setTermDaysStr)}
                  {...props}
                />
              )}
            </Field>
          </div>

          <div className="split">
            <Field
              id="lend-ltv"
              label="Maximum LTV (%)"
              hint="Tier A caps asset LTV at 60%."
            >
              {(props) => (
                <TextInput
                  id="lend-ltv"
                  value={maxLtvPct}
                  onChange={updateField(setMaxLtvPct)}
                  {...props}
                />
              )}
            </Field>
            <Field id="lend-expiry" label="Order expiry (days)" hint="1 to 30 days.">
              {(props) => (
                <TextInput
                  id="lend-expiry"
                  inputMode="numeric"
                  value={expiryDaysStr}
                  onChange={updateField(setExpiryDaysStr)}
                  {...props}
                />
              )}
            </Field>
          </div>

          <div className="field">
            <label htmlFor="lend-collateral">Allowed collateral token</label>
            <select
              id="lend-collateral"
              value={allowedCollateral}
              onChange={(e) => updateField(setAllowedCollateral)(e.target.value)}
            >
              <option value={zeroAddress}>
                Any registered B20 collateral ({zeroAddress.slice(0, 6)}…)
              </option>
              {assets.map((asset) => (
                <option key={asset.token} value={asset.token}>
                  {asset.symbol} · {asset.status_name} · Cap LTV{' '}
                  {formatBpsPercent(asset.ltv?.max_init_ltv_bps ?? asset.max_init_ltv_bps)}
                </option>
              ))}
            </select>
            <p className="hint">Choose any registered B20 asset or a specific equity token.</p>
          </div>

          <fieldset>
            <legend>Yield mode</legend>
            <label className="choice">
              <input
                type="radio"
                name="lend-yield"
                checked={yieldMode === 0}
                onChange={() => updateField(setYieldMode)(0)}
              />
              <span>0 — Standard fixed APR only (default).</span>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="lend-yield"
                checked={yieldMode === 1}
                onChange={() => updateField(setYieldMode)(1)}
              />
              <span>1 — Yield mode enabled (requires borrower order match).</span>
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
              disabled={quoteLoading || !quoteAssetObj || Boolean(txBusy)}
            >
              {quoteLoading ? '1. Quoting…' : '1. Simulate live quote'}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => void handleApproveUsdc()}
              disabled={
                !web3?.connected ||
                web3?.wrongNetwork ||
                !web3?.eligibilityDeclarationValid ||
                Boolean(txBusy) ||
                !quoteAssetObj ||
                quoteLoading ||
                !quoteResult
              }
            >
              {txBusy === 'approve'
                ? '2. Approving USDC…'
                : needsApproval
                  ? '2. Approve exact USDC to LoanCore'
                  : '2. Approve / verify LoanCore allowance'}
            </button>
            <button
              className="btn"
              type="submit"
              disabled={
                !web3?.connected ||
                web3?.wrongNetwork ||
                !web3?.eligibilityDeclarationValid ||
                Boolean(txBusy) ||
                !quoteAssetObj ||
                quoteLoading ||
                !quoteResult ||
                Boolean(eligibilityInfo && !eligibilityInfo.isEligible)
              }
            >
              {txBusy === 'sign' ? '3. Signing EIP-712 offer…' : '3. Sign & publish LendOffer'}
            </button>
          </div>
        </div>

        <Sheet
          sticky
          title="Live /quote & LoanCore USDC readiness"
          note="USDC approvals to LoanCore and EIP-712 LendOffers use exact or rounded-up raw 6-decimal bigint amounts from api/, never display strings or floats."
        >
          {lendMeta.error ? <p className="err">{lendMeta.error}</p> : null}
          {makerOpenOffers.error ? <p className="err">{makerOpenOffers.error}</p> : null}
          <Rows
            items={[
              { label: 'OrderSettlement', value: web3?.config?.contracts?.orderSettlement ?? 'Unset' },
              { label: 'LoanCore (USDC spender)', value: web3?.config?.contracts?.loanCore ?? 'Unset' },
              { label: 'EligibilityGate (on-chain)', value: eligibilityStatusText },
              { label: 'EIP-712 Reg S declaration', value: formatRegSDeclarationRowValue(web3) },
              {
                label: 'USDC balance / LoanCore allowance',
                value: lendMeta.data
                  ? `$${lendMeta.data.balanceFormatted} (${lendMeta.data.balanceRaw} raw) / $${lendMeta.data.allowanceFormatted} (${lendMeta.data.allowanceRaw} raw)`
                  : web3?.connected
                    ? 'Loading on-chain USDC balance…'
                    : 'Connect wallet on Base',
              },
              {
                label: 'Maker nonce / Open offers sum',
                value: lendMeta.data
                  ? makerOpenOffers.loading
                    ? `Nonce ${lendMeta.data.makerNonce} · Refreshing open offers…`
                    : makerOpenOffers.error
                      ? `Nonce ${lendMeta.data.makerNonce} · Error loading open offers`
                      : `Nonce ${lendMeta.data.makerNonce} · Open $${safeFormatUnits(existingOpenUsdcSumRaw, USDC_DECIMALS, 2)} (${existingOpenUsdcSumRaw.toString()} raw)`
                  : '—',
              },
              ...(exactOfferAmounts
                ? [
                    {
                      label: 'Required LoanCore allowance',
                      value: `$${formatTokenUnitsDisplay(exactOfferAmounts.requiredApprovalRaw, USDC_DECIMALS, 2)} (${exactOfferAmounts.requiredApprovalRaw.toString()} raw)${insufficientBalance ? ' · INSUFFICIENT USDC' : needsApproval ? ' · APPROVAL NEEDED' : ' · READY'}`,
                    },
                    {
                      label: 'Origination fee / Net to borrower',
                      value: `${formatApiAmount(quoteResult.amounts.origination_fee, { prefixUsd: true })} / ${formatApiAmount(quoteResult.amounts.net_proceeds, { prefixUsd: true })}`,
                    },
                    {
                      label: 'Interest at maturity / Protocol cut',
                      value: `${formatApiAmount(quoteResult.amounts.interest_maturity, { prefixUsd: true })} / ${formatApiAmount(quoteResult.amounts.protocol_interest_cut, { prefixUsd: true })}`,
                    },
                    {
                      label: 'Lender net interest earned',
                      value: `${formatApiAmount(quoteResult.amounts.lender_net_interest, { prefixUsd: true })} (${exactOfferAmounts.lenderNetInterestRaw.toString()} raw)`,
                    },
                    {
                      label: 'Reference asset / Per-loan cap',
                      value: `${quoteResult.asset?.symbol ?? '—'} · ${formatApiAmount(quoteResult.caps?.per_loan_cap, { prefixUsd: true })}`,
                    },
                  ]
                : []),
            ]}
          />
          {latestSignedOffer ? (
            <div className="note" role="status" style={{ marginTop: 12 }}>
              Latest LendOffer <code>{shortAddress(latestSignedOffer.orderHash)}</code>{' '}
              ({latestSignedOffer.publishedToApi ? 'published to api/' : `local only: ${latestSignedOffer.publishError || 'unpublished'}`}).
            </div>
          ) : null}
        </Sheet>
      </form>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ marginBottom: 8 }}>Your signed LendOffers (on-chain synced)</h2>
        <p className="hint">
          Persisted locally after EIP-712 signing. Cancel individual offers via{' '}
          <code>cancelLendOffer()</code> or invalidate all open orders with <code>bumpNonce()</code>.
        </p>
        {cancelError ? <p className="err" role="alert">{cancelError}</p> : null}
        {cancelNotice ? <p className="note" role="status">{cancelNotice}</p> : null}
        {allowanceReductionState ? (
          <div className="err block" role="status" style={{ marginTop: 10, marginBottom: 12 }}>
            <p>
              Warning: LoanCore USDC allowance is still $
              {formatTokenUnitsDisplay(allowanceReductionState.currentAllowanceRaw, USDC_DECIMALS, 2)}{' '}
              ({allowanceReductionState.currentAllowanceRaw} raw), above your remaining known open
              LendOffers ($
              {formatTokenUnitsDisplay(allowanceReductionState.targetAllowanceRaw, USDC_DECIMALS, 2)}{' '}
              / {allowanceReductionState.targetAllowanceRaw} raw).{' '}
              {allowanceReductionState.blockedByUnknown
                ? 'One or more offers currently have unknown on-chain status; allowance reduction is blocked until "Refresh on-chain offer status" reads cleanly.'
                : 'Reduce or revoke excess allowance to limit contract exposure.'}
            </p>
            <div className="actions" style={{ marginTop: 8 }}>
              <button
                className="btn secondary"
                type="button"
                onClick={() => void handleReduceAllowanceAfterCancel()}
                disabled={Boolean(txBusy) || Boolean(allowanceReductionState.blockedByUnknown)}
              >
                {allowanceReductionState.blockedByUnknown
                  ? 'Reduction blocked (unknown offer status)'
                  : txBusy === 'reduce-allowance'
                    ? 'Updating LoanCore USDC allowance…'
                    : `Reduce LoanCore USDC allowance to $${formatTokenUnitsDisplay(allowanceReductionState.targetAllowanceRaw, USDC_DECIMALS, 2)}`}
              </button>
            </div>
          </div>
        ) : null}
        <div className="actions" style={{ marginBottom: 12 }}>
          <button
            className="btn secondary"
            type="button"
            onClick={() => void syncPersistedOffers()}
            disabled={offersRefreshing}
          >
            {offersRefreshing ? 'Refreshing on-chain state…' : 'Refresh on-chain offer status'}
          </button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => void handleBumpAllNonces()}
            disabled={!web3?.connected || web3?.wrongNetwork || Boolean(txBusy)}
          >
            {txBusy === 'bump-nonce' ? 'Bumping maker nonce…' : 'Bump maker nonce (invalidate all open orders)'}
          </button>
        </div>

        {persistedOffers.length === 0 ? (
          <p className="hint">No locally persisted signed LendOffers yet.</p>
        ) : (
          <div className="fields">
            {persistedOffers.map((item, idx) => {
              const removalInfo = classifyPersistedOrderRemoval(item, 'lend');
              return (
                <div className="note" key={item?.orderHash || `corrupt-${idx}`} style={{ marginBottom: 8 }}>
                  <div>
                    <strong>LendOffer {item?.orderHash ? shortAddress(item.orderHash) : '(corrupt entry)'}</strong> · Status:{' '}
                    <code>{item?.onchainStatus ?? 'open'}</code> · Offered:{' '}
                    <code>
                      ${safeFormatUnits(item?.offerJson?.usdcAmount ?? 0n, USDC_DECIMALS, 2)}
                    </code>{' '}
                    · Remaining:{' '}
                    <code>
                      ${safeFormatUnits(item?.remainingRaw ?? item?.offerJson?.usdcAmount ?? 0n, USDC_DECIMALS, 2)}
                    </code>
                  </div>
                  <div className="actions" style={{ marginTop: 8 }}>
                    {item?.offerJson && !removalInfo.isCorrupt ? (
                      <button className="btn secondary" type="button" onClick={() => void copyOfferPayload(item)}>
                        {copiedHash === item.orderHash ? 'Copied JSON' : 'Copy LendOffer JSON'}
                      </button>
                    ) : null}
                    {item?.offerJson &&
                    !removalInfo.isCorrupt &&
                    isNonFinalOrderStatus(item.onchainStatus) &&
                    item.onchainStatus !== 'unknown' &&
                    web3?.address?.toLowerCase() === String(item.offerJson?.lender ?? '').toLowerCase() ? (
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => void handleCancelOffer(item.offerJson)}
                        disabled={Boolean(txBusy)}
                      >
                        Cancel on-chain
                      </button>
                    ) : null}
                    {removalInfo.showRemove ? (
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => {
                          if (
                            removalInfo.requiresConfirm &&
                            typeof window !== 'undefined' &&
                            typeof window.confirm === 'function' &&
                            !window.confirm(
                              'On-chain status could not be verified. If this LendOffer is open and not on api/, removing it drops its USDC from local allowance checks. Remove saved entry anyway?'
                            )
                          ) {
                            return;
                          }
                          const hashStr = typeof item?.orderHash === 'string' ? item.orderHash.trim() : '';
                          const updated = removeSignedLendOffer(
                            hashStr ? hashStr : { index: idx, expectedEntry: item }
                          );
                          setPersistedOffers(updated);
                          void syncPersistedOffers();
                          void loadMakerOpenOffers();
                        }}
                        disabled={Boolean(txBusy)}
                      >
                        Remove saved entry
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <form className="fields" onSubmit={handleCancelPastedJson} style={{ marginTop: 14 }}>
          <Field id="cancel-lend-json" label="Cancel pasted LendOffer JSON" hint='Paste JSON containing {"order": {...}, "signature": "0x..."}'>
            {(props) => (
              <TextInput
                id="cancel-lend-json"
                value={pasteCancelJson}
                onChange={setPasteCancelJson}
                {...props}
              />
            )}
          </Field>
          <div className="actions">
            <button
              className="btn secondary"
              type="submit"
              disabled={!web3?.connected || web3?.wrongNetwork || Boolean(txBusy) || !pasteCancelJson.trim()}
            >
              {txBusy === 'cancel-paste' ? 'Cancelling offer…' : 'Cancel pasted LendOffer'}
            </button>
          </div>
        </form>
      </section>

      <section style={{ marginTop: 36 }}>
        <h2 style={{ marginBottom: 8 }}>Fill open BorrowOrders (mint PositionNFT)</h2>
        <p className="hint">
          Step 1 verifies signature, expiry, nonce, borrower collateral escrow allowance, EligibilityGate,
          live /quote, and simulates <code>OrderSettlement.fillBorrowOrder()</code> before requesting USDC
          approval. Step 2 approves LoanCore (exact fill or cumulative partial-fill sum) and mints your{' '}
          <code>PositionNFT</code>.
        </p>

        {openBorrowOrders.length > 0 ? (
          <div className="actions" style={{ marginBottom: 12 }}>
            {openBorrowOrders.slice(0, 6).map((row) => {
              const remRaw = String(row.remaining_usdc?.raw ?? row.min_usdc?.raw ?? '500000000');
              return (
                <button
                  key={row.order_hash}
                  className="btn secondary"
                  type="button"
                  onClick={() => applyBorrowOrderSelection(row)}
                >
                  BorrowOrder {row.order_hash.slice(0, 10)}… · {row.collateral_symbol ?? 'B20'} · $
                  {formatTokenUnitsDisplay(remRaw, USDC_DECIMALS, 2)} @{' '}
                  {formatBpsPercent(row.max_rate_bps ?? row.rate_bps)}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="hint">No open BorrowOrders currently listed in api/; paste a signed BorrowOrder JSON below.</p>
        )}

        <form className="fields" onSubmit={handleVerifyBorrowOrder}>
          <div className="field">
            <label htmlFor="borrow-order-json">Signed BorrowOrder JSON</label>
            <textarea
              id="borrow-order-json"
              rows={4}
              value={borrowOrderJsonStr}
              onChange={(e) => {
                setBorrowOrderJsonStr(e.target.value);
                setSelectedBorrowRemainingRaw('');
                setBorrowPreview(null);
                setBorrowFillError('');
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
          <div className="split">
            <Field id="borrow-fill-usdc" label="USDC to fund (up to 6 decimals)">
              {(props) => (
                <TextInput
                  id="borrow-fill-usdc"
                  value={borrowFillUsdcStr}
                  onChange={(v) => {
                    setBorrowFillUsdcStr(v);
                    setBorrowPreview(null);
                    setBorrowFillError('');
                  }}
                  {...props}
                />
              )}
            </Field>
            <Field
              id="borrow-fill-plan"
              label="Optional multi-fill USDC approval plan (includes current fill first)"
              hint="Comma-separated per-fill sequence starting with the current fill (e.g. 700, 700 when current fill is 700) so LoanCore approval covers sum(plan). Every fill must be >= max(minFill, $500)."
            >
              {(props) => (
                <TextInput
                  id="borrow-fill-plan"
                  value={borrowMultiFillPlanStr}
                  onChange={(v) => {
                    setBorrowMultiFillPlanStr(v);
                    setBorrowPreview(null);
                    setBorrowFillError('');
                  }}
                  {...props}
                />
              )}
            </Field>
          </div>

          {borrowFillError ? <p className="err" role="alert">{borrowFillError}</p> : null}
          {borrowFillResult ? (
            <p className="note" role="status">
              Opened Loan #{borrowFillResult.loanId ?? '?'} · Minted PositionNFT #
              {borrowFillResult.positionTokenId ?? borrowFillResult.loanId ?? '?'} (tx {borrowFillResult.txHash}) ·
              Funded {borrowFillResult.fillUsdcRaw} raw USDC against {borrowFillResult.collateralForFillRaw} raw
              collateral.{' '}
              {borrowFillResult.loanId ? <Link to={`/loans/${borrowFillResult.loanId}`}>Inspect Loan</Link> : null}{' '}
              · <Link to="/positions">View Positions</Link>
            </p>
          ) : null}

          <div className="actions">
            <button
              className="btn secondary"
              type="submit"
              disabled={borrowPreviewBusy || borrowFillBusy || !borrowOrderJsonStr.trim()}
            >
              {borrowPreviewBusy ? 'Verifying & simulating fill…' : '1. Verify & preview BorrowOrder fill'}
            </button>
          </div>
        </form>

        {borrowPreview ? (
          <Sheet
            title="BorrowOrder fill review (pre-approval simulation verified)"
            note="Signature, expiry, nonce, cancellation status, borrower CollateralEscrow allowance, EligibilityGate, and OrderSettlement.fillBorrowOrder() eth_call all passed. Confirm below to approve USDC (if needed) and fill."
          >
            {borrowPreview.warnings?.length > 0 ? (
              <div className="err block" role="note">
                {borrowPreview.warnings.map((w) => (
                  <p key={w.code}>
                    Warning ({w.code}): {w.message}
                  </p>
                ))}
              </div>
            ) : null}
            <Rows
              items={[
                { label: 'Borrower', value: borrowPreview.borrower },
                { label: 'Order hash', value: borrowPreview.orderHash },
                { label: 'Fixed APR / Term', value: `${formatBpsPercent(borrowPreview.rateBps)} · ${borrowPreview.termDays} days` },
                { label: 'Max LTV / Oracle state', value: `${formatBpsPercent(borrowPreview.maxLtvBps)} · ${borrowPreview.quote?.asset?.oracle_state_name ?? '—'}` },
                { label: 'Order expiry (UTC)', value: new Date(borrowPreview.expiry * 1000).toISOString() },
                {
                  label: 'Remaining / Min fill (USDC)',
                  value: `$${formatTokenUnitsDisplay(borrowPreview.remainingRaw, USDC_DECIMALS, 2)} / $${formatTokenUnitsDisplay(borrowPreview.minFillRaw, USDC_DECIMALS, 2)}`,
                },
                {
                  label: 'Fill principal USDC (6 dec)',
                  value: `$${formatTokenUnitsDisplay(borrowPreview.fillAmountRaw, USDC_DECIMALS, 2)} (${borrowPreview.fillAmountRaw} raw)`,
                },
                {
                  label: 'Pro-rata collateral locked (ceil)',
                  value: `${formatTokenUnitsDisplay(borrowPreview.collateralForFillRaw, borrowPreview.collateralDecimals, 6)} ${borrowPreview.collateralSymbol} (${borrowPreview.collateralForFillRaw} raw)`,
                },
                {
                  label: 'Lender net interest / Protocol cut',
                  value: `$${formatTokenUnitsDisplay(borrowPreview.exact.lenderNetInterestRaw, USDC_DECIMALS, 2)} (${borrowPreview.exact.lenderNetInterestRaw.toString()} raw) / $${formatTokenUnitsDisplay(borrowPreview.exact.protocolInterestCutRaw, USDC_DECIMALS, 2)}`,
                },
                {
                  label: 'Open LendOffers sum / Required LoanCore allowance',
                  value: `$${formatTokenUnitsDisplay(borrowPreview.existingOpenSumRaw ?? '0', USDC_DECIMALS, 2)} (${borrowPreview.existingOpenSumRaw ?? '0'} raw) · Need $${formatTokenUnitsDisplay(borrowPreview.requiredApprovalRaw ?? borrowPreview.fillAmountRaw, USDC_DECIMALS, 2)} (${borrowPreview.requiredApprovalRaw ?? borrowPreview.fillAmountRaw} raw)`,
                },
                {
                  label: 'Pre-approval eth_call simulation',
                  value: borrowPreview.simulationVerified
                    ? borrowPreview.needsApproval
                      ? `Verified (LoanCore USDC approval required: $${formatTokenUnitsDisplay(borrowPreview.requiredApprovalRaw ?? borrowPreview.fillAmountRaw, USDC_DECIMALS, 2)})`
                      : 'Verified (LoanCore USDC allowance sufficient)'
                    : 'Pending wallet connection',
                },
              ]}
            />
            <div className="actions" style={{ marginTop: 14 }}>
              <button
                className="btn"
                type="button"
                onClick={() => void handleConfirmFillBorrowOrder()}
                disabled={borrowFillBusy || !web3?.connected || web3?.wrongNetwork || !web3?.eligibilityDeclarationValid}
              >
                {borrowFillBusy
                  ? '2. Approving USDC & filling BorrowOrder…'
                  : '2. Confirm: Approve USDC & fill BorrowOrder'}
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() => setBorrowPreview(null)}
                disabled={borrowFillBusy}
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
