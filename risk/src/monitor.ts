import {
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  createPublicClient,
  defineChain,
  getAddress,
  http as viemHttp,
} from 'viem';
import { base } from 'viem/chains';
import {
  ASSET_STATUS_NAMES,
  LOAN_STATUS_NAMES,
  ORACLE_STATE_NAMES,
  OracleState,
  aggregatorV3Abi,
  assetRegistryAbi,
  collateralEscrowAbi,
  erc20MetaAbi,
  loanCoreAbi,
  oracleRouterAbi,
} from './abi.js';
import { AlertEngine, type AlertObservation, type AlertSeverity } from './alerts.js';
import type { RiskConfig } from './config.js';
import { type ReadOnlyDatabase, openReadOnlyDatabase } from './db.js';
import { type FormattedAmount, ceilDiv, formatAmount, formatRay18 } from './format.js';

const USDC_DECIMALS = 6;
const RATE_DECIMALS = 18;
const FEED_DECIMALS_DEFAULT = 8;
const MULTICALL_CHUNK_SIZE = 200;
const GRACE_PERIOD_SECONDS = 86_400n;

export function computeLiquidationPrice(
  debt: bigint,
  liqLtvBps: bigint,
  collateralRaw: bigint,
  priceScale: bigint
): bigint {
  if (debt <= 0n || liqLtvBps <= 0n || collateralRaw <= 0n) return 0n;
  const gMax = (debt * 10_000n) / liqLtvBps;
  return ceilDiv((gMax + 1n) * priceScale, collateralRaw * 1_000_000n);
}

export type LoanRiskStatus = 'healthy' | 'margin_call' | 'near_liquidation' | 'liquidatable';

export interface LoanRiskSnapshot {
  loan_id: string;
  borrower: Address;
  collateral_token: Address;
  collateral_symbol: string | null;
  collateral_decimals: number;
  loan_status: number;
  loan_status_name: string;
  risk_status: LoanRiskStatus;
  principal_remaining: FormattedAmount;
  due_interest: FormattedAmount;
  total_debt: FormattedAmount;
  gross_collateral_value_usdc: FormattedAmount;
  current_ltv_bps: number;
  margin_call_ltv_bps: number;
  liq_ltv_bps: number;
  health_factor: { raw: string; formatted: string; decimals: number };
  liquidation_price: FormattedAmount;
  oracle_price: FormattedAmount;
  oracle_state: number;
  oracle_state_name: string;
  distance_to_liquidation_bps: number;
  block_number: string;
}

export interface AssetRiskSnapshot {
  token: Address;
  symbol: string | null;
  decimals: number;
  status: number;
  status_name: string;
  oracle_price: FormattedAmount;
  oracle_state: number;
  oracle_state_name: string;
  feed_updated_at: string;
  feed_age_seconds: number;
  max_stale_open_secs: number;
  max_stale_closed_secs: number;
  price_deviation_bps: number;
  recorded_multiplier: FormattedAmount;
  ui_multiplier: FormattedAmount | null;
  multiplier_drift_bps: number;
  asset_cap: FormattedAmount;
  asset_outstanding_principal: FormattedAmount;
  asset_cap_utilization_bps: number;
  escrow_balance: FormattedAmount | 'unknown';
  escrow_ledger_balance: FormattedAmount | 'unknown';
  open_loans_collateral_sum: FormattedAmount;
  escrow_matches_open_loans: boolean | 'unknown';
}

export interface KeeperLivenessSnapshot {
  last_sync_multiplier_block: string | null;
  last_sync_multiplier_timestamp: string | null;
  seconds_since_sync_multiplier: number | null;
  seconds_since_start_liquidation: number | null;
  seconds_since_default_or_restart: number | null;
  last_liquidation_or_auction_block: string | null;
  last_liquidation_or_auction_timestamp: string | null;
  seconds_since_liquidation_or_auction: number | null;
  unacted_liquidatable_loans: Array<{ loan_id: string; stalled_seconds: number }>;
  unacted_defaulted_loans: Array<{ loan_id: string; stalled_seconds: number }>;
  unacted_expired_auctions: Array<{ auction_id: string; stalled_seconds: number }>;
}

export interface RiskSummarySnapshot {
  status: 'healthy' | 'warning' | 'critical' | 'degraded';
  monitor_degraded: boolean;
  last_scan_error: string | null;
  scan_count: number;
  rpc_errors_total: number;
  last_scan_timestamp: string;
  chain_head_block: string | null;
  block_timestamp: string | null;
  market_open: boolean | null;
  protocol_paused: boolean | null;
  global_usdc_cap: FormattedAmount | null;
  total_outstanding_principal: FormattedAmount | null;
  global_cap_utilization_bps: number | null;
  indexer: {
    last_indexed_block: string | null;
    lag_blocks: string | null;
    updated_at: string | null;
    lag_seconds: number | null;
    max_healthy_lag_blocks: number;
    max_healthy_lag_secs: number;
  };
  keeper: KeeperLivenessSnapshot;
  loan_counts: Record<LoanRiskStatus, number>;
  active_alerts: Record<AlertSeverity, number>;
  assets: AssetRiskSnapshot[];
}

export interface MonitorInternalState {
  chainIdVerified: boolean;
  scanCount: number;
  rpcErrorsTotal: number;
  dbErrorsTotal: number;
  consecutiveRpcFailures: number;
  monitorDegraded: boolean;
  lastScanError: string | null;
  previousPrices: Map<string, bigint>;
  liquidatableSinceBlockTs: Map<string, number>;
  surplusSeenAtMsByAsset: Map<string, { balance: bigint; firstSeenMs: number }>;
  latestSummary: RiskSummarySnapshot | null;
  latestLoans: LoanRiskSnapshot[];
}

export interface RiskContext {
  config: RiskConfig;
  publicClient: PublicClient<Transport, Chain>;
  db: ReadOnlyDatabase;
  alerts: AlertEngine;
  state: MonitorInternalState;
}

function validateChainId(chainId: number, config: Pick<RiskConfig, 'isFork' | 'forkChainId'>): void {
  if (!config.isFork && chainId !== 8453) {
    throw new Error(
      `Invalid chainId ${chainId}: expected Base Mainnet (8453). Set FORK=true and FORK_CHAIN_ID=${chainId} for forks.`
    );
  }
  if (config.isFork && chainId !== config.forkChainId) {
    throw new Error(`Invalid fork chainId ${chainId}: expected FORK_CHAIN_ID=${config.forkChainId}.`);
  }
}

async function chunkedMulticall(
  publicClient: PublicClient<Transport, Chain>,
  contracts: ReadonlyArray<{
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }>,
  blockNumber: bigint
): Promise<Array<{ status: 'success'; result: unknown } | { status: 'failure'; error: Error }>> {
  const multicallAddr = base.contracts.multicall3.address;
  const out: Array<{ status: 'success'; result: unknown } | { status: 'failure'; error: Error }> = [];
  for (let i = 0; i < contracts.length; i += MULTICALL_CHUNK_SIZE) {
    const chunk = contracts.slice(i, i + MULTICALL_CHUNK_SIZE);
    const res = await publicClient.multicall({
      contracts: chunk as Parameters<typeof publicClient.multicall>[0]['contracts'],
      allowFailure: true,
      blockNumber,
      multicallAddress: multicallAddr,
    });
    for (const item of res) {
      out.push(item as { status: 'success'; result: unknown } | { status: 'failure'; error: Error });
    }
  }
  return out;
}

export async function createRiskContext(
  config: RiskConfig,
  dbOverride?: ReadOnlyDatabase
): Promise<RiskContext> {
  const probeClient = createPublicClient({ transport: viemHttp(config.rpcUrl), cacheTime: 0 });
  let chainId = config.isFork ? config.forkChainId : 8453;
  let chainIdVerified = false;
  let bootRpcError: string | null = null;

  try {
    chainId = await probeClient.getChainId();
    validateChainId(chainId, config);
    chainIdVerified = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Do not mask invalid fork/mainnet chainId configuration mismatches
    if (/Invalid (fork )?chainId/i.test(msg)) {
      throw err;
    }
    bootRpcError = msg;
    console.warn(`[RISK_RPC_BOOT_DEGRADED] Initial RPC getChainId failed (starting degraded): ${msg}`);
  }

  const chain = defineChain({
    id: chainId,
    name: chainId === base.id ? base.name : `Nostok Chain ${chainId}`,
    nativeCurrency: base.nativeCurrency,
    contracts: chainId === base.id ? base.contracts : undefined,
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  const publicClient = createPublicClient({
    chain,
    transport: viemHttp(config.rpcUrl),
    cacheTime: 0,
  });

  let db: ReadOnlyDatabase;
  let bootDbError: string | null = null;
  if (dbOverride) {
    db = dbOverride;
  } else {
    const opened = await openReadOnlyDatabase(config.databaseUrl, true);
    db = opened.db;
    bootDbError = opened.bootError ?? null;
  }

  const alerts = new AlertEngine(config.alertCooldownMs, config.webhookUrl, {
    minActiveMs: config.alertMinActiveMs,
    webhookTimeoutMs: config.webhookTimeoutMs,
  });

  const bootError = bootRpcError ?? bootDbError;

  return {
    config,
    publicClient,
    db,
    alerts,
    state: {
      chainIdVerified,
      scanCount: 0,
      rpcErrorsTotal: bootRpcError ? 1 : 0,
      dbErrorsTotal: bootDbError ? 1 : 0,
      consecutiveRpcFailures: bootRpcError ? 1 : 0,
      monitorDegraded: bootError !== null,
      lastScanError: bootError,
      previousPrices: new Map(),
      liquidatableSinceBlockTs: new Map(),
      surplusSeenAtMsByAsset: new Map(),
      latestSummary: null,
      latestLoans: [],
    },
  };
}

function preserveLoanAlertKeys(preserveKeys: Set<string>, loanId: string): void {
  for (const suffix of ['liquidatable', 'near_liq', 'margin_call', 'default_overdue', 'in_grace']) {
    preserveKeys.add(`loan_risk:${loanId}:${suffix}`);
  }
  preserveKeys.add(`keeper_inactive:loan:${loanId}`);
  preserveKeys.add(`keeper_inactive:default:${loanId}`);
}

export async function runRiskScan(ctx: RiskContext, nowMs = Date.now()): Promise<RiskSummarySnapshot> {
  ctx.state.scanCount += 1;
  const nowIso = new Date(nowMs).toISOString();
  const observations: AlertObservation[] = [];

  // Step 1: Read indexer metadata & keeper event timestamps (NEVER use DB principal_repaid / collateral_raw for risk math)
  let idxLastBlock: string | null = null;
  let idxUpdatedAt: string | null = null;
  let idxUpdatedMs: number | null = null;
  const terminalLoanIds = new Set<string>();
  let assetDbRows: Array<{
    token: string;
    symbol: string | null;
    decimals: number | null;
    feed: string | null;
    feed_decimals: number | null;
    max_stale_open_secs: number | null;
  }> = [];
  let activeAuctionRows: Array<{
    auction_id: string;
    loan_id: string;
    start_time: string;
    duration: string;
  }> = [];
  let keeperEventRows: Array<{
    event_name: string;
    is_default_auction: string;
    max_block: string | null;
    max_ts: string | null;
  }> = [];

  try {
    const [idxStateRes, terminalLoansRes, assetsRes, auctionsRes, keeperRes] = await Promise.all([
      ctx.db.query<{ last_indexed_block: string; updated_at: unknown }>(
        'SELECT last_indexed_block::TEXT AS last_indexed_block, updated_at FROM indexer_state WHERE id = 1'
      ),
      ctx.db.query<{ loan_id: string }>(
        `SELECT loan_id::TEXT AS loan_id
         FROM loans
         WHERE status IN (3, 4, 5)`
      ),
      ctx.db.query<{
        token: string;
        symbol: string | null;
        decimals: number | null;
        feed: string | null;
        feed_decimals: number | null;
        max_stale_open_secs: number | null;
      }>(
        `SELECT token, symbol, decimals, feed, feed_decimals, max_stale_open_secs
         FROM assets
         ORDER BY token ASC`
      ),
      ctx.db.query<{
        auction_id: string;
        loan_id: string;
        start_time: string;
        duration: string;
      }>(
        `SELECT
           auction_id::TEXT AS auction_id,
           loan_id::TEXT AS loan_id,
           start_time::TEXT AS start_time,
           duration::TEXT AS duration
         FROM auctions
         WHERE status = 0
         ORDER BY auction_id ASC`
      ),
      ctx.db.query<{
        event_name: string;
        is_default_auction: string;
        max_block: string | null;
        max_ts: string | null;
      }>(
        `SELECT
           event_name,
           COALESCE(payload->>'isDefaultAuction', 'false') AS is_default_auction,
           MAX(block_number)::TEXT AS max_block,
           MAX(block_timestamp)::TEXT AS max_ts
         FROM loan_events
         WHERE event_name IN ('MultiplierSynced', 'AuctionStarted', 'AuctionRestarted', 'AuctionCancelled')
         GROUP BY event_name, COALESCE(payload->>'isDefaultAuction', 'false')`
      ),
    ]);

    if (idxStateRes.rows.length > 0) {
      idxLastBlock = idxStateRes.rows[0].last_indexed_block;
      const rawUpdated = idxStateRes.rows[0].updated_at;
      const parsedDate =
        rawUpdated instanceof Date
          ? rawUpdated
          : rawUpdated !== null && rawUpdated !== undefined
            ? new Date(String(rawUpdated))
            : null;
      if (parsedDate && !Number.isNaN(parsedDate.getTime())) {
        idxUpdatedAt = parsedDate.toISOString();
        idxUpdatedMs = parsedDate.getTime();
      }
    }
    for (const r of terminalLoansRes.rows) {
      terminalLoanIds.add(r.loan_id);
    }
    assetDbRows = assetsRes.rows;
    activeAuctionRows = auctionsRes.rows;
    keeperEventRows = keeperRes.rows;
  } catch (err) {
    ctx.state.dbErrorsTotal += 1;
    const reason = err instanceof Error ? err.message : String(err);
    ctx.state.monitorDegraded = true;
    ctx.state.lastScanError = reason;
    observations.push({
      dedupKey: 'monitor:db_error',
      category: 'monitor',
      severity: 'critical',
      title: 'Risk monitor database error',
      message: `Failed reading indexer DB: ${reason}`,
      details: { error: reason },
    });
    const preserveKeys = new Set(
      ctx.alerts
        .getActiveAlerts()
        .map((a) => a.dedup_key)
        .filter((k) => k !== 'monitor:db_error')
    );
    await ctx.alerts.syncObservations(observations, nowMs, preserveKeys);
    const degradedSummary: RiskSummarySnapshot = {
      status: 'degraded',
      monitor_degraded: true,
      last_scan_error: reason,
      scan_count: ctx.state.scanCount,
      rpc_errors_total: ctx.state.rpcErrorsTotal,
      last_scan_timestamp: nowIso,
      chain_head_block: null,
      block_timestamp: null,
      market_open: null,
      protocol_paused: null,
      global_usdc_cap: null,
      total_outstanding_principal: null,
      global_cap_utilization_bps: null,
      indexer: {
        last_indexed_block: null,
        lag_blocks: null,
        updated_at: null,
        lag_seconds: null,
        max_healthy_lag_blocks: ctx.config.maxHealthyLagBlocks,
        max_healthy_lag_secs: ctx.config.maxHealthyLagSecs,
      },
      keeper: {
        last_sync_multiplier_block: null,
        last_sync_multiplier_timestamp: null,
        seconds_since_sync_multiplier: null,
        seconds_since_start_liquidation: null,
        seconds_since_default_or_restart: null,
        last_liquidation_or_auction_block: null,
        last_liquidation_or_auction_timestamp: null,
        seconds_since_liquidation_or_auction: null,
        unacted_liquidatable_loans: [],
        unacted_defaulted_loans: [],
        unacted_expired_auctions: [],
      },
      loan_counts: { healthy: 0, margin_call: 0, near_liquidation: 0, liquidatable: 0 },
      active_alerts: ctx.alerts.getActiveCountBySeverity(),
      assets: [],
    };
    ctx.state.latestSummary = degradedSummary;
    return degradedSummary;
  }

  // Step 2: Fetch chain head + live protocol state via chunked multicalls (with safe degraded isolation on RPC outage)
  let headBlock: bigint;
  let blockTimestamp: bigint;
  let paused: boolean;
  let globalCap: bigint;
  let totalOutstanding: bigint;
  let marketOpen: boolean;
  let maxStaleClosedSecs: number;

  const assetAddrs = assetDbRows.map((a) => getAddress(a.token));
  let assetLiveResults: AssetRiskSnapshot[] = [];
  const assetByLower = new Map<string, AssetRiskSnapshot>();
  let loanSnapshots: LoanRiskSnapshot[] = [];
  const preserveKeys = new Set<string>();

  try {
    if (!ctx.state.chainIdVerified) {
      const chainId = await ctx.publicClient.getChainId();
      validateChainId(chainId, ctx.config);
      ctx.state.chainIdVerified = true;
    }

    headBlock = await ctx.publicClient.getBlockNumber();
    const headBlockObj = await ctx.publicClient.getBlock({ blockNumber: headBlock });
    blockTimestamp = headBlockObj.timestamp;

    const headerAndAssetContracts = [
      { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'paused' } as const,
      { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'globalUsdcCap' } as const,
      { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'totalOutstandingPrincipal' } as const,
      { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'nextLoanId' } as const,
      { address: ctx.config.oracleRouter, abi: oracleRouterAbi, functionName: 'isMarketOpen' } as const,
      { address: ctx.config.oracleRouter, abi: oracleRouterAbi, functionName: 'maxStaleClosedSecs' } as const,
      ...assetAddrs.flatMap((tokenAddr, idx) => {
        const feedAddr = assetDbRows[idx].feed ? getAddress(assetDbRows[idx].feed!) : tokenAddr;
        return [
          { address: ctx.config.assetRegistry, abi: assetRegistryAbi, functionName: 'getAssetConfig', args: [tokenAddr] } as const,
          { address: ctx.config.oracleRouter, abi: oracleRouterAbi, functionName: 'getPrice', args: [tokenAddr] } as const,
          { address: ctx.config.oracleRouter, abi: oracleRouterAbi, functionName: 'recordedMultiplier', args: [tokenAddr] } as const,
          { address: tokenAddr, abi: erc20MetaAbi, functionName: 'uiMultiplier' } as const,
          { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'assetOutstandingPrincipal', args: [tokenAddr] } as const,
          { address: tokenAddr, abi: erc20MetaAbi, functionName: 'balanceOf', args: [ctx.config.collateralEscrow] } as const,
          { address: ctx.config.collateralEscrow, abi: collateralEscrowAbi, functionName: 'getBalance', args: [tokenAddr] } as const,
          { address: feedAddr, abi: aggregatorV3Abi, functionName: 'latestRoundData' } as const,
        ];
      }),
    ];

    const mcRes = await chunkedMulticall(ctx.publicClient, headerAndAssetContracts, headBlock);

    if (
      mcRes[0].status === 'failure' ||
      mcRes[1].status === 'failure' ||
      mcRes[2].status === 'failure' ||
      mcRes[3].status === 'failure' ||
      mcRes[4].status === 'failure' ||
      mcRes[5].status === 'failure'
    ) {
      throw new Error('Core protocol multicall returned failure');
    }

    paused = mcRes[0].result as boolean;
    globalCap = mcRes[1].result as bigint;
    totalOutstanding = mcRes[2].result as bigint;
    const nextLoanId = mcRes[3].result as bigint;
    marketOpen = mcRes[4].result as boolean;
    maxStaleClosedSecs = Number(mcRes[5].result as number | bigint);

    // Fetch all non-terminal on-chain loans directly from LoanCore (so risk/escrow math is 100% immune to indexer lag)
    const candidateLoanIds: bigint[] = [];
    for (let id = 1n; id < nextLoanId; id++) {
      if (!terminalLoanIds.has(id.toString())) {
        candidateLoanIds.push(id);
      }
    }

    const loanContracts = candidateLoanIds.flatMap((id) => [
      { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'getLoan', args: [id] } as const,
      { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'getDueInterest', args: [id] } as const,
    ]);
    const loanMcRes =
      loanContracts.length > 0
        ? await chunkedMulticall(ctx.publicClient, loanContracts, headBlock)
        : [];

    const onchainOpenCollateralByAsset = new Map<string, bigint>();
    const activeLiquidatableIds = new Set<string>();
    let anyLoanReadFailed = false;
    const liveOnchainLoans: Array<{
      loanId: string;
      onchainLoan: {
        borrower: Address;
        collateralToken: Address;
        collateralRaw: bigint;
        principal: bigint;
        maturity: bigint;
        marginCallLtvBps: number;
        liqLtvBps: number;
        status: number;
        principalRepaid: bigint;
      };
      dueInterest: bigint;
    }> = [];

    for (let i = 0; i < candidateLoanIds.length; i++) {
      const loanRes = loanMcRes[i * 2];
      const dueIntRes = loanMcRes[i * 2 + 1];
      if (!loanRes || !dueIntRes || loanRes.status === 'failure' || dueIntRes.status === 'failure') {
        anyLoanReadFailed = true;
        ctx.state.rpcErrorsTotal += 1;
        const failedLoanId = candidateLoanIds[i].toString();
        preserveLoanAlertKeys(preserveKeys, failedLoanId);
        activeLiquidatableIds.add(failedLoanId);
        continue;
      }
      const onchainLoan = loanRes.result as {
        borrower: Address;
        collateralToken: Address;
        collateralRaw: bigint;
        principal: bigint;
        maturity: bigint;
        marginCallLtvBps: number;
        liqLtvBps: number;
        status: number;
        principalRepaid: bigint;
      };
      const liveStatus = Number(onchainLoan.status);
      if (liveStatus >= 3) continue;

      const tokenKey = onchainLoan.collateralToken.toLowerCase();
      onchainOpenCollateralByAsset.set(
        tokenKey,
        (onchainOpenCollateralByAsset.get(tokenKey) ?? 0n) + onchainLoan.collateralRaw
      );
      liveOnchainLoans.push({
        loanId: candidateLoanIds[i].toString(),
        onchainLoan,
        dueInterest: dueIntRes.result as bigint,
      });
    }

    const ASSET_STRIDE = 8;
    const assetsOffset = 6;

    // Evaluate each asset
    assetLiveResults = [];
    for (let i = 0; i < assetAddrs.length; i++) {
      const tokenAddr = assetAddrs[i];
      const dbRow = assetDbRows[i];
      const baseIdx = assetsOffset + i * ASSET_STRIDE;
      const cfgRes = mcRes[baseIdx];
      const priceRes = mcRes[baseIdx + 1];
      const recMultRes = mcRes[baseIdx + 2];
      const uiMultRes = mcRes[baseIdx + 3];
      const assetOutRes = mcRes[baseIdx + 4];
      const erc20BalRes = mcRes[baseIdx + 5];
      const escrowLedgerRes = mcRes[baseIdx + 6];
      const roundRes = mcRes[baseIdx + 7];

      if (cfgRes.status === 'failure' || priceRes.status === 'failure') {
        ctx.state.rpcErrorsTotal += 1;
        const failedTokenKey = tokenAddr.toLowerCase();
        for (const prefix of [
          'oracle_stale',
          'sequencer_invalid',
          'oracle_disputed',
          'oracle_price_deviation',
          'corporate_action_freeze',
          'multiplier_drift',
          'asset_cap_util',
          'escrow_mismatch',
          'escrow_surplus',
        ]) {
          preserveKeys.add(`${prefix}:${failedTokenKey}`);
        }
        preserveKeys.add(`asset_status:${failedTokenKey}:frozen`);
        preserveKeys.add(`asset_status:${failedTokenKey}:wind_down`);
        preserveKeys.add(`asset_status:${failedTokenKey}:reduce_only`);
        continue;
      }

      const cfg = cfgRes.result as {
        feed: Address;
        feedDecimals: number;
        maxDiscountBps: number;
        closedMarketHaircutBps: number;
        perLoanCap: bigint;
        assetCap: bigint;
        maxStaleOpenSecs: number;
        status: number;
        restricted: boolean;
      };
      const pr = priceRes.result as readonly [bigint, number, number];
      let oraclePrice = pr[0];
      const feedDecimals = Number(pr[1] ?? cfg.feedDecimals ?? dbRow.feed_decimals ?? FEED_DECIMALS_DEFAULT);
      const oracleState = Number(pr[2]);
      const recMult = recMultRes.status === 'success' ? (recMultRes.result as bigint) : 0n;
      const uiMult = uiMultRes.status === 'success' ? (uiMultRes.result as bigint) : null;
      const assetOutstanding = assetOutRes.status === 'success' ? (assetOutRes.result as bigint) : 0n;
      const erc20EscrowBal: bigint | null =
        erc20BalRes.status === 'success' ? (erc20BalRes.result as bigint) : null;
      const escrowLedgerBal: bigint | null =
        escrowLedgerRes.status === 'success' ? (escrowLedgerRes.result as bigint) : null;
      if (erc20EscrowBal === null || escrowLedgerBal === null) {
        ctx.state.rpcErrorsTotal += 1;
      }

      let feedUpdatedAt = 0n;
      let rawFeedPrice = 0n;
      if (roundRes.status === 'success') {
        const rd = roundRes.result as readonly [bigint, bigint, bigint, bigint, bigint];
        if (rd[1] > 0n) rawFeedPrice = rd[1];
        feedUpdatedAt = rd[3];
      }
      if (oraclePrice === 0n && rawFeedPrice > 0n) {
        oraclePrice = rawFeedPrice;
      }

      const feedAgeSecs =
        feedUpdatedAt > 0n && blockTimestamp >= feedUpdatedAt
          ? Number(blockTimestamp - feedUpdatedAt)
          : 0;
      const staleThreshold = marketOpen ? Number(cfg.maxStaleOpenSecs) : maxStaleClosedSecs;

      // Price deviation vs previous reading
      const tokenKey = tokenAddr.toLowerCase();
      const prevPrice = ctx.state.previousPrices.get(tokenKey);
      let priceDeviationBps = 0;
      if (prevPrice !== undefined && prevPrice > 0n && oraclePrice > 0n) {
        const diff = oraclePrice > prevPrice ? oraclePrice - prevPrice : prevPrice - oraclePrice;
        priceDeviationBps = Number((diff * 10_000n) / prevPrice);
      }
      if (oraclePrice > 0n) {
        ctx.state.previousPrices.set(tokenKey, oraclePrice);
      }

      // Multiplier drift
      let multiplierDriftBps = 0;
      if (recMult > 0n && uiMult !== null && uiMult > 0n) {
        const mDiff = uiMult > recMult ? uiMult - recMult : recMult - uiMult;
        multiplierDriftBps = Number((mDiff * 10_000n) / recMult);
      }

      const tokenDecimals = dbRow.decimals !== null ? Number(dbRow.decimals) : 18;
      const symbol = dbRow.symbol ?? tokenAddr;
      const openLoanColSum = onchainOpenCollateralByAsset.get(tokenKey) ?? 0n;
      const capUtilBps =
        cfg.assetCap > 0n ? Number((assetOutstanding * 10_000n) / cfg.assetCap) : 0;
      const escrowMatchesOpenLoans: boolean | 'unknown' =
        anyLoanReadFailed || erc20EscrowBal === null || escrowLedgerBal === null
          ? 'unknown'
          : erc20EscrowBal >= escrowLedgerBal && escrowLedgerBal === openLoanColSum;

      const snapshot: AssetRiskSnapshot = {
        token: tokenAddr,
        symbol,
        decimals: tokenDecimals,
        status: Number(cfg.status),
        status_name: ASSET_STATUS_NAMES[Number(cfg.status)] ?? `UNKNOWN(${cfg.status})`,
        oracle_price: formatAmount(oraclePrice, feedDecimals, 'USD'),
        oracle_state: oracleState,
        oracle_state_name: ORACLE_STATE_NAMES[oracleState] ?? `UNKNOWN(${oracleState})`,
        feed_updated_at: feedUpdatedAt.toString(),
        feed_age_seconds: feedAgeSecs,
        max_stale_open_secs: Number(cfg.maxStaleOpenSecs),
        max_stale_closed_secs: maxStaleClosedSecs,
        price_deviation_bps: priceDeviationBps,
        recorded_multiplier: formatAmount(recMult, RATE_DECIMALS),
        ui_multiplier: uiMult !== null ? formatAmount(uiMult, RATE_DECIMALS) : null,
        multiplier_drift_bps: multiplierDriftBps,
        asset_cap: formatAmount(cfg.assetCap, USDC_DECIMALS, 'USDC'),
        asset_outstanding_principal: formatAmount(assetOutstanding, USDC_DECIMALS, 'USDC'),
        asset_cap_utilization_bps: capUtilBps,
        escrow_balance:
          erc20EscrowBal !== null ? formatAmount(erc20EscrowBal, tokenDecimals, symbol) : 'unknown',
        escrow_ledger_balance:
          escrowLedgerBal !== null ? formatAmount(escrowLedgerBal, tokenDecimals, symbol) : 'unknown',
        open_loans_collateral_sum: formatAmount(openLoanColSum, tokenDecimals, symbol),
        escrow_matches_open_loans: escrowMatchesOpenLoans,
      };
      assetLiveResults.push(snapshot);
      assetByLower.set(tokenKey, snapshot);

      // Oracle alerts
      if (oracleState === OracleState.STALE_FEED || (feedUpdatedAt > 0n && feedAgeSecs > staleThreshold)) {
        observations.push({
          dedupKey: `oracle_stale:${tokenKey}`,
          category: 'oracle',
          severity: 'critical',
          title: `Stale oracle feed for ${symbol}`,
          message: `${symbol} feed age ${feedAgeSecs}s exceeds ${staleThreshold}s (${marketOpen ? 'market open' : 'market closed'}; state=${snapshot.oracle_state_name})`,
          details: {
            token: tokenAddr,
            symbol,
            feedAgeSecs,
            staleThreshold,
            oracleState: snapshot.oracle_state_name,
          },
        });
      }
      if (oracleState === OracleState.INVALID_SEQUENCER) {
        observations.push({
          dedupKey: `sequencer_invalid:${tokenKey}`,
          category: 'oracle',
          severity: 'page',
          title: `L2 sequencer invalid for ${symbol}`,
          message: `OracleRouter reports INVALID_SEQUENCER for ${symbol}`,
          details: { token: tokenAddr, symbol },
        });
      }
      if (oracleState === OracleState.DISPUTED) {
        observations.push({
          dedupKey: `oracle_disputed:${tokenKey}`,
          category: 'oracle',
          severity: 'critical',
          title: `Oracle feed disputed for ${symbol}`,
          message: `OracleRouter reports DISPUTED for ${symbol}`,
          details: { token: tokenAddr, symbol },
        });
      }
      if (priceDeviationBps >= ctx.config.priceDeviationWarnBps) {
        observations.push({
          dedupKey: `oracle_price_deviation:${tokenKey}`,
          category: 'oracle',
          severity: 'warning',
          title: `Large oracle price move on ${symbol}`,
          message: `${symbol} price moved ${priceDeviationBps} bps since previous scan`,
          details: {
            token: tokenAddr,
            symbol,
            priceDeviationBps,
            oraclePrice: oraclePrice.toString(),
          },
        });
      }

      // Corporate action & asset status alerts
      if (multiplierDriftBps >= 500 || oracleState === OracleState.FROZEN_CORPORATE_ACTION) {
        observations.push({
          dedupKey: `corporate_action_freeze:${tokenKey}`,
          category: 'corporate_action',
          severity: 'page',
          title: `Corporate action freeze on ${symbol}`,
          message: `${symbol} multiplier jumped ${multiplierDriftBps} bps (recorded=${recMult}, ui=${uiMult ?? 0n})`,
          details: {
            token: tokenAddr,
            symbol,
            multiplierDriftBps,
            recordedMultiplier: recMult.toString(),
            uiMultiplier: (uiMult ?? 0n).toString(),
            oracleState: snapshot.oracle_state_name,
          },
        });
      } else if (multiplierDriftBps >= 100) {
        observations.push({
          dedupKey: `multiplier_drift:${tokenKey}`,
          category: 'corporate_action',
          severity: 'warning',
          title: `Multiplier drift >= 1% on ${symbol}`,
          message: `${symbol} uiMultiplier drifted ${multiplierDriftBps} bps from OracleRouter.recordedMultiplier`,
          details: {
            token: tokenAddr,
            symbol,
            multiplierDriftBps,
            recordedMultiplier: recMult.toString(),
            uiMultiplier: (uiMult ?? 0n).toString(),
          },
        });
      }

      if (Number(cfg.status) === 3) {
        observations.push({
          dedupKey: `asset_status:${tokenKey}:frozen`,
          category: 'asset_status',
          severity: 'critical',
          title: `Asset ${symbol} is Frozen`,
          message: `${symbol} status in AssetRegistry is Frozen`,
          details: { token: tokenAddr, symbol, status: 'Frozen' },
        });
      } else if (Number(cfg.status) === 2) {
        observations.push({
          dedupKey: `asset_status:${tokenKey}:wind_down`,
          category: 'asset_status',
          severity: 'warning',
          title: `Asset ${symbol} is WindDown`,
          message: `${symbol} status in AssetRegistry is WindDown`,
          details: { token: tokenAddr, symbol, status: 'WindDown' },
        });
      } else if (Number(cfg.status) === 1) {
        observations.push({
          dedupKey: `asset_status:${tokenKey}:reduce_only`,
          category: 'asset_status',
          severity: 'warning',
          title: `Asset ${symbol} is ReduceOnly`,
          message: `${symbol} status in AssetRegistry is ReduceOnly`,
          details: { token: tokenAddr, symbol, status: 'ReduceOnly' },
        });
      }

      // Per-asset cap utilization alerts
      if (cfg.assetCap > 0n) {
        if (capUtilBps >= 9500) {
          observations.push({
            dedupKey: `asset_cap_util:${tokenKey}`,
            category: 'caps',
            severity: 'critical',
            title: `${symbol} cap utilization >= 95%`,
            message: `${symbol} utilization at ${capUtilBps} bps (${assetOutstanding}/${cfg.assetCap})`,
            details: { token: tokenAddr, symbol, capUtilBps, outstanding: assetOutstanding.toString(), cap: cfg.assetCap.toString() },
          });
        } else if (capUtilBps >= 8000) {
          observations.push({
            dedupKey: `asset_cap_util:${tokenKey}`,
            category: 'caps',
            severity: 'warning',
            title: `${symbol} cap utilization >= 80%`,
            message: `${symbol} utilization at ${capUtilBps} bps (${assetOutstanding}/${cfg.assetCap})`,
            details: { token: tokenAddr, symbol, capUtilBps, outstanding: assetOutstanding.toString(), cap: cfg.assetCap.toString() },
          });
        }
      }

      // Three-way on-chain escrow invariant check:
      // 1) ERC-20 balanceOf(escrow) vs CollateralEscrow.getBalance(token) ledger vs sum(on-chain loan.collateralRaw)
      // Completely independent of indexer lag. If either read failed ("unknown"), skip alerting rather than
      // defaulting to 0n. Shortfalls or ledger mismatches are critical; pure donation surpluses emit a bounded
      // informational notice and auto-resolve so they never stay active forever.
      if (escrowMatchesOpenLoans === 'unknown' || erc20EscrowBal === null || escrowLedgerBal === null) {
        ctx.state.surplusSeenAtMsByAsset.delete(tokenKey);
        preserveKeys.add(`escrow_mismatch:${tokenKey}`);
        preserveKeys.add(`escrow_surplus:${tokenKey}`);
      } else if (!escrowMatchesOpenLoans) {
        ctx.state.surplusSeenAtMsByAsset.delete(tokenKey);
        observations.push({
          dedupKey: `escrow_mismatch:${tokenKey}`,
          category: 'protocol',
          severity: 'critical',
          title: `Escrow balance mismatch on ${symbol}`,
          message: `${symbol} escrow check failed (balanceOf=${erc20EscrowBal}, ledger=${escrowLedgerBal}, openLoansSum=${openLoanColSum})`,
          details: {
            token: tokenAddr,
            symbol,
            escrowBalance: erc20EscrowBal.toString(),
            escrowLedgerBalance: escrowLedgerBal.toString(),
            openLoansCollateralSum: openLoanColSum.toString(),
          },
        });
      } else if (erc20EscrowBal > escrowLedgerBal) {
        let seen = ctx.state.surplusSeenAtMsByAsset.get(tokenKey);
        if (!seen || seen.balance !== erc20EscrowBal) {
          seen = { balance: erc20EscrowBal, firstSeenMs: nowMs };
          ctx.state.surplusSeenAtMsByAsset.set(tokenKey, seen);
        }
        // Keep informational surplus alert active at most one minActiveMs window for a given balance
        if (nowMs - seen.firstSeenMs <= ctx.config.alertMinActiveMs) {
          observations.push({
            dedupKey: `escrow_surplus:${tokenKey}`,
            category: 'protocol',
            severity: 'info',
            title: `Unaccounted token surplus in escrow for ${symbol}`,
            message: `${symbol} balanceOf(escrow) (${erc20EscrowBal}) exceeds ledger/loans (${escrowLedgerBal})`,
            details: {
              token: tokenAddr,
              symbol,
              escrowBalance: erc20EscrowBal.toString(),
              escrowLedgerBalance: escrowLedgerBal.toString(),
              surplus: (erc20EscrowBal - escrowLedgerBal).toString(),
            },
          });
        }
      } else {
        ctx.state.surplusSeenAtMsByAsset.delete(tokenKey);
      }
    }

    // Protocol-wide alerts (paused & globalUsdcCap utilization)
    if (paused) {
      observations.push({
        dedupKey: 'protocol_paused',
        category: 'protocol',
        severity: 'page',
        title: 'Protocol LoanCore is paused',
        message: 'LoanCore.paused() returned true',
        details: { loanCore: ctx.config.loanCore },
      });
    }

    const globalUtilBps =
      globalCap > 0n ? Number((totalOutstanding * 10_000n) / globalCap) : 0;
    if (globalCap > 0n) {
      if (globalUtilBps >= 9500) {
        observations.push({
          dedupKey: 'global_cap_util',
          category: 'caps',
          severity: 'critical',
          title: 'Global USDC cap utilization >= 95%',
          message: `Global utilization at ${globalUtilBps} bps (${totalOutstanding}/${globalCap})`,
          details: {
            globalUtilBps,
            totalOutstanding: totalOutstanding.toString(),
            globalCap: globalCap.toString(),
          },
        });
      } else if (globalUtilBps >= 8000) {
        observations.push({
          dedupKey: 'global_cap_util',
          category: 'caps',
          severity: 'warning',
          title: 'Global USDC cap utilization >= 80%',
          message: `Global utilization at ${globalUtilBps} bps (${totalOutstanding}/${globalCap})`,
          details: {
            globalUtilBps,
            totalOutstanding: totalOutstanding.toString(),
            globalCap: globalCap.toString(),
          },
        });
      }
    }

    // Indexer lag alerts
    const lagBlocks =
      idxLastBlock !== null && headBlock >= BigInt(idxLastBlock)
        ? headBlock - BigInt(idxLastBlock)
        : null;
    const lagSeconds = idxUpdatedMs !== null ? Math.max(0, Math.floor((nowMs - idxUpdatedMs) / 1000)) : null;

    if (idxLastBlock === null || (lagBlocks !== null && lagBlocks > BigInt(ctx.config.maxHealthyLagBlocks))) {
      const lagVal = lagBlocks !== null ? Number(lagBlocks) : null;
      observations.push({
        dedupKey: 'indexer_lag',
        category: 'indexer',
        severity: lagVal === null || lagVal > ctx.config.maxHealthyLagBlocks * 3 ? 'critical' : 'warning',
        title: 'Indexer block lag detected',
        message: `Indexer is behind chain head (last=${idxLastBlock ?? 'none'}, head=${headBlock}, lag=${lagBlocks?.toString() ?? 'unknown'})`,
        details: {
          lastIndexedBlock: idxLastBlock,
          chainHeadBlock: headBlock.toString(),
          lagBlocks: lagBlocks?.toString() ?? null,
        },
      });
    } else if (lagSeconds !== null && lagSeconds > ctx.config.maxHealthyLagSecs) {
      observations.push({
        dedupKey: 'indexer_lag_age',
        category: 'indexer',
        severity: 'warning',
        title: 'Indexer state timestamp stale',
        message: `indexer_state.updated_at age is ${lagSeconds}s (> ${ctx.config.maxHealthyLagSecs}s)`,
        details: {
          lagSeconds,
          maxHealthyLagSecs: ctx.config.maxHealthyLagSecs,
          updatedAt: idxUpdatedAt,
        },
      });
    }

    // Evaluate per-loan risk metrics matching LoanCore.startLiquidation & startDefaultAuction using 100% ON-CHAIN state
    const unactedLiquidatable: Array<{ loan_id: string; stalled_seconds: number }> = [];
    const unactedDefaulted: Array<{ loan_id: string; stalled_seconds: number }> = [];

    for (const item of liveOnchainLoans) {
      const { loanId, onchainLoan, dueInterest } = item;
      const liveStatus = Number(onchainLoan.status);

      const principalRemaining =
        onchainLoan.principal > onchainLoan.principalRepaid
          ? onchainLoan.principal - onchainLoan.principalRepaid
          : 0n;
      const totalDebt = principalRemaining + dueInterest;

      const tokenKey = onchainLoan.collateralToken.toLowerCase();
      const assetSnap = assetByLower.get(tokenKey);
      if (!assetSnap) {
        preserveLoanAlertKeys(preserveKeys, loanId);
        activeLiquidatableIds.add(loanId);
        continue;
      }
      const tokenDecimals = assetSnap?.decimals ?? 18;
      const feedDecimals = assetSnap?.oracle_price.decimals ?? FEED_DECIMALS_DEFAULT;
      const oraclePrice = assetSnap ? BigInt(assetSnap.oracle_price.raw) : 0n;
      const oracleState = assetSnap?.oracle_state ?? OracleState.STALE_FEED;
      const oracleStateName = assetSnap?.oracle_state_name ?? 'UNKNOWN';

      // Exact GROSS value math from OracleRouter.sol:381-383 (no closed-market haircut)
      const scaleDenom = 10n ** BigInt(tokenDecimals) * 10n ** BigInt(feedDecimals);
      const grossValueUsdc =
        onchainLoan.collateralRaw > 0n && oraclePrice > 0n
          ? (onchainLoan.collateralRaw * oraclePrice * 1_000_000n) / scaleDenom
          : 0n;

      const currentLtvBps =
        grossValueUsdc > 0n ? Number((totalDebt * 10_000n) / grossValueUsdc) : 100_000;
      const liqLtvBps = Number(onchainLoan.liqLtvBps);
      const marginCallLtvBps = Number(onchainLoan.marginCallLtvBps);

      const healthFactorRaw =
        totalDebt > 0n && grossValueUsdc > 0n
          ? (grossValueUsdc * BigInt(liqLtvBps) * 10n ** 14n) / totalDebt
          : 0n;

      // Exact first strictly non-liquidating price: ceil((floor(D * 1e4 / liq) + 1) * S / (c * 1e6))
      const liqPriceRaw = computeLiquidationPrice(
        totalDebt,
        BigInt(liqLtvBps),
        onchainLoan.collateralRaw,
        scaleDenom
      );

      const distanceBps =
        oraclePrice > 0n && liqPriceRaw > 0n
          ? oraclePrice >= liqPriceRaw
            ? Number(((oraclePrice - liqPriceRaw) * 10_000n) / oraclePrice)
            : -Number(((liqPriceRaw - oraclePrice) * 10_000n) / oraclePrice)
          : 0;

      const canLiquidateOnchain =
        (liveStatus === 0 || liveStatus === 1) &&
        oracleState === OracleState.VALID_OPEN &&
        grossValueUsdc > 0n &&
        (totalDebt * 10_000n) / grossValueUsdc >= BigInt(liqLtvBps);

      const graceDeadline = onchainLoan.maturity + GRACE_PERIOD_SECONDS;
      const isPastGrace = (liveStatus === 0 || liveStatus === 1) && blockTimestamp > graceDeadline;
      const isInGraceWindow =
        (liveStatus === 0 || liveStatus === 1) && !isPastGrace && blockTimestamp > onchainLoan.maturity;

      let riskStatus: LoanRiskStatus = 'healthy';
      if (canLiquidateOnchain || isPastGrace) {
        riskStatus = 'liquidatable';
      } else if (
        isInGraceWindow ||
        currentLtvBps >= liqLtvBps ||
        currentLtvBps >= Math.max(marginCallLtvBps, liqLtvBps - ctx.config.nearLiqBufferBps)
      ) {
        riskStatus = 'near_liquidation';
      } else if (currentLtvBps >= marginCallLtvBps) {
        riskStatus = 'margin_call';
      }

      if (canLiquidateOnchain) {
        activeLiquidatableIds.add(loanId);
        const firstSeenTs = ctx.state.liquidatableSinceBlockTs.get(loanId);
        if (firstSeenTs === undefined) {
          ctx.state.liquidatableSinceBlockTs.set(loanId, Number(blockTimestamp));
        } else {
          const stalledSecs = Math.max(0, Number(blockTimestamp) - firstSeenTs);
          if (stalledSecs >= ctx.config.keeperInactivityAlertSecs) {
            unactedLiquidatable.push({ loan_id: loanId, stalled_seconds: stalledSecs });
            observations.push({
              dedupKey: `keeper_inactive:loan:${loanId}`,
              category: 'keeper',
              severity: 'critical',
              title: `Keeper inactive on liquidatable loan #${loanId}`,
              message: `Loan #${loanId} has been liquidatable for ${stalledSecs}s without startLiquidation`,
              details: {
                loanId,
                stalledSeconds: stalledSecs,
                currentLtvBps,
                liqLtvBps,
              },
            });
          }
        }
        observations.push({
          dedupKey: `loan_risk:${loanId}:liquidatable`,
          category: 'loan_risk',
          severity: 'critical',
          title: `Loan #${loanId} is liquidatable`,
          message: `Loan #${loanId} LTV=${currentLtvBps} bps >= liq=${liqLtvBps} bps (VALID_OPEN)`,
          details: { loanId, currentLtvBps, liqLtvBps },
        });
      } else if (riskStatus === 'near_liquidation') {
        if (!isInGraceWindow) {
          observations.push({
            dedupKey: `loan_risk:${loanId}:near_liq`,
            category: 'loan_risk',
            severity: 'warning',
            title: `Loan #${loanId} near liquidation`,
            message: `Loan #${loanId} LTV=${currentLtvBps} bps (liq threshold=${liqLtvBps} bps, oracle=${oracleStateName})`,
            details: { loanId, currentLtvBps, liqLtvBps, oracleState: oracleStateName },
          });
        }
      } else if (riskStatus === 'margin_call') {
        observations.push({
          dedupKey: `loan_risk:${loanId}:margin_call`,
          category: 'loan_risk',
          severity: 'info',
          title: `Loan #${loanId} in margin call zone`,
          message: `Loan #${loanId} LTV=${currentLtvBps} bps >= marginCall=${marginCallLtvBps} bps`,
          details: { loanId, currentLtvBps, marginCallLtvBps },
        });
      }

      if (isPastGrace) {
        const overdueSecs = Number(blockTimestamp - graceDeadline);
        observations.push({
          dedupKey: `loan_risk:${loanId}:default_overdue`,
          category: 'loan_risk',
          severity: 'critical',
          title: `Loan #${loanId} defaulted past 24h grace`,
          message: `Loan #${loanId} is ${overdueSecs}s past maturity + 24h grace without startDefaultAuction`,
          details: { loanId, overdueSecs, maturity: onchainLoan.maturity.toString() },
        });
        if (overdueSecs >= ctx.config.keeperInactivityAlertSecs) {
          unactedDefaulted.push({ loan_id: loanId, stalled_seconds: overdueSecs });
          observations.push({
            dedupKey: `keeper_inactive:default:${loanId}`,
            category: 'keeper',
            severity: 'critical',
            title: `Keeper inactive on defaulted loan #${loanId}`,
            message: `Loan #${loanId} is ${overdueSecs}s past maturity + 24h grace without startDefaultAuction`,
            details: { loanId, stalledSeconds: overdueSecs, maturity: onchainLoan.maturity.toString() },
          });
        }
      } else if (isInGraceWindow) {
        const graceElapsedSecs = Number(blockTimestamp - onchainLoan.maturity);
        observations.push({
          dedupKey: `loan_risk:${loanId}:in_grace`,
          category: 'loan_risk',
          severity: 'warning',
          title: `Loan #${loanId} in 24h grace period`,
          message: `Loan #${loanId} passed maturity (${graceElapsedSecs}s into 24h grace)`,
          details: { loanId, graceElapsedSecs, maturity: onchainLoan.maturity.toString() },
        });
      }

      loanSnapshots.push({
        loan_id: loanId,
        borrower: getAddress(onchainLoan.borrower),
        collateral_token: getAddress(onchainLoan.collateralToken),
        collateral_symbol: assetSnap?.symbol ?? null,
        collateral_decimals: tokenDecimals,
        loan_status: liveStatus,
        loan_status_name: LOAN_STATUS_NAMES[liveStatus] ?? `UNKNOWN(${liveStatus})`,
        risk_status: riskStatus,
        principal_remaining: formatAmount(principalRemaining, USDC_DECIMALS, 'USDC'),
        due_interest: formatAmount(dueInterest, USDC_DECIMALS, 'USDC'),
        total_debt: formatAmount(totalDebt, USDC_DECIMALS, 'USDC'),
        gross_collateral_value_usdc: formatAmount(grossValueUsdc, USDC_DECIMALS, 'USDC'),
        current_ltv_bps: currentLtvBps,
        margin_call_ltv_bps: marginCallLtvBps,
        liq_ltv_bps: liqLtvBps,
        health_factor: formatRay18(healthFactorRaw),
        liquidation_price: formatAmount(liqPriceRaw, feedDecimals, 'USD'),
        oracle_price: formatAmount(oraclePrice, feedDecimals, 'USD'),
        oracle_state: oracleState,
        oracle_state_name: oracleStateName,
        distance_to_liquidation_bps: distanceBps,
        block_number: headBlock.toString(),
      });
    }

    // Clear resolved liquidatable tracking for loans no longer liquidatable
    for (const id of Array.from(ctx.state.liquidatableSinceBlockTs.keys())) {
      if (!activeLiquidatableIds.has(id)) {
        ctx.state.liquidatableSinceBlockTs.delete(id);
      }
    }

    // Keeper liveness for expired active auctions
    const unactedExpiredAuctions: Array<{ auction_id: string; stalled_seconds: number }> = [];
    for (const auc of activeAuctionRows) {
      const endTs = BigInt(auc.start_time) + BigInt(auc.duration);
      if (blockTimestamp > endTs) {
        const stalledSecs = Number(blockTimestamp - endTs);
        if (stalledSecs >= ctx.config.keeperInactivityAlertSecs) {
          unactedExpiredAuctions.push({ auction_id: auc.auction_id, stalled_seconds: stalledSecs });
          observations.push({
            dedupKey: `keeper_inactive:auction:${auc.auction_id}`,
            category: 'keeper',
            severity: 'critical',
            title: `Keeper inactive on expired auction #${auc.auction_id}`,
            message: `Auction #${auc.auction_id} (loan #${auc.loan_id}) expired ${stalledSecs}s ago with no restart/cancel`,
            details: { auctionId: auc.auction_id, loanId: auc.loan_id, stalledSeconds: stalledSecs },
          });
        }
      }
    }

    let syncEvt: { max_block: string | null; max_ts: string | null } | undefined;
    let startLiqTsNum: number | null = null;
    let defaultOrRestartTsNum: number | null = null;
    let latestAuctionBlock: string | null = null;
    let latestAuctionTs: string | null = null;

    for (const row of keeperEventRows) {
      const tsNum = row.max_ts ? Number(row.max_ts) : null;
      if (row.event_name === 'MultiplierSynced') {
        syncEvt = row;
        continue;
      }
      if (
        row.max_block &&
        (latestAuctionBlock === null || BigInt(row.max_block) > BigInt(latestAuctionBlock))
      ) {
        latestAuctionBlock = row.max_block;
        latestAuctionTs = row.max_ts;
      }
      if (row.event_name === 'AuctionStarted' && row.is_default_auction !== 'true') {
        if (tsNum !== null && (startLiqTsNum === null || tsNum > startLiqTsNum)) {
          startLiqTsNum = tsNum;
        }
      } else if (
        row.event_name === 'AuctionRestarted' ||
        row.event_name === 'AuctionCancelled' ||
        (row.event_name === 'AuctionStarted' && row.is_default_auction === 'true')
      ) {
        if (tsNum !== null && (defaultOrRestartTsNum === null || tsNum > defaultOrRestartTsNum)) {
          defaultOrRestartTsNum = tsNum;
        }
      }
    }

    const syncTsNum = syncEvt?.max_ts ? Number(syncEvt.max_ts) : null;
    const aucTsNum = latestAuctionTs ? Number(latestAuctionTs) : null;

    ctx.state.consecutiveRpcFailures = 0;
    ctx.state.monitorDegraded = false;
    ctx.state.lastScanError = null;
    ctx.state.latestLoans = loanSnapshots;

    await ctx.alerts.syncObservations(observations, nowMs, preserveKeys);

    const counts: Record<LoanRiskStatus, number> = {
      healthy: 0,
      margin_call: 0,
      near_liquidation: 0,
      liquidatable: 0,
    };
    for (const l of loanSnapshots) {
      counts[l.risk_status] += 1;
    }

    const activeCounts = ctx.alerts.getActiveCountBySeverity();
    const overallStatus: RiskSummarySnapshot['status'] =
      activeCounts.page > 0 || activeCounts.critical > 0
        ? 'critical'
        : activeCounts.warning > 0
          ? 'warning'
          : 'healthy';

    const summary: RiskSummarySnapshot = {
      status: overallStatus,
      monitor_degraded: false,
      last_scan_error: null,
      scan_count: ctx.state.scanCount,
      rpc_errors_total: ctx.state.rpcErrorsTotal,
      last_scan_timestamp: nowIso,
      chain_head_block: headBlock.toString(),
      block_timestamp: blockTimestamp.toString(),
      market_open: marketOpen,
      protocol_paused: paused,
      global_usdc_cap: formatAmount(globalCap, USDC_DECIMALS, 'USDC'),
      total_outstanding_principal: formatAmount(totalOutstanding, USDC_DECIMALS, 'USDC'),
      global_cap_utilization_bps: globalUtilBps,
      indexer: {
        last_indexed_block: idxLastBlock,
        lag_blocks: lagBlocks !== null ? lagBlocks.toString() : null,
        updated_at: idxUpdatedAt,
        lag_seconds: lagSeconds,
        max_healthy_lag_blocks: ctx.config.maxHealthyLagBlocks,
        max_healthy_lag_secs: ctx.config.maxHealthyLagSecs,
      },
      keeper: {
        last_sync_multiplier_block: syncEvt?.max_block ?? null,
        last_sync_multiplier_timestamp: syncEvt?.max_ts ?? null,
        seconds_since_sync_multiplier:
          syncTsNum !== null ? Math.max(0, Number(blockTimestamp) - syncTsNum) : null,
        seconds_since_start_liquidation:
          startLiqTsNum !== null ? Math.max(0, Number(blockTimestamp) - startLiqTsNum) : null,
        seconds_since_default_or_restart:
          defaultOrRestartTsNum !== null
            ? Math.max(0, Number(blockTimestamp) - defaultOrRestartTsNum)
            : null,
        last_liquidation_or_auction_block: latestAuctionBlock,
        last_liquidation_or_auction_timestamp: latestAuctionTs,
        seconds_since_liquidation_or_auction:
          aucTsNum !== null ? Math.max(0, Number(blockTimestamp) - aucTsNum) : null,
        unacted_liquidatable_loans: unactedLiquidatable,
        unacted_defaulted_loans: unactedDefaulted,
        unacted_expired_auctions: unactedExpiredAuctions,
      },
      loan_counts: counts,
      active_alerts: activeCounts,
      assets: assetLiveResults,
    };
    ctx.state.latestSummary = summary;
    return summary;
  } catch (err) {
    ctx.state.rpcErrorsTotal += 1;
    ctx.state.consecutiveRpcFailures += 1;
    ctx.state.monitorDegraded = true;
    const reason = err instanceof Error ? err.message : String(err);
    ctx.state.lastScanError = reason;

    observations.push({
      dedupKey: 'monitor:degraded',
      category: 'monitor',
      severity: ctx.state.consecutiveRpcFailures >= 3 ? 'page' : 'critical',
      title: 'Risk monitor degraded (RPC failure)',
      message: `RPC scan failed (${ctx.state.consecutiveRpcFailures} consecutive failures): ${reason}`,
      details: {
        consecutiveRpcFailures: ctx.state.consecutiveRpcFailures,
        reason,
      },
    });

    // Preserve previous non-monitor alerts while RPC is unreachable instead of falsely resolving them
    const preserveKeys = new Set(
      ctx.alerts
        .getActiveAlerts()
        .map((a) => a.dedup_key)
        .filter((k) => k !== 'monitor:degraded')
    );
    await ctx.alerts.syncObservations(observations, nowMs, preserveKeys);

    const prev = ctx.state.latestSummary;
    const degradedSummary: RiskSummarySnapshot = {
      status: 'degraded',
      monitor_degraded: true,
      last_scan_error: reason,
      scan_count: ctx.state.scanCount,
      rpc_errors_total: ctx.state.rpcErrorsTotal,
      last_scan_timestamp: nowIso,
      chain_head_block: prev?.chain_head_block ?? null,
      block_timestamp: prev?.block_timestamp ?? null,
      market_open: prev?.market_open ?? null,
      protocol_paused: prev?.protocol_paused ?? null,
      global_usdc_cap: prev?.global_usdc_cap ?? null,
      total_outstanding_principal: prev?.total_outstanding_principal ?? null,
      global_cap_utilization_bps: prev?.global_cap_utilization_bps ?? null,
      indexer: prev?.indexer ?? {
        last_indexed_block: idxLastBlock,
        lag_blocks: null,
        updated_at: idxUpdatedAt,
        lag_seconds: null,
        max_healthy_lag_blocks: ctx.config.maxHealthyLagBlocks,
        max_healthy_lag_secs: ctx.config.maxHealthyLagSecs,
      },
      keeper: prev?.keeper ?? {
        last_sync_multiplier_block: null,
        last_sync_multiplier_timestamp: null,
        seconds_since_sync_multiplier: null,
        seconds_since_start_liquidation: null,
        seconds_since_default_or_restart: null,
        last_liquidation_or_auction_block: null,
        last_liquidation_or_auction_timestamp: null,
        seconds_since_liquidation_or_auction: null,
        unacted_liquidatable_loans: [],
        unacted_defaulted_loans: [],
        unacted_expired_auctions: [],
      },
      loan_counts: prev?.loan_counts ?? { healthy: 0, margin_call: 0, near_liquidation: 0, liquidatable: 0 },
      active_alerts: ctx.alerts.getActiveCountBySeverity(),
      assets: prev?.assets ?? [],
    };
    ctx.state.latestSummary = degradedSummary;
    return degradedSummary;
  }
}
