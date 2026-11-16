import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Address, type Chain, type PublicClient, type Transport, createPublicClient, defineChain, getAddress, http as viemHttp } from 'viem';
import { base } from 'viem/chains';
import { ZodError } from 'zod/v3';
import {
  ASSET_STATUS_NAMES,
  AUCTION_STATUS_NAMES,
  LOAN_STATUS_NAMES,
  ORACLE_STATE_NAMES,
  OracleState,
  assetRegistryAbi,
  erc20MetaAbi,
  feeCollectorAbi,
  loanCoreAbi,
  oracleRouterAbi,
} from './abi.js';
import type { ApiConfig } from './config.js';
import { type ReadOnlyDatabase, openReadOnlyDatabase, toBigInt } from './db.js';
import { formatAmount, formatRawString } from './format.js';
import { RpcUnavailableError, computeLoanQuote } from './quote.js';
import {
  assetsQuerySchema,
  auctionsQuerySchema,
  buildPaginationSchema,
  loansQuerySchema,
  ordersQuerySchema,
  positionsQuerySchema,
  quoteRequestSchema,
} from './validation.js';

const USDC_DECIMALS = 6;
const RATE_DECIMALS = 18;
const FEED_DECIMALS_DEFAULT = 8;

interface AssetLiveSnapshot {
  livePrice: bigint;
  livePriceDec: number;
  oracleState: number;
  assetOutstanding: bigint;
  liveRecMult: bigint;
  liveUiMult: bigint | null;
  livePerLoanCap: bigint | null;
  liveAssetCap: bigint | null;
  liveStatus: number | null;
}

interface ProtocolFeesSnapshot {
  origination_fee_bps: number;
  max_origination_bps: number;
  interest_cut_bps: number;
  max_interest_cut_bps: number;
  liquidation_fee_bps: number;
  max_liquidation_bps: number;
  safety_reserve_share_bps: number;
}

interface AssetsBlockCacheEntry {
  blockNumber: bigint;
  globalCap: bigint;
  totalOutstanding: bigint;
  fees: ProtocolFeesSnapshot;
  perAsset: Map<string, AssetLiveSnapshot>;
}

export interface ApiContext {
  config: ApiConfig;
  publicClient: PublicClient<Transport, Chain>;
  db: ReadOnlyDatabase;
  assetBlockCache?: AssetsBlockCacheEntry;
}

class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

interface RateBucket {
  count: number;
  resetAtMs: number;
}

class IpRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxBuckets: number;
  private readonly evictionTimer: NodeJS.Timeout;

  constructor(maxRequests: number, windowMs: number, maxBuckets: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxBuckets = maxBuckets;
    const sweepIntervalMs = Math.max(1000, Math.min(windowMs, 60_000));
    this.evictionTimer = setInterval(() => {
      this.evictExpired();
    }, sweepIntervalMs);
    this.evictionTimer.unref();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, b] of this.buckets.entries()) {
      if (b.resetAtMs <= now) {
        this.buckets.delete(k);
      }
    }
  }

  check(ip: string): { allowed: boolean; remaining: number; resetEpochSec: number; retryAfterSec: number } {
    const now = Date.now();
    let bucket = this.buckets.get(ip);
    if (bucket && bucket.resetAtMs <= now) {
      this.buckets.delete(ip);
      bucket = undefined;
    }

    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        this.evictExpired();
      }
      if (this.buckets.size >= this.maxBuckets) {
        return {
          allowed: false,
          remaining: 0,
          resetEpochSec: Math.ceil((now + this.windowMs) / 1000),
          retryAfterSec: Math.max(1, Math.ceil(this.windowMs / 1000)),
        };
      }
      bucket = { count: 0, resetAtMs: now + this.windowMs };
      this.buckets.set(ip, bucket);
    }

    bucket.count += 1;
    const allowed = bucket.count <= this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - bucket.count);
    const resetEpochSec = Math.ceil(bucket.resetAtMs / 1000);
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000));
    return { allowed, remaining, resetEpochSec, retryAfterSec };
  }

  close(): void {
    clearInterval(this.evictionTimer);
  }
}

export function resolveClientIp(req: IncomingMessage, trustProxyHops: number): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (trustProxyHops <= 0) {
    return remote;
  }
  const xff = req.headers['x-forwarded-for'];
  const headerStr = Array.isArray(xff) ? xff.join(',') : xff;
  if (!headerStr || headerStr.trim().length === 0) {
    return remote;
  }
  const ips = headerStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ips.length === 0) {
    return remote;
  }
  const idx = ips.length >= trustProxyHops ? ips.length - trustProxyHops : 0;
  return ips[idx];
}

function validateChainId(chainId: number, config: Pick<ApiConfig, 'isFork' | 'forkChainId'>): void {
  if (!config.isFork && chainId !== 8453) {
    throw new Error(
      `Invalid chainId ${chainId}: expected Base Mainnet (8453). Set FORK=true and FORK_CHAIN_ID=${chainId} for forks.`
    );
  }
  if (config.isFork && chainId !== config.forkChainId) {
    throw new Error(`Invalid fork chainId ${chainId}: expected FORK_CHAIN_ID=${config.forkChainId}.`);
  }
}

export async function createApiContext(
  config: ApiConfig,
  dbOverride?: ReadOnlyDatabase
): Promise<ApiContext> {
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
  return { config, publicClient, db };
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): void {
  const reqOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (allowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (reqOrigin && allowedOrigins.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

/**
 * Rejects unquoted JSON numeric literals above Number.MAX_SAFE_INTEGER before JSON.parse
 * so values like 1e21 or 9007199254740993 are never silently rounded or coerced into 500s.
 */
export function assertSafeJsonNumbers(rawJson: string): void {
  const withoutStrings = rawJson.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const numMatches = withoutStrings.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
  for (const token of numMatches) {
    if (/[eE.]/.test(token)) {
      const parsed = Number(token);
      if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          'JSON numeric value exceeds Number.MAX_SAFE_INTEGER; encode large numbers as decimal strings'
        );
      }
      continue;
    }
    try {
      const asBig = BigInt(token);
      if (asBig > BigInt(Number.MAX_SAFE_INTEGER) || asBig < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          'JSON integer exceeds Number.MAX_SAFE_INTEGER; encode large numbers as decimal strings'
        );
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid JSON numeric literal');
    }
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLengthHeader = req.headers['content-length'];
  if (contentLengthHeader !== undefined) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      throw new HttpError(
        413,
        'PAYLOAD_TOO_LARGE',
        `Request body exceeds maximum allowed size of ${maxBytes} bytes`
      );
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        req.destroy();
        reject(
          new HttpError(
            413,
            'PAYLOAD_TOO_LARGE',
            `Request body exceeds maximum allowed size of ${maxBytes} bytes`
          )
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        reject(new HttpError(400, 'EMPTY_BODY', 'JSON request body cannot be empty'));
        return;
      }
      try {
        assertSafeJsonNumbers(raw);
        resolve(JSON.parse(raw));
      } catch (err) {
        if (err instanceof HttpError) {
          reject(err);
        } else {
          reject(new HttpError(400, 'INVALID_JSON', 'Malformed JSON request body'));
        }
      }
    });

    req.on('error', () => {
      if (settled) return;
      settled = true;
      reject(new HttpError(400, 'REQUEST_READ_ERROR', 'Failed while reading request stream'));
    });
  });
}

function urlSearchParamsToObject(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of sp.entries()) {
    out[key] = value;
  }
  return out;
}

function parseOrThrow<T>(
  schema: { safeParse: (d: unknown) => { success: true; data: T } | { success: false; error: ZodError } },
  data: unknown
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      field: i.path.join('.') || 'request',
      message: i.message,
    }));
    throw new HttpError(400, 'VALIDATION_ERROR', issues[0]?.message ?? 'Invalid request parameters', issues);
  }
  return result.data;
}

interface SnapshotMeta {
  block_number: string;
  indexed_at: string | null;
  block_timestamp: string | null;
  freshness_timestamp: string;
}

async function getSnapshotMeta(ctx: ApiContext): Promise<SnapshotMeta> {
  const freshnessTimestamp = new Date().toISOString();
  const stateRes = await ctx.db.query<{ last_indexed_block: string; updated_at: unknown }>(
    'SELECT last_indexed_block::TEXT AS last_indexed_block, updated_at FROM indexer_state WHERE id = 1'
  );
  if (stateRes.rows.length === 0) {
    return {
      block_number: '0',
      indexed_at: null,
      block_timestamp: null,
      freshness_timestamp: freshnessTimestamp,
    };
  }

  const lastBlock = stateRes.rows[0].last_indexed_block;
  const rawUpdated = stateRes.rows[0].updated_at;
  const indexedAt =
    rawUpdated instanceof Date
      ? rawUpdated.toISOString()
      : rawUpdated !== null && rawUpdated !== undefined
        ? new Date(String(rawUpdated)).toISOString()
        : null;

  const blkRes = await ctx.db.query<{ block_timestamp: string }>(
    'SELECT block_timestamp::TEXT AS block_timestamp FROM indexed_blocks WHERE block_number = $1',
    [lastBlock]
  );

  return {
    block_number: lastBlock,
    indexed_at: indexedAt,
    block_timestamp: blkRes.rows[0]?.block_timestamp ?? null,
    freshness_timestamp: freshnessTimestamp,
  };
}

function buildPaginationEnvelope(limit: number, offset: number, returned: number, total: number) {
  const nextOffset = offset + returned < total ? offset + returned : null;
  return {
    limit,
    offset,
    cursor: String(offset),
    next_cursor: nextOffset !== null ? String(nextOffset) : null,
    has_more: nextOffset !== null,
    total,
  };
}

async function handleHealth(ctx: ApiContext) {
  const freshnessTimestamp = new Date().toISOString();
  let dbOk = false;
  let lastIndexedBlock: string | null = null;
  let indexedAt: string | null = null;
  let blockTimestamp: string | null = null;
  let chainId: number | null = null;

  try {
    await ctx.db.query('SELECT 1 AS ok');
    dbOk = true;
    const stateRes = await ctx.db.query<{ last_indexed_block: string; chain_id: number; updated_at: unknown }>(
      'SELECT last_indexed_block::TEXT AS last_indexed_block, chain_id, updated_at FROM indexer_state WHERE id = 1'
    );
    if (stateRes.rows.length > 0) {
      lastIndexedBlock = stateRes.rows[0].last_indexed_block;
      chainId = Number(stateRes.rows[0].chain_id);
      const rawUpdated = stateRes.rows[0].updated_at;
      indexedAt =
        rawUpdated instanceof Date
          ? rawUpdated.toISOString()
          : rawUpdated !== null && rawUpdated !== undefined
            ? new Date(String(rawUpdated)).toISOString()
            : null;
      const blkRes = await ctx.db.query<{ block_timestamp: string }>(
        'SELECT block_timestamp::TEXT AS block_timestamp FROM indexed_blocks WHERE block_number = $1',
        [lastIndexedBlock]
      );
      blockTimestamp = blkRes.rows[0]?.block_timestamp ?? null;
    }
  } catch {
    dbOk = false;
  }

  let rpcOk = false;
  let chainHeadBlock: string | null = null;
  try {
    const head = await ctx.publicClient.getBlockNumber();
    chainHeadBlock = head.toString();
    rpcOk = true;
  } catch {
    rpcOk = false;
  }

  let lagBlocks: string | null = null;
  let withinLagThreshold = false;
  if (lastIndexedBlock !== null && chainHeadBlock !== null) {
    const li = BigInt(lastIndexedBlock);
    const ch = BigInt(chainHeadBlock);
    const lag = ch >= li ? ch - li : 0n;
    lagBlocks = lag.toString();
    withinLagThreshold = lag <= BigInt(ctx.config.maxHealthyLagBlocks);
  }

  const healthy = dbOk && rpcOk;
  return {
    statusCode: healthy ? 200 : 503,
    body: {
      status: healthy ? (withinLagThreshold ? 'ok' : 'degraded') : 'unhealthy',
      db_ok: dbOk,
      rpc_ok: rpcOk,
      chain_id: chainId ?? ctx.publicClient.chain.id,
      block_number: lastIndexedBlock ?? '0',
      last_indexed_block: lastIndexedBlock,
      chain_head_block: chainHeadBlock,
      lag_blocks: lagBlocks,
      max_healthy_lag_blocks: ctx.config.maxHealthyLagBlocks,
      within_lag_threshold: withinLagThreshold,
      indexed_at: indexedAt,
      block_timestamp: blockTimestamp,
      freshness_timestamp: freshnessTimestamp,
    },
  };
}

async function handleOrders(ctx: ApiContext, queryObj: Record<string, string>) {
  const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
  const filters = parseOrThrow(ordersQuerySchema, queryObj);
  const meta = await getSnapshotMeta(ctx);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status === 'cancelled') {
    conditions.push('o.cancelled = TRUE');
  } else if (filters.status === 'partially_filled') {
    conditions.push('o.cancelled = FALSE AND o.filled_usdc > 0 AND o.min_usdc > 0 AND o.filled_usdc < o.min_usdc');
  } else if (filters.status === 'filled') {
    conditions.push(
      'o.cancelled = FALSE AND o.filled_usdc > 0 AND o.min_usdc > 0 AND o.filled_usdc >= o.min_usdc'
    );
  } else if (filters.status === 'unknown') {
    conditions.push('o.cancelled = FALSE AND o.min_usdc = 0');
  }

  if (filters.maker) {
    params.push(filters.maker);
    conditions.push(`LOWER(o.maker) = LOWER($${params.length})`);
  }

  if (filters.asset) {
    params.push(filters.asset);
    conditions.push(
      `(
        LOWER(o.collateral_token) = LOWER($${params.length})
        OR EXISTS (
          SELECT 1
          FROM order_fills ofi
          JOIN loans l ON l.loan_id = ofi.loan_id
          WHERE ofi.order_hash = o.order_hash
            AND LOWER(l.collateral_token) = LOWER($${params.length})
        )
      )`
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRes = await ctx.db.query<{ cnt: number }>(
    `SELECT COUNT(*)::INT AS cnt FROM orders o ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  const dataParams = [...params, pag.limit, pag.offset];
  const rowsRes = await ctx.db.query<{
    order_hash: string;
    maker: string;
    collateral_token: string | null;
    collateral_symbol: string | null;
    min_usdc: string;
    filled_usdc: string;
    order_type: string;
    cancelled: boolean;
    maker_nonce: string;
    first_seen_block: string;
    last_updated_block: string;
    fills_count: number;
  }>(
    `SELECT
       o.order_hash,
       o.maker,
       o.collateral_token,
       a.symbol AS collateral_symbol,
       o.min_usdc::TEXT AS min_usdc,
       o.filled_usdc::TEXT AS filled_usdc,
       o.order_type,
       o.cancelled,
       o.maker_nonce::TEXT AS maker_nonce,
       o.first_seen_block::TEXT AS first_seen_block,
       o.last_updated_block::TEXT AS last_updated_block,
       (SELECT COUNT(*)::INT FROM order_fills ofi WHERE ofi.order_hash = o.order_hash) AS fills_count
     FROM orders o
     LEFT JOIN assets a ON LOWER(a.token) = LOWER(o.collateral_token)
     ${whereClause}
     ORDER BY o.last_updated_block DESC, o.order_hash ASC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  const hashes = rowsRes.rows.map((r) => r.order_hash);
  const fillsByOrder = new Map<
    string,
    Array<{
      loan_id: string;
      collateral_token: string | null;
      collateral_symbol: string | null;
      fill_amount_usdc: ReturnType<typeof formatAmount>;
      collateral_amount: ReturnType<typeof formatAmount>;
      taker: string;
      block_number: string;
      tx_hash: string;
    }>
  >();

  if (hashes.length > 0) {
    const placeholders = hashes.map((_, idx) => `$${idx + 1}`).join(', ');
    const fillsRes = await ctx.db.query<{
      order_hash: string;
      loan_id: string;
      taker: string;
      fill_amount_usdc: string;
      collateral_amount: string;
      block_number: string;
      tx_hash: string;
      collateral_token: string | null;
      symbol: string | null;
      decimals: number | null;
    }>(
      `SELECT
         ofi.order_hash,
         ofi.loan_id::TEXT AS loan_id,
         ofi.taker,
         ofi.fill_amount_usdc::TEXT AS fill_amount_usdc,
         ofi.collateral_amount::TEXT AS collateral_amount,
         ofi.block_number::TEXT AS block_number,
         ofi.tx_hash,
         l.collateral_token,
         a.symbol,
         a.decimals
       FROM order_fills ofi
       LEFT JOIN loans l ON l.loan_id = ofi.loan_id
       LEFT JOIN assets a ON LOWER(a.token) = LOWER(l.collateral_token)
       WHERE ofi.order_hash IN (${placeholders})
       ORDER BY ofi.block_number ASC, ofi.log_index ASC`,
      hashes
    );
    for (const f of fillsRes.rows) {
      const colDecimals = f.decimals !== null ? Number(f.decimals) : 18;
      const arr = fillsByOrder.get(f.order_hash) ?? [];
      arr.push({
        loan_id: f.loan_id,
        collateral_token: f.collateral_token,
        collateral_symbol: f.symbol,
        fill_amount_usdc: formatRawString(f.fill_amount_usdc, USDC_DECIMALS, 'USDC'),
        collateral_amount: formatRawString(f.collateral_amount, colDecimals, f.symbol ?? undefined),
        taker: f.taker,
        block_number: f.block_number,
        tx_hash: f.tx_hash,
      });
      fillsByOrder.set(f.order_hash, arr);
    }
  }

  const data = rowsRes.rows.map((r) => {
    const filled = BigInt(r.filled_usdc);
    const minUsdc = BigInt(r.min_usdc);
    const remaining = minUsdc > filled ? minUsdc - filled : 0n;
    const derivedStatus = r.cancelled
      ? 'cancelled'
      : minUsdc === 0n
        ? 'unknown'
        : filled < minUsdc
          ? 'partially_filled'
          : 'filled';
    return {
      order_hash: r.order_hash,
      maker: getAddress(r.maker),
      order_type: r.order_type,
      collateral_token: r.collateral_token ? getAddress(r.collateral_token) : null,
      collateral_symbol: r.collateral_symbol,
      status: derivedStatus,
      min_usdc: formatAmount(minUsdc, USDC_DECIMALS, 'USDC'),
      filled_usdc: formatAmount(filled, USDC_DECIMALS, 'USDC'),
      remaining_usdc: minUsdc > 0n ? formatAmount(remaining, USDC_DECIMALS, 'USDC') : null,
      cancelled: r.cancelled,
      maker_nonce: r.maker_nonce,
      fills_count: Number(r.fills_count),
      fills: fillsByOrder.get(r.order_hash) ?? [],
      first_seen_block: r.first_seen_block,
      last_updated_block: r.last_updated_block,
    };
  });

  return {
    statusCode: 200,
    body: {
      ...meta,
      pagination: buildPaginationEnvelope(pag.limit, pag.offset, data.length, total),
      data,
    },
  };
}

async function handleLoans(ctx: ApiContext, queryObj: Record<string, string>) {
  const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
  const filters = parseOrThrow(loansQuerySchema, queryObj);
  const meta = await getSnapshotMeta(ctx);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.borrower) {
    params.push(filters.borrower);
    conditions.push(`LOWER(l.borrower) = LOWER($${params.length})`);
  }
  if (filters.lender) {
    params.push(filters.lender);
    conditions.push(`LOWER(l.lender) = LOWER($${params.length})`);
  }
  if (filters.status !== undefined) {
    params.push(filters.status);
    conditions.push(`l.status = $${params.length}`);
  }
  if (filters.asset) {
    params.push(filters.asset);
    conditions.push(`LOWER(l.collateral_token) = LOWER($${params.length})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRes = await ctx.db.query<{ cnt: number }>(
    `SELECT COUNT(*)::INT AS cnt FROM loans l ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  const dataParams = [...params, pag.limit, pag.offset];
  const rowsRes = await ctx.db.query<{
    loan_id: string;
    borrower: string;
    lender: string | null;
    collateral_token: string;
    symbol: string | null;
    decimals: number | null;
    collateral_raw: string;
    principal: string;
    start_time: string;
    maturity: string;
    rate_bps: number;
    penalty_spread_bps: number;
    init_ltv_bps: number;
    margin_call_ltv_bps: number;
    liq_ltv_bps: number;
    min_interest_days: number;
    status: number;
    yield_mode: number;
    core_version: number;
    interest_paid: string;
    principal_repaid: string;
    active_auction_id: string;
    bad_debt_shortfall: string;
    opened_block: string;
    last_updated_block: string;
  }>(
    `SELECT
       l.loan_id::TEXT AS loan_id,
       l.borrower,
       l.lender,
       l.collateral_token,
       a.symbol,
       a.decimals,
       l.collateral_raw::TEXT AS collateral_raw,
       l.principal::TEXT AS principal,
       l.start_time::TEXT AS start_time,
       l.maturity::TEXT AS maturity,
       l.rate_bps,
       l.penalty_spread_bps,
       l.init_ltv_bps,
       l.margin_call_ltv_bps,
       l.liq_ltv_bps,
       l.min_interest_days,
       l.status,
       l.yield_mode,
       l.core_version,
       l.interest_paid::TEXT AS interest_paid,
       l.principal_repaid::TEXT AS principal_repaid,
       l.active_auction_id::TEXT AS active_auction_id,
       l.bad_debt_shortfall::TEXT AS bad_debt_shortfall,
       l.opened_block::TEXT AS opened_block,
       l.last_updated_block::TEXT AS last_updated_block
     FROM loans l
     LEFT JOIN assets a ON LOWER(a.token) = LOWER(l.collateral_token)
     ${whereClause}
     ORDER BY l.loan_id ASC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  const data = rowsRes.rows.map((r) => {
    const colDecimals = r.decimals !== null ? Number(r.decimals) : 18;
    const statusNum = Number(r.status);
    return {
      loan_id: r.loan_id,
      borrower: getAddress(r.borrower),
      lender: r.lender ? getAddress(r.lender) : null,
      collateral_token: getAddress(r.collateral_token),
      collateral_amount: formatRawString(r.collateral_raw, colDecimals, r.symbol ?? undefined),
      principal: formatRawString(r.principal, USDC_DECIMALS, 'USDC'),
      principal_repaid: formatRawString(r.principal_repaid, USDC_DECIMALS, 'USDC'),
      interest_paid: formatRawString(r.interest_paid, USDC_DECIMALS, 'USDC'),
      bad_debt_shortfall: formatRawString(r.bad_debt_shortfall, USDC_DECIMALS, 'USDC'),
      start_time: r.start_time,
      maturity: r.maturity,
      rate_bps: Number(r.rate_bps),
      penalty_spread_bps: Number(r.penalty_spread_bps),
      init_ltv_bps: Number(r.init_ltv_bps),
      margin_call_ltv_bps: Number(r.margin_call_ltv_bps),
      liq_ltv_bps: Number(r.liq_ltv_bps),
      min_interest_days: Number(r.min_interest_days),
      status: statusNum,
      status_name: LOAN_STATUS_NAMES[statusNum] ?? `UNKNOWN(${statusNum})`,
      yield_mode: Number(r.yield_mode),
      core_version: Number(r.core_version),
      active_auction_id: r.active_auction_id,
      opened_block: r.opened_block,
      last_updated_block: r.last_updated_block,
    };
  });

  return {
    statusCode: 200,
    body: {
      ...meta,
      pagination: buildPaginationEnvelope(pag.limit, pag.offset, data.length, total),
      data,
    },
  };
}

async function handlePositions(ctx: ApiContext, queryObj: Record<string, string>) {
  const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
  const filters = parseOrThrow(positionsQuerySchema, queryObj);
  const meta = await getSnapshotMeta(ctx);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.owner) {
    params.push(filters.owner);
    conditions.push(`LOWER(p.owner) = LOWER($${params.length})`);
  }
  if (filters.auction_locked !== undefined) {
    params.push(filters.auction_locked);
    conditions.push(`p.auction_locked = $${params.length}`);
  }
  if (filters.burned !== undefined) {
    params.push(filters.burned);
    conditions.push(`p.is_burned = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRes = await ctx.db.query<{ cnt: number }>(
    `SELECT COUNT(*)::INT AS cnt FROM positions p ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  const dataParams = [...params, pag.limit, pag.offset];
  const rowsRes = await ctx.db.query<{
    loan_id: string;
    owner: string;
    auction_locked: boolean;
    is_burned: boolean;
    minted_block: string;
    last_updated_block: string;
    collateral_token: string | null;
    principal: string | null;
    loan_status: number | null;
    symbol: string | null;
  }>(
    `SELECT
       p.loan_id::TEXT AS loan_id,
       p.owner,
       p.auction_locked,
       p.is_burned,
       p.minted_block::TEXT AS minted_block,
       p.last_updated_block::TEXT AS last_updated_block,
       l.collateral_token,
       l.principal::TEXT AS principal,
       l.status AS loan_status,
       a.symbol
     FROM positions p
     LEFT JOIN loans l ON l.loan_id = p.loan_id
     LEFT JOIN assets a ON LOWER(a.token) = LOWER(l.collateral_token)
     ${whereClause}
     ORDER BY p.loan_id ASC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  const data = rowsRes.rows.map((r) => ({
    loan_id: r.loan_id,
    owner: getAddress(r.owner),
    auction_locked: r.auction_locked,
    is_burned: r.is_burned,
    collateral_token: r.collateral_token ? getAddress(r.collateral_token) : null,
    collateral_symbol: r.symbol,
    principal: r.principal !== null ? formatRawString(r.principal, USDC_DECIMALS, 'USDC') : null,
    loan_status: r.loan_status !== null ? Number(r.loan_status) : null,
    loan_status_name:
      r.loan_status !== null ? (LOAN_STATUS_NAMES[Number(r.loan_status)] ?? 'UNKNOWN') : null,
    minted_block: r.minted_block,
    last_updated_block: r.last_updated_block,
  }));

  return {
    statusCode: 200,
    body: {
      ...meta,
      pagination: buildPaginationEnvelope(pag.limit, pag.offset, data.length, total),
      data,
    },
  };
}

async function handleAuctions(ctx: ApiContext, queryObj: Record<string, string>) {
  const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
  const filters = parseOrThrow(auctionsQuerySchema, queryObj);
  const meta = await getSnapshotMeta(ctx);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status !== undefined) {
    params.push(filters.status);
    conditions.push(`a.status = $${params.length}`);
  }
  const loanFilter = filters.loan ?? filters.loan_id;
  if (loanFilter !== undefined) {
    params.push(loanFilter);
    conditions.push(`a.loan_id = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRes = await ctx.db.query<{ cnt: number }>(
    `SELECT COUNT(*)::INT AS cnt FROM auctions a ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  const dataParams = [...params, pag.limit, pag.offset];
  const rowsRes = await ctx.db.query<{
    auction_id: string;
    loan_id: string;
    borrower: string;
    collateral_token: string;
    collateral_total: string;
    collateral_remaining: string;
    debt_principal_remaining: string;
    debt_interest_remaining: string;
    start_price: string;
    floor_price: string;
    start_time: string;
    duration: string;
    keeper: string;
    status: number;
    is_default_auction: boolean;
    total_usdc_collected: string;
    debt_paid: string;
    fee_paid: string;
    surplus_to_borrower: string;
    created_block: string;
    last_updated_block: string;
    symbol: string | null;
    decimals: number | null;
    feed_decimals: number | null;
  }>(
    `SELECT
       a.auction_id::TEXT AS auction_id,
       a.loan_id::TEXT AS loan_id,
       a.borrower,
       a.collateral_token,
       a.collateral_total::TEXT AS collateral_total,
       a.collateral_remaining::TEXT AS collateral_remaining,
       a.debt_principal_remaining::TEXT AS debt_principal_remaining,
       a.debt_interest_remaining::TEXT AS debt_interest_remaining,
       a.start_price::TEXT AS start_price,
       a.floor_price::TEXT AS floor_price,
       a.start_time::TEXT AS start_time,
       a.duration::TEXT AS duration,
       a.keeper,
       a.status,
       a.is_default_auction,
       a.total_usdc_collected::TEXT AS total_usdc_collected,
       a.debt_paid::TEXT AS debt_paid,
       a.fee_paid::TEXT AS fee_paid,
       a.surplus_to_borrower::TEXT AS surplus_to_borrower,
       a.created_block::TEXT AS created_block,
       a.last_updated_block::TEXT AS last_updated_block,
       ast.symbol,
       ast.decimals,
       ast.feed_decimals
     FROM auctions a
     LEFT JOIN assets ast ON LOWER(ast.token) = LOWER(a.collateral_token)
     ${whereClause}
     ORDER BY a.auction_id ASC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  const data = rowsRes.rows.map((r) => {
    const colDecimals = r.decimals !== null ? Number(r.decimals) : 18;
    const feedDecimals = r.feed_decimals !== null ? Number(r.feed_decimals) : FEED_DECIMALS_DEFAULT;
    const st = Number(r.status);
    return {
      auction_id: r.auction_id,
      loan_id: r.loan_id,
      borrower: getAddress(r.borrower),
      collateral_token: getAddress(r.collateral_token),
      collateral_total: formatRawString(r.collateral_total, colDecimals, r.symbol ?? undefined),
      collateral_remaining: formatRawString(r.collateral_remaining, colDecimals, r.symbol ?? undefined),
      debt_principal_remaining: formatRawString(r.debt_principal_remaining, USDC_DECIMALS, 'USDC'),
      debt_interest_remaining: formatRawString(r.debt_interest_remaining, USDC_DECIMALS, 'USDC'),
      start_price: formatRawString(r.start_price, feedDecimals, 'USD'),
      floor_price: formatRawString(r.floor_price, feedDecimals, 'USD'),
      start_time: r.start_time,
      duration: r.duration,
      keeper: getAddress(r.keeper),
      status: st,
      status_name: AUCTION_STATUS_NAMES[st] ?? `UNKNOWN(${st})`,
      is_default_auction: r.is_default_auction,
      total_usdc_collected: formatRawString(r.total_usdc_collected, USDC_DECIMALS, 'USDC'),
      debt_paid: formatRawString(r.debt_paid, USDC_DECIMALS, 'USDC'),
      fee_paid: formatRawString(r.fee_paid, USDC_DECIMALS, 'USDC'),
      surplus_to_borrower: formatRawString(r.surplus_to_borrower, USDC_DECIMALS, 'USDC'),
      created_block: r.created_block,
      last_updated_block: r.last_updated_block,
    };
  });

  return {
    statusCode: 200,
    body: {
      ...meta,
      pagination: buildPaginationEnvelope(pag.limit, pag.offset, data.length, total),
      data,
    },
  };
}

async function fetchLiveAssetsStateForBlock(
  ctx: ApiContext,
  tokens: Address[],
  chainHead: bigint
): Promise<AssetsBlockCacheEntry> {
  const existing = ctx.assetBlockCache;
  if (
    existing &&
    existing.blockNumber === chainHead &&
    tokens.every((t) => existing.perAsset.has(t.toLowerCase()))
  ) {
    return existing;
  }

  const contracts = [
    {
      address: ctx.config.loanCore,
      abi: loanCoreAbi,
      functionName: 'globalUsdcCap',
    } as const,
    {
      address: ctx.config.loanCore,
      abi: loanCoreAbi,
      functionName: 'totalOutstandingPrincipal',
    } as const,
    {
      address: ctx.config.feeCollector,
      abi: feeCollectorAbi,
      functionName: 'originationFeeBps',
    } as const,
    {
      address: ctx.config.feeCollector,
      abi: feeCollectorAbi,
      functionName: 'interestCutBps',
    } as const,
    {
      address: ctx.config.feeCollector,
      abi: feeCollectorAbi,
      functionName: 'liquidationFeeBps',
    } as const,
    {
      address: ctx.config.feeCollector,
      abi: feeCollectorAbi,
      functionName: 'safetyReserveShareBps',
    } as const,
    {
      address: ctx.config.feeCollector,
      abi: feeCollectorAbi,
      functionName: 'MAX_ORIGINATION_BPS',
    } as const,
    {
      address: ctx.config.feeCollector,
      abi: feeCollectorAbi,
      functionName: 'MAX_INTEREST_CUT_BPS',
    } as const,
    {
      address: ctx.config.feeCollector,
      abi: feeCollectorAbi,
      functionName: 'MAX_LIQUIDATION_BPS',
    } as const,
    ...tokens.flatMap((tokenAddr) => [
      {
        address: ctx.config.assetRegistry,
        abi: assetRegistryAbi,
        functionName: 'isAssetSupported',
        args: [tokenAddr],
      } as const,
      {
        address: ctx.config.loanCore,
        abi: loanCoreAbi,
        functionName: 'assetOutstandingPrincipal',
        args: [tokenAddr],
      } as const,
      {
        address: ctx.config.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'recordedMultiplier',
        args: [tokenAddr],
      } as const,
      {
        address: ctx.config.assetRegistry,
        abi: assetRegistryAbi,
        functionName: 'getAssetConfig',
        args: [tokenAddr],
      } as const,
      {
        address: ctx.config.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'getPrice',
        args: [tokenAddr],
      } as const,
      {
        address: tokenAddr,
        abi: erc20MetaAbi,
        functionName: 'uiMultiplier',
      } as const,
    ]),
  ];

  let results;
  try {
    results = await ctx.publicClient.multicall({
      contracts,
      allowFailure: true,
      blockNumber: chainHead,
      multicallAddress: base.contracts.multicall3.address,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RpcUnavailableError(`Multicall failed on /assets: ${reason}`);
  }

  if (results[0].status === 'failure' || results[1].status === 'failure') {
    throw new RpcUnavailableError('LoanCore cap read failed on /assets');
  }
  if (
    results[2].status === 'failure' ||
    results[3].status === 'failure' ||
    results[4].status === 'failure' ||
    results[5].status === 'failure' ||
    results[6].status === 'failure' ||
    results[7].status === 'failure' ||
    results[8].status === 'failure'
  ) {
    throw new RpcUnavailableError('FeeCollector read failed on /assets');
  }

  const globalCap = results[0].result as bigint;
  const totalOutstanding = results[1].result as bigint;
  const fees: ProtocolFeesSnapshot = {
    origination_fee_bps: Number(results[2].result),
    interest_cut_bps: Number(results[3].result),
    liquidation_fee_bps: Number(results[4].result),
    safety_reserve_share_bps: Number(results[5].result),
    max_origination_bps: Number(results[6].result),
    max_interest_cut_bps: Number(results[7].result),
    max_liquidation_bps: Number(results[8].result),
  };
  const perAsset = new Map<string, AssetLiveSnapshot>(
    existing && existing.blockNumber === chainHead ? existing.perAsset : undefined
  );

  const ASSETS_OFFSET = 9;
  const STRIDE = 6;
  for (let i = 0; i < tokens.length; i++) {
    const baseIdx = ASSETS_OFFSET + i * STRIDE;
    const tokenAddr = tokens[i];
    const supportedRes = results[baseIdx];
    const assetOutRes = results[baseIdx + 1];
    const recMultRes = results[baseIdx + 2];
    const cfgRes = results[baseIdx + 3];
    const priceRes = results[baseIdx + 4];
    const uiMultRes = results[baseIdx + 5];

    const supported = supportedRes.status === 'success' ? (supportedRes.result as boolean) : false;
    const assetOutstanding = assetOutRes.status === 'success' ? (assetOutRes.result as bigint) : 0n;
    const liveRecMult = recMultRes.status === 'success' ? (recMultRes.result as bigint) : 0n;
    const liveUiMult = uiMultRes.status === 'success' ? (uiMultRes.result as bigint) : null;

    let livePrice = 0n;
    let livePriceDec = FEED_DECIMALS_DEFAULT;
    let oracleState: number = OracleState.STALE_FEED;
    let livePerLoanCap: bigint | null = null;
    let liveAssetCap: bigint | null = null;
    let liveStatus: number | null = null;

    if (supported && cfgRes.status === 'success') {
      const cfg = cfgRes.result as {
        perLoanCap: bigint;
        assetCap: bigint;
        status: number;
      };
      livePerLoanCap = cfg.perLoanCap;
      liveAssetCap = cfg.assetCap;
      liveStatus = Number(cfg.status);
    }

    if (supported && priceRes.status === 'success') {
      const pr = priceRes.result as readonly [bigint, number, number];
      livePrice = pr[0];
      livePriceDec = Number(pr[1]);
      oracleState = Number(pr[2]);
    }

    perAsset.set(tokenAddr.toLowerCase(), {
      livePrice,
      livePriceDec,
      oracleState,
      assetOutstanding,
      liveRecMult,
      liveUiMult,
      livePerLoanCap,
      liveAssetCap,
      liveStatus,
    });
  }

  const cacheEntry: AssetsBlockCacheEntry = {
    blockNumber: chainHead,
    globalCap,
    totalOutstanding,
    fees,
    perAsset,
  };
  ctx.assetBlockCache = cacheEntry;
  return cacheEntry;
}

async function handleAssets(ctx: ApiContext, queryObj: Record<string, string>) {
  const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
  const filters = parseOrThrow(assetsQuerySchema, queryObj);
  const meta = await getSnapshotMeta(ctx);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status !== undefined) {
    params.push(filters.status);
    conditions.push(`a.status = $${params.length}`);
  }
  const tokenFilter = filters.asset ?? filters.token;
  if (tokenFilter) {
    params.push(tokenFilter);
    conditions.push(`LOWER(a.token) = LOWER($${params.length})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRes = await ctx.db.query<{ cnt: number }>(
    `SELECT COUNT(*)::INT AS cnt FROM assets a ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0]?.cnt ?? 0);

  const dataParams = [...params, pag.limit, pag.offset];
  const rowsRes = await ctx.db.query<{
    token: string;
    symbol: string | null;
    decimals: number | null;
    feed: string | null;
    feed_decimals: number | null;
    tier: number | null;
    max_init_ltv_bps: number | null;
    margin_call_ltv_bps: number | null;
    liq_ltv_bps: number | null;
    bad_debt_ltv_bps: number | null;
    max_discount_bps: number | null;
    closed_market_haircut_bps: number | null;
    per_loan_cap: string | null;
    asset_cap: string | null;
    max_stale_open_secs: number | null;
    status: number | null;
    restricted: boolean | null;
    recorded_multiplier: string | null;
    escrow_balance_raw: string;
    updated_block: string;
  }>(
    `SELECT
       a.token,
       a.symbol,
       a.decimals,
       a.feed,
       a.feed_decimals,
       a.tier,
       a.max_init_ltv_bps,
       a.margin_call_ltv_bps,
       a.liq_ltv_bps,
       a.bad_debt_ltv_bps,
       a.max_discount_bps,
       a.closed_market_haircut_bps,
       a.per_loan_cap::TEXT AS per_loan_cap,
       a.asset_cap::TEXT AS asset_cap,
       a.max_stale_open_secs,
       a.status,
       a.restricted,
       a.recorded_multiplier::TEXT AS recorded_multiplier,
       a.escrow_balance_raw::TEXT AS escrow_balance_raw,
       a.updated_block::TEXT AS updated_block
     FROM assets a
     ${whereClause}
     ORDER BY a.token ASC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  let chainHead: bigint;
  try {
    chainHead = await ctx.publicClient.getBlockNumber();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RpcUnavailableError(`Failed to fetch chain head on /assets: ${reason}`);
  }

  const pageTokens = rowsRes.rows.map((r) => getAddress(r.token));
  const liveSnapshot = await fetchLiveAssetsStateForBlock(ctx, pageTokens, chainHead);
  const { globalCap, totalOutstanding, fees, perAsset } = liveSnapshot;

  const data = rowsRes.rows.map((r) => {
    const tokenAddr = getAddress(r.token);
    const tokenDecimals = r.decimals !== null ? Number(r.decimals) : 18;
    const feedDecimalsDefault = r.feed_decimals !== null ? Number(r.feed_decimals) : FEED_DECIMALS_DEFAULT;
    const live = perAsset.get(tokenAddr.toLowerCase());

    const livePrice = live?.livePrice ?? 0n;
    const livePriceDec = live?.livePriceDec ?? feedDecimalsDefault;
    const oracleState = live?.oracleState ?? OracleState.STALE_FEED;
    const assetOutstanding = live?.assetOutstanding ?? 0n;
    const liveRecMult =
      live?.liveRecMult ?? (r.recorded_multiplier ? toBigInt(r.recorded_multiplier) : 0n);
    const liveUiMult = live?.liveUiMult ?? null;
    const livePerLoanCap =
      live?.livePerLoanCap ?? (r.per_loan_cap ? toBigInt(r.per_loan_cap) : 0n);
    const liveAssetCap = live?.liveAssetCap ?? (r.asset_cap ? toBigInt(r.asset_cap) : 0n);
    const liveStatus = live?.liveStatus ?? (r.status !== null ? Number(r.status) : 0);

    const globalRemaining = globalCap > totalOutstanding ? globalCap - totalOutstanding : 0n;
    const assetRemaining =
      liveAssetCap > 0n
        ? liveAssetCap > assetOutstanding
          ? liveAssetCap - assetOutstanding
          : 0n
        : globalRemaining;

    return {
      token: tokenAddr,
      symbol: r.symbol,
      decimals: tokenDecimals,
      feed: r.feed ? getAddress(r.feed) : null,
      tier: r.tier !== null ? Number(r.tier) : null,
      status: liveStatus,
      status_name: ASSET_STATUS_NAMES[liveStatus] ?? `UNKNOWN(${liveStatus})`,
      restricted: r.restricted,
      ltv: {
        max_init_ltv_bps: r.max_init_ltv_bps !== null ? Number(r.max_init_ltv_bps) : null,
        margin_call_ltv_bps: r.margin_call_ltv_bps !== null ? Number(r.margin_call_ltv_bps) : null,
        liq_ltv_bps: r.liq_ltv_bps !== null ? Number(r.liq_ltv_bps) : null,
        bad_debt_ltv_bps: r.bad_debt_ltv_bps !== null ? Number(r.bad_debt_ltv_bps) : null,
        max_discount_bps: r.max_discount_bps !== null ? Number(r.max_discount_bps) : null,
        closed_market_haircut_bps:
          r.closed_market_haircut_bps !== null ? Number(r.closed_market_haircut_bps) : null,
      },
      caps: {
        per_loan_cap: formatAmount(livePerLoanCap, USDC_DECIMALS, 'USDC'),
        asset_cap: formatAmount(liveAssetCap, USDC_DECIMALS, 'USDC'),
        asset_outstanding_principal: formatAmount(assetOutstanding, USDC_DECIMALS, 'USDC'),
        asset_remaining: formatAmount(assetRemaining, USDC_DECIMALS, 'USDC'),
        global_usdc_cap: formatAmount(globalCap, USDC_DECIMALS, 'USDC'),
        global_remaining: formatAmount(globalRemaining, USDC_DECIMALS, 'USDC'),
      },
      multiplier: {
        recorded: formatAmount(liveRecMult, RATE_DECIMALS),
        ui: liveUiMult !== null ? formatAmount(liveUiMult, RATE_DECIMALS) : null,
      },
      oracle: {
        price: formatAmount(livePrice, livePriceDec, 'USD'),
        state: oracleState,
        state_name: ORACLE_STATE_NAMES[oracleState] ?? `UNKNOWN(${oracleState})`,
        max_stale_open_secs: r.max_stale_open_secs !== null ? Number(r.max_stale_open_secs) : null,
      },
      escrow_balance: formatRawString(r.escrow_balance_raw, tokenDecimals, r.symbol ?? undefined),
      updated_block: r.updated_block,
      live_block_number: chainHead.toString(),
    };
  });

  return {
    statusCode: 200,
    body: {
      ...meta,
      live_block_number: chainHead.toString(),
      fees,
      pagination: buildPaginationEnvelope(pag.limit, pag.offset, data.length, total),
      data,
    },
  };
}

async function handleFees(ctx: ApiContext) {
  const meta = await getSnapshotMeta(ctx);
  let chainHead: bigint;
  try {
    chainHead = await ctx.publicClient.getBlockNumber();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RpcUnavailableError(`Failed to fetch chain head on /fees: ${reason}`);
  }
  const liveSnapshot = await fetchLiveAssetsStateForBlock(ctx, [], chainHead);
  return {
    statusCode: 200,
    body: {
      ...meta,
      live_block_number: chainHead.toString(),
      fees: liveSnapshot.fees,
    },
  };
}

export function createApiServer(ctx: ApiContext): http.Server {
  const rateLimiter = new IpRateLimiter(
    ctx.config.rateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(req, res, ctx.config.corsOrigins);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const clientIp = resolveClientIp(req, ctx.config.trustProxyHops);
    const rl = rateLimiter.check(clientIp);
    res.setHeader('X-RateLimit-Limit', String(ctx.config.rateLimitMax));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(rl.resetEpochSec));

    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendJson(res, 429, {
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests from this IP; please retry later.',
        },
      });
      return;
    }

    try {
      const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = parsedUrl.pathname.startsWith('/v1/')
        ? parsedUrl.pathname.slice(3)
        : parsedUrl.pathname;
      const queryObj = urlSearchParamsToObject(parsedUrl.searchParams);

      if (pathname === '/health' && req.method === 'GET') {
        const result = await handleHealth(ctx);
        sendJson(res, result.statusCode, result.body);
        return;
      }

      if (pathname === '/orders' && req.method === 'GET') {
        const result = await handleOrders(ctx, queryObj);
        sendJson(res, result.statusCode, result.body);
        return;
      }

      if (pathname === '/loans' && req.method === 'GET') {
        const result = await handleLoans(ctx, queryObj);
        sendJson(res, result.statusCode, result.body);
        return;
      }

      if (pathname === '/positions' && req.method === 'GET') {
        const result = await handlePositions(ctx, queryObj);
        sendJson(res, result.statusCode, result.body);
        return;
      }

      if (pathname === '/auctions' && req.method === 'GET') {
        const result = await handleAuctions(ctx, queryObj);
        sendJson(res, result.statusCode, result.body);
        return;
      }

      if (pathname === '/assets' && req.method === 'GET') {
        const result = await handleAssets(ctx, queryObj);
        sendJson(res, result.statusCode, result.body);
        return;
      }

      if (pathname === '/fees' && req.method === 'GET') {
        const result = await handleFees(ctx);
        sendJson(res, result.statusCode, result.body);
        return;
      }

      if (pathname === '/quote' && (req.method === 'GET' || req.method === 'POST')) {
        const rawInput =
          req.method === 'GET' ? queryObj : await readJsonBody(req, ctx.config.maxBodyBytes);
        const input = parseOrThrow(quoteRequestSchema, rawInput);
        const quote = await computeLoanQuote({
          publicClient: ctx.publicClient,
          db: ctx.db,
          config: ctx.config,
          input,
        });
        sendJson(res, 200, quote);
        return;
      }

      const knownPaths = new Set(['/health', '/orders', '/loans', '/positions', '/auctions', '/assets', '/fees', '/quote']);
      if (knownPaths.has(pathname)) {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Method ${req.method ?? 'UNKNOWN'} not allowed on ${pathname}`);
      }

      throw new HttpError(404, 'NOT_FOUND', `Route not found: ${parsedUrl.pathname}`);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.statusCode, {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          },
        });
        return;
      }

      if (err instanceof RpcUnavailableError) {
        console.warn('[API_RPC_UNAVAILABLE]', err.message);
        sendJson(res, 503, {
          error: {
            code: 'RPC_UNAVAILABLE',
            message: 'Blockchain RPC node is unavailable; please retry shortly.',
          },
        });
        return;
      }

      // Sanitized internal error response: never leak stack traces or SQL/RPC secrets
      console.error('[API_ERROR]', err instanceof Error ? err.message : String(err));
      sendJson(res, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred while processing the request.',
        },
      });
    }
  });

  server.on('close', () => {
    rateLimiter.close();
  });

  return server;
}
