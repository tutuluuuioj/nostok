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
  erc20MetaAbi,
  loanCoreAbi,
  oracleRouterAbi,
} from './abi.js';
import { AlertEngine, type AlertObservation, type AlertSeverity } from './alerts.js';
import type { RiskConfig } from './config.js';
import { type ReadOnlyDatabase, openReadOnlyDatabase, toBigInt } from './db.js';
import { type FormattedAmount, ceilDiv, formatAmount, formatRay18 } from './format.js';

const USDC_DECIMALS = 6;
const RATE_DECIMALS = 18;
const FEED_DECIMALS_DEFAULT = 8;

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
  escrow_balance: FormattedAmount;
  open_loans_collateral_sum: FormattedAmount;
  escrow_matches_open_loans: boolean;
}

export interface KeeperLivenessSnapshot {
  last_sync_multiplier_block: string | null;
  last_sync_multiplier_timestamp: string | null;
  seconds_since_sync_multiplier: number | null;
  last_liquidation_or_auction_block: string | null;
  last_liquidation_or_auction_timestamp: string | null;
  seconds_since_liquidation_or_auction: number | null;
  unacted_liquidatable_loans: Array<{ loan_id: string; stalled_seconds: number }>;
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
  scanCount: number;
  rpcErrorsTotal: number;
  dbErrorsTotal: number;
  consecutiveRpcFailures: number;
  monitorDegraded: boolean;
  lastScanError: string | null;
  previousPrices: Map<string, bigint>;
  liquidatableSinceBlockTs: Map<string, number>;
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

export async function createRiskContext(
  config: RiskConfig,
  dbOverride?: ReadOnlyDatabase
): Promise<RiskContext> {
  const probeClient = createPublicClient({ transport: viemHttp(config.rpcUrl), cacheTime: 0 });
  const chainId = await probeClient.getChainId();
  validateChainId(chainId, config);

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

  const db = dbOverride ?? (await openReadOnlyDatabase(config.databaseUrl));
  const alerts = new AlertEngine(config.alertCooldownMs, config.webhookUrl);

  return {
    config,
    publicClient,
    db,
    alerts,
    state: {
      scanCount: 0,
      rpcErrorsTotal: 0,
      dbErrorsTotal: 0,
      consecutiveRpcFailures: 0,
      monitorDegraded: false,
      lastScanError: null,
      previousPrices: new Map(),
      liquidatableSinceBlockTs: new Map(),
      latestSummary: null,
      latestLoans: [],
    },
  };
}

export async function runRiskScan(ctx: RiskContext, nowMs = Date.now()): Promise<RiskSummarySnapshot> {
  ctx.state.scanCount += 1;
  const nowIso = new Date(nowMs).toISOString();
  const observations: AlertObservation[] = [];

  // Step 1: Read strictly SELECT-only data from indexer DB
  let idxLastBlock: string | null = null;
  let idxUpdatedAt: string | null = null;
  let idxUpdatedMs: number | null = null;
  let openLoanRows: Array<{
    loan_id: string;
    borrower: string;
    collateral_token: string;
    collateral_raw: string;
    principal: string;
    principal_repaid: string;
    margin_call_ltv_bps: number;
    liq_ltv_bps: number;
    status: number;
  }> = [];
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
    max_block: string | null;
    max_ts: string | null;
  }> = [];

  try {
    const [idxStateRes, loansRes, assetsRes, auctionsRes, keeperRes] = await Promise.all([
      ctx.db.query<{ last_indexed_block: string; updated_at: unknown }>(
        'SELECT last_indexed_block::TEXT AS last_indexed_block, updated_at FROM indexer_state WHERE id = 1'
      ),
      ctx.db.query<{
        loan_id: string;
        borrower: string;
        collateral_token: string;
        collateral_raw: string;
        principal: string;
        principal_repaid: string;
        margin_call_ltv_bps: number;
        liq_ltv_bps: number;
        status: number;
      }>(
        `SELECT
           loan_id::TEXT AS loan_id,
           borrower,
           collateral_token,
           collateral_raw::TEXT AS collateral_raw,
           principal::TEXT AS principal,
           principal_repaid::TEXT AS principal_repaid,
           margin_call_ltv_bps,
           liq_ltv_bps,
           status
         FROM loans
         WHERE status IN (0, 1, 2)
         ORDER BY loan_id ASC`
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
      ctx.db.query<{ event_name: string; max_block: string | null; max_ts: string | null }>(
        `SELECT
           event_name,
           MAX(block_number)::TEXT AS max_block,
           MAX(block_timestamp)::TEXT AS max_ts
         FROM loan_events
         WHERE event_name IN ('MultiplierSynced', 'AuctionStarted', 'AuctionRestarted')
         GROUP BY event_name`
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
    openLoanRows = loansRes.rows;
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
        last_liquidation_or_auction_block: null,
        last_liquidation_or_auction_timestamp: null,
        seconds_since_liquidation_or_auction: null,
        unacted_liquidatable_loans: [],
        unacted_expired_auctions: [],
      },
      loan_counts: { healthy: 0, margin_call: 0, near_liquidation: 0, liquidatable: 0 },
      active_alerts: ctx.alerts.getActiveCountBySeverity(),
      assets: [],
    };
    ctx.state.latestSummary = degradedSummary;
    return degradedSummary;
  }

  // Step 2: Fetch chain head + live protocol state via multicall (with safe degraded isolation on RPC outage)
  let headBlock: bigint;
  let blockTimestamp: bigint;
  let paused: boolean;
  let globalCap: bigint;
  let totalOutstanding: bigint;
  let marketOpen: boolean;
  let maxStaleClosedSecs: number;

  const assetAddrs = assetDbRows.map((a) => getAddress(a.token));
  const openCollateralByAsset = new Map<string, bigint>();
  for (const r of openLoanRows) {
    const key = r.collateral_token.toLowerCase();
    openCollateralByAsset.set(key, (openCollateralByAsset.get(key) ?? 0n) + toBigInt(r.collateral_raw));
  }

  let assetLiveResults: AssetRiskSnapshot[] = [];
  const assetByLower = new Map<string, AssetRiskSnapshot>();
  let loanSnapshots: LoanRiskSnapshot[] = [];

  try {
    headBlock = await ctx.publicClient.getBlockNumber();
    const headBlockObj = await ctx.publicClient.getBlock({ blockNumber: headBlock });
    blockTimestamp = headBlockObj.timestamp;

    const multicallAddr = base.contracts.multicall3.address;
    const globalAndAssetContracts = [
      { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'paused' } as const,
      { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'globalUsdcCap' } as const,
      { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'totalOutstandingPrincipal' } as const,
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
          { address: feedAddr, abi: aggregatorV3Abi, functionName: 'latestRoundData' } as const,
        ];
      }),
      ...openLoanRows.flatMap((row) => {
        const id = BigInt(row.loan_id);
        return [
          { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'getLoan', args: [id] } as const,
          { address: ctx.config.loanCore, abi: loanCoreAbi, functionName: 'getDueInterest', args: [id] } as const,
        ];
      }),
    ];

    const mcRes = await ctx.publicClient.multicall({
      contracts: globalAndAssetContracts,
      allowFailure: true,
      blockNumber: headBlock,
      multicallAddress: multicallAddr,
    });

    if (
      mcRes[0].status === 'failure' ||
      mcRes[1].status === 'failure' ||
      mcRes[2].status === 'failure' ||
      mcRes[3].status === 'failure' ||
      mcRes[4].status === 'failure'
    ) {
      throw new Error('Core protocol multicall returned failure');
    }

    paused = mcRes[0].result as boolean;
    globalCap = mcRes[1].result as bigint;
    totalOutstanding = mcRes[2].result as bigint;
    marketOpen = mcRes[3].result as boolean;
    maxStaleClosedSecs = Number(mcRes[4].result as number | bigint);

    const ASSET_STRIDE = 7;
    const LOAN_STRIDE = 2;
    const assetsOffset = 5;
    const loansOffset = assetsOffset + assetAddrs.length * ASSET_STRIDE;

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
      const escrowBalRes = mcRes[baseIdx + 5];
      const roundRes = mcRes[baseIdx + 6];

      if (cfgRes.status === 'failure' || priceRes.status === 'failure') {
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
      const escrowBal = escrowBalRes.status === 'success' ? (escrowBalRes.result as bigint) : 0n;

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
      const openLoanColSum = openCollateralByAsset.get(tokenKey) ?? 0n;
      const capUtilBps =
        cfg.assetCap > 0n ? Number((assetOutstanding * 10_000n) / cfg.assetCap) : 0;

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
        escrow_balance: formatAmount(escrowBal, tokenDecimals, symbol),
        open_loans_collateral_sum: formatAmount(openLoanColSum, tokenDecimals, symbol),
        escrow_matches_open_loans: escrowBal === openLoanColSum,
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

      // Escrow invariant check (only flag if indexer lag is within healthy threshold to avoid stale DB false positives)
      const indexerLagBlocks =
        idxLastBlock !== null && headBlock >= BigInt(idxLastBlock)
          ? headBlock - BigInt(idxLastBlock)
          : null;
      if (
        escrowBal !== openLoanColSum &&
        indexerLagBlocks !== null &&
        indexerLagBlocks <= BigInt(ctx.config.maxHealthyLagBlocks)
      ) {
        observations.push({
          dedupKey: `escrow_mismatch:${tokenKey}`,
          category: 'protocol',
          severity: escrowBal < openLoanColSum ? 'critical' : 'warning',
          title: `Escrow balance mismatch on ${symbol}`,
          message: `${symbol} CollateralEscrow balance (${escrowBal}) != open loans collateral sum (${openLoanColSum})`,
          details: {
            token: tokenAddr,
            symbol,
            escrowBalance: escrowBal.toString(),
            openLoansCollateralSum: openLoanColSum.toString(),
          },
        });
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

    // Evaluate per-loan risk metrics matching LoanCore.startLiquidation exactly
    const activeLiquidatableIds = new Set<string>();
    const unactedLiquidatable: Array<{ loan_id: string; stalled_seconds: number }> = [];

    for (let i = 0; i < openLoanRows.length; i++) {
      const dbLoan = openLoanRows[i];
      const baseIdx = loansOffset + i * LOAN_STRIDE;
      const loanRes = mcRes[baseIdx];
      const dueIntRes = mcRes[baseIdx + 1];
      if (loanRes.status === 'failure' || dueIntRes.status === 'failure') continue;

      const onchainLoan = loanRes.result as {
        borrower: Address;
        collateralToken: Address;
        collateralRaw: bigint;
        principal: bigint;
        marginCallLtvBps: number;
        liqLtvBps: number;
        status: number;
      };
      const dueInterest = dueIntRes.result as bigint;
      const liveStatus = Number(onchainLoan.status);
      // Skip if settled/repaid on-chain even before indexer catches up
      if (liveStatus >= 3) continue;

      const principalRemaining =
        onchainLoan.principal > toBigInt(dbLoan.principal_repaid)
          ? onchainLoan.principal - toBigInt(dbLoan.principal_repaid)
          : onchainLoan.principal;
      const totalDebt = principalRemaining + dueInterest;

      const tokenKey = onchainLoan.collateralToken.toLowerCase();
      const assetSnap = assetByLower.get(tokenKey);
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

      const liqPriceRaw =
        onchainLoan.collateralRaw > 0n && liqLtvBps > 0 && totalDebt > 0n
          ? ceilDiv(
              totalDebt * 10_000n * scaleDenom,
              BigInt(liqLtvBps) * onchainLoan.collateralRaw * 1_000_000n
            )
          : 0n;

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
        BigInt(currentLtvBps) >= BigInt(liqLtvBps);

      let riskStatus: LoanRiskStatus = 'healthy';
      if (canLiquidateOnchain) {
        riskStatus = 'liquidatable';
      } else if (
        currentLtvBps >= liqLtvBps ||
        currentLtvBps >= Math.max(marginCallLtvBps, liqLtvBps - ctx.config.nearLiqBufferBps)
      ) {
        riskStatus = 'near_liquidation';
      } else if (currentLtvBps >= marginCallLtvBps) {
        riskStatus = 'margin_call';
      }

      if (riskStatus === 'liquidatable') {
        activeLiquidatableIds.add(dbLoan.loan_id);
        const firstSeenTs = ctx.state.liquidatableSinceBlockTs.get(dbLoan.loan_id);
        if (firstSeenTs === undefined) {
          ctx.state.liquidatableSinceBlockTs.set(dbLoan.loan_id, Number(blockTimestamp));
        } else {
          const stalledSecs = Math.max(0, Number(blockTimestamp) - firstSeenTs);
          if (stalledSecs >= ctx.config.keeperInactivityAlertSecs) {
            unactedLiquidatable.push({ loan_id: dbLoan.loan_id, stalled_seconds: stalledSecs });
            observations.push({
              dedupKey: `keeper_inactive:loan:${dbLoan.loan_id}`,
              category: 'keeper',
              severity: 'critical',
              title: `Keeper inactive on liquidatable loan #${dbLoan.loan_id}`,
              message: `Loan #${dbLoan.loan_id} has been liquidatable for ${stalledSecs}s without startLiquidation`,
              details: {
                loanId: dbLoan.loan_id,
                stalledSeconds: stalledSecs,
                currentLtvBps,
                liqLtvBps,
              },
            });
          }
        }
        observations.push({
          dedupKey: `loan_risk:${dbLoan.loan_id}:liquidatable`,
          category: 'loan_risk',
          severity: 'critical',
          title: `Loan #${dbLoan.loan_id} is liquidatable`,
          message: `Loan #${dbLoan.loan_id} LTV=${currentLtvBps} bps >= liq=${liqLtvBps} bps (VALID_OPEN)`,
          details: { loanId: dbLoan.loan_id, currentLtvBps, liqLtvBps },
        });
      } else if (riskStatus === 'near_liquidation') {
        observations.push({
          dedupKey: `loan_risk:${dbLoan.loan_id}:near_liq`,
          category: 'loan_risk',
          severity: 'warning',
          title: `Loan #${dbLoan.loan_id} near liquidation`,
          message: `Loan #${dbLoan.loan_id} LTV=${currentLtvBps} bps (liq threshold=${liqLtvBps} bps, oracle=${oracleStateName})`,
          details: { loanId: dbLoan.loan_id, currentLtvBps, liqLtvBps, oracleState: oracleStateName },
        });
      } else if (riskStatus === 'margin_call') {
        observations.push({
          dedupKey: `loan_risk:${dbLoan.loan_id}:margin_call`,
          category: 'loan_risk',
          severity: 'info',
          title: `Loan #${dbLoan.loan_id} in margin call zone`,
          message: `Loan #${dbLoan.loan_id} LTV=${currentLtvBps} bps >= marginCall=${marginCallLtvBps} bps`,
          details: { loanId: dbLoan.loan_id, currentLtvBps, marginCallLtvBps },
        });
      }

      loanSnapshots.push({
        loan_id: dbLoan.loan_id,
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

    const evMap = new Map(keeperEventRows.map((r) => [r.event_name, r]));
    const syncEvt = evMap.get('MultiplierSynced');
    const startedEvt = evMap.get('AuctionStarted');
    const restartedEvt = evMap.get('AuctionRestarted');

    let latestAuctionBlock: string | null = null;
    let latestAuctionTs: string | null = null;
    for (const cand of [startedEvt, restartedEvt]) {
      if (!cand?.max_block) continue;
      if (latestAuctionBlock === null || BigInt(cand.max_block) > BigInt(latestAuctionBlock)) {
        latestAuctionBlock = cand.max_block;
        latestAuctionTs = cand.max_ts;
      }
    }

    const syncTsNum = syncEvt?.max_ts ? Number(syncEvt.max_ts) : null;
    const aucTsNum = latestAuctionTs ? Number(latestAuctionTs) : null;

    ctx.state.consecutiveRpcFailures = 0;
    ctx.state.monitorDegraded = false;
    ctx.state.lastScanError = null;
    ctx.state.latestLoans = loanSnapshots;

    await ctx.alerts.syncObservations(observations, nowMs);

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
        last_liquidation_or_auction_block: latestAuctionBlock,
        last_liquidation_or_auction_timestamp: latestAuctionTs,
        seconds_since_liquidation_or_auction:
          aucTsNum !== null ? Math.max(0, Number(blockTimestamp) - aucTsNum) : null,
        unacted_liquidatable_loans: unactedLiquidatable,
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
        last_liquidation_or_auction_block: null,
        last_liquidation_or_auction_timestamp: null,
        seconds_since_liquidation_or_auction: null,
        unacted_liquidatable_loans: [],
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
