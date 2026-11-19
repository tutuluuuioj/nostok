import { formatUnits, getAddress, isAddress, zeroAddress } from 'viem';
import {
  ASSET_STATUS_NAMES,
  ASSET_TIER_NAMES,
  ORACLE_STATE_NAMES,
  USDC_DECIMALS,
  aggregatorV3Abi,
  assetRegistryAbi,
  collateralEscrowAbi,
  createProtocolPublicClient,
  erc20Abi,
  feeCollectorAbi,
  getFrontendConfig,
  loanCoreAbi,
  oracleRouterAbi,
} from './contracts.js';
import {
  fetchJsonStrict,
  fetchLoanQuote,
  fetchPaginatedApiRows,
  formatTokenUnitsDisplay,
  formatWeb3Error,
} from './web3.js';

export { fetchLoanQuote };

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

export function buildBookSummary(
  assets,
  orders,
  loans,
  auctions,
  { loansTruncated = false, ordersTruncated = false, auctionsTruncated = false } = {}
) {
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
    ordersTruncated,
    auctionsTruncated,
  };
}

const RATE_DECIMALS = 18;
const FEED_DECIMALS_DEFAULT = 8;

function formatRawAmountObject(rawValue, decimals, symbol = null) {
  const big = BigInt(rawValue ?? 0n);
  return {
    raw: big.toString(),
    formatted: formatUnits(big, decimals),
    decimals,
    ...(symbol ? { symbol } : {}),
  };
}

function summarizeEscrowBalances(onChainAssets) {
  const assets = Array.isArray(onChainAssets) ? onChainAssets : [];
  if (assets.length === 0) return '0 assets discovered';
  return assets
    .map((asset) => {
      const sym = asset.symbol || `${asset.token.slice(0, 6)}…`;
      const bal = formatApiAmount(asset.escrow_balance, { maxFractionDigits: 4, showSymbol: false });
      return `${sym} ${bal}`;
    })
    .join(' · ');
}

export function buildDataMetricRows(summary, data, health, onChain = null) {
  const hasOnChain = Boolean(onChain?.ok && onChain?.protocol);
  const indexerUnavailable = !summary || Boolean(data?.error && !health);
  const unavailable = indexerUnavailable && !hasOnChain;
  const loanPlus = summary?.loansTruncated ? '+' : '';
  const ordersPlus = summary?.ordersTruncated || summary?.loansTruncated ? '+' : '';
  const auctionsPlus = summary?.auctionsTruncated || summary?.loansTruncated ? '+' : '';

  const liveProtocol = hasOnChain ? onChain.protocol : null;
  const outstandingValue = liveProtocol
    ? formatApiAmount(liveProtocol.totalOutstandingPrincipal, { prefixUsd: true, showSymbol: true })
    : unavailable
      ? 'Unavailable'
      : `${formatApiAmount(summary.totalOutstandingUsdc, { prefixUsd: true, showSymbol: true })}${loanPlus}`;

  const globalCapValue = liveProtocol
    ? `${formatApiAmount(liveProtocol.globalUsdcCap, { prefixUsd: true })} / ${formatApiAmount(liveProtocol.globalRemainingUsdc, { prefixUsd: true })}`
    : unavailable || !summary.globalCapUsdc
      ? 'Unavailable'
      : `${formatApiAmount(summary.globalCapUsdc, { prefixUsd: true })} / ${formatApiAmount(summary.globalRemainingUsdc, { prefixUsd: true })}`;

  const chainHeadBlock = liveProtocol ? onChain.blockNumber : health?.chain_head_block ?? '—';
  let lagDisplay = health?.lag_blocks ?? '—';
  if (
    hasOnChain &&
    health?.last_indexed_block !== null &&
    health?.last_indexed_block !== undefined
  ) {
    try {
      const headBig = BigInt(onChain.blockNumber);
      const idxBig = BigInt(health.last_indexed_block);
      lagDisplay = (headBig >= idxBig ? headBig - idxBig : 0n).toString();
    } catch {
      // preserve API lag string
    }
  }

  return [
    {
      label: 'Outstanding principal',
      value: outstandingValue,
    },
    {
      label: 'Global USDC cap / remaining',
      value: globalCapValue,
    },
    ...(hasOnChain
      ? [
          {
            label: 'Protocol status (LoanCore.paused)',
            value: liveProtocol.paused ? 'PAUSED' : 'Active',
          },
          {
            label: 'Originated loans (LoanCore)',
            value: `${liveProtocol.originatedLoansCount}`,
          },
          {
            label: 'Base market session / Sequencer',
            value: `${liveProtocol.marketOpen ? 'Open' : 'Closed'} · ${liveProtocol.sequencerValid ? 'Sequencer valid' : 'Sequencer invalid'}`,
          },
          {
            label: 'Collateral escrowed (CollateralEscrow)',
            value: summarizeEscrowBalances(onChain.assets),
          },
        ]
      : []),
    {
      label: 'Total originated (indexed)',
      value: indexerUnavailable
        ? hasOnChain
          ? 'Indexer unavailable'
          : 'Unavailable'
        : `${formatApiAmount(summary.totalOriginatedUsdc, { prefixUsd: true, showSymbol: true })}${loanPlus}`,
    },
    {
      label: 'Active loans (status 0)',
      value: indexerUnavailable
        ? hasOnChain
          ? 'Indexer unavailable'
          : 'Unavailable'
        : `${summary.activeLoansCount}${loanPlus}`,
    },
    {
      label: 'Loans in grace (status 1)',
      value: indexerUnavailable
        ? hasOnChain
          ? 'Indexer unavailable'
          : 'Unavailable'
        : `${summary.graceLoansCount}${loanPlus}`,
    },
    {
      label: 'Loans in auction (status 2)',
      value: indexerUnavailable
        ? hasOnChain
          ? 'Indexer unavailable'
          : 'Unavailable'
        : `${summary.auctionLoansCount}${loanPlus}`,
    },
    {
      label: 'Repaid / defaulted / liquidated',
      value: indexerUnavailable
        ? hasOnChain
          ? 'Indexer unavailable'
          : 'Unavailable'
        : `${summary.repaidLoansCount}${loanPlus} / ${summary.settledDefaultCount}${loanPlus} / ${summary.settledLiquidatedCount}${loanPlus}`,
    },
    {
      label: 'Active liquidation auctions',
      value: indexerUnavailable
        ? hasOnChain
          ? 'Indexer unavailable'
          : 'Unavailable'
        : `${summary.activeAuctionsCount}${auctionsPlus}`,
    },
    {
      label: 'Indexed orders (active / total)',
      value: indexerUnavailable
        ? hasOnChain
          ? 'Indexer unavailable'
          : 'Unavailable'
        : `${summary.activeOrdersCount}${ordersPlus} / ${(data?.orders ?? []).length}${ordersPlus}`,
    },
    {
      label: 'Weighted average APR (open book)',
      value: indexerUnavailable
        ? hasOnChain
          ? 'Indexer unavailable'
          : 'Unavailable'
        : formatBpsPercent(summary.weightedAverageAprBps),
    },
    {
      label: 'Realized bad debt shortfall',
      value: indexerUnavailable
        ? hasOnChain
          ? 'Indexer unavailable'
          : 'Unavailable'
        : `${formatApiAmount(summary.badDebtUsdc, { prefixUsd: true, showSymbol: true })}${loanPlus}`,
    },
    {
      label: 'Indexed block / chain head',
      value:
        health || hasOnChain
          ? `#${health?.last_indexed_block ?? '—'} / #${chainHeadBlock} (lag ${lagDisplay})`
          : 'Unavailable',
    },
    {
      label: 'Snapshot timestamp',
      value:
        (hasOnChain ? new Date(onChain.blockTimestamp * 1000).toISOString() : null) ??
        health?.freshness_timestamp ??
        data?.fetchedAt ??
        'Unavailable',
    },
  ];
}

export function buildOnChainEnvironmentRows(onChain) {
  if (!onChain?.ok || !onChain?.protocol) return [];
  const p = onChain.protocol;
  const blockIso = Number.isFinite(onChain.blockTimestamp)
    ? new Date(onChain.blockTimestamp * 1000).toISOString()
    : '—';
  const sessionNote = p.useManualMarketSession
    ? ` (manual override: ${p.isMarketOpenManual ? 'open' : 'closed'})`
    : ' (US market hours + calendar)';
  return [
    { label: 'Base RPC block / timestamp', value: `#${onChain.blockNumber} · ${blockIso}` },
    { label: 'LoanCore.paused()', value: p.paused ? 'PAUSED (repay & top-up only)' : 'Active (unpaused)' },
    {
      label: 'Global USDC cap / outstanding / remaining',
      value: `${formatApiAmount(p.globalUsdcCap, { prefixUsd: true })} / ${formatApiAmount(p.totalOutstandingPrincipal, { prefixUsd: true })} / ${formatApiAmount(p.globalRemainingUsdc, { prefixUsd: true })}`,
    },
    { label: 'Originated loans (LoanCore.nextLoanId - 1)', value: `${p.originatedLoansCount}` },
    {
      label: 'OracleRouter.isMarketOpen()',
      value: `${p.marketOpen ? 'Open' : 'Closed'}${sessionNote}`,
    },
    {
      label: 'OracleRouter.isSequencerValid()',
      value: p.sequencerValid ? 'Valid (uptime ok)' : 'Invalid / within 1h grace period',
    },
    {
      label: 'OracleRouter.maxStaleClosedSecs()',
      value: `${p.maxStaleClosedSecs}s`,
    },
  ];
}

export function buildRiskSummaryRows(risk) {
  if (!risk) return [];
  return [
    { label: 'Monitor status', value: risk.status ?? '—' },
    { label: 'Monitor degraded (monitor_degraded)', value: risk.monitor_degraded ? 'true (degraded)' : 'false' },
    { label: 'Last scan error (last_scan_error)', value: risk.last_scan_error || 'None' },
    { label: 'Last scan timestamp (last_scan_timestamp)', value: risk.last_scan_timestamp || '—' },
    { label: 'Chain head block', value: `#${risk.chain_head_block ?? '—'}` },
    {
      label: 'Equity market open',
      value: risk.market_open === null || risk.market_open === undefined ? '—' : risk.market_open ? 'Open' : 'Closed',
    },
    {
      label: 'Protocol paused',
      value: risk.protocol_paused === null || risk.protocol_paused === undefined ? '—' : risk.protocol_paused ? 'Paused' : 'Active',
    },
    {
      label: 'Global cap / outstanding',
      value: `${formatApiAmount(risk.global_usdc_cap, { prefixUsd: true })} / ${formatApiAmount(risk.total_outstanding_principal, { prefixUsd: true })}`,
    },
    {
      label: 'Loans by risk (H / MC / NL / Liq / Unk)',
      value: risk.loan_counts
        ? `${risk.loan_counts.healthy} / ${risk.loan_counts.margin_call} / ${risk.loan_counts.near_liquidation} / ${risk.loan_counts.liquidatable} / ${risk.loan_counts.unknown ?? 0}`
        : '—',
    },
  ];
}

export function buildProtocolFeeCards(fees) {
  if (!fees) return [];
  return [
    {
      name: 'Origination',
      detail: `Borrower. ${formatBpsPercent(fees.origination_fee_bps)} of principal. Hard cap ${formatBpsPercent(fees.max_origination_bps)}. Taken from proceeds at fill.`,
    },
    {
      name: 'Interest cut',
      detail: `Lender. ${formatBpsPercent(fees.interest_cut_bps)} of interest. Hard cap ${formatBpsPercent(fees.max_interest_cut_bps)}. Taken at repayment.`,
    },
    {
      name: 'Liquidation',
      detail: `Borrower, from proceeds. ${formatBpsPercent(fees.liquidation_fee_bps)} of collateral sold. Hard cap ${formatBpsPercent(fees.max_liquidation_bps)}. Includes the keeper reward.`,
    },
    {
      name: 'Safety reserve share',
      detail: `Protocol split. ${formatBpsPercent(fees.safety_reserve_share_bps)} of collected protocol fees routed to safety reserve.`,
    },
  ];
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
  includeInactive = false,
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
      fees: null,
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
    if (includeInactive) {
      orderParams.set('include_inactive', 'true');
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

    const ordersStale = Boolean(ordersRes?.stale);
    const degraded = Boolean(
      !healthRes ||
        healthRes.status !== 'ok' ||
        healthRes.db_ok === false ||
        healthRes.rpc_ok === false ||
        healthRes.within_lag_threshold === false ||
        ordersStale
    );

    const statusReason = degraded
      ? ordersStale && healthRes?.status === 'ok'
        ? 'Orderbook RPC refresh failed or returned stale relayed order states.'
        : `API health is ${healthRes?.status ?? 'unavailable'} (db_ok=${healthRes?.db_ok}, rpc_ok=${healthRes?.rpc_ok}, lag=${healthRes?.lag_blocks ?? '?'} blocks).`
      : '';

    const bookSummary = buildBookSummary(
      assetsRes.rows,
      ordersRes.rows,
      loansRes.rows,
      auctionsRes.rows,
      {
        loansTruncated: loansRes.truncated,
        ordersTruncated: ordersRes.truncated,
        auctionsTruncated: auctionsRes.truncated,
      }
    );

    return {
      requestId,
      stale: degraded,
      degraded,
      error: statusReason,
      fetchedAt,
      health: healthRes,
      fees: assetsRes.fees ?? null,
      assets: assetsRes.rows,
      orders: ordersRes.rows,
      ordersTruncated: Boolean(ordersRes.truncated),
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
      fees: null,
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

async function safeRead(promise, fallback = null) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

async function discoverAssetTokensFromLogs(client, assetRegistryAddr, blockNumber) {
  const eventAbi = assetRegistryAbi.find((item) => item.type === 'event' && item.name === 'AssetConfigSet');
  if (!eventAbi) return [];
  const collect = (logs, out, seen) => {
    for (const log of logs) {
      const rawTok = log?.args?.token;
      if (!rawTok || !isAddress(rawTok)) continue;
      const checksummed = getAddress(rawTok);
      const key = checksummed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(checksummed);
    }
  };

  for (const windowBlocks of [10_000n, 2_000n, 500n]) {
    const fromBlock = blockNumber > windowBlocks ? blockNumber - windowBlocks : 0n;
    try {
      const logs = await client.getLogs({
        address: assetRegistryAddr,
        event: eventAbi,
        fromBlock,
        toBlock: blockNumber,
      });
      const addrs = [];
      collect(logs, addrs, new Set());
      return addrs;
    } catch {
      // Retry with smaller window if RPC limits eth_getLogs block span
    }
  }

  // Fallback for strict small-window RPCs or local fork tail blocks: walk back in 150-block steps
  const addrs = [];
  const seen = new Set();
  let curTo = blockNumber;
  for (let i = 0; i < 4 && curTo > 0n; i++) {
    const curFrom = curTo > 150n ? curTo - 149n : 0n;
    try {
      const logs = await client.getLogs({
        address: assetRegistryAddr,
        event: eventAbi,
        fromBlock: curFrom,
        toBlock: curTo,
      });
      collect(logs, addrs, seen);
    } catch {
      break;
    }
    if (curFrom === 0n) break;
    curTo = curFrom - 1n;
  }
  return addrs;
}

async function discoverAssetTokensFromRecentLoans(client, loanCoreAddr, nextLoanId, blockNumber) {
  const nextBig = BigInt(nextLoanId ?? 1n);
  if (nextBig <= 1n) return [];
  const endId = nextBig - 1n;
  const startId = endId > 29n ? endId - 29n : 1n;
  const ids = [];
  for (let id = startId; id <= endId; id++) {
    ids.push(id);
  }
  const loans = await Promise.all(
    ids.map((id) =>
      safeRead(
        client.readContract({
          address: loanCoreAddr,
          abi: loanCoreAbi,
          functionName: 'getLoan',
          args: [id],
          blockNumber,
        }),
        null
      )
    )
  );
  const tokens = [];
  const seen = new Set();
  for (const loan of loans) {
    const rawTok = loan?.collateralToken;
    if (!rawTok || rawTok === zeroAddress || !isAddress(rawTok)) continue;
    const cs = getAddress(rawTok);
    const key = cs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(cs);
  }
  return tokens;
}

async function readSingleOnChainAssetState({
  tokenAddr,
  client,
  blockNumber,
  blockTimestamp,
  assetRegistryAddr,
  oracleRouterAddr,
  loanCoreAddr,
  escrowAddr,
  globalRemaining,
  globalCap,
  maxStaleClosedSecs,
  fallbackAsset = null,
}) {
  const [
    supported,
    assetCfg,
    priceTuple,
    recMultRaw,
    assetOutstandingRaw,
    escrowBalanceRaw,
    symbolRes,
    decimalsRes,
    uiMultRes,
  ] = await Promise.all([
    client.readContract({
      address: assetRegistryAddr,
      abi: assetRegistryAbi,
      functionName: 'isAssetSupported',
      args: [tokenAddr],
      blockNumber,
    }),
    client.readContract({
      address: assetRegistryAddr,
      abi: assetRegistryAbi,
      functionName: 'getAssetConfig',
      args: [tokenAddr],
      blockNumber,
    }),
    safeRead(
      client.readContract({
        address: oracleRouterAddr,
        abi: oracleRouterAbi,
        functionName: 'getPrice',
        args: [tokenAddr],
        blockNumber,
      }),
      null
    ),
    safeRead(
      client.readContract({
        address: oracleRouterAddr,
        abi: oracleRouterAbi,
        functionName: 'recordedMultiplier',
        args: [tokenAddr],
        blockNumber,
      }),
      0n
    ),
    client.readContract({
      address: loanCoreAddr,
      abi: loanCoreAbi,
      functionName: 'assetOutstandingPrincipal',
      args: [tokenAddr],
      blockNumber,
    }),
    escrowAddr
      ? safeRead(
          client.readContract({
            address: escrowAddr,
            abi: collateralEscrowAbi,
            functionName: 'getBalance',
            args: [tokenAddr],
            blockNumber,
          }),
          0n
        )
      : Promise.resolve(0n),
    safeRead(
      client.readContract({
        address: tokenAddr,
        abi: erc20Abi,
        functionName: 'symbol',
        blockNumber,
      }),
      null
    ),
    safeRead(
      client.readContract({
        address: tokenAddr,
        abi: erc20Abi,
        functionName: 'decimals',
        blockNumber,
      }),
      null
    ),
    safeRead(
      client.readContract({
        address: tokenAddr,
        abi: erc20Abi,
        functionName: 'uiMultiplier',
        blockNumber,
      }),
      null
    ),
  ]);

  const feedAddr = assetCfg?.feed && assetCfg.feed !== zeroAddress ? getAddress(assetCfg.feed) : null;
  if (!supported && !feedAddr) {
    return null;
  }

  const tokenDecimals =
    decimalsRes !== null && decimalsRes !== undefined
      ? Number(decimalsRes)
      : Number.isInteger(fallbackAsset?.decimals)
        ? fallbackAsset.decimals
        : 18;
  const symbol =
    typeof symbolRes === 'string' && symbolRes.trim()
      ? symbolRes.trim()
      : fallbackAsset?.symbol ?? null;

  const oneWholeTokenRaw = 10n ** BigInt(tokenDecimals);
  const [unitValueTuple, roundData] = await Promise.all([
    safeRead(
      client.readContract({
        address: oracleRouterAddr,
        abi: oracleRouterAbi,
        functionName: 'getValue',
        args: [tokenAddr, oneWholeTokenRaw],
        blockNumber,
      }),
      null
    ),
    feedAddr
      ? safeRead(
          client.readContract({
            address: feedAddr,
            abi: aggregatorV3Abi,
            functionName: 'latestRoundData',
            blockNumber,
          }),
          null
        )
      : Promise.resolve(null),
  ]);

  const priceRaw = priceTuple ? BigInt(priceTuple[0] ?? 0n) : 0n;
  const priceDecimals = priceTuple
    ? Number(priceTuple[1])
    : Number(assetCfg?.feedDecimals ?? FEED_DECIMALS_DEFAULT);
  const oracleState = priceTuple ? Number(priceTuple[2]) : 3;

  const grossUnitUsdcRaw = unitValueTuple ? BigInt(unitValueTuple[0] ?? 0n) : 0n;
  const effectiveUnitUsdcRaw = unitValueTuple ? BigInt(unitValueTuple[1] ?? 0n) : 0n;

  const feedUpdatedAt = roundData ? BigInt(roundData[3] ?? 0n) : 0n;
  const feedAgeSeconds =
    feedUpdatedAt > 0n
      ? blockTimestamp >= feedUpdatedAt
        ? Number(blockTimestamp - feedUpdatedAt)
        : 0
      : null;

  const recMult = BigInt(recMultRaw ?? 0n);
  const uiMult = uiMultRes !== null && uiMultRes !== undefined ? BigInt(uiMultRes) : null;
  let multiplierDriftBps = 0;
  if (uiMult !== null && uiMult > 0n) {
    if (recMult > 0n) {
      const diff = uiMult > recMult ? uiMult - recMult : recMult - uiMult;
      multiplierDriftBps = Number((diff * 10_000n) / recMult);
    } else {
      multiplierDriftBps = null;
    }
  }

  const perLoanCap = BigInt(assetCfg.perLoanCap ?? 0n);
  const assetCap = BigInt(assetCfg.assetCap ?? 0n);
  const assetOutstanding = BigInt(assetOutstandingRaw ?? 0n);
  const assetRemaining =
    assetCap > 0n
      ? assetCap > assetOutstanding
        ? assetCap - assetOutstanding
        : 0n
      : globalRemaining;
  const status = Number(assetCfg.status ?? 0);
  const tier = Number(assetCfg.tier ?? 0);

  return {
    source: 'onchain_rpc',
    token: tokenAddr,
    symbol,
    decimals: tokenDecimals,
    supported: Boolean(supported),
    feed: feedAddr,
    tier,
    tier_name: ASSET_TIER_NAMES[tier] ?? `Tier ${tier}`,
    status,
    status_name: ASSET_STATUS_NAMES[status] ?? `UNKNOWN(${status})`,
    restricted: Boolean(assetCfg.restricted),
    ltv: {
      max_init_ltv_bps: Number(assetCfg.maxInitLtvBps),
      margin_call_ltv_bps: Number(assetCfg.marginCallLtvBps),
      liq_ltv_bps: Number(assetCfg.liqLtvBps),
      bad_debt_ltv_bps: Number(assetCfg.badDebtLtvBps),
      max_discount_bps: Number(assetCfg.maxDiscountBps),
      closed_market_haircut_bps: Number(assetCfg.closedMarketHaircutBps),
    },
    caps: {
      per_loan_cap: formatRawAmountObject(perLoanCap, USDC_DECIMALS, 'USDC'),
      asset_cap: formatRawAmountObject(assetCap, USDC_DECIMALS, 'USDC'),
      asset_outstanding_principal: formatRawAmountObject(assetOutstanding, USDC_DECIMALS, 'USDC'),
      asset_remaining: formatRawAmountObject(assetRemaining, USDC_DECIMALS, 'USDC'),
      global_usdc_cap: formatRawAmountObject(globalCap, USDC_DECIMALS, 'USDC'),
      global_remaining: formatRawAmountObject(globalRemaining, USDC_DECIMALS, 'USDC'),
    },
    multiplier: {
      recorded: formatRawAmountObject(recMult, RATE_DECIMALS),
      ui: uiMult !== null ? formatRawAmountObject(uiMult, RATE_DECIMALS) : null,
      drift_bps: multiplierDriftBps,
    },
    oracle: {
      price: formatRawAmountObject(priceRaw, priceDecimals, 'USD'),
      state: oracleState,
      state_name: ORACLE_STATE_NAMES[oracleState] ?? `UNKNOWN(${oracleState})`,
      max_stale_open_secs: Number(assetCfg.maxStaleOpenSecs),
      max_stale_closed_secs: maxStaleClosedSecs,
      feed_updated_at: feedUpdatedAt > 0n ? Number(feedUpdatedAt) : null,
      feed_age_seconds: feedAgeSeconds,
      gross_unit_value_usdc: formatRawAmountObject(grossUnitUsdcRaw, USDC_DECIMALS, 'USDC'),
      effective_unit_value_usdc: formatRawAmountObject(effectiveUnitUsdcRaw, USDC_DECIMALS, 'USDC'),
    },
    escrow_balance: formatRawAmountObject(escrowBalanceRaw ?? 0n, tokenDecimals, symbol),
    live_block_number: blockNumber.toString(),
    live_block_timestamp: Number(blockTimestamp),
  };
}

export async function fetchLiveProtocolContractState({
  cfg = getFrontendConfig(),
  publicClient = null,
  tokenAddresses = [],
  knownAssets = [],
  includeLogDiscovery = true,
} = {}) {
  const fetchedAt = new Date().toISOString();
  const c = cfg?.contracts ?? {};
  if (!cfg?.rpcUrl || !c.loanCore || !c.assetRegistry || !c.oracleRouter) {
    return {
      ok: false,
      error: 'RPC URL or core contract addresses (LoanCore, AssetRegistry, OracleRouter) not configured.',
      fetchedAt,
      blockNumber: null,
      blockTimestamp: null,
      protocol: null,
      fees: null,
      assets: [],
      tokenAddressesUsed: [],
    };
  }

  const client = publicClient ?? createProtocolPublicClient(cfg);
  const loanCoreAddr = getAddress(c.loanCore);
  const assetRegistryAddr = getAddress(c.assetRegistry);
  const oracleRouterAddr = getAddress(c.oracleRouter);
  const configuredEscrowAddr = c.collateralEscrow ? getAddress(c.collateralEscrow) : null;

  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    const blockNumber = block.number;
    const blockTimestamp = BigInt(block.timestamp ?? 0n);

    const [
      paused,
      globalCap,
      totalOutstanding,
      nextLoanId,
      feeCollectorAddrRaw,
      loanCoreEscrowRaw,
      marketOpen,
      sequencerValid,
      maxStaleClosedSecsRaw,
      useManualMarketSession,
      isMarketOpenManual,
    ] = await Promise.all([
      client.readContract({ address: loanCoreAddr, abi: loanCoreAbi, functionName: 'paused', blockNumber }),
      client.readContract({ address: loanCoreAddr, abi: loanCoreAbi, functionName: 'globalUsdcCap', blockNumber }),
      client.readContract({
        address: loanCoreAddr,
        abi: loanCoreAbi,
        functionName: 'totalOutstandingPrincipal',
        blockNumber,
      }),
      client.readContract({ address: loanCoreAddr, abi: loanCoreAbi, functionName: 'nextLoanId', blockNumber }),
      safeRead(
        client.readContract({ address: loanCoreAddr, abi: loanCoreAbi, functionName: 'feeCollector', blockNumber }),
        null
      ),
      safeRead(
        client.readContract({ address: loanCoreAddr, abi: loanCoreAbi, functionName: 'escrow', blockNumber }),
        null
      ),
      client.readContract({ address: oracleRouterAddr, abi: oracleRouterAbi, functionName: 'isMarketOpen', blockNumber }),
      client.readContract({
        address: oracleRouterAddr,
        abi: oracleRouterAbi,
        functionName: 'isSequencerValid',
        blockNumber,
      }),
      client.readContract({
        address: oracleRouterAddr,
        abi: oracleRouterAbi,
        functionName: 'maxStaleClosedSecs',
        blockNumber,
      }),
      safeRead(
        client.readContract({
          address: oracleRouterAddr,
          abi: oracleRouterAbi,
          functionName: 'useManualMarketSession',
          blockNumber,
        }),
        false
      ),
      safeRead(
        client.readContract({
          address: oracleRouterAddr,
          abi: oracleRouterAbi,
          functionName: 'isMarketOpenManual',
          blockNumber,
        }),
        false
      ),
    ]);

    const escrowAddr =
      loanCoreEscrowRaw && loanCoreEscrowRaw !== zeroAddress
        ? getAddress(loanCoreEscrowRaw)
        : configuredEscrowAddr;
    const feeCollectorAddr =
      feeCollectorAddrRaw && feeCollectorAddrRaw !== zeroAddress ? getAddress(feeCollectorAddrRaw) : null;

    const feePromise = feeCollectorAddr
      ? Promise.all([
          client.readContract({ address: feeCollectorAddr, abi: feeCollectorAbi, functionName: 'originationFeeBps', blockNumber }),
          client.readContract({ address: feeCollectorAddr, abi: feeCollectorAbi, functionName: 'interestCutBps', blockNumber }),
          client.readContract({ address: feeCollectorAddr, abi: feeCollectorAbi, functionName: 'liquidationFeeBps', blockNumber }),
          client.readContract({
            address: feeCollectorAddr,
            abi: feeCollectorAbi,
            functionName: 'safetyReserveShareBps',
            blockNumber,
          }),
          client.readContract({
            address: feeCollectorAddr,
            abi: feeCollectorAbi,
            functionName: 'MAX_ORIGINATION_BPS',
            blockNumber,
          }),
          client.readContract({
            address: feeCollectorAddr,
            abi: feeCollectorAbi,
            functionName: 'MAX_INTEREST_CUT_BPS',
            blockNumber,
          }),
          client.readContract({
            address: feeCollectorAddr,
            abi: feeCollectorAbi,
            functionName: 'MAX_LIQUIDATION_BPS',
            blockNumber,
          }),
        ]).then(([orig, intCut, liq, resShare, maxOrig, maxInt, maxLiq]) => ({
          origination_fee_bps: Number(orig),
          interest_cut_bps: Number(intCut),
          liquidation_fee_bps: Number(liq),
          safety_reserve_share_bps: Number(resShare),
          max_origination_bps: Number(maxOrig),
          max_interest_cut_bps: Number(maxInt),
          max_liquidation_bps: Number(maxLiq),
        }))
      : Promise.resolve(null);

    const logDiscoveryPromise = includeLogDiscovery
      ? discoverAssetTokensFromLogs(client, assetRegistryAddr, blockNumber)
      : Promise.resolve([]);
    const loanDiscoveryPromise = discoverAssetTokensFromRecentLoans(
      client,
      loanCoreAddr,
      nextLoanId,
      blockNumber
    );

    const [fees, logTokens, loanTokens] = await Promise.all([
      safeRead(feePromise, null),
      logDiscoveryPromise,
      loanDiscoveryPromise,
    ]);

    const knownByLower = new Map();
    for (const a of Array.isArray(knownAssets) ? knownAssets : []) {
      if (a?.token && isAddress(a.token)) {
        knownByLower.set(getAddress(a.token).toLowerCase(), a);
      }
    }

    const tokenSet = new Map();
    for (const candidate of [
      ...(tokenAddresses || []),
      ...(Array.isArray(knownAssets) ? knownAssets.map((a) => a?.token) : []),
      ...logTokens,
      ...loanTokens,
    ]) {
      if (!candidate || !isAddress(candidate)) continue;
      const cs = getAddress(candidate);
      tokenSet.set(cs.toLowerCase(), cs);
    }

    const globalCapBig = BigInt(globalCap ?? 0n);
    const totalOutBig = BigInt(totalOutstanding ?? 0n);
    const globalRemBig = globalCapBig > totalOutBig ? globalCapBig - totalOutBig : 0n;
    const maxStaleClosedSecs = Number(maxStaleClosedSecsRaw ?? 0);

    const candidateList = Array.from(tokenSet.values()).sort((a, b) => a.localeCompare(b));
    const assetResults = await Promise.all(
      candidateList.map((tokenAddr) =>
        readSingleOnChainAssetState({
          tokenAddr,
          client,
          blockNumber,
          blockTimestamp,
          assetRegistryAddr,
          oracleRouterAddr,
          loanCoreAddr,
          escrowAddr,
          globalCap: globalCapBig,
          globalRemaining: globalRemBig,
          maxStaleClosedSecs,
          fallbackAsset: knownByLower.get(tokenAddr.toLowerCase()) ?? null,
        })
      )
    );
    const liveAssets = assetResults.filter(Boolean);
    const nextLoanBig = BigInt(nextLoanId ?? 1n);

    return {
      ok: true,
      error: '',
      fetchedAt,
      blockNumber: blockNumber.toString(),
      blockTimestamp: Number(blockTimestamp),
      protocol: {
        paused: Boolean(paused),
        nextLoanId: nextLoanBig.toString(),
        originatedLoansCount: (nextLoanBig > 1n ? nextLoanBig - 1n : 0n).toString(),
        globalUsdcCap: formatRawAmountObject(globalCapBig, USDC_DECIMALS, 'USDC'),
        totalOutstandingPrincipal: formatRawAmountObject(totalOutBig, USDC_DECIMALS, 'USDC'),
        globalRemainingUsdc: formatRawAmountObject(globalRemBig, USDC_DECIMALS, 'USDC'),
        feeCollector: feeCollectorAddr,
        escrow: escrowAddr,
        marketOpen: Boolean(marketOpen),
        sequencerValid: Boolean(sequencerValid),
        maxStaleClosedSecs,
        useManualMarketSession: Boolean(useManualMarketSession),
        isMarketOpenManual: Boolean(isMarketOpenManual),
      },
      fees,
      assets: liveAssets,
      tokenAddressesUsed: candidateList,
    };
  } catch (err) {
    return {
      ok: false,
      error: formatWeb3Error(err),
      fetchedAt,
      blockNumber: null,
      blockTimestamp: null,
      protocol: null,
      fees: null,
      assets: [],
      tokenAddressesUsed: [],
    };
  }
}

export function reconcileLiveAssetsWithApi(apiAssets, onChainSnapshot) {
  const safeApi = Array.isArray(apiAssets) ? apiAssets : [];
  if (!onChainSnapshot?.ok) {
    return { assets: safeApi, discrepancies: [], usingOnChain: false };
  }

  const chainAssets = Array.isArray(onChainSnapshot.assets) ? onChainSnapshot.assets : [];
  const apiByLower = new Map();
  for (const asset of safeApi) {
    if (asset?.token && isAddress(asset.token)) {
      apiByLower.set(getAddress(asset.token).toLowerCase(), asset);
    }
  }

  const merged = [];
  const discrepancies = [];
  const seen = new Set();

  for (const chainAsset of chainAssets) {
    const key = chainAsset.token.toLowerCase();
    seen.add(key);
    const apiAsset = apiByLower.get(key) ?? null;
    if (apiAsset) {
      const label = chainAsset.symbol || apiAsset.symbol || chainAsset.token;
      if (apiAsset.status !== undefined && Number(apiAsset.status) !== Number(chainAsset.status)) {
        discrepancies.push(
          `${label}: AssetStatus api=${apiAsset.status_name ?? apiAsset.status} vs Base AssetRegistry=${chainAsset.status_name}`
        );
      }
      if (
        apiAsset.oracle?.state !== undefined &&
        Number(apiAsset.oracle.state) !== Number(chainAsset.oracle.state)
      ) {
        discrepancies.push(
          `${label}: OracleState api=${apiAsset.oracle.state_name ?? apiAsset.oracle.state} vs Base OracleRouter=${chainAsset.oracle.state_name}`
        );
      }
      if (
        apiAsset.ltv?.max_init_ltv_bps !== undefined &&
        Number(apiAsset.ltv.max_init_ltv_bps) !== Number(chainAsset.ltv.max_init_ltv_bps)
      ) {
        discrepancies.push(
          `${label}: maxInitLtvBps api=${apiAsset.ltv.max_init_ltv_bps} vs Base AssetRegistry=${chainAsset.ltv.max_init_ltv_bps}`
        );
      }
      if (
        apiAsset.ltv?.liq_ltv_bps !== undefined &&
        Number(apiAsset.ltv.liq_ltv_bps) !== Number(chainAsset.ltv.liq_ltv_bps)
      ) {
        discrepancies.push(
          `${label}: liqLtvBps api=${apiAsset.ltv.liq_ltv_bps} vs Base AssetRegistry=${chainAsset.ltv.liq_ltv_bps}`
        );
      }
      if (
        apiAsset.caps?.asset_cap?.raw !== undefined &&
        String(apiAsset.caps.asset_cap.raw) !== String(chainAsset.caps.asset_cap.raw)
      ) {
        discrepancies.push(
          `${label}: assetCap api=${apiAsset.caps.asset_cap.raw} vs Base AssetRegistry=${chainAsset.caps.asset_cap.raw}`
        );
      }
      if (
        apiAsset.multiplier?.recorded?.raw !== undefined &&
        String(apiAsset.multiplier.recorded.raw) !== String(chainAsset.multiplier.recorded.raw)
      ) {
        discrepancies.push(
          `${label}: recordedMultiplier api=${apiAsset.multiplier.recorded.raw} vs Base OracleRouter=${chainAsset.multiplier.recorded.raw}`
        );
      }
    }

    merged.push({
      ...(apiAsset || {}),
      ...chainAsset,
      updated_block: apiAsset?.updated_block ?? null,
    });
  }

  for (const apiAsset of safeApi) {
    if (!apiAsset?.token || !isAddress(apiAsset.token)) continue;
    const key = getAddress(apiAsset.token).toLowerCase();
    if (seen.has(key)) continue;
    merged.push({
      ...apiAsset,
      source: 'api_only',
    });
  }

  return {
    assets: merged,
    discrepancies,
    usingOnChain: true,
  };
}

export async function fetchMarketsAndLiveContracts({
  cfg = getFrontendConfig(),
  assetFilter = null,
  statusFilter = null,
  includeInactive = false,
  requestId = null,
  includeLoans = true,
  includeAuctions = true,
  tokenAddresses = [],
  publicClient = null,
} = {}) {
  const [market, initialOnChain] = await Promise.all([
    fetchMarketSnapshot({
      cfg,
      assetFilter,
      statusFilter,
      includeInactive,
      requestId,
      includeLoans,
      includeAuctions,
    }),
    fetchLiveProtocolContractState({
      cfg,
      publicClient,
      tokenAddresses,
      includeLogDiscovery: true,
    }),
  ]);

  let onChain = initialOnChain;
  if (onChain.ok) {
    const discoveredLower = new Set(onChain.tokenAddressesUsed.map((t) => t.toLowerCase()));
    const extraApiTokens = [];
    for (const a of market.assets ?? []) {
      if (a?.token && isAddress(a.token)) {
        const cs = getAddress(a.token);
        if (!discoveredLower.has(cs.toLowerCase())) {
          extraApiTokens.push(cs);
        }
      }
    }
    if (extraApiTokens.length > 0) {
      onChain = await fetchLiveProtocolContractState({
        cfg,
        publicClient,
        tokenAddresses: [...onChain.tokenAddressesUsed, ...extraApiTokens],
        knownAssets: market.assets ?? [],
        includeLogDiscovery: false,
      });
    }
  }

  const reconciled = reconcileLiveAssetsWithApi(market.assets, onChain);
  const protocolDiscrepancies = [...reconciled.discrepancies];
  if (
    onChain.ok &&
    market.bookSummary?.globalCapUsdc?.raw &&
    String(market.bookSummary.globalCapUsdc.raw) !== String(onChain.protocol.globalUsdcCap.raw)
  ) {
    protocolDiscrepancies.push(
      `Global USDC cap api=${market.bookSummary.globalCapUsdc.raw} vs Base LoanCore=${onChain.protocol.globalUsdcCap.raw}`
    );
  }

  return {
    market,
    onChain,
    assets: reconciled.assets,
    usingOnChainAssets: reconciled.usingOnChain,
    discrepancies: protocolDiscrepancies,
  };
}
