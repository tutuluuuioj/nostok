import {
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  type Transport,
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  defineChain,
  getAddress,
  http,
  zeroAddress,
} from 'viem';
import { base } from 'viem/chains';
import {
  assetRegistryAbi,
  b20Erc20Abi,
  collateralEscrowAbi,
  liquidationAuctionAbi,
  loanCoreAbi,
  oracleRouterAbi,
  orderSettlementAbi,
  positionNftAbi,
} from './abi.js';
import type { IndexerConfig } from './config.js';
import {
  type DatabaseAdapter,
  type Queryable,
  isConnectionDropError,
  openDatabase,
  toBigInt,
} from './db.js';

export const INDEXED_BLOCKS_RETENTION = 1000n;

export interface IndexerContext {
  config: IndexerConfig;
  publicClient: PublicClient<Transport, Chain>;
  db: DatabaseAdapter;
  trackedAssets: Set<Address>;
  consecutiveBlockHashAborts: number;
}

export interface IndexerSyncSummary {
  reorgDetected: boolean;
  rolledBackToBlock?: bigint;
  batchAborted?: boolean;
  consecutiveBlockHashAborts?: number;
  recommendedBackoffMs?: number;
  fromBlock?: bigint;
  toBlock?: bigint;
  blocksProcessed: number;
  eventsIndexed: number;
}

export interface GetLogsQueryParams {
  address: Address | Address[];
  event?: (typeof b20Erc20Abi)[0];
  args?: { from?: Address | null; to?: Address | null };
  fromBlock: bigint;
  toBlock: bigint;
}

function validateChainId(
  chainId: number,
  config: Pick<IndexerConfig, 'isFork' | 'forkChainId'>
): void {
  if (!config.isFork && chainId !== 8453) {
    throw new Error(
      `Invalid chainId ${chainId}: expected Base Mainnet (8453). Set FORK=true and FORK_CHAIN_ID=${chainId} for forks.`
    );
  }
  if (config.isFork && chainId !== config.forkChainId) {
    throw new Error(`Invalid fork chainId ${chainId}: expected FORK_CHAIN_ID=${config.forkChainId}.`);
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function normalizeAddress(addr: string): Address {
  return getAddress(addr);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function collectErrorInfo(err: unknown): { text: string; codes: number[] } {
  const parts: string[] = [];
  const codes: number[] = [];
  const visited = new Set<unknown>();
  let cur: unknown = err;

  while (cur && typeof cur === 'object' && !visited.has(cur)) {
    visited.add(cur);
    const obj = cur as {
      name?: unknown;
      shortMessage?: unknown;
      message?: unknown;
      details?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (typeof obj.name === 'string') parts.push(obj.name);
    if (typeof obj.shortMessage === 'string') parts.push(obj.shortMessage);
    if (typeof obj.message === 'string') parts.push(obj.message);
    if (typeof obj.details === 'string') parts.push(obj.details);
    if (typeof obj.code === 'number') codes.push(obj.code);
    cur = obj.cause;
  }

  if (typeof err === 'string') parts.push(err);
  return { text: parts.join(' | ').toLowerCase(), codes };
}

export function isContractRevertError(err: unknown): boolean {
  if (err instanceof BaseError) {
    const matched = err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ExecutionRevertedError ||
        (e instanceof Error &&
          (e.name === 'ContractFunctionRevertedError' || e.name === 'ExecutionRevertedError'))
    );
    if (matched) return true;
  }

  const visited = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !visited.has(cur)) {
    visited.add(cur);
    const obj = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if (
      obj instanceof ContractFunctionRevertedError ||
      obj instanceof ExecutionRevertedError ||
      obj.name === 'ContractFunctionRevertedError' ||
      obj.name === 'ExecutionRevertedError' ||
      obj.code === 3
    ) {
      return true;
    }
    cur = obj.cause;
  }
  return false;
}

export function isRangeTooLargeError(err: unknown): boolean {
  const { text, codes } = collectErrorInfo(err);
  if (
    codes.includes(-32016) ||
    text.includes('rate limit') ||
    text.includes('ratelimit') ||
    text.includes('too many requests') ||
    /\b429\b/.test(text)
  ) {
    return false;
  }

  const rangeKeywords = [
    'range is too large',
    'range too large',
    'block range',
    'too many results',
    'query returned more than',
    'log response size',
    'response size exceeded',
    'max results',
    'exceeds max',
    '10000 results',
    'try with this block range',
    'more than 10000',
  ];
  if (rangeKeywords.some((kw) => text.includes(kw))) {
    return true;
  }
  if (
    (codes.includes(-32005) || codes.includes(-32602)) &&
    (text.includes('range') || text.includes('result') || text.includes('log') || text.includes('block'))
  ) {
    return true;
  }
  return false;
}

export async function getBlockWithRetry(
  publicClient: PublicClient<Transport, Chain>,
  blockNumber: bigint,
  maxRetries = 3,
  baseDelayMs = 100
) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await publicClient.getBlock({ blockNumber });
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * 2 ** attempt;
        console.warn(
          `[INDEXER_BLOCK] getBlock(${blockNumber}) failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms...`
        );
        await sleep(delayMs);
      }
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`getBlock(${blockNumber}) RPC failed after ${maxRetries + 1} attempts: ${reason}`);
}

export async function readAtBlock<T>(
  fn: (blockNumber: bigint) => Promise<T>,
  blockNumber: bigint,
  label = 'contractRead',
  maxRetries = 3,
  baseDelayMs = 100
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(blockNumber);
    } catch (err) {
      if (isContractRevertError(err)) {
        throw err;
      }
      lastErr = err;
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }

  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.warn(
    `[INDEXER_WARN] Historical state read (${label}) failed at block ${blockNumber} after ${maxRetries + 1} attempts (archive-capable RPC required; refusing fallback to latest): ${reason}`
  );
  throw new Error(
    `Historical state read (${label}) failed at block ${blockNumber}. Archive-capable RPC required: ${reason}`
  );
}

export async function fetchLogsWithRetryAndSplit(
  publicClient: PublicClient<Transport, Chain>,
  params: GetLogsQueryParams,
  maxRetries = 3,
  baseDelayMs = 100
): Promise<Log[]> {
  if (params.toBlock < params.fromBlock) {
    return [];
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return params.event
        ? await publicClient.getLogs<typeof b20Erc20Abi[0]>({
            address: params.address,
            event: params.event,
            args: params.args,
            fromBlock: params.fromBlock,
            toBlock: params.toBlock,
          })
        : await publicClient.getLogs({
            address: params.address,
            fromBlock: params.fromBlock,
            toBlock: params.toBlock,
          });
    } catch (err) {
      if (isRangeTooLargeError(err) && params.fromBlock < params.toBlock) {
        const mid = params.fromBlock + (params.toBlock - params.fromBlock) / 2n;
        console.warn(
          `[INDEXER_LOGS] getLogs range [${params.fromBlock}..${params.toBlock}] too large; splitting in half at ${mid}...`
        );
        const left = await fetchLogsWithRetryAndSplit(
          publicClient,
          { ...params, toBlock: mid },
          maxRetries,
          baseDelayMs
        );
        const right = await fetchLogsWithRetryAndSplit(
          publicClient,
          { ...params, fromBlock: mid + 1n },
          maxRetries,
          baseDelayMs
        );
        return [...left, ...right];
      }

      lastErr = err;
      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * 2 ** attempt;
        console.warn(
          `[INDEXER_LOGS] getLogs failed for [${params.fromBlock}..${params.toBlock}] (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms...`
        );
        await sleep(delayMs);
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function createIndexerContext(config: IndexerConfig): Promise<IndexerContext> {
  const probeClient = createPublicClient({ transport: http(config.rpcUrl), cacheTime: 0 });
  const chainId = await probeClient.getChainId();
  validateChainId(chainId, config);

  const chain = defineChain({
    id: chainId,
    name: chainId === base.id ? base.name : `Nostok Chain ${chainId}`,
    nativeCurrency: base.nativeCurrency,
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
    cacheTime: 0,
  });

  const db = await openDatabase(config.databaseUrl);
  const trackedAssets = new Set<Address>(config.assets.map((a) => getAddress(a)));

  // Restore any previously indexed assets from DB into trackedAssets set
  const existingAssets = await db.query<{ token: string }>('SELECT token FROM assets');
  for (const row of existingAssets.rows) {
    trackedAssets.add(getAddress(row.token));
  }

  // Ensure initial configured assets exist in DB
  const headBlock = await publicClient.getBlockNumber();
  for (const token of trackedAssets) {
    await reconcileAsset(publicClient, db, config, token, headBlock);
  }

  return {
    config,
    publicClient,
    db,
    trackedAssets,
    consecutiveBlockHashAborts: 0,
  };
}

async function reconcileAsset(
  publicClient: PublicClient<Transport, Chain>,
  db: Queryable,
  config: IndexerConfig,
  token: Address,
  blockNumber: bigint
): Promise<void> {
  let symbol: string | null = null;
  let decimals: number | null = null;
  try {
    [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address: token, abi: b20Erc20Abi, functionName: 'symbol' }),
      publicClient.readContract({ address: token, abi: b20Erc20Abi, functionName: 'decimals' }),
    ]);
  } catch {
    // Non-fatal fallback
  }

  const [supported, recordedMult, escrowBal] = await Promise.all([
    readAtBlock(
      (bn) =>
        publicClient.readContract({
          address: config.assetRegistry,
          abi: assetRegistryAbi,
          functionName: 'isAssetSupported',
          args: [token],
          blockNumber: bn,
        }),
      blockNumber,
      `assetRegistry.isAssetSupported(${token})`
    ),
    readAtBlock(
      (bn) =>
        publicClient.readContract({
          address: config.oracleRouter,
          abi: oracleRouterAbi,
          functionName: 'recordedMultiplier',
          args: [token],
          blockNumber: bn,
        }),
      blockNumber,
      `oracleRouter.recordedMultiplier(${token})`
    ),
    readAtBlock(
      (bn) =>
        publicClient.readContract({
          address: config.collateralEscrow,
          abi: collateralEscrowAbi,
          functionName: 'getBalance',
          args: [token],
          blockNumber: bn,
        }),
      blockNumber,
      `collateralEscrow.getBalance(${token})`
    ).catch((err) => {
      if (isContractRevertError(err)) return 0n;
      throw err;
    }),
  ]);

  let cfg: Awaited<ReturnType<typeof readAssetCfg>> | null = null;
  if (supported) {
    cfg = await readAssetCfg(publicClient, config.assetRegistry, token, blockNumber);
  }

  await db.query(
    `INSERT INTO assets (
      token, symbol, decimals, feed, feed_decimals, tier,
      max_init_ltv_bps, margin_call_ltv_bps, liq_ltv_bps, bad_debt_ltv_bps,
      max_discount_bps, closed_market_haircut_bps, per_loan_cap, asset_cap,
      max_stale_open_secs, status, restricted, recorded_multiplier, escrow_balance_raw,
      updated_block, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18, $19,
      $20, NOW()
    )
    ON CONFLICT (token) DO UPDATE SET
      symbol = COALESCE(EXCLUDED.symbol, assets.symbol),
      decimals = COALESCE(EXCLUDED.decimals, assets.decimals),
      feed = COALESCE(EXCLUDED.feed, assets.feed),
      feed_decimals = COALESCE(EXCLUDED.feed_decimals, assets.feed_decimals),
      tier = COALESCE(EXCLUDED.tier, assets.tier),
      max_init_ltv_bps = COALESCE(EXCLUDED.max_init_ltv_bps, assets.max_init_ltv_bps),
      margin_call_ltv_bps = COALESCE(EXCLUDED.margin_call_ltv_bps, assets.margin_call_ltv_bps),
      liq_ltv_bps = COALESCE(EXCLUDED.liq_ltv_bps, assets.liq_ltv_bps),
      bad_debt_ltv_bps = COALESCE(EXCLUDED.bad_debt_ltv_bps, assets.bad_debt_ltv_bps),
      max_discount_bps = COALESCE(EXCLUDED.max_discount_bps, assets.max_discount_bps),
      closed_market_haircut_bps = COALESCE(EXCLUDED.closed_market_haircut_bps, assets.closed_market_haircut_bps),
      per_loan_cap = COALESCE(EXCLUDED.per_loan_cap, assets.per_loan_cap),
      asset_cap = COALESCE(EXCLUDED.asset_cap, assets.asset_cap),
      max_stale_open_secs = COALESCE(EXCLUDED.max_stale_open_secs, assets.max_stale_open_secs),
      status = COALESCE(EXCLUDED.status, assets.status),
      restricted = COALESCE(EXCLUDED.restricted, assets.restricted),
      recorded_multiplier = EXCLUDED.recorded_multiplier,
      escrow_balance_raw = EXCLUDED.escrow_balance_raw,
      updated_block = EXCLUDED.updated_block,
      updated_at = NOW()`,
    [
      getAddress(token),
      symbol,
      decimals,
      cfg ? getAddress(cfg.feed) : null,
      cfg ? cfg.feedDecimals : null,
      cfg ? cfg.tier : null,
      cfg ? cfg.maxInitLtvBps : null,
      cfg ? cfg.marginCallLtvBps : null,
      cfg ? cfg.liqLtvBps : null,
      cfg ? cfg.badDebtLtvBps : null,
      cfg ? cfg.maxDiscountBps : null,
      cfg ? cfg.closedMarketHaircutBps : null,
      cfg ? cfg.perLoanCap.toString() : null,
      cfg ? cfg.assetCap.toString() : null,
      cfg ? cfg.maxStaleOpenSecs : null,
      cfg ? cfg.status : null,
      cfg ? cfg.restricted : null,
      recordedMult.toString(),
      escrowBal.toString(),
      blockNumber.toString(),
    ]
  );
}

async function readAssetCfg(
  publicClient: PublicClient<Transport, Chain>,
  assetRegistry: Address,
  token: Address,
  blockNumber: bigint
) {
  return readAtBlock(
    (bn) =>
      publicClient.readContract({
        address: assetRegistry,
        abi: assetRegistryAbi,
        functionName: 'getAssetConfig',
        args: [token],
        blockNumber: bn,
      }),
    blockNumber,
    `assetRegistry.getAssetConfig(${token})`
  );
}

async function reconcileLoan(
  publicClient: PublicClient<Transport, Chain>,
  db: Queryable,
  config: IndexerConfig,
  loanId: bigint,
  blockNumber: bigint,
  lenderHint?: Address
): Promise<void> {
  const [loan, activeAuctionId, badDebtRow] = await Promise.all([
    readAtBlock(
      (bn) =>
        publicClient.readContract({
          address: config.loanCore,
          abi: loanCoreAbi,
          functionName: 'getLoan',
          args: [loanId],
          blockNumber: bn,
        }),
      blockNumber,
      `loanCore.getLoan(${loanId})`
    ),
    readAtBlock(
      (bn) =>
        publicClient.readContract({
          address: config.loanCore,
          abi: loanCoreAbi,
          functionName: 'loanActiveAuction',
          args: [loanId],
          blockNumber: bn,
        }),
      blockNumber,
      `loanCore.loanActiveAuction(${loanId})`
    ),
    db.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(amount_raw), 0)::TEXT AS total
       FROM loan_events
       WHERE loan_id = $1 AND event_name = 'BadDebtRecorded'`,
      [loanId.toString()]
    ),
  ]);

  if (loan.borrower === zeroAddress) return;
  const shortfall = badDebtRow.rows[0]?.total ?? '0';

  await db.query(
    `INSERT INTO loans (
      loan_id, borrower, lender, collateral_token, collateral_raw, principal,
      start_time, maturity, rate_bps, penalty_spread_bps,
      init_ltv_bps, margin_call_ltv_bps, liq_ltv_bps, min_interest_days,
      status, yield_mode, core_version, interest_paid, principal_repaid,
      active_auction_id, bad_debt_shortfall, opened_block, last_updated_block, row_version, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18, $19,
      $20, $21, $22, $22, 1, NOW()
    )
    ON CONFLICT (loan_id) DO UPDATE SET
      lender = COALESCE(EXCLUDED.lender, loans.lender),
      collateral_raw = EXCLUDED.collateral_raw,
      principal = EXCLUDED.principal,
      maturity = EXCLUDED.maturity,
      rate_bps = EXCLUDED.rate_bps,
      penalty_spread_bps = EXCLUDED.penalty_spread_bps,
      status = EXCLUDED.status,
      interest_paid = EXCLUDED.interest_paid,
      principal_repaid = EXCLUDED.principal_repaid,
      active_auction_id = EXCLUDED.active_auction_id,
      bad_debt_shortfall = EXCLUDED.bad_debt_shortfall,
      last_updated_block = EXCLUDED.last_updated_block,
      row_version = loans.row_version + 1,
      updated_at = NOW()`,
    [
      loanId.toString(),
      getAddress(loan.borrower),
      lenderHint ? getAddress(lenderHint) : null,
      getAddress(loan.collateralToken),
      loan.collateralRaw.toString(),
      loan.principal.toString(),
      loan.startTime.toString(),
      loan.maturity.toString(),
      loan.rateBps,
      loan.penaltySpreadBps,
      loan.initLtvBps,
      loan.marginCallLtvBps,
      loan.liqLtvBps,
      loan.minInterestDays,
      loan.status,
      loan.yieldMode,
      loan.coreVersion,
      loan.interestPaid.toString(),
      loan.principalRepaid.toString(),
      activeAuctionId.toString(),
      shortfall,
      blockNumber.toString(),
    ]
  );
}

async function reconcileAuction(
  publicClient: PublicClient<Transport, Chain>,
  db: Queryable,
  config: IndexerConfig,
  auctionId: bigint,
  blockNumber: bigint
): Promise<void> {
  const auction = await readAtBlock(
    (bn) =>
      publicClient.readContract({
        address: config.liquidationAuction,
        abi: liquidationAuctionAbi,
        functionName: 'getAuction',
        args: [auctionId],
        blockNumber: bn,
      }),
    blockNumber,
    `liquidationAuction.getAuction(${auctionId})`
  );

  if (auction.loanId === 0n) return;

  const settledRes = await db.query<{ payload: string }>(
    `SELECT payload::TEXT AS payload
     FROM loan_events
     WHERE event_name = 'AuctionSettled'
       AND (payload->>'auctionId') = $1
     ORDER BY block_number DESC, log_index DESC
     LIMIT 1`,
    [auctionId.toString()]
  );

  let totalUsdcCollected = '0';
  let debtPaid = '0';
  let feePaid = '0';
  let surplusToBorrower = '0';
  if (settledRes.rows.length > 0) {
    const p = JSON.parse(settledRes.rows[0].payload) as Record<string, string>;
    totalUsdcCollected = p.totalUsdcCollected ?? '0';
    debtPaid = p.debtPaid ?? '0';
    feePaid = p.feePaid ?? '0';
    surplusToBorrower = p.surplusToBorrower ?? '0';
  }

  await db.query(
    `INSERT INTO auctions (
      auction_id, loan_id, borrower, collateral_token,
      collateral_total, collateral_remaining, debt_principal_remaining, debt_interest_remaining,
      start_price, floor_price, start_time, duration, keeper, status, is_default_auction,
      total_usdc_collected, debt_paid, fee_paid, surplus_to_borrower,
      created_block, last_updated_block, updated_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19,
      $20, $20, NOW()
    )
    ON CONFLICT (auction_id) DO UPDATE SET
      collateral_remaining = EXCLUDED.collateral_remaining,
      debt_principal_remaining = EXCLUDED.debt_principal_remaining,
      debt_interest_remaining = EXCLUDED.debt_interest_remaining,
      start_price = EXCLUDED.start_price,
      floor_price = EXCLUDED.floor_price,
      start_time = EXCLUDED.start_time,
      status = EXCLUDED.status,
      total_usdc_collected = EXCLUDED.total_usdc_collected,
      debt_paid = EXCLUDED.debt_paid,
      fee_paid = EXCLUDED.fee_paid,
      surplus_to_borrower = EXCLUDED.surplus_to_borrower,
      last_updated_block = EXCLUDED.last_updated_block,
      updated_at = NOW()`,
    [
      auctionId.toString(),
      auction.loanId.toString(),
      getAddress(auction.borrower),
      getAddress(auction.collateralToken),
      auction.collateralTotal.toString(),
      auction.collateralRemaining.toString(),
      auction.debtPrincipalRemaining.toString(),
      auction.debtInterestRemaining.toString(),
      auction.startPrice.toString(),
      auction.floorPrice.toString(),
      auction.startTime.toString(),
      auction.duration.toString(),
      getAddress(auction.keeper),
      auction.status,
      auction.isDefaultAuction,
      totalUsdcCollected,
      debtPaid,
      feePaid,
      surplusToBorrower,
      blockNumber.toString(),
    ]
  );
}

async function reconcilePosition(
  publicClient: PublicClient<Transport, Chain>,
  db: Queryable,
  config: IndexerConfig,
  loanId: bigint,
  blockNumber: bigint
): Promise<void> {
  let owner: Address = zeroAddress;
  let isBurned = false;
  try {
    owner = await readAtBlock(
      (bn) =>
        publicClient.readContract({
          address: config.positionNft,
          abi: positionNftAbi,
          functionName: 'ownerOf',
          args: [loanId],
          blockNumber: bn,
        }),
      blockNumber,
      `positionNft.ownerOf(${loanId})`
    );
  } catch (err) {
    if (isContractRevertError(err)) {
      isBurned = true;
    } else {
      throw err;
    }
  }

  const auctionLocked = await readAtBlock(
    (bn) =>
      publicClient.readContract({
        address: config.positionNft,
        abi: positionNftAbi,
        functionName: 'isAuctionLocked',
        args: [loanId],
        blockNumber: bn,
      }),
    blockNumber,
    `positionNft.isAuctionLocked(${loanId})`
  ).catch((err) => {
    if (isContractRevertError(err)) return false;
    throw err;
  });

  await db.query(
    `INSERT INTO positions (
      loan_id, owner, auction_locked, is_burned, minted_block, last_updated_block
    ) VALUES ($1, $2, $3, $4, $5, $5)
    ON CONFLICT (loan_id) DO UPDATE SET
      owner = EXCLUDED.owner,
      auction_locked = EXCLUDED.auction_locked,
      is_burned = EXCLUDED.is_burned,
      last_updated_block = EXCLUDED.last_updated_block`,
    [
      loanId.toString(),
      getAddress(owner),
      auctionLocked,
      isBurned,
      blockNumber.toString(),
    ]
  );
}

interface DirtyOrderMeta {
  maker: Address;
  minUsdc?: bigint;
  collateralToken?: Address;
  orderType?: 'borrow' | 'lend';
}

/**
 * Decodes order metadata (minUsdc, collateral token, order type) from the transaction calldata.
 *
 * - getTransaction is retried with exponential backoff. A transient RPC failure is NEVER cached, so a
 *   later event (or the next poll) retries it.
 * - If the calldata cannot be decoded as a direct OrderSettlement call (e.g. a wrapper/multicall contract),
 *   null is returned. Callers then store min_usdc = 0, which means "unknown" (the API reports status
 *   "unknown" and remaining = null instead of "filled").
 */
export async function resolveOrderMetaFromTx(
  publicClient: { getTransaction: (args: { hash: Hex }) => Promise<{ input: Hex }> },
  txHash: Hex,
  cache: Map<Hex, Omit<DirtyOrderMeta, 'maker'> | null>,
  opts: { attempts?: number; baseDelayMs?: number } = {}
): Promise<Omit<DirtyOrderMeta, 'maker'> | null> {
  const key = txHash.toLowerCase() as Hex;
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }

  const attempts = Math.max(1, opts.attempts ?? 4);
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? 200);
  let tx: { input: Hex } | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      tx = await publicClient.getTransaction({ hash: txHash });
      break;
    } catch (err) {
      if (attempt === attempts) {
        console.warn(
          `[INDEXER_WARN] getTransaction(${txHash}) failed after ${attempts} attempts; order min_usdc left unknown (not cached): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
        );
        return null;
      }
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  if (!tx) return null;

  let meta: Omit<DirtyOrderMeta, 'maker'> | null = null;
  try {
    const decoded = decodeFunctionData({ abi: orderSettlementAbi, data: tx.input });

    if (
      decoded.functionName === 'fillBorrowOrder' ||
      decoded.functionName === 'fillBorrowOrderWithAttestations' ||
      decoded.functionName === 'cancelBorrowOrder'
    ) {
      const order = decoded.args[0];
      const tok = normalizeAddress(order.collateralToken);
      meta = {
        minUsdc: BigInt(order.minUsdc),
        collateralToken: tok !== zeroAddress ? tok : undefined,
        orderType: 'borrow',
      };
    } else if (
      decoded.functionName === 'fillLendOffer' ||
      decoded.functionName === 'fillLendOfferWithAttestations'
    ) {
      const offer = decoded.args[0];
      const tok = normalizeAddress(decoded.args[2]);
      meta = {
        minUsdc: BigInt(offer.usdcAmount),
        collateralToken: tok !== zeroAddress ? tok : undefined,
        orderType: 'lend',
      };
    } else if (decoded.functionName === 'cancelLendOffer') {
      const offer = decoded.args[0];
      const allowed = normalizeAddress(offer.allowedCollateral);
      meta = {
        minUsdc: BigInt(offer.usdcAmount),
        collateralToken: allowed !== zeroAddress ? allowed : undefined,
        orderType: 'lend',
      };
    }
  } catch {
    // Calldata is not a direct OrderSettlement call (wrapper contract). Deterministic for this tx,
    // so caching null for the lifetime of this sync batch is safe.
    meta = null;
  }

  cache.set(key, meta);
  return meta;
}

async function reconcileOrder(
  publicClient: PublicClient<Transport, Chain>,
  db: Queryable,
  config: IndexerConfig,
  orderHash: Hex,
  meta: DirtyOrderMeta,
  blockNumber: bigint
): Promise<void> {
  const { maker } = meta;
  const [cancelled, filledUsdc, makerNonce] = await Promise.all([
    readAtBlock(
      (bn) =>
        publicClient.readContract({
          address: config.orderSettlement,
          abi: orderSettlementAbi,
          functionName: 'isOrderCancelled',
          args: [orderHash],
          blockNumber: bn,
        }),
      blockNumber,
      `orderSettlement.isOrderCancelled(${orderHash})`
    ),
    readAtBlock(
      (bn) =>
        publicClient.readContract({
          address: config.orderSettlement,
          abi: orderSettlementAbi,
          functionName: 'getOrderFilledAmount',
          args: [orderHash],
          blockNumber: bn,
        }),
      blockNumber,
      `orderSettlement.getOrderFilledAmount(${orderHash})`
    ),
    readAtBlock(
      (bn) =>
        publicClient.readContract({
          address: config.orderSettlement,
          abi: orderSettlementAbi,
          functionName: 'getMakerNonce',
          args: [maker],
          blockNumber: bn,
        }),
      blockNumber,
      `orderSettlement.getMakerNonce(${maker})`
    ),
  ]);

  let collateralToken = meta.collateralToken ?? null;
  if (!collateralToken) {
    const fallbackRes = await db.query<{ collateral_token: string | null }>(
      `SELECT l.collateral_token
       FROM order_fills ofi
       JOIN loans l ON l.loan_id = ofi.loan_id
       WHERE ofi.order_hash = $1
       LIMIT 1`,
      [orderHash.toLowerCase()]
    );
    if (fallbackRes.rows[0]?.collateral_token) {
      collateralToken = getAddress(fallbackRes.rows[0].collateral_token);
    }
  }

  await db.query(
    `INSERT INTO orders (
      order_hash, maker, collateral_token, min_usdc, filled_usdc, order_type, cancelled, maker_nonce, first_seen_block, last_updated_block
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
    ON CONFLICT (order_hash) DO UPDATE SET
      collateral_token = COALESCE(EXCLUDED.collateral_token, orders.collateral_token),
      min_usdc = CASE WHEN EXCLUDED.min_usdc > 0 THEN EXCLUDED.min_usdc ELSE orders.min_usdc END,
      filled_usdc = EXCLUDED.filled_usdc,
      order_type = COALESCE(EXCLUDED.order_type, orders.order_type),
      cancelled = EXCLUDED.cancelled,
      maker_nonce = EXCLUDED.maker_nonce,
      last_updated_block = EXCLUDED.last_updated_block`,
    [
      orderHash.toLowerCase(),
      getAddress(maker),
      collateralToken,
      (meta.minUsdc ?? 0n).toString(),
      filledUsdc.toString(),
      meta.orderType ?? 'borrow',
      cancelled,
      makerNonce.toString(),
      blockNumber.toString(),
    ]
  );
}

async function insertLoanEvent(
  tx: Queryable,
  params: {
    blockNumber: bigint;
    blockHash: Hex;
    txHash: Hex;
    logIndex: number;
    contractAddress: Address;
    eventName: string;
    loanId?: bigint | null;
    token?: Address | null;
    actor?: Address | null;
    counterparty?: Address | null;
    amountRaw?: bigint | null;
    secondaryAmount?: bigint | null;
    payload: Record<string, unknown>;
    blockTimestamp: bigint;
  }
): Promise<void> {
  await tx.query(
    `INSERT INTO loan_events (
      block_number, block_hash, tx_hash, log_index, contract_address, event_name,
      loan_id, token, actor, counterparty, amount_raw, secondary_amount, payload, block_timestamp
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
    ON CONFLICT (block_number, log_index) DO UPDATE SET
      block_hash = EXCLUDED.block_hash,
      tx_hash = EXCLUDED.tx_hash,
      event_name = EXCLUDED.event_name,
      loan_id = EXCLUDED.loan_id,
      token = EXCLUDED.token,
      actor = EXCLUDED.actor,
      counterparty = EXCLUDED.counterparty,
      amount_raw = EXCLUDED.amount_raw,
      secondary_amount = EXCLUDED.secondary_amount,
      payload = EXCLUDED.payload`,
    [
      params.blockNumber.toString(),
      params.blockHash.toLowerCase(),
      params.txHash.toLowerCase(),
      params.logIndex,
      getAddress(params.contractAddress),
      params.eventName,
      params.loanId !== undefined && params.loanId !== null ? params.loanId.toString() : null,
      params.token ? getAddress(params.token) : null,
      params.actor ? getAddress(params.actor) : null,
      params.counterparty ? getAddress(params.counterparty) : null,
      params.amountRaw !== undefined && params.amountRaw !== null ? params.amountRaw.toString() : null,
      params.secondaryAmount !== undefined && params.secondaryAmount !== null
        ? params.secondaryAmount.toString()
        : null,
      safeJson(params.payload),
      params.blockTimestamp.toString(),
    ]
  );
}

/**
 * Verifies canonical block hashes against `indexed_blocks`.
 * If a chain reorg or Anvil revert occurred, rolls back all blocks after the common ancestor
 * and reconciles surviving DB rows with canonical onchain view state.
 */
export async function detectAndHandleReorg(
  ctx: IndexerContext
): Promise<{ reorgDetected: boolean; rolledBackToBlock?: bigint }> {
  const { publicClient, db, config } = ctx;
  const checkLimit = Math.max(config.confirmations + 16, 32);

  const stored = await db.query<{ block_number: string; block_hash: string }>(
    'SELECT block_number, block_hash FROM indexed_blocks ORDER BY block_number DESC LIMIT $1',
    [checkLimit]
  );
  if (stored.rows.length === 0) {
    return { reorgDetected: false };
  }

  const headBlock = await publicClient.getBlockNumber();
  const highestStored = toBigInt(stored.rows[0].block_number);

  let forkPoint: bigint | null = null;
  let reorgNeeded = highestStored > headBlock;

  if (!reorgNeeded) {
    for (let i = 0; i < stored.rows.length; i++) {
      const row = stored.rows[i];
      const bn = toBigInt(row.block_number);
      const canonical = await getBlockWithRetry(publicClient, bn);
      if (!canonical.hash || canonical.hash.toLowerCase() !== row.block_hash.toLowerCase()) {
        reorgNeeded = true;
      } else {
        if (reorgNeeded) {
          forkPoint = bn;
        }
        break;
      }
    }
  }

  if (!reorgNeeded) {
    return { reorgDetected: false };
  }

  // Walk backwards in bounded pages to find highest matching canonical block
  if (forkPoint === null) {
    let page = stored.rows;
    while (page.length > 0 && forkPoint === null) {
      for (const row of page) {
        const bn = toBigInt(row.block_number);
        if (bn > headBlock) continue;
        const canonical = await getBlockWithRetry(publicClient, bn);
        if (canonical.hash && canonical.hash.toLowerCase() === row.block_hash.toLowerCase()) {
          forkPoint = bn;
          break;
        }
      }
      if (forkPoint !== null || page.length < checkLimit) {
        break;
      }
      const lowestChecked = toBigInt(page[page.length - 1].block_number);
      const nextRes = await db.query<{ block_number: string; block_hash: string }>(
        'SELECT block_number, block_hash FROM indexed_blocks WHERE block_number < $1 ORDER BY block_number DESC LIMIT $2',
        [lowestChecked.toString(), checkLimit]
      );
      page = nextRes.rows;
    }
  }

  const rollbackTo = forkPoint ?? config.startBlock - 1n;
  console.warn(
    `[INDEXER_REORG] Chain reorg detected (head=${headBlock}, storedTop=${highestStored}). Rolling back DB state to block ${rollbackTo}...`
  );

  // Identify surviving entities modified in orphaned blocks so we reconcile them back to canonical state
  const affectedLoanRows = await db.query<{ loan_id: string }>(
    `SELECT DISTINCT loan_id::TEXT AS loan_id
     FROM loan_events
     WHERE block_number > $1 AND loan_id IS NOT NULL
     UNION
     SELECT loan_id::TEXT AS loan_id
     FROM loans
     WHERE opened_block <= $1 AND last_updated_block > $1`,
    [rollbackTo.toString()]
  );
  const affectedOrderRows = await db.query<{ order_hash: string; maker: string }>(
    `SELECT order_hash, maker
     FROM orders
     WHERE first_seen_block <= $1 AND last_updated_block > $1`,
    [rollbackTo.toString()]
  );
  const affectedAuctionRows = await db.query<{ auction_id: string }>(
    `SELECT auction_id::TEXT AS auction_id
     FROM auctions
     WHERE created_block <= $1 AND last_updated_block > $1`,
    [rollbackTo.toString()]
  );
  const affectedPositionRows = await db.query<{ loan_id: string }>(
    `SELECT loan_id::TEXT AS loan_id
     FROM positions
     WHERE minted_block <= $1 AND last_updated_block > $1`,
    [rollbackTo.toString()]
  );
  const affectedAssetRows = await db.query<{ token: string }>(
    `SELECT DISTINCT token
     FROM assets
     WHERE updated_block > $1`,
    [rollbackTo.toString()]
  );

  await db.transaction(async (tx) => {
    const rb = rollbackTo.toString();
    await tx.query('DELETE FROM loan_events WHERE block_number > $1', [rb]);
    await tx.query('DELETE FROM order_fills WHERE block_number > $1', [rb]);
    await tx.query('DELETE FROM auction_buys WHERE block_number > $1', [rb]);
    await tx.query('DELETE FROM claims WHERE block_number > $1', [rb]);
    await tx.query('DELETE FROM loans WHERE opened_block > $1', [rb]);
    await tx.query('DELETE FROM auctions WHERE created_block > $1', [rb]);
    await tx.query('DELETE FROM positions WHERE minted_block > $1', [rb]);
    await tx.query('DELETE FROM orders WHERE first_seen_block > $1', [rb]);
    await tx.query('DELETE FROM indexed_blocks WHERE block_number > $1', [rb]);

    await tx.query(
      `INSERT INTO indexer_state (id, last_indexed_block, chain_id, updated_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET
         last_indexed_block = EXCLUDED.last_indexed_block,
         updated_at = NOW()`,
      [rb, publicClient.chain.id]
    );
  });

  const reconcileBlock = rollbackTo >= 0n ? rollbackTo : 0n;
  const survivingLoanIds = new Set(affectedLoanRows.rows.map((r) => toBigInt(r.loan_id)));
  for (const row of affectedPositionRows.rows) {
    survivingLoanIds.add(toBigInt(row.loan_id));
  }

  for (const loanId of survivingLoanIds) {
    const exists = await db.query('SELECT 1 FROM loans WHERE loan_id = $1', [loanId.toString()]);
    if (exists.rows.length > 0) {
      await reconcileLoan(publicClient, db, config, loanId, reconcileBlock);
    }
    const posExists = await db.query('SELECT 1 FROM positions WHERE loan_id = $1', [loanId.toString()]);
    if (posExists.rows.length > 0) {
      await reconcilePosition(publicClient, db, config, loanId, reconcileBlock);
    }
  }

  for (const row of affectedAuctionRows.rows) {
    const auctionId = toBigInt(row.auction_id);
    const exists = await db.query('SELECT 1 FROM auctions WHERE auction_id = $1', [auctionId.toString()]);
    if (exists.rows.length > 0) {
      await reconcileAuction(publicClient, db, config, auctionId, reconcileBlock);
    }
  }

  for (const row of affectedOrderRows.rows) {
    const exists = await db.query('SELECT 1 FROM orders WHERE order_hash = $1', [row.order_hash]);
    if (exists.rows.length > 0) {
      await reconcileOrder(
        publicClient,
        db,
        config,
        row.order_hash as Hex,
        { maker: getAddress(row.maker) },
        reconcileBlock
      );
    }
  }

  const assetTokens = new Set<Address>(ctx.trackedAssets);
  for (const row of affectedAssetRows.rows) {
    assetTokens.add(getAddress(row.token));
  }
  for (const token of assetTokens) {
    await reconcileAsset(publicClient, db, config, token, reconcileBlock);
  }

  console.log(`[INDEXER_REORG] Rollback & canonical reconciliation complete at block ${rollbackTo}.`);
  return { reorgDetected: true, rolledBackToBlock: rollbackTo };
}

async function pruneOldIndexedBlocks(db: Queryable, chainHead: bigint): Promise<void> {
  if (chainHead <= INDEXED_BLOCKS_RETENTION) return;
  const cutoff = chainHead - INDEXED_BLOCKS_RETENTION;
  await db.query('DELETE FROM indexed_blocks WHERE block_number < $1', [cutoff.toString()]);
}

export async function runIndexerSync(ctx: IndexerContext): Promise<IndexerSyncSummary> {
  const { config, publicClient, db } = ctx;

  const reorgResult = await detectAndHandleReorg(ctx);

  const stateRes = await db.query<{ last_indexed_block: string }>(
    'SELECT last_indexed_block FROM indexer_state WHERE id = 1'
  );
  const lastIndexed =
    stateRes.rows.length > 0
      ? toBigInt(stateRes.rows[0].last_indexed_block)
      : config.startBlock - 1n;

  const chainHead = await publicClient.getBlockNumber();
  const safeTarget =
    chainHead >= BigInt(config.confirmations) ? chainHead - BigInt(config.confirmations) : -1n;

  if (safeTarget < 0n || lastIndexed >= safeTarget) {
    await pruneOldIndexedBlocks(db, chainHead);
    ctx.consecutiveBlockHashAborts = 0;
    return {
      reorgDetected: reorgResult.reorgDetected,
      rolledBackToBlock: reorgResult.rolledBackToBlock,
      consecutiveBlockHashAborts: 0,
      blocksProcessed: 0,
      eventsIndexed: 0,
    };
  }

  const fromBlock = lastIndexed + 1n;
  const maxBatchTo = fromBlock + BigInt(config.blockBatchSize) - 1n;
  const toBlock = safeTarget < maxBatchTo ? safeTarget : maxBatchTo;

  const coreAddresses: Address[] = [
    config.loanCore,
    config.orderSettlement,
    config.liquidationAuction,
    config.positionNft,
    config.assetRegistry,
    config.oracleRouter,
  ];

  // Fetch core protocol logs plus Transfer logs on listed B20 tokens involving CollateralEscrow
  const tokenAddresses = Array.from(ctx.trackedAssets);
  const [coreLogs, b20InLogs, b20OutLogs] = await Promise.all([
    fetchLogsWithRetryAndSplit(publicClient, {
      address: coreAddresses,
      fromBlock,
      toBlock,
    }),
    tokenAddresses.length > 0
      ? fetchLogsWithRetryAndSplit(publicClient, {
          address: tokenAddresses,
          event: b20Erc20Abi[0],
          args: { to: config.collateralEscrow },
          fromBlock,
          toBlock,
        })
      : Promise.resolve([]),
    tokenAddresses.length > 0
      ? fetchLogsWithRetryAndSplit(publicClient, {
          address: tokenAddresses,
          event: b20Erc20Abi[0],
          args: { from: config.collateralEscrow },
          fromBlock,
          toBlock,
        })
      : Promise.resolve([]),
  ]);

  const seenKeys = new Set<string>();
  const allLogs: Log[] = [];
  for (const l of [...coreLogs, ...b20InLogs, ...b20OutLogs]) {
    if (l.blockNumber === null || l.logIndex === null) continue;
    const key = `${l.blockNumber}:${l.logIndex}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      allLogs.push(l);
    }
  }

  allLogs.sort((a, b) => {
    const ba = a.blockNumber ?? 0n;
    const bb = b.blockNumber ?? 0n;
    if (ba !== bb) return ba < bb ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  const logsByBlock = new Map<bigint, Log[]>();
  for (const log of allLogs) {
    const bn = log.blockNumber!;
    const arr = logsByBlock.get(bn) ?? [];
    arr.push(log);
    logsByBlock.set(bn, arr);
  }

  let eventsIndexed = 0;
  let blocksProcessed = 0;

  for (let bn = fromBlock; bn <= toBlock; bn++) {
    const block = await getBlockWithRetry(publicClient, bn);
    let blockLogs = logsByBlock.get(bn) ?? [];

    // Requirement 6: Check if AssetConfigSet introduced any untracked token mid-batch
    const newlyDiscoveredTokens: Address[] = [];
    for (const log of blockLogs) {
      if (getAddress(log.address) !== config.assetRegistry) continue;
      try {
        const decoded = decodeEventLog({ abi: assetRegistryAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === 'AssetConfigSet') {
          const tokenAddr = normalizeAddress(decoded.args.token);
          if (!ctx.trackedAssets.has(tokenAddr) && !newlyDiscoveredTokens.includes(tokenAddr)) {
            newlyDiscoveredTokens.push(tokenAddr);
          }
        }
      } catch {
        // Ignore unrelated log decoding errors
      }
    }

    if (newlyDiscoveredTokens.length > 0) {
      console.log(
        `[INDEXER] Mid-batch AssetConfigSet detected for ${newlyDiscoveredTokens.join(', ')} at block ${bn}; fetching B20 escrow Transfer logs for [${bn}..${toBlock}]...`
      );
      const [newInLogs, newOutLogs] = await Promise.all([
        fetchLogsWithRetryAndSplit(publicClient, {
          address: newlyDiscoveredTokens,
          event: b20Erc20Abi[0],
          args: { to: config.collateralEscrow },
          fromBlock: bn,
          toBlock,
        }),
        fetchLogsWithRetryAndSplit(publicClient, {
          address: newlyDiscoveredTokens,
          event: b20Erc20Abi[0],
          args: { from: config.collateralEscrow },
          fromBlock: bn,
          toBlock,
        }),
      ]);

      for (const l of [...newInLogs, ...newOutLogs]) {
        if (l.blockNumber === null || l.logIndex === null) continue;
        const key = `${l.blockNumber}:${l.logIndex}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          const arr = logsByBlock.get(l.blockNumber) ?? [];
          arr.push(l);
          arr.sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0));
          logsByBlock.set(l.blockNumber, arr);
        }
      }
      blockLogs = logsByBlock.get(bn) ?? [];
    }

    // Requirement 5: Verify every log in this block belongs to canonical block.hash
    const expectedBlockHash = block.hash.toLowerCase();
    for (const log of blockLogs) {
      if (!log.blockHash || log.blockHash.toLowerCase() !== expectedBlockHash) {
        ctx.consecutiveBlockHashAborts += 1;
        let recommendedBackoffMs: number | undefined;
        if (ctx.consecutiveBlockHashAborts >= 5) {
          recommendedBackoffMs = Math.min(
            config.pollIntervalMs * 2 ** (ctx.consecutiveBlockHashAborts - 4),
            60_000
          );
          console.error(
            `[INDEXER_ERROR] ${ctx.consecutiveBlockHashAborts} consecutive log.blockHash mismatch aborts (latest at block ${bn}, log.blockHash=${String(log.blockHash)}, block.hash=${block.hash}). Backing off poll to ${recommendedBackoffMs}ms.`
          );
        } else {
          console.warn(
            `[INDEXER_REORG] Log blockHash mismatch at block ${bn} (log.blockHash=${String(log.blockHash)}, block.hash=${block.hash}). Aborting batch to retry next poll (consecutive=${ctx.consecutiveBlockHashAborts}).`
          );
        }
        return {
          reorgDetected: true,
          rolledBackToBlock: reorgResult.rolledBackToBlock,
          batchAborted: true,
          consecutiveBlockHashAborts: ctx.consecutiveBlockHashAborts,
          recommendedBackoffMs,
          fromBlock,
          toBlock: bn > fromBlock ? bn - 1n : undefined,
          blocksProcessed,
          eventsIndexed,
        };
      }
    }

    const effectiveTrackedAssets = new Set<Address>(ctx.trackedAssets);
    for (const t of newlyDiscoveredTokens) {
      effectiveTrackedAssets.add(t);
    }

    const orderTxCache = new Map<Hex, Omit<DirtyOrderMeta, 'maker'> | null>();
    const eventsIndexedBeforeBlock = eventsIndexed;

    const commitBlockTx = async () => {
      eventsIndexed = eventsIndexedBeforeBlock;
      const dirtyLoans = new Map<bigint, Address | undefined>();
      const dirtyAuctions = new Set<bigint>();
      const dirtyPositions = new Set<bigint>();
      const dirtyOrders = new Map<Hex, DirtyOrderMeta>();
      const dirtyAssets = new Set<Address>();

      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO indexed_blocks (block_number, block_hash, parent_hash, block_timestamp)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (block_number) DO UPDATE SET
             block_hash = EXCLUDED.block_hash,
             parent_hash = EXCLUDED.parent_hash,
             block_timestamp = EXCLUDED.block_timestamp`,
          [
            bn.toString(),
            block.hash.toLowerCase(),
            block.parentHash.toLowerCase(),
            block.timestamp.toString(),
          ]
        );

      for (const log of blockLogs) {
        if (!log.blockHash || log.blockHash.toLowerCase() !== expectedBlockHash) {
          throw new Error(`Log blockHash mismatch inside tx at block ${bn}`);
        }
        const source = getAddress(log.address);
        const logIndex = log.logIndex!;
        const txHash = log.transactionHash!;
        const blockHash = block.hash;

        if (source === config.loanCore) {
          let decoded;
          try {
            decoded = decodeEventLog({ abi: loanCoreAbi, data: log.data, topics: log.topics });
          } catch {
            continue;
          }
          eventsIndexed++;

          switch (decoded.eventName) {
            case 'LoanOpened': {
              const args = decoded.args;
              dirtyLoans.set(args.loanId, normalizeAddress(args.lender));
              dirtyAssets.add(normalizeAddress(args.collateralToken));
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'LoanOpened',
                loanId: args.loanId,
                token: args.collateralToken,
                actor: args.borrower,
                counterparty: args.lender,
                amountRaw: args.principal,
                secondaryAmount: args.collateralAmount,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'Repaid': {
              const args = decoded.args;
              if (!dirtyLoans.has(args.loanId)) dirtyLoans.set(args.loanId, undefined);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'Repaid',
                loanId: args.loanId,
                actor: args.payer,
                amountRaw: args.principalPaid,
                secondaryAmount: args.interestPaid,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'PartialRepaid': {
              const args = decoded.args;
              if (!dirtyLoans.has(args.loanId)) dirtyLoans.set(args.loanId, undefined);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'PartialRepaid',
                loanId: args.loanId,
                actor: args.payer,
                amountRaw: args.principalPaid,
                secondaryAmount: args.collateralReleased,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'ToppedUp': {
              const args = decoded.args;
              if (!dirtyLoans.has(args.loanId)) dirtyLoans.set(args.loanId, undefined);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'ToppedUp',
                loanId: args.loanId,
                actor: args.funder,
                amountRaw: args.additionalCollateral,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'Extended': {
              const args = decoded.args;
              if (!dirtyLoans.has(args.loanId)) dirtyLoans.set(args.loanId, undefined);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'Extended',
                loanId: args.loanId,
                amountRaw: BigInt(args.newMaturity),
                secondaryAmount: BigInt(args.newRateBps),
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'StatusSynced': {
              const args = decoded.args;
              if (!dirtyLoans.has(args.loanId)) dirtyLoans.set(args.loanId, undefined);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'StatusSynced',
                loanId: args.loanId,
                amountRaw: BigInt(args.status),
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'BadDebtRecorded': {
              const args = decoded.args;
              if (!dirtyLoans.has(args.loanId)) dirtyLoans.set(args.loanId, undefined);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'BadDebtRecorded',
                loanId: args.loanId,
                amountRaw: args.shortfall,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'Claimed': {
              const args = decoded.args;
              await tx.query(
                `INSERT INTO claims (
                  recipient, amount, block_number, block_hash, tx_hash, log_index, block_timestamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (block_number, log_index) DO UPDATE SET
                  recipient = EXCLUDED.recipient,
                  amount = EXCLUDED.amount,
                  block_hash = EXCLUDED.block_hash`,
                [
                  getAddress(args.recipient),
                  args.amount.toString(),
                  bn.toString(),
                  blockHash.toLowerCase(),
                  txHash.toLowerCase(),
                  logIndex,
                  block.timestamp.toString(),
                ]
              );
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'Claimed',
                actor: args.recipient,
                amountRaw: args.amount,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
          }
        } else if (source === config.orderSettlement) {
          let decoded;
          try {
            decoded = decodeEventLog({ abi: orderSettlementAbi, data: log.data, topics: log.topics });
          } catch {
            continue;
          }
          eventsIndexed++;

          switch (decoded.eventName) {
            case 'OrderFilled': {
              const args = decoded.args;
              const txMeta = await resolveOrderMetaFromTx(publicClient, txHash, orderTxCache);
              const existing = dirtyOrders.get(args.orderHash);
              dirtyOrders.set(args.orderHash, {
                maker: normalizeAddress(args.maker),
                minUsdc: txMeta?.minUsdc ?? existing?.minUsdc,
                collateralToken: txMeta?.collateralToken ?? existing?.collateralToken,
                orderType: txMeta?.orderType ?? existing?.orderType,
              });
              await tx.query(
                `INSERT INTO order_fills (
                  order_hash, maker, taker, loan_id, fill_amount_usdc, collateral_amount,
                  block_number, block_hash, tx_hash, log_index, block_timestamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (block_number, log_index) DO UPDATE SET
                  order_hash = EXCLUDED.order_hash,
                  fill_amount_usdc = EXCLUDED.fill_amount_usdc`,
                [
                  args.orderHash.toLowerCase(),
                  getAddress(args.maker),
                  getAddress(args.taker),
                  args.loanId.toString(),
                  args.fillAmountUsdc.toString(),
                  args.collateralAmount.toString(),
                  bn.toString(),
                  blockHash.toLowerCase(),
                  txHash.toLowerCase(),
                  logIndex,
                  block.timestamp.toString(),
                ]
              );
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'OrderFilled',
                loanId: args.loanId,
                token: txMeta?.collateralToken ?? null,
                actor: args.maker,
                counterparty: args.taker,
                amountRaw: args.fillAmountUsdc,
                secondaryAmount: args.collateralAmount,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'OrderCancelled': {
              const args = decoded.args;
              const txMeta = await resolveOrderMetaFromTx(publicClient, txHash, orderTxCache);
              const existing = dirtyOrders.get(args.orderHash);
              dirtyOrders.set(args.orderHash, {
                maker: normalizeAddress(args.maker),
                minUsdc: txMeta?.minUsdc ?? existing?.minUsdc,
                collateralToken: txMeta?.collateralToken ?? existing?.collateralToken,
                orderType: txMeta?.orderType ?? existing?.orderType,
              });
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'OrderCancelled',
                token: txMeta?.collateralToken ?? null,
                actor: args.maker,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'NonceBumped': {
              const args = decoded.args;
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'NonceBumped',
                actor: args.maker,
                amountRaw: args.newNonce,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
          }
        } else if (source === config.liquidationAuction) {
          let decoded;
          try {
            decoded = decodeEventLog({ abi: liquidationAuctionAbi, data: log.data, topics: log.topics });
          } catch {
            continue;
          }
          eventsIndexed++;

          switch (decoded.eventName) {
            case 'AuctionStarted': {
              const args = decoded.args;
              dirtyAuctions.add(args.auctionId);
              if (!dirtyLoans.has(args.loanId)) dirtyLoans.set(args.loanId, undefined);
              dirtyAssets.add(normalizeAddress(args.collateralToken));
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'AuctionStarted',
                loanId: args.loanId,
                token: args.collateralToken,
                actor: args.borrower,
                amountRaw: args.collateralAmount,
                secondaryAmount: args.startPrice,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'AuctionBought': {
              const args = decoded.args;
              dirtyAuctions.add(args.auctionId);
              const existingAuction = await tx.query<{ loan_id: string; collateral_token: string }>(
                'SELECT loan_id::TEXT AS loan_id, collateral_token FROM auctions WHERE auction_id = $1',
                [args.auctionId.toString()]
              );
              const loanIdForEvent =
                existingAuction.rows.length > 0 ? toBigInt(existingAuction.rows[0].loan_id) : null;
              if (loanIdForEvent !== null && !dirtyLoans.has(loanIdForEvent)) {
                dirtyLoans.set(loanIdForEvent, undefined);
              }
              if (existingAuction.rows.length > 0) {
                dirtyAssets.add(normalizeAddress(existingAuction.rows[0].collateral_token));
              }

              await tx.query(
                `INSERT INTO auction_buys (
                  auction_id, buyer, collateral_purchased, usdc_paid, clearing_price,
                  block_number, block_hash, tx_hash, log_index, block_timestamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (block_number, log_index) DO UPDATE SET
                  collateral_purchased = EXCLUDED.collateral_purchased,
                  usdc_paid = EXCLUDED.usdc_paid`,
                [
                  args.auctionId.toString(),
                  getAddress(args.buyer),
                  args.collateralPurchased.toString(),
                  args.usdcPaid.toString(),
                  args.clearingPrice.toString(),
                  bn.toString(),
                  blockHash.toLowerCase(),
                  txHash.toLowerCase(),
                  logIndex,
                  block.timestamp.toString(),
                ]
              );
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'AuctionBought',
                loanId: loanIdForEvent,
                actor: args.buyer,
                amountRaw: args.collateralPurchased,
                secondaryAmount: args.usdcPaid,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'AuctionSettled': {
              const args = decoded.args;
              dirtyAuctions.add(args.auctionId);
              const existingAuction = await tx.query<{ loan_id: string; collateral_token: string }>(
                'SELECT loan_id::TEXT AS loan_id, collateral_token FROM auctions WHERE auction_id = $1',
                [args.auctionId.toString()]
              );
              const loanIdForEvent =
                existingAuction.rows.length > 0 ? toBigInt(existingAuction.rows[0].loan_id) : null;
              if (loanIdForEvent !== null && !dirtyLoans.has(loanIdForEvent)) {
                dirtyLoans.set(loanIdForEvent, undefined);
              }
              if (existingAuction.rows.length > 0) {
                dirtyAssets.add(normalizeAddress(existingAuction.rows[0].collateral_token));
              }

              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'AuctionSettled',
                loanId: loanIdForEvent,
                amountRaw: args.totalUsdcCollected,
                secondaryAmount: args.debtPaid,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'AuctionCancelled': {
              const args = decoded.args;
              dirtyAuctions.add(args.auctionId);
              if (!dirtyLoans.has(args.loanId)) dirtyLoans.set(args.loanId, undefined);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'AuctionCancelled',
                loanId: args.loanId,
                amountRaw: args.auctionId,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'AuctionRestarted': {
              const args = decoded.args;
              dirtyAuctions.add(args.auctionId);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'AuctionRestarted',
                amountRaw: args.newStartPrice,
                secondaryAmount: args.newFloorPrice,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
          }
        } else if (source === config.positionNft) {
          let decoded;
          try {
            decoded = decodeEventLog({ abi: positionNftAbi, data: log.data, topics: log.topics });
          } catch {
            continue;
          }
          eventsIndexed++;

          switch (decoded.eventName) {
            case 'Transfer': {
              const args = decoded.args;
              dirtyPositions.add(args.tokenId);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'PositionTransfer',
                loanId: args.tokenId,
                actor: args.from,
                counterparty: args.to,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'LoanClaimMinted': {
              const args = decoded.args;
              dirtyPositions.add(args.loanId);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'LoanClaimMinted',
                loanId: args.loanId,
                actor: args.to,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'LoanClaimBurned': {
              const args = decoded.args;
              dirtyPositions.add(args.loanId);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'LoanClaimBurned',
                loanId: args.loanId,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
            case 'LoanAuctionLocked': {
              const args = decoded.args;
              dirtyPositions.add(args.loanId);
              await insertLoanEvent(tx, {
                blockNumber: bn,
                blockHash,
                txHash,
                logIndex,
                contractAddress: source,
                eventName: 'LoanAuctionLocked',
                loanId: args.loanId,
                payload: args,
                blockTimestamp: block.timestamp,
              });
              break;
            }
          }
        } else if (source === config.assetRegistry) {
          let decoded;
          try {
            decoded = decodeEventLog({ abi: assetRegistryAbi, data: log.data, topics: log.topics });
          } catch {
            continue;
          }
          eventsIndexed++;

          if (decoded.eventName === 'AssetConfigSet') {
            const tokenAddr = normalizeAddress(decoded.args.token);
            effectiveTrackedAssets.add(tokenAddr);
            dirtyAssets.add(tokenAddr);
            await insertLoanEvent(tx, {
              blockNumber: bn,
              blockHash,
              txHash,
              logIndex,
              contractAddress: source,
              eventName: 'AssetConfigSet',
              token: tokenAddr,
              payload: decoded.args,
              blockTimestamp: block.timestamp,
            });
          } else if (decoded.eventName === 'AssetStatusSet') {
            const tokenAddr = normalizeAddress(decoded.args.token);
            dirtyAssets.add(tokenAddr);
            await insertLoanEvent(tx, {
              blockNumber: bn,
              blockHash,
              txHash,
              logIndex,
              contractAddress: source,
              eventName: 'AssetStatusSet',
              token: tokenAddr,
              amountRaw: BigInt(decoded.args.status),
              payload: decoded.args,
              blockTimestamp: block.timestamp,
            });
          }
        } else if (source === config.oracleRouter) {
          let decoded;
          try {
            decoded = decodeEventLog({ abi: oracleRouterAbi, data: log.data, topics: log.topics });
          } catch {
            continue;
          }
          eventsIndexed++;

          if (decoded.eventName === 'MultiplierSynced') {
            const tokenAddr = normalizeAddress(decoded.args.token);
            dirtyAssets.add(tokenAddr);
            await insertLoanEvent(tx, {
              blockNumber: bn,
              blockHash,
              txHash,
              logIndex,
              contractAddress: source,
              eventName: 'MultiplierSynced',
              token: tokenAddr,
              amountRaw: decoded.args.multiplier,
              payload: decoded.args,
              blockTimestamp: block.timestamp,
            });
          }
        } else if (effectiveTrackedAssets.has(source)) {
          let decoded;
          try {
            decoded = decodeEventLog({ abi: b20Erc20Abi, data: log.data, topics: log.topics });
          } catch {
            continue;
          }
          if (decoded.eventName !== 'Transfer') continue;
          const from = normalizeAddress(decoded.args.from);
          const to = normalizeAddress(decoded.args.to);
          if (from !== config.collateralEscrow && to !== config.collateralEscrow) continue;

          eventsIndexed++;
          dirtyAssets.add(source);
          await insertLoanEvent(tx, {
            blockNumber: bn,
            blockHash,
            txHash,
            logIndex,
            contractAddress: source,
            eventName: to === config.collateralEscrow ? 'EscrowTransferIn' : 'EscrowTransferOut',
            token: source,
            actor: from,
            counterparty: to,
            amountRaw: decoded.args.value,
            payload: decoded.args,
            blockTimestamp: block.timestamp,
          });
        }
      }

      // Reconcile dirty entities with on-chain contract state inside the same transaction
      for (const [loanId, lenderHint] of dirtyLoans.entries()) {
        await reconcileLoan(publicClient, tx, config, loanId, bn, lenderHint);
      }
      for (const auctionId of dirtyAuctions) {
        await reconcileAuction(publicClient, tx, config, auctionId, bn);
      }
      for (const loanId of dirtyPositions) {
        await reconcilePosition(publicClient, tx, config, loanId, bn);
      }
      for (const [orderHash, orderMeta] of dirtyOrders.entries()) {
        await reconcileOrder(publicClient, tx, config, orderHash, orderMeta, bn);
      }
      for (const token of dirtyAssets) {
        await reconcileAsset(publicClient, tx, config, token, bn);
      }

      await tx.query(
        `INSERT INTO indexer_state (id, last_indexed_block, chain_id, updated_at)
         VALUES (1, $1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET
           last_indexed_block = EXCLUDED.last_indexed_block,
           updated_at = NOW()`,
        [bn.toString(), publicClient.chain.id]
      );
      });
    };

    try {
      await commitBlockTx();
    } catch (txErr) {
      if (isConnectionDropError(txErr)) {
        console.warn(
          `[INDEXER_DB_TX_RETRY] Block ${bn} transaction interrupted by connection drop; retrying once...`
        );
        await commitBlockTx();
      } else {
        throw txErr;
      }
    }

    for (const token of newlyDiscoveredTokens) {
      ctx.trackedAssets.add(token);
    }
    blocksProcessed++;
  }

  await pruneOldIndexedBlocks(db, chainHead);
  ctx.consecutiveBlockHashAborts = 0;

  return {
    reorgDetected: reorgResult.reorgDetected,
    rolledBackToBlock: reorgResult.rolledBackToBlock,
    consecutiveBlockHashAborts: 0,
    fromBlock,
    toBlock,
    blocksProcessed,
    eventsIndexed,
  };
}
