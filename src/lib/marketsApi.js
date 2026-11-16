import { formatUnits, getAddress, isAddress } from 'viem';
import { USDC_DECIMALS, getFrontendConfig } from './contracts.js';
import {
  fetchJsonStrict,
  fetchPaginatedApiRows,
  formatTokenUnitsDisplay,
  formatWeb3Error,
} from './web3.js';

function addThousandsCommas(intStr) {
  return String(intStr).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function parseDecimalToRaw(inputStr, decimals) {
  const clean = String(inputStr ?? '').trim();
  if (!clean) return null;
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  if (frac.length > decimals) return null;
  const paddedFrac = frac.padEnd(decimals, '0');
  const rawStr = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, '') || '0';
  const big = BigInt(rawStr);
  if (big <= 0n) return null;
  return big.toString();
}

export function parsePercentToBps(inputStr) {
  const clean = String(inputStr ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isInteger(bps) || bps < 0 || bps > 100_000) return null;
  return bps;
}

export function formatBpsPercent(bps) {
  if (bps === null || bps === undefined) return '—';
  const n = Number(bps);
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0;
  const abs = Math.abs(Math.round(n));
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

export function formatApiAmount(
  amountObj,
  { prefixUsd = false, maxFractionDigits = 2, minFractionDigits = 2, showSymbol = false } = {}
) {
  if (!amountObj || amountObj.raw === undefined || amountObj.raw === null) return '—';
  const decimals = Number.isInteger(amountObj.decimals) ? amountObj.decimals : USDC_DECIMALS;
  const rawBig = BigInt(amountObj.raw);
  const abs = rawBig < 0n ? -rawBig : rawBig;

  const baseDisplay = formatTokenUnitsDisplay(rawBig, decimals, maxFractionDigits);
  let out;
  if (baseDisplay.startsWith('<') || baseDisplay.startsWith('>-')) {
    if (prefixUsd) {
      out = baseDisplay.startsWith('<')
        ? `<$${baseDisplay.slice(1)}`
        : `>-$${baseDisplay.slice(2)}`;
    } else {
      out = baseDisplay;
    }
  } else {
    const str = formatUnits(abs, decimals);
    const [whole, frac = ''] = str.split('.');
    let clipped = frac.slice(0, maxFractionDigits).replace(/0+$/, '');
    if (prefixUsd && minFractionDigits > 0 && clipped.length < minFractionDigits) {
      clipped = clipped.padEnd(minFractionDigits, '0');
    }
    const groupedWhole = prefixUsd ? addThousandsCommas(whole) : whole;
    const body = clipped ? `${groupedWhole}.${clipped}` : groupedWhole;
    out = `${rawBig < 0n ? '-' : ''}${prefixUsd ? '$' : ''}${body}`;
  }

  if (showSymbol && amountObj.symbol) {
    return `${out} ${amountObj.symbol}`;
  }
  return out;
}

export function formatRawUsdc(raw, opts = {}) {
  return formatApiAmount(
    { raw: BigInt(raw ?? 0n).toString(), decimals: USDC_DECIMALS, symbol: 'USDC' },
    { prefixUsd: true, maxFractionDigits: 2, ...opts }
  );
}

export function buildBookSummary(assets, orders, loans, auctions, { loansTruncated = false } = {}) {
  const safeAssets = Array.isArray(assets) ? assets : [];
  const safeOrders = Array.isArray(orders) ? orders : [];
  const safeLoans = Array.isArray(loans) ? loans : [];
  const safeAuctions = Array.isArray(auctions) ? auctions : [];

  let activeLoansCount = 0;
  let graceLoansCount = 0;
  let auctionLoansCount = 0;
  let repaidLoansCount = 0;
  let settledDefaultCount = 0;
  let settledLiquidatedCount = 0;
  let totalOriginatedRaw = 0n;
  let openPrincipalSumRaw = 0n;
  let badDebtRaw = 0n;
  let aprWeightedSum = 0n;

  for (const l of safeLoans) {
    const st = Number(l.status);
    const prin = BigInt(l.principal?.raw ?? 0n);
    const repaid = BigInt(l.principal_repaid?.raw ?? 0n);
    const remaining = prin > repaid ? prin - repaid : 0n;
    const shortfall = BigInt(l.bad_debt_shortfall?.raw ?? 0n);
    totalOriginatedRaw += prin;
    badDebtRaw += shortfall;

    if (st === 0) activeLoansCount += 1;
    else if (st === 1) graceLoansCount += 1;
    else if (st === 2) auctionLoansCount += 1;
    else if (st === 3) repaidLoansCount += 1;
    else if (st === 4) settledDefaultCount += 1;
    else if (st === 5) settledLiquidatedCount += 1;

    if (st < 3 && remaining > 0n) {
      openPrincipalSumRaw += remaining;
      aprWeightedSum += remaining * BigInt(Number(l.rate_bps ?? 0));
    }
  }

  const firstCaps = safeAssets[0]?.caps ?? null;
  let totalOutstandingRaw = openPrincipalSumRaw;
  if (!loansTruncated && firstCaps?.global_usdc_cap?.raw && firstCaps?.global_remaining?.raw) {
    const gCap = BigInt(firstCaps.global_usdc_cap.raw);
    const gRem = BigInt(firstCaps.global_remaining.raw);
    if (gCap >= gRem) {
      totalOutstandingRaw = gCap - gRem;
    }
  }

  const weightedAverageAprBps =
    openPrincipalSumRaw > 0n ? Number(aprWeightedSum / openPrincipalSumRaw) : 0;

  const borrowOrders = safeOrders.filter((o) => o.order_type === 'borrow' || o.order_type === 'BorrowOrder');
  const lendOffers = safeOrders.filter((o) => o.order_type === 'lend' || o.order_type === 'LendOffer');
  const activeOrdersCount = safeOrders.filter(
    (o) => !o.cancelled && o.status !== 'filled'
  ).length;
  const activeAuctionsCount = safeAuctions.filter((a) => Number(a.status) === 0).length;

  return {
    totalOutstandingUsdc: {
      raw: totalOutstandingRaw.toString(),
      formatted: formatUnits(totalOutstandingRaw, USDC_DECIMALS),
      decimals: USDC_DECIMALS,
      symbol: 'USDC',
    },
    globalCapUsdc: firstCaps?.global_usdc_cap ?? null,
    globalRemainingUsdc: firstCaps?.global_remaining ?? null,
    totalOriginatedUsdc: {
      raw: totalOriginatedRaw.toString(),
      formatted: formatUnits(totalOriginatedRaw, USDC_DECIMALS),
      decimals: USDC_DECIMALS,
      symbol: 'USDC',
    },
    badDebtUsdc: {
      raw: badDebtRaw.toString(),
      formatted: formatUnits(badDebtRaw, USDC_DECIMALS),
      decimals: USDC_DECIMALS,
      symbol: 'USDC',
    },
    activeLoansCount,
    graceLoansCount,
    auctionLoansCount,
    liveLoansCount: activeLoansCount + graceLoansCount + auctionLoansCount,
    repaidLoansCount,
    settledDefaultCount,
    settledLiquidatedCount,
    weightedAverageAprBps,
    borrowOrders,
    lendOffers,
    activeOrdersCount,
    activeAuctionsCount,
    loansTruncated,
  };
}

/**
 * @param {{
 *   cfg?: any,
 *   assetFilter?: string | null,
 *   statusFilter?: string | null,
 *   requestId?: number | null,
 *   includeLoans?: boolean,
 *   includeAuctions?: boolean
 * }} [opts]
 */
export async function fetchMarketSnapshot({
  cfg = getFrontendConfig(),
  assetFilter = null,
  statusFilter = null,
  requestId = null,
  includeLoans = true,
  includeAuctions = true,
} = {}) {
  const fetchedAt = new Date().toISOString();
  if (!cfg?.apiUrl) {
    return {
      requestId,
      stale: true,
      degraded: true,
      error: 'VITE_API_URL is not configured.',
      fetchedAt,
      health: null,
      assets: [],
      orders: [],
      loans: [],
      auctions: [],
      bookSummary: null,
    };
  }

  try {
    const orderParams = new URLSearchParams();
    if (assetFilter && isAddress(assetFilter)) {
      orderParams.set('asset', getAddress(assetFilter));
    }
    if (statusFilter && statusFilter !== 'all') {
      orderParams.set('status', statusFilter);
    }
    const orderQuery = orderParams.toString();
    const ordersBase = `${cfg.apiUrl}/orders${orderQuery ? `?${orderQuery}` : ''}`;

    const [healthRes, assetsRes, ordersRes, loansRes, auctionsRes] = await Promise.all([
      fetchHealthAllow503(`${cfg.apiUrl}/health`),
      fetchPaginatedApiRows(`${cfg.apiUrl}/assets`, { limit: 100, maxPages: 5 }),
      fetchPaginatedApiRows(ordersBase, { limit: 100, maxPages: 10 }),
      includeLoans
        ? fetchPaginatedApiRows(`${cfg.apiUrl}/loans`, { limit: 100, maxPages: 10 })
        : Promise.resolve({ rows: [], total: 0, truncated: false }),
      includeAuctions
        ? fetchPaginatedApiRows(`${cfg.apiUrl}/auctions`, { limit: 100, maxPages: 5 })
        : Promise.resolve({ rows: [], total: 0, truncated: false }),
    ]);

    const degraded = Boolean(
      !healthRes ||
        healthRes.status !== 'ok' ||
        healthRes.db_ok === false ||
        healthRes.rpc_ok === false ||
        healthRes.within_lag_threshold === false
    );

    const statusReason = degraded
      ? `API health is ${healthRes?.status ?? 'unavailable'} (db_ok=${healthRes?.db_ok}, rpc_ok=${healthRes?.rpc_ok}, lag=${healthRes?.lag_blocks ?? '?'} blocks).`
      : '';

    const bookSummary = buildBookSummary(
      assetsRes.rows,
      ordersRes.rows,
      loansRes.rows,
      auctionsRes.rows,
      { loansTruncated: loansRes.truncated }
    );

    return {
      requestId,
      stale: degraded,
      degraded,
      error: statusReason,
      fetchedAt,
      health: healthRes,
      assets: assetsRes.rows,
      orders: ordersRes.rows,
      loans: loansRes.rows,
      auctions: auctionsRes.rows,
      bookSummary,
    };
  } catch (err) {
    return {
      requestId,
      stale: true,
      degraded: true,
      error: `Failed to fetch live market data: ${formatWeb3Error(err)}`,
      fetchedAt,
      health: null,
      assets: [],
      orders: [],
      loans: [],
      auctions: [],
      bookSummary: null,
    };
  }
}

async function fetchHealthAllow503(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.status === 503 && parsed && typeof parsed === 'object' && 'status' in parsed) {
      return parsed;
    }
    if (!res.ok) {
      const msg = parsed?.error?.message || `HTTP ${res.status} from ${url}`;
      throw new Error(msg);
    }
    if (!parsed) {
      throw new Error(`Invalid JSON from ${url}`);
    }
    return parsed;
  } catch (err) {
    if (err && typeof err === 'object' && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRiskSummaryOptional(cfg = getFrontendConfig()) {
  if (!cfg?.riskUrl) return { data: null, error: 'VITE_RISK_URL not configured.' };
  try {
    const data = await fetchHealthAllow503(`${cfg.riskUrl}/risk/summary`);
    return { data, error: data?.monitor_degraded ? data.last_scan_error || 'Risk monitor degraded.' : '' };
  } catch (err) {
    return { data: null, error: formatWeb3Error(err) };
  }
}

/**
 * @param {{
 *   cfg?: any,
 *   asset: string,
 *   principalRaw?: string | null,
 *   collateralAmountRaw?: string | null,
 *   termDays: number,
 *   aprBps: number,
 *   maxLtvBps?: number | string | null,
 *   borrower?: string | null,
 *   lender?: string | null,
 *   borrowerAttestation?: string | null,
 *   lenderAttestation?: string | null
 * }} opts
 */
export async function fetchLoanQuote({
  cfg = getFrontendConfig(),
  asset,
  principalRaw,
  collateralAmountRaw,
  termDays,
  aprBps,
  maxLtvBps,
  borrower,
  lender,
  borrowerAttestation,
  lenderAttestation,
}) {
  if (!cfg?.apiUrl) {
    throw new Error('VITE_API_URL is not configured.');
  }
  if (!asset || !isAddress(asset)) {
    throw new Error('Select a valid registered collateral asset.');
  }
  if (!principalRaw && !collateralAmountRaw) {
    throw new Error('Enter either a USDC principal amount or a collateral token amount.');
  }

  const params = new URLSearchParams();
  params.set('asset', getAddress(asset));
  if (principalRaw) params.set('principal', String(principalRaw));
  if (collateralAmountRaw) params.set('collateral_amount', String(collateralAmountRaw));
  params.set('term_days', String(termDays));
  params.set('apr_bps', String(aprBps));
  if (maxLtvBps !== undefined && maxLtvBps !== null && maxLtvBps !== '') {
    params.set('max_ltv_bps', String(maxLtvBps));
  }
  if (borrower && isAddress(borrower)) {
    params.set('borrower', getAddress(borrower));
  }
  if (lender && isAddress(lender)) {
    params.set('lender', getAddress(lender));
  }
  if (borrowerAttestation && /^0x([0-9a-fA-F]{2})+$/.test(borrowerAttestation.trim())) {
    params.set('borrower_attestation', borrowerAttestation.trim());
  }
  if (lenderAttestation && /^0x([0-9a-fA-F]{2})+$/.test(lenderAttestation.trim())) {
    params.set('lender_attestation', lenderAttestation.trim());
  }

  return fetchJsonStrict(`${cfg.apiUrl}/quote?${params.toString()}`);
}
