import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  createPublicClient,
  defineChain,
  getAddress,
  http as viemHttp,
  recoverAddress,
  zeroAddress,
} from 'viem';
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
  orderSettlementAbi,
} from './abi.js';
import type { ApiConfig } from './config.js';
import { type ReadOnlyDatabase, openReadOnlyDatabase, toBigInt } from './db.js';
import { formatAmount, formatRawString } from './format.js';
import { RpcUnavailableError, computeLoanQuote } from './quote.js';
import {
  MAX_ORDER_EXPIRY_SECS,
  assetsQuerySchema,
  auctionsQuerySchema,
  buildPaginationSchema,
  loansQuerySchema,
  ordersQuerySchema,
  positionsQuerySchema,
  postOrderSchema,
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

export interface RelaySignedOrderRecord {
  orderHash: Hex;
  orderType: 'borrow' | 'lend';
  maker: Address;
  collateralToken: Address | null;
  collateralSymbol: string | null;
  collateralDecimals: number;
  collateralAmount: string | null;
  totalUsdc: string;
  rateBps: number;
  termDays: number;
  maxLtvBps: number;
  minFill: string;
  expiry: string;
  nonce: string;
  yieldMode: number;
  signedOrder: Record<string, unknown>;
  signature: Hex;
  submittedAt: string;
  submittedIp: string;
  submittedAtMs: number;
  cachedFilled: bigint;
  cachedCancelled: boolean;
  cachedMakerNonce: bigint;
  cachedMakerBalance?: bigint;
  cachedMakerAllowance?: bigint;
  cachedFundingChecked?: boolean;
  cachedFundingOverBudget?: boolean;
  cachedCollateralCheck?: boolean;
  cachedUndercollateralized?: boolean;
  cachedOracleStale?: boolean;
  cachedClosedHaircutShortfall?: boolean;
  cachedRpcStale?: boolean;
  cachedStatus: 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'expired' | 'nonce_bumped' | 'unfunded';
  cachedBlockNumber: bigint;
  lastRefreshedAtMs: number;
}

export interface ApiContext {
  config: ApiConfig;
  publicClient: PublicClient<Transport, Chain>;
  db: ReadOnlyDatabase;
  assetBlockCache?: AssetsBlockCacheEntry;
  signedOrders?: Map<string, RelaySignedOrderRecord>;
  relayBgRefreshIntervalMs?: number;
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
  return { config, publicClient, db, signedOrders: new Map() };
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none';");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
  setSecurityHeaders(res);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  setSecurityHeaders(res);
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

const MAX_SIGNED_ORDERS = 2000;
const MAX_ORDERS_PER_MAKER = 20;
const MAX_ORDERS_PER_IP = 50;
const NEAR_EXPIRY_EVICTION_WINDOW_SECS = 86_400n;
const EVICTION_REFRESH_SCAN_LIMIT = 60;
const RELAY_STATE_CACHE_TTL_MS = 2000;
const MAX_RELAY_REFRESH_PER_REQ = 120;
const UNFUNDED_REFRESH_SLICE = 20;
const BG_REFRESH_INTERVAL_MS = 30_000;
const BG_REFRESH_BATCH_LIMIT = 100;
const RELAY_MULTICALL_CHUNK = 250;
const FALLBACK_SIGNED_ORDERS = new WeakMap<ApiContext, Map<string, RelaySignedOrderRecord>>();
const MAKER_ORDER_LOCKS = new WeakMap<ApiContext, Map<string, Promise<void>>>();

async function withMakerOrderLock<T>(
  ctx: ApiContext,
  maker: Address,
  fn: () => Promise<T>
): Promise<T> {
  let locks = MAKER_ORDER_LOCKS.get(ctx);
  if (!locks) {
    locks = new Map();
    MAKER_ORDER_LOCKS.set(ctx, locks);
  }
  const key = maker.toLowerCase();
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prev.then(() => current);
  locks.set(key, queued);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === queued) {
      locks.delete(key);
    }
  }
}

interface RelayHeadCacheState {
  blockNumber: bigint;
  timestamp: bigint;
  inFlightBlock: Promise<{ number: bigint; timestamp: bigint; rpcFailed: boolean }> | null;
  inFlightRefresh: Map<string, Promise<boolean>>;
}
const RELAY_HEAD_CACHE = new WeakMap<ApiContext, RelayHeadCacheState>();

function getRelayHeadState(ctx: ApiContext): RelayHeadCacheState {
  let state = RELAY_HEAD_CACHE.get(ctx);
  if (!state) {
    state = {
      blockNumber: 0n,
      timestamp: 0n,
      inFlightBlock: null,
      inFlightRefresh: new Map(),
    };
    RELAY_HEAD_CACHE.set(ctx, state);
  }
  return state;
}

async function getLatestBlockForRelay(
  ctx: ApiContext,
  fallbackBlock: bigint
): Promise<{ number: bigint; timestamp: bigint; rpcFailed: boolean }> {
  const headState = getRelayHeadState(ctx);
  if (headState.inFlightBlock) {
    return headState.inFlightBlock;
  }
  const p = ctx.publicClient
    .getBlock({ blockTag: 'latest' })
    .then((b) => {
      headState.blockNumber = b.number;
      headState.timestamp = b.timestamp;
      return { number: b.number, timestamp: b.timestamp, rpcFailed: false };
    })
    .catch(() => ({
      number: headState.blockNumber > 0n ? headState.blockNumber : fallbackBlock,
      timestamp: headState.timestamp > 0n ? headState.timestamp : BigInt(Math.floor(Date.now() / 1000)),
      rpcFailed: true,
    }))
    .finally(() => {
      headState.inFlightBlock = null;
    });
  headState.inFlightBlock = p;
  return p;
}

function getSignedOrdersMap(ctx: ApiContext): Map<string, RelaySignedOrderRecord> {
  if (ctx.signedOrders) return ctx.signedOrders;
  let existing = FALLBACK_SIGNED_ORDERS.get(ctx);
  if (!existing) {
    existing = new Map<string, RelaySignedOrderRecord>();
    FALLBACK_SIGNED_ORDERS.set(ctx, existing);
  }
  return existing;
}

export function sanitizeTokenSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 16) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

interface LiveRelayOrderState {
  record: RelaySignedOrderRecord;
  filled: bigint;
  remaining: bigint;
  cancelled: boolean;
  expired: boolean;
  nonceBumped: boolean;
  unfunded: boolean;
  undercollateralized: boolean;
  fillableWhenMarketOpens: boolean;
  stale: boolean;
  currentMakerNonce: bigint;
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'expired' | 'nonce_bumped' | 'unfunded';
  blockNumber: bigint;
}

function computeCollateralValuationUsdc(params: {
  collateralRaw: bigint;
  tokenDecimals: number;
  price: bigint;
  feedDecimals: number;
  oracleState: number;
  closedMarketHaircutBps: number;
}): bigint {
  if (params.collateralRaw <= 0n || params.price <= 0n) return 0n;
  if (
    params.oracleState !== OracleState.VALID_OPEN &&
    params.oracleState !== OracleState.VALID_CLOSED
  ) {
    return 0n;
  }
  const denom = 10n ** BigInt(params.tokenDecimals) * 10n ** BigInt(params.feedDecimals);
  if (denom <= 0n) return 0n;
  const grossUsdc = (params.collateralRaw * params.price * 1_000_000n) / denom;
  if (params.oracleState === OracleState.VALID_CLOSED && params.closedMarketHaircutBps > 0) {
    return grossUsdc - (grossUsdc * BigInt(params.closedMarketHaircutBps)) / 10_000n;
  }
  return grossUsdc;
}

function isBorrowOrderAdequatelyCollateralized(params: {
  collateralRaw: bigint;
  tokenDecimals: number;
  minUsdc: bigint;
  maxLtvBps: number;
  assetMaxInitLtvBps: number;
  assetStatus: number;
  closedMarketHaircutBps: number;
  price: bigint;
  feedDecimals: number;
  oracleState: number;
}): {
  ok: boolean;
  effectiveUsdc: bigint;
  allowedLtvBps: number;
  oracleNonTradable: boolean;
  closedHaircutShortfall: boolean;
} {
  if (params.assetStatus !== 0) {
    return {
      ok: false,
      effectiveUsdc: 0n,
      allowedLtvBps: 0,
      oracleNonTradable: false,
      closedHaircutShortfall: false,
    };
  }
  const oracleNonTradable =
    params.oracleState !== OracleState.VALID_OPEN &&
    params.oracleState !== OracleState.VALID_CLOSED;
  if (oracleNonTradable) {
    return {
      ok: false,
      effectiveUsdc: 0n,
      allowedLtvBps: 0,
      oracleNonTradable: true,
      closedHaircutShortfall: false,
    };
  }
  const effectiveUsdc = computeCollateralValuationUsdc({
    collateralRaw: params.collateralRaw,
    tokenDecimals: params.tokenDecimals,
    price: params.price,
    feedDecimals: params.feedDecimals,
    oracleState: params.oracleState,
    closedMarketHaircutBps: params.closedMarketHaircutBps,
  });
  const allowedLtvBps = Math.min(params.maxLtvBps, params.assetMaxInitLtvBps);
  const ok =
    allowedLtvBps > 0 &&
    params.price > 0n &&
    effectiveUsdc * BigInt(allowedLtvBps) >= params.minUsdc * 10_000n;
  if (
    !ok &&
    params.oracleState === OracleState.VALID_CLOSED &&
    params.closedMarketHaircutBps > 0 &&
    params.price > 0n &&
    allowedLtvBps > 0
  ) {
    const openUsdc = computeCollateralValuationUsdc({
      collateralRaw: params.collateralRaw,
      tokenDecimals: params.tokenDecimals,
      price: params.price,
      feedDecimals: params.feedDecimals,
      oracleState: OracleState.VALID_OPEN,
      closedMarketHaircutBps: 0,
    });
    if (openUsdc * BigInt(allowedLtvBps) >= params.minUsdc * 10_000n) {
      return {
        ok: false,
        effectiveUsdc,
        allowedLtvBps,
        oracleNonTradable: false,
        closedHaircutShortfall: true,
      };
    }
  }
  return {
    ok,
    effectiveUsdc,
    allowedLtvBps,
    oracleNonTradable: false,
    closedHaircutShortfall: false,
  };
}

function getRequiredFundingSpec(
  ctx: ApiContext,
  params: {
    orderType: 'borrow' | 'lend';
    collateralToken: Address | null;
    collateralAmount: string | null;
    totalUsdc: bigint;
    filled: bigint;
    priorOpenRequiredRaw?: bigint;
  }
): {
  token: Address;
  spender: Address;
  requiredRaw: bigint;
  priorOpenRequiredRaw: bigint;
  cumulativeRequiredRaw: bigint;
} | null {
  const remaining = params.totalUsdc > params.filled ? params.totalUsdc - params.filled : 0n;
  if (remaining === 0n) return null;
  const priorOpenRequiredRaw = params.priorOpenRequiredRaw ?? 0n;
  if (params.orderType === 'borrow') {
    if (!params.collateralToken || !params.collateralAmount) return null;
    const colBig = BigInt(params.collateralAmount);
    const requiredRaw = (colBig * remaining + (params.totalUsdc - 1n)) / params.totalUsdc;
    return {
      token: getAddress(params.collateralToken),
      spender: ctx.config.collateralEscrow,
      requiredRaw,
      priorOpenRequiredRaw,
      cumulativeRequiredRaw: requiredRaw + priorOpenRequiredRaw,
    };
  }
  return {
    token: ctx.config.usdc,
    spender: ctx.config.loanCore,
    requiredRaw: remaining,
    priorOpenRequiredRaw,
    cumulativeRequiredRaw: remaining + priorOpenRequiredRaw,
  };
}

function fundingPairKey(token: Address, maker: Address, spender: Address): string {
  return `${token.toLowerCase()}:${maker.toLowerCase()}:${spender.toLowerCase()}`;
}

function isRelayRecordDead(
  rec: RelaySignedOrderRecord,
  chainNowSec: bigint,
  currentMakerNonceOverride?: bigint
): boolean {
  const filled = rec.cachedFilled ?? 0n;
  const total = BigInt(rec.totalUsdc);
  const currentNonce = currentMakerNonceOverride ?? rec.cachedMakerNonce ?? BigInt(rec.nonce);
  return (
    Boolean(rec.cachedCancelled) ||
    currentNonce !== BigInt(rec.nonce) ||
    filled >= total ||
    BigInt(rec.expiry) <= chainNowSec
  );
}

function getMakerPriorOpenRequiredRaw(
  ctx: ApiContext,
  signedMap: Map<string, RelaySignedOrderRecord>,
  params: {
    maker: Address;
    token: Address;
    spender: Address;
    chainNowSec: bigint;
    excludeOrderHashLower?: string;
  }
): bigint {
  const targetMaker = params.maker.toLowerCase();
  const targetToken = params.token.toLowerCase();
  const targetSpender = params.spender.toLowerCase();
  let totalPrior = 0n;
  for (const [k, existing] of signedMap.entries()) {
    if (params.excludeOrderHashLower && k === params.excludeOrderHashLower) continue;
    if (existing.maker.toLowerCase() !== targetMaker) continue;
    if (isRelayRecordDead(existing, params.chainNowSec)) continue;
    if (existing.cachedStatus === 'unfunded') continue;
    if (
      existing.orderType === 'borrow' &&
      existing.cachedCollateralCheck &&
      existing.cachedUndercollateralized &&
      !existing.cachedClosedHaircutShortfall
    ) {
      continue;
    }
    const existingSpec = getRequiredFundingSpec(ctx, {
      orderType: existing.orderType,
      collateralToken: existing.collateralToken,
      collateralAmount: existing.collateralAmount,
      totalUsdc: BigInt(existing.totalUsdc),
      filled: existing.cachedFilled ?? 0n,
    });
    if (!existingSpec) continue;
    if (
      existingSpec.token.toLowerCase() === targetToken &&
      existingSpec.spender.toLowerCase() === targetSpender
    ) {
      totalPrior += existingSpec.requiredRaw;
    }
  }
  return totalPrior;
}

function reconcileMakerFundingBudgets(
  ctx: ApiContext,
  signedMap: Map<string, RelaySignedOrderRecord>,
  fundingResultMap: Map<string, { balance: bigint; allowance: bigint; ok: boolean }>,
  chainNowSec: bigint,
  chainBlockNum: bigint
): void {
  const groups = new Map<string, Array<{ rec: RelaySignedOrderRecord; requiredRaw: bigint }>>();
  for (const rec of signedMap.values()) {
    const fSpec = getRequiredFundingSpec(ctx, {
      orderType: rec.orderType,
      collateralToken: rec.collateralToken,
      collateralAmount: rec.collateralAmount,
      totalUsdc: BigInt(rec.totalUsdc),
      filled: rec.cachedFilled ?? 0n,
    });
    if (!fSpec) continue;
    const fKey = fundingPairKey(fSpec.token, rec.maker, fSpec.spender);
    const latest = fundingResultMap.get(fKey);
    if (!latest?.ok) continue;

    rec.cachedMakerBalance = latest.balance;
    rec.cachedMakerAllowance = latest.allowance;
    rec.cachedFundingChecked = true;

    if (isRelayRecordDead(rec, chainNowSec)) {
      rec.cachedFundingOverBudget = false;
      deriveRelayLiveState(ctx, rec, chainNowSec, chainBlockNum);
      continue;
    }
    if (
      rec.orderType === 'borrow' &&
      rec.cachedCollateralCheck &&
      rec.cachedUndercollateralized &&
      !rec.cachedClosedHaircutShortfall
    ) {
      rec.cachedFundingOverBudget = false;
      deriveRelayLiveState(ctx, rec, chainNowSec, chainBlockNum);
      continue;
    }

    const list = groups.get(fKey);
    if (list) {
      list.push({ rec, requiredRaw: fSpec.requiredRaw });
    } else {
      groups.set(fKey, [{ rec, requiredRaw: fSpec.requiredRaw }]);
    }
  }

  for (const [fKey, entries] of groups.entries()) {
    const latest = fundingResultMap.get(fKey);
    if (!latest?.ok) continue;
    entries.sort((a, b) => {
      const dt = (a.rec.submittedAtMs ?? 0) - (b.rec.submittedAtMs ?? 0);
      if (dt !== 0) return dt;
      return a.rec.orderHash.toLowerCase().localeCompare(b.rec.orderHash.toLowerCase());
    });
    let runningSum = 0n;
    for (const entry of entries) {
      const nextSum = runningSum + entry.requiredRaw;
      if (latest.balance >= nextSum && latest.allowance >= nextSum) {
        entry.rec.cachedFundingOverBudget = false;
        runningSum = nextSum;
      } else {
        entry.rec.cachedFundingOverBudget = true;
      }
      deriveRelayLiveState(ctx, entry.rec, chainNowSec, chainBlockNum);
    }
  }
}

function deriveRelayLiveState(
  ctx: ApiContext,
  rec: RelaySignedOrderRecord,
  chainNowSec: bigint,
  chainBlockNum: bigint
): LiveRelayOrderState {
  const filled = rec.cachedFilled ?? 0n;
  const cancelled = Boolean(rec.cachedCancelled);
  const currentMakerNonce = rec.cachedMakerNonce ?? BigInt(rec.nonce);
  const total = BigInt(rec.totalUsdc);
  const remaining = total > filled ? total - filled : 0n;
  const expired = BigInt(rec.expiry) <= chainNowSec;
  const nonceBumped = currentMakerNonce !== BigInt(rec.nonce);
  const fundingSpec = getRequiredFundingSpec(ctx, {
    orderType: rec.orderType,
    collateralToken: rec.collateralToken,
    collateralAmount: rec.collateralAmount,
    totalUsdc: total,
    filled,
  });
  const undercollateralized =
    rec.orderType === 'borrow' &&
    Boolean(rec.cachedCollateralCheck && rec.cachedUndercollateralized && !rec.cachedClosedHaircutShortfall);
  const singleOrderUnfunded = Boolean(
    rec.cachedFundingChecked &&
      fundingSpec &&
      ((rec.cachedMakerBalance ?? 0n) < fundingSpec.requiredRaw ||
        (rec.cachedMakerAllowance ?? 0n) < fundingSpec.requiredRaw)
  );
  const unfunded = undercollateralized || singleOrderUnfunded || Boolean(rec.cachedFundingOverBudget);
  const status: LiveRelayOrderState['status'] = cancelled
    ? 'cancelled'
    : nonceBumped
      ? 'nonce_bumped'
      : remaining === 0n
        ? 'filled'
        : expired
          ? 'expired'
          : unfunded
            ? 'unfunded'
            : filled > 0n
              ? 'partially_filled'
              : 'open';

  if (unfunded) {
    rec.cachedClosedHaircutShortfall = false;
  }

  const fillableWhenMarketOpens =
    rec.orderType === 'borrow' &&
    Boolean(rec.cachedClosedHaircutShortfall) &&
    !unfunded &&
    !cancelled &&
    !nonceBumped &&
    !expired &&
    remaining > 0n;

  rec.cachedStatus = status;
  return {
    record: rec,
    filled,
    remaining,
    cancelled,
    expired,
    nonceBumped,
    unfunded,
    undercollateralized,
    fillableWhenMarketOpens,
    stale: Boolean(rec.cachedRpcStale || rec.cachedOracleStale),
    currentMakerNonce,
    status,
    blockNumber: rec.cachedBlockNumber > 0n ? rec.cachedBlockNumber : chainBlockNum,
  };
}

async function batchRefreshRelayRecords(
  ctx: ApiContext,
  records: RelaySignedOrderRecord[],
  chainNowSec: bigint,
  chainBlockNum: bigint,
  chainRpcFailed = false,
  forceRefresh = false
): Promise<boolean> {
  if (records.length === 0) return chainRpcFailed;
  const headState = getRelayHeadState(ctx);
  const nowMs = Date.now();
  const capped = records.slice(0, MAX_RELAY_REFRESH_PER_REQ);
  if (chainRpcFailed) {
    for (const r of capped) {
      r.cachedRpcStale = true;
    }
    return true;
  }
  const stale = forceRefresh
    ? capped
    : capped.filter(
        (rec) =>
          Boolean(rec.cachedRpcStale) ||
          rec.cachedBlockNumber !== chainBlockNum ||
          nowMs - rec.lastRefreshedAtMs > RELAY_STATE_CACHE_TTL_MS
      );
  if (stale.length === 0) {
    return capped.some((r) => Boolean(r.cachedRpcStale || r.cachedOracleStale));
  }

  const batchKey = `${forceRefresh ? 'force' : 'norm'}:${chainBlockNum.toString()}:${stale.map((r) => r.orderHash.toLowerCase()).join(',')}`;
  const inFlight = headState.inFlightRefresh.get(batchKey);
  if (inFlight) {
    return inFlight;
  }

  const runPromise = (async (): Promise<boolean> => {
    const uniqueMakers = Array.from(new Set(stale.map((r) => getAddress(r.maker))));
    const fundingPairsMap = new Map<string, { token: Address; maker: Address; spender: Address }>();
    const recFundingKey = new Map<string, string>();
    for (const r of stale) {
      const fSpec = getRequiredFundingSpec(ctx, {
        orderType: r.orderType,
        collateralToken: r.collateralToken,
        collateralAmount: r.collateralAmount,
        totalUsdc: BigInt(r.totalUsdc),
        filled: r.cachedFilled ?? 0n,
      });
      if (fSpec) {
        const mAddr = getAddress(r.maker);
        const fKey = fundingPairKey(fSpec.token, mAddr, fSpec.spender);
        recFundingKey.set(r.orderHash.toLowerCase(), fKey);
        if (!fundingPairsMap.has(fKey)) {
          fundingPairsMap.set(fKey, { token: fSpec.token, maker: mAddr, spender: fSpec.spender });
        }
      }
    }
    const uniqueFundingPairs = Array.from(fundingPairsMap.entries());
    const uniqueCollateralTokens = Array.from(
      new Set(
        stale
          .filter((r) => r.orderType === 'borrow' && r.collateralToken)
          .map((r) => getAddress(r.collateralToken!))
      )
    );

    const calls: Array<{
      address: Address;
      abi:
        | typeof orderSettlementAbi
        | typeof erc20MetaAbi
        | typeof oracleRouterAbi
        | typeof assetRegistryAbi;
      functionName:
        | 'getOrderFilledAmount'
        | 'isOrderCancelled'
        | 'getMakerNonce'
        | 'balanceOf'
        | 'allowance'
        | 'getPrice'
        | 'getAssetConfig';
      args: readonly [Hex] | readonly [Address] | readonly [Address, Address];
    }> = [];

    for (const r of stale) {
      calls.push({
        address: ctx.config.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'getOrderFilledAmount',
        args: [r.orderHash],
      });
      calls.push({
        address: ctx.config.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'isOrderCancelled',
        args: [r.orderHash],
      });
    }
    const makerStartIdx = calls.length;
    for (const m of uniqueMakers) {
      calls.push({
        address: ctx.config.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'getMakerNonce',
        args: [m],
      });
    }
    const fundingStartIdx = calls.length;
    for (const [, fp] of uniqueFundingPairs) {
      calls.push({
        address: fp.token,
        abi: erc20MetaAbi,
        functionName: 'balanceOf',
        args: [fp.maker],
      });
      calls.push({
        address: fp.token,
        abi: erc20MetaAbi,
        functionName: 'allowance',
        args: [fp.maker, fp.spender],
      });
    }
    const oracleStartIdx = calls.length;
    for (const tok of uniqueCollateralTokens) {
      calls.push({
        address: ctx.config.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'getPrice',
        args: [tok],
      });
      calls.push({
        address: ctx.config.assetRegistry,
        abi: assetRegistryAbi,
        functionName: 'getAssetConfig',
        args: [tok],
      });
    }

    type McResult = { status: 'success'; result: unknown } | { status: 'failure'; error: unknown };
    const results: McResult[] = [];
    let batchRpcError = false;

    try {
      for (let i = 0; i < calls.length; i += RELAY_MULTICALL_CHUNK) {
        const chunk = calls.slice(i, i + RELAY_MULTICALL_CHUNK);
        const resChunk = await ctx.publicClient.multicall({
          contracts: chunk as unknown as readonly [],
          allowFailure: true,
        });
        results.push(...(resChunk as unknown as McResult[]));
      }
    } catch {
      batchRpcError = true;
      for (const r of stale) {
        r.cachedRpcStale = true;
      }
      return true;
    }

    const makerNonceMap = new Map<string, bigint>();
    for (let mIdx = 0; mIdx < uniqueMakers.length; mIdx++) {
      const mcRes = results[makerStartIdx + mIdx];
      if (mcRes && mcRes.status === 'success') {
        makerNonceMap.set(uniqueMakers[mIdx].toLowerCase(), BigInt(mcRes.result as bigint));
      }
    }

    const fundingResultMap = new Map<string, { balance: bigint; allowance: bigint; ok: boolean }>();
    for (let fIdx = 0; fIdx < uniqueFundingPairs.length; fIdx++) {
      const [fKey] = uniqueFundingPairs[fIdx];
      const balRes = results[fundingStartIdx + fIdx * 2];
      const allowRes = results[fundingStartIdx + fIdx * 2 + 1];
      if (balRes?.status === 'success' && allowRes?.status === 'success') {
        fundingResultMap.set(fKey, {
          balance: BigInt(balRes.result as bigint),
          allowance: BigInt(allowRes.result as bigint),
          ok: true,
        });
      } else {
        fundingResultMap.set(fKey, { balance: 0n, allowance: 0n, ok: false });
      }
    }

    const oracleAssetMap = new Map<
      string,
      {
        price: bigint;
        feedDecimals: number;
        oracleState: number;
        maxInitLtvBps: number;
        closedMarketHaircutBps: number;
        assetStatus: number;
        ok: boolean;
      }
    >();
    for (let tIdx = 0; tIdx < uniqueCollateralTokens.length; tIdx++) {
      const tokLower = uniqueCollateralTokens[tIdx].toLowerCase();
      const pRes = results[oracleStartIdx + tIdx * 2];
      const cfgRes = results[oracleStartIdx + tIdx * 2 + 1];
      if (pRes?.status === 'success' && cfgRes?.status === 'success') {
        const priceTuple = pRes.result as readonly [bigint, number, number];
        const cfg = cfgRes.result as {
          maxInitLtvBps: number;
          closedMarketHaircutBps: number;
          status: number;
        };
        oracleAssetMap.set(tokLower, {
          price: BigInt(priceTuple[0]),
          feedDecimals: Number(priceTuple[1]),
          oracleState: Number(priceTuple[2]),
          maxInitLtvBps: Number(cfg.maxInitLtvBps),
          closedMarketHaircutBps: Number(cfg.closedMarketHaircutBps ?? 0),
          assetStatus: Number(cfg.status),
          ok: true,
        });
      } else {
        oracleAssetMap.set(tokLower, {
          price: 0n,
          feedDecimals: 8,
          oracleState: 5,
          maxInitLtvBps: 0,
          closedMarketHaircutBps: 0,
          assetStatus: 2,
          ok: false,
        });
      }
    }

    const doneAtMs = Date.now();
    let anyStale = batchRpcError;
    for (let idx = 0; idx < stale.length; idx++) {
      const rec = stale[idx];
      const fRes = results[idx * 2];
      const cRes = results[idx * 2 + 1];
      const nonceVal = makerNonceMap.get(rec.maker.toLowerCase());
      const fKey = recFundingKey.get(rec.orderHash.toLowerCase());
      const fState = fKey ? fundingResultMap.get(fKey) : undefined;

      if (fRes?.status === 'success') {
        rec.cachedFilled = BigInt(fRes.result as bigint);
      }
      if (cRes?.status === 'success') {
        rec.cachedCancelled = Boolean(cRes.result);
      }
      if (nonceVal !== undefined) {
        rec.cachedMakerNonce = nonceVal;
      }
      if (fState?.ok) {
        rec.cachedMakerBalance = fState.balance;
        rec.cachedMakerAllowance = fState.allowance;
        rec.cachedFundingChecked = true;
      }

      let collateralCheckOk = true;
      if (rec.orderType === 'borrow' && rec.collateralToken && rec.collateralAmount) {
        const oa = oracleAssetMap.get(rec.collateralToken.toLowerCase());
        if (oa?.ok) {
          const check = isBorrowOrderAdequatelyCollateralized({
            collateralRaw: BigInt(rec.collateralAmount),
            tokenDecimals: rec.collateralDecimals,
            minUsdc: BigInt(rec.totalUsdc),
            maxLtvBps: rec.maxLtvBps,
            assetMaxInitLtvBps: oa.maxInitLtvBps,
            assetStatus: oa.assetStatus,
            closedMarketHaircutBps: oa.closedMarketHaircutBps,
            price: oa.price,
            feedDecimals: oa.feedDecimals,
            oracleState: oa.oracleState,
          });
          if (check.oracleNonTradable) {
            // Preserve last collateral/funding status and flag stale instead of marking unfunded;
            // always clear closed-market shortfall whenever oracle state is outside VALID_CLOSED.
            rec.cachedOracleStale = true;
            rec.cachedClosedHaircutShortfall = false;
            anyStale = true;
          } else {
            rec.cachedOracleStale = false;
            rec.cachedCollateralCheck = true;
            if (check.closedHaircutShortfall && oa.oracleState === OracleState.VALID_CLOSED) {
              rec.cachedClosedHaircutShortfall = true;
              rec.cachedUndercollateralized = false;
            } else {
              rec.cachedClosedHaircutShortfall = false;
              rec.cachedUndercollateralized = !check.ok;
            }
          }
        } else {
          collateralCheckOk = false;
        }
      }

      const recOk =
        fRes?.status === 'success' &&
        cRes?.status === 'success' &&
        nonceVal !== undefined &&
        (!fKey || Boolean(fState?.ok)) &&
        collateralCheckOk;

      if (recOk) {
        rec.cachedRpcStale = false;
        rec.cachedBlockNumber = chainBlockNum;
        rec.lastRefreshedAtMs = doneAtMs;
      } else {
        rec.cachedRpcStale = true;
        anyStale = true;
      }
      deriveRelayLiveState(ctx, rec, chainNowSec, chainBlockNum);
    }

    if (fundingResultMap.size > 0) {
      reconcileMakerFundingBudgets(
        ctx,
        getSignedOrdersMap(ctx),
        fundingResultMap,
        chainNowSec,
        chainBlockNum
      );
    }

    return anyStale;
  })().finally(() => {
    headState.inFlightRefresh.delete(batchKey);
  });

  headState.inFlightRefresh.set(batchKey, runPromise);
  return runPromise;
}

function formatRelayOrderEnvelope(live: LiveRelayOrderState, fills: unknown[] = []) {
  const rec = live.record;
  const total = BigInt(rec.totalUsdc);
  return {
    order_hash: rec.orderHash,
    maker: rec.maker,
    order_type: rec.orderType,
    collateral_token: rec.collateralToken,
    collateral_symbol: rec.collateralSymbol,
    status: live.status,
    unfunded: live.unfunded,
    undercollateralized: live.undercollateralized,
    fillable_when_market_opens: live.fillableWhenMarketOpens,
    stale: live.stale,
    min_usdc: formatAmount(total, USDC_DECIMALS, 'USDC'),
    ...(rec.orderType === 'lend' ? { usdc_amount: formatAmount(total, USDC_DECIMALS, 'USDC') } : {}),
    filled_usdc: formatAmount(live.filled, USDC_DECIMALS, 'USDC'),
    remaining_usdc: formatAmount(live.remaining, USDC_DECIMALS, 'USDC'),
    cancelled: live.cancelled,
    maker_nonce: rec.nonce,
    current_maker_nonce: live.currentMakerNonce.toString(),
    fills_count: fills.length,
    fills,
    first_seen_block: live.blockNumber.toString(),
    last_updated_block: live.blockNumber.toString(),
    collateral_amount: rec.collateralAmount
      ? formatAmount(BigInt(rec.collateralAmount), rec.collateralDecimals, rec.collateralSymbol ?? undefined)
      : null,
    rate_bps: rec.rateBps,
    ...(rec.orderType === 'borrow'
      ? { max_rate_bps: rec.rateBps }
      : { min_rate_bps: rec.rateBps, allowed_collateral: rec.collateralToken ?? zeroAddress }),
    term_days: rec.termDays,
    max_ltv_bps: rec.maxLtvBps,
    min_fill: formatAmount(BigInt(rec.minFill), USDC_DECIMALS, 'USDC'),
    expiry: rec.expiry,
    nonce: rec.nonce,
    yield_mode: rec.yieldMode,
    signed_order: rec.signedOrder,
    signature: rec.signature,
    submitted_at: rec.submittedAt,
  };
}

async function handlePostOrder(ctx: ApiContext, rawBody: unknown, clientIp = 'unknown') {
  const input = parseOrThrow(postOrderSchema, rawBody);
  const lockMaker =
    input.order_type === 'borrow' ? getAddress(input.order.borrower) : getAddress(input.order.lender);

  return withMakerOrderLock(ctx, lockMaker, async () => {
  const signedMap = getSignedOrdersMap(ctx);

  let blk: { number: bigint; timestamp: bigint };
  try {
    blk = await ctx.publicClient.getBlock({ blockTag: 'latest' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RpcUnavailableError(`Failed to read latest block on POST /orders: ${reason}`);
  }

  let orderHash: Hex;
  let maker: Address;
  let collateralToken: Address | null = null;
  let collateralAmount: string | null = null;
  let totalUsdc: bigint;
  let rateBps: number;
  let termDays: number;
  let maxLtvBps: number;
  let minFill: bigint;
  let expiry: bigint;
  let nonce: bigint;
  let yieldMode: number;
  let signedOrderPlain: Record<string, unknown>;

  if (input.order_type === 'borrow') {
    const o = input.order;
    maker = getAddress(o.borrower);
    collateralToken = getAddress(o.collateralToken);
    collateralAmount = o.collateralAmount;
    totalUsdc = BigInt(o.minUsdc);
    rateBps = o.maxRateBps;
    termDays = o.termDays;
    maxLtvBps = o.maxLtvBps;
    minFill = BigInt(o.minFill);
    expiry = BigInt(o.expiry);
    nonce = BigInt(o.nonce);
    yieldMode = o.yieldMode;

    const structArgs = {
      borrower: maker,
      collateralToken,
      collateralAmount: BigInt(collateralAmount),
      minUsdc: totalUsdc,
      maxRateBps: rateBps,
      termDays,
      maxLtvBps,
      minFill,
      expiry,
      nonce,
      yieldMode,
      allowInKindSettlement: Boolean(o.allowInKindSettlement),
    };
    signedOrderPlain = {
      borrower: maker,
      collateralToken,
      collateralAmount: collateralAmount.toString(),
      minUsdc: totalUsdc.toString(),
      maxRateBps: rateBps,
      termDays,
      maxLtvBps,
      minFill: minFill.toString(),
      expiry: expiry.toString(),
      nonce: nonce.toString(),
      yieldMode,
      allowInKindSettlement: Boolean(o.allowInKindSettlement),
    };
    try {
      orderHash = await ctx.publicClient.readContract({
        address: ctx.config.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'hashBorrowOrder',
        args: [structArgs],
      });
    } catch (err) {
      throw new RpcUnavailableError(err instanceof Error ? err.message : String(err));
    }
  } else {
    const o = input.order;
    maker = getAddress(o.lender);
    const allowedCol = getAddress(o.allowedCollateral);
    collateralToken = allowedCol === zeroAddress ? null : allowedCol;
    totalUsdc = BigInt(o.usdcAmount);
    rateBps = o.minRateBps;
    termDays = o.termDays;
    maxLtvBps = o.maxLtvBps;
    minFill = BigInt(o.minFill);
    expiry = BigInt(o.expiry);
    nonce = BigInt(o.nonce);
    yieldMode = o.yieldMode;

    const structArgs = {
      lender: maker,
      usdcAmount: totalUsdc,
      minRateBps: rateBps,
      termDays,
      allowedCollateral: allowedCol,
      maxLtvBps,
      minFill,
      expiry,
      nonce,
      yieldMode,
    };
    signedOrderPlain = {
      lender: maker,
      usdcAmount: totalUsdc.toString(),
      minRateBps: rateBps,
      termDays,
      allowedCollateral: allowedCol,
      maxLtvBps,
      minFill: minFill.toString(),
      expiry: expiry.toString(),
      nonce: nonce.toString(),
      yieldMode,
    };
    try {
      orderHash = await ctx.publicClient.readContract({
        address: ctx.config.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'hashLendOffer',
        args: [structArgs],
      });
    } catch (err) {
      throw new RpcUnavailableError(err instanceof Error ? err.message : String(err));
    }
  }

  if (minFill > totalUsdc) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Order minFill cannot exceed principal amount');
  }

  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash: orderHash, signature: input.signature as Hex });
  } catch {
    throw new HttpError(400, 'INVALID_ORDER_SIGNATURE', 'Malformed EIP-712 order signature');
  }
  if (recovered.toLowerCase() !== maker.toLowerCase()) {
    throw new HttpError(
      400,
      'INVALID_ORDER_SIGNATURE',
      `Signature signer ${recovered} does not match order maker ${maker}`
    );
  }

  if (expiry <= blk.timestamp) {
    throw new HttpError(400, 'ORDER_EXPIRED', 'Order expiry timestamp is in the past');
  }
  if (expiry > blk.timestamp + MAX_ORDER_EXPIRY_SECS) {
    throw new HttpError(
      400,
      'ORDER_EXPIRY_TOO_FAR',
      `Order expiry cannot exceed ${Number(MAX_ORDER_EXPIRY_SECS / 86_400n)} days from current block timestamp`
    );
  }

  let acceptedViaClosedShortfall = false;
  // Validate collateral token against AssetRegistry & resolve indexed symbol before storing
  let collateralSymbol: string | null = null;
  let collateralDecimals = 18;
  if (collateralToken) {
    let isSupported = false;
    let assetCfg: {
      maxInitLtvBps: number;
      closedMarketHaircutBps: number;
      perLoanCap: bigint;
      status: number;
    } | null = null;
    try {
      isSupported = Boolean(
        await ctx.publicClient.readContract({
          address: ctx.config.assetRegistry,
          abi: assetRegistryAbi,
          functionName: 'isAssetSupported',
          args: [collateralToken],
        })
      );
      if (isSupported) {
        assetCfg = (await ctx.publicClient.readContract({
          address: ctx.config.assetRegistry,
          abi: assetRegistryAbi,
          functionName: 'getAssetConfig',
          args: [collateralToken],
        })) as unknown as {
          maxInitLtvBps: number;
          closedMarketHaircutBps: number;
          perLoanCap: bigint;
          status: number;
        };
      }
    } catch (err) {
      throw new RpcUnavailableError(err instanceof Error ? err.message : String(err));
    }

    if (!isSupported || !assetCfg) {
      throw new HttpError(
        400,
        'UNSUPPORTED_COLLATERAL_ASSET',
        `Collateral token ${collateralToken} is not registered in AssetRegistry`
      );
    }
    if (Number(assetCfg.status) !== 0) {
      throw new HttpError(
        400,
        'COLLATERAL_ASSET_NOT_ACTIVE',
        `Collateral token ${collateralToken} is not Active in AssetRegistry`
      );
    }

    const assetRes = await ctx.db.query<{ symbol: string | null; decimals: number | null }>(
      'SELECT symbol, decimals FROM assets WHERE LOWER(token) = LOWER($1) LIMIT 1',
      [collateralToken]
    );
    if (assetRes.rows[0]) {
      collateralSymbol = sanitizeTokenSymbol(assetRes.rows[0].symbol);
      collateralDecimals = Number(assetRes.rows[0].decimals ?? 18);
    } else {
      try {
        const [sym, dec] = await Promise.all([
          ctx.publicClient.readContract({ address: collateralToken, abi: erc20MetaAbi, functionName: 'symbol' }),
          ctx.publicClient.readContract({ address: collateralToken, abi: erc20MetaAbi, functionName: 'decimals' }),
        ]);
        collateralSymbol = sanitizeTokenSymbol(sym);
        collateralDecimals = Number(dec);
      } catch {
        // leave null/18 fallback
      }
    }

    if (input.order_type === 'borrow') {
      if (maxLtvBps > Number(assetCfg.maxInitLtvBps)) {
        throw new HttpError(
          400,
          'LTV_EXCEEDS_ASSET_MAX',
          `Order maxLtvBps (${maxLtvBps}) exceeds asset maxInitLtvBps (${assetCfg.maxInitLtvBps})`
        );
      }
      if (BigInt(assetCfg.perLoanCap) > 0n && totalUsdc > BigInt(assetCfg.perLoanCap)) {
        throw new HttpError(
          400,
          'PER_LOAN_CAP_EXCEEDED',
          `Order principal (${totalUsdc}) exceeds asset perLoanCap (${assetCfg.perLoanCap})`
        );
      }

      let priceTuple: readonly [bigint, number, number];
      try {
        priceTuple = (await ctx.publicClient.readContract({
          address: ctx.config.oracleRouter,
          abi: oracleRouterAbi,
          functionName: 'getPrice',
          args: [collateralToken],
        })) as unknown as readonly [bigint, number, number];
      } catch (err) {
        throw new RpcUnavailableError(err instanceof Error ? err.message : String(err));
      }

      const oraclePrice = BigInt(priceTuple[0]);
      const feedDecimals = Number(priceTuple[1]);
      const oracleState = Number(priceTuple[2]);
      const colCheck = isBorrowOrderAdequatelyCollateralized({
        collateralRaw: BigInt(collateralAmount ?? '0'),
        tokenDecimals: collateralDecimals,
        minUsdc: totalUsdc,
        maxLtvBps,
        assetMaxInitLtvBps: Number(assetCfg.maxInitLtvBps),
        assetStatus: Number(assetCfg.status),
        closedMarketHaircutBps: Number(assetCfg.closedMarketHaircutBps ?? 0),
        price: oraclePrice,
        feedDecimals,
        oracleState,
      });
      if (!colCheck.ok) {
        if (colCheck.closedHaircutShortfall && oracleState === OracleState.VALID_CLOSED) {
          // Closed-market haircut shortfall on an otherwise open-market-valid order:
          // accept symmetrically with refresh as fillable_when_market_opens=true.
          acceptedViaClosedShortfall = true;
        } else {
          throw new HttpError(
            400,
            'ORDER_UNDERCOLLATERALIZED',
            `Order collateral (${collateralAmount ?? '0'} raw, effective value ${colCheck.effectiveUsdc.toString()} USDC at oracle state ${oracleState}) does not satisfy minUsdc (${totalUsdc.toString()}) at LTV ${colCheck.allowedLtvBps} bps`
          );
        }
      }
    }
  }

  let cancelled = false;
  let currentMakerNonce = 0n;
  let filled = 0n;
  try {
    const [cRes, nRes, fRes] = await Promise.all([
      ctx.publicClient.readContract({
        address: ctx.config.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'isOrderCancelled',
        args: [orderHash],
      }),
      ctx.publicClient.readContract({
        address: ctx.config.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'getMakerNonce',
        args: [maker],
      }),
      ctx.publicClient.readContract({
        address: ctx.config.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'getOrderFilledAmount',
        args: [orderHash],
      }),
    ]);
    cancelled = Boolean(cRes);
    currentMakerNonce = BigInt(nRes);
    filled = BigInt(fRes);
  } catch (err) {
    throw new RpcUnavailableError(err instanceof Error ? err.message : String(err));
  }

  if (cancelled) {
    throw new HttpError(400, 'ORDER_CANCELLED', 'Order has already been cancelled on-chain');
  }
  if (currentMakerNonce !== nonce) {
    throw new HttpError(
      400,
      'INVALID_ORDER_NONCE',
      `Order nonce ${nonce.toString()} does not match on-chain maker nonce ${currentMakerNonce.toString()}`
    );
  }
  if (filled >= totalUsdc) {
    throw new HttpError(400, 'ORDER_ALREADY_FILLED', 'Order has already been completely filled on-chain');
  }

  const orderHashLower = orderHash.toLowerCase();
  const makerLower = maker.toLowerCase();

  const pruneDeadEntries = () => {
    for (const [k, existing] of signedMap.entries()) {
      if (
        BigInt(existing.expiry) <= blk.timestamp ||
        existing.cachedCancelled ||
        existing.cachedStatus === 'filled' ||
        (existing.maker.toLowerCase() === makerLower && BigInt(existing.nonce) !== currentMakerNonce)
      ) {
        signedMap.delete(k);
      }
    }
  };

  pruneDeadEntries();

  const baseFundingSpec = getRequiredFundingSpec(ctx, {
    orderType: input.order_type,
    collateralToken,
    collateralAmount,
    totalUsdc,
    filled,
  });
  let makerBalance = 0n;
  let makerAllowance = 0n;
  let hasFundingCheck = false;
  if (baseFundingSpec) {
    const sameScopeExisting = Array.from(signedMap.values()).filter((existing) => {
      if (existing.orderHash.toLowerCase() === orderHashLower) return false;
      if (existing.maker.toLowerCase() !== makerLower) return false;
      const eSpec = getRequiredFundingSpec(ctx, {
        orderType: existing.orderType,
        collateralToken: existing.collateralToken,
        collateralAmount: existing.collateralAmount,
        totalUsdc: BigInt(existing.totalUsdc),
        filled: existing.cachedFilled ?? 0n,
      });
      return Boolean(
        eSpec &&
          eSpec.token.toLowerCase() === baseFundingSpec.token.toLowerCase() &&
          eSpec.spender.toLowerCase() === baseFundingSpec.spender.toLowerCase()
      );
    });
    if (sameScopeExisting.length > 0) {
      await batchRefreshRelayRecords(ctx, sameScopeExisting, blk.timestamp, blk.number, false);
      pruneDeadEntries();
    }

    const priorOpenRequiredRaw = getMakerPriorOpenRequiredRaw(ctx, signedMap, {
      maker,
      token: baseFundingSpec.token,
      spender: baseFundingSpec.spender,
      chainNowSec: blk.timestamp,
      excludeOrderHashLower: orderHashLower,
    });
    const fundingSpec = getRequiredFundingSpec(ctx, {
      orderType: input.order_type,
      collateralToken,
      collateralAmount,
      totalUsdc,
      filled,
      priorOpenRequiredRaw,
    })!;
    hasFundingCheck = true;

    try {
      const [balRes, allowRes] = await Promise.all([
        ctx.publicClient.readContract({
          address: fundingSpec.token,
          abi: erc20MetaAbi,
          functionName: 'balanceOf',
          args: [maker],
        }),
        ctx.publicClient.readContract({
          address: fundingSpec.token,
          abi: erc20MetaAbi,
          functionName: 'allowance',
          args: [maker, fundingSpec.spender],
        }),
      ]);
      makerBalance = BigInt(balRes);
      makerAllowance = BigInt(allowRes);
    } catch (err) {
      throw new RpcUnavailableError(err instanceof Error ? err.message : String(err));
    }

    const spenderLabel = input.order_type === 'borrow' ? 'CollateralEscrow' : 'LoanCore';
    if (makerBalance < fundingSpec.cumulativeRequiredRaw) {
      throw new HttpError(
        400,
        'INSUFFICIENT_ORDER_FUNDING',
        `Maker balance (${makerBalance.toString()}) is below cumulative required ${fundingSpec.cumulativeRequiredRaw.toString()} raw units (${fundingSpec.requiredRaw.toString()} new + ${fundingSpec.priorOpenRequiredRaw.toString()} open orders)`
      );
    }
    if (makerAllowance < fundingSpec.cumulativeRequiredRaw) {
      throw new HttpError(
        400,
        'INSUFFICIENT_ORDER_FUNDING',
        `Maker ${spenderLabel} allowance (${makerAllowance.toString()}) is below cumulative required ${fundingSpec.cumulativeRequiredRaw.toString()} raw units (${fundingSpec.requiredRaw.toString()} new + ${fundingSpec.priorOpenRequiredRaw.toString()} open orders)`
      );
    }
  }

  // Enforce per-maker active cap (evict ONLY the same maker's unfunded/soonest/oldest order)
  const getSameMakerEntries = () =>
    Array.from(signedMap.entries())
      .filter(([k, e]) => k !== orderHashLower && e.maker.toLowerCase() === makerLower)
      .sort((a, b) => {
        const aUnf = a[1].cachedStatus === 'unfunded' ? 0 : 1;
        const bUnf = b[1].cachedStatus === 'unfunded' ? 0 : 1;
        if (aUnf !== bUnf) return aUnf - bUnf;
        const aExp = BigInt(a[1].expiry);
        const bExp = BigInt(b[1].expiry);
        if (aExp !== bExp) return aExp < bExp ? -1 : 1;
        return (a[1].submittedAtMs ?? 0) - (b[1].submittedAtMs ?? 0);
      });

  const sameMakerEntries = getSameMakerEntries();
  while (sameMakerEntries.length >= MAX_ORDERS_PER_MAKER) {
    const oldest = sameMakerEntries.shift();
    if (oldest) signedMap.delete(oldest[0]);
  }

  // Enforce per-IP cap over funded non-dead entries so one IP cannot flood 50+ orders
  if (!signedMap.has(orderHashLower)) {
    const ipEntries = Array.from(signedMap.entries()).filter(
      ([k, e]) =>
        k !== orderHashLower &&
        e.submittedIp === clientIp &&
        e.cachedStatus !== 'unfunded'
    );
    if (ipEntries.length >= MAX_ORDERS_PER_IP) {
      throw new HttpError(
        429,
        'RATE_LIMIT_EXCEEDED',
        `Too many active signed orders (${MAX_ORDERS_PER_IP}) submitted from this IP address.`
      );
    }
  }

  // At capacity, re-verify any cached-unfunded candidates via live multicall BEFORE evicting,
  // and exclude only open/funded closed-market haircut shortfalls from eviction.
  if (!signedMap.has(orderHashLower) && signedMap.size >= MAX_SIGNED_ORDERS) {
    const cachedUnfundedToVerify = Array.from(signedMap.entries())
      .filter(([, e]) => e.cachedStatus === 'unfunded')
      .sort((a, b) => {
        const aExp = BigInt(a[1].expiry);
        const bExp = BigInt(b[1].expiry);
        if (aExp !== bExp) return aExp < bExp ? -1 : 1;
        return (a[1].submittedAtMs ?? 0) - (b[1].submittedAtMs ?? 0);
      })
      .map(([, e]) => e)
      .slice(0, EVICTION_REFRESH_SCAN_LIMIT);

    if (cachedUnfundedToVerify.length > 0) {
      await batchRefreshRelayRecords(
        ctx,
        cachedUnfundedToVerify,
        blk.timestamp,
        blk.number,
        false,
        true
      );
      pruneDeadEntries();
    }

    const stillCachedUnfunded = Array.from(signedMap.values()).some(
      (e) => e.cachedStatus === 'unfunded'
    );
    if (!stillCachedUnfunded && signedMap.size >= MAX_SIGNED_ORDERS) {
      const probeCandidates = Array.from(signedMap.values())
        .sort((a, b) => {
          const aExp = BigInt(a.expiry);
          const bExp = BigInt(b.expiry);
          if (a.lastRefreshedAtMs !== b.lastRefreshedAtMs) {
            return a.lastRefreshedAtMs - b.lastRefreshedAtMs;
          }
          return aExp < bExp ? -1 : aExp > bExp ? 1 : 0;
        })
        .slice(0, EVICTION_REFRESH_SCAN_LIMIT);
      await batchRefreshRelayRecords(ctx, probeCandidates, blk.timestamp, blk.number, false, true);
      pruneDeadEntries();
    }
  }

  if (!signedMap.has(orderHashLower) && signedMap.size >= MAX_SIGNED_ORDERS) {
    const unfundedCandidates = Array.from(signedMap.entries())
      .filter(([, e]) => e.cachedStatus === 'unfunded')
      .sort((a, b) => {
        const aExp = BigInt(a[1].expiry);
        const bExp = BigInt(b[1].expiry);
        if (aExp !== bExp) return aExp < bExp ? -1 : 1;
        return (a[1].submittedAtMs ?? 0) - (b[1].submittedAtMs ?? 0);
      });

    if (unfundedCandidates.length > 0) {
      signedMap.delete(unfundedCandidates[0][0]);
    } else if (sameMakerEntries.length > 0) {
      const oldest = sameMakerEntries.shift();
      if (oldest) signedMap.delete(oldest[0]);
    } else {
      const nearExpiryCandidates = Array.from(signedMap.entries())
        .filter(([, e]) => {
          const hasValidShortfallExemption =
            e.cachedClosedHaircutShortfall &&
            (e.cachedStatus === 'open' || e.cachedStatus === 'partially_filled') &&
            !e.cachedFundingOverBudget;
          if (hasValidShortfallExemption) return false;
          const eExp = BigInt(e.expiry);
          return (
            eExp <= blk.timestamp + NEAR_EXPIRY_EVICTION_WINDOW_SECS &&
            (eExp < expiry || eExp <= blk.timestamp + 3600n)
          );
        })
        .sort((a, b) => {
          const aExp = BigInt(a[1].expiry);
          const bExp = BigInt(b[1].expiry);
          if (aExp !== bExp) return aExp < bExp ? -1 : 1;
          return (a[1].submittedAtMs ?? 0) - (b[1].submittedAtMs ?? 0);
        });

      if (nearExpiryCandidates.length > 0) {
        signedMap.delete(nearExpiryCandidates[0][0]);
      } else {
        throw new HttpError(
          429,
          'ORDERBOOK_CAPACITY_EXCEEDED',
          'Signed order relay has reached active capacity; retry after existing orders expire or fill.'
        );
      }
    }
  }

  const nowMs = Date.now();
  const initialStatus: LiveRelayOrderState['status'] = filled > 0n ? 'partially_filled' : 'open';
  const record: RelaySignedOrderRecord = {
    orderHash,
    orderType: input.order_type,
    maker,
    collateralToken,
    collateralSymbol,
    collateralDecimals,
    collateralAmount,
    totalUsdc: totalUsdc.toString(),
    rateBps,
    termDays,
    maxLtvBps,
    minFill: minFill.toString(),
    expiry: expiry.toString(),
    nonce: nonce.toString(),
    yieldMode,
    signedOrder: signedOrderPlain,
    signature: input.signature as Hex,
    submittedAt: new Date(nowMs).toISOString(),
    submittedIp: clientIp,
    submittedAtMs: nowMs,
    cachedFilled: filled,
    cachedCancelled: false,
    cachedMakerNonce: currentMakerNonce,
    cachedMakerBalance: makerBalance,
    cachedMakerAllowance: makerAllowance,
    cachedFundingChecked: hasFundingCheck,
    cachedFundingOverBudget: false,
    cachedCollateralCheck: input.order_type === 'borrow',
    cachedUndercollateralized: false,
    cachedOracleStale: false,
    cachedClosedHaircutShortfall: input.order_type === 'borrow' ? acceptedViaClosedShortfall : false,
    cachedRpcStale: false,
    cachedStatus: initialStatus,
    cachedBlockNumber: blk.number,
    lastRefreshedAtMs: nowMs,
  };
  signedMap.set(orderHashLower, record);

  const liveState = deriveRelayLiveState(ctx, record, blk.timestamp, blk.number);
  return {
    statusCode: 201,
    body: formatRelayOrderEnvelope(liveState, []),
  };
  });
}

function formatDbOrderRow(
  r: {
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
  },
  fillsByOrder: Map<string, unknown[]>,
  liveRelay: LiveRelayOrderState | undefined
) {
  const filled = liveRelay ? liveRelay.filled : BigInt(r.filled_usdc);
  const minUsdc = BigInt(r.min_usdc);
  const cancelled = liveRelay ? liveRelay.cancelled : r.cancelled;
  const remaining = minUsdc > filled ? minUsdc - filled : 0n;
  const derivedStatus = cancelled
    ? 'cancelled'
    : liveRelay?.nonceBumped
      ? 'nonce_bumped'
      : minUsdc === 0n
        ? 'unknown'
        : filled >= minUsdc
          ? 'filled'
          : liveRelay?.unfunded
            ? 'unfunded'
            : liveRelay && filled === 0n && !liveRelay.expired
              ? 'open'
              : 'partially_filled';

  const baseRow: Record<string, unknown> = {
    order_hash: r.order_hash,
    maker: getAddress(r.maker),
    order_type: r.order_type,
    collateral_token: r.collateral_token ? getAddress(r.collateral_token) : null,
    collateral_symbol: r.collateral_symbol,
    status: derivedStatus,
    min_usdc: formatAmount(minUsdc, USDC_DECIMALS, 'USDC'),
    filled_usdc: formatAmount(filled, USDC_DECIMALS, 'USDC'),
    remaining_usdc: minUsdc > 0n ? formatAmount(remaining, USDC_DECIMALS, 'USDC') : null,
    cancelled,
    maker_nonce: r.maker_nonce,
    fills_count: Number(r.fills_count),
    fills: fillsByOrder.get(r.order_hash) ?? [],
    first_seen_block: r.first_seen_block,
    last_updated_block: r.last_updated_block,
  };

  if (liveRelay) {
    const rec = liveRelay.record;
    baseRow.collateral_amount = rec.collateralAmount
      ? formatAmount(BigInt(rec.collateralAmount), rec.collateralDecimals, rec.collateralSymbol ?? undefined)
      : null;
    baseRow.rate_bps = rec.rateBps;
    if (rec.orderType === 'borrow') {
      baseRow.max_rate_bps = rec.rateBps;
    } else {
      baseRow.min_rate_bps = rec.rateBps;
      baseRow.allowed_collateral = rec.collateralToken ?? zeroAddress;
    }
    baseRow.term_days = rec.termDays;
    baseRow.max_ltv_bps = rec.maxLtvBps;
    baseRow.min_fill = formatAmount(BigInt(rec.minFill), USDC_DECIMALS, 'USDC');
    baseRow.expiry = rec.expiry;
    baseRow.nonce = rec.nonce;
    baseRow.current_maker_nonce = liveRelay.currentMakerNonce.toString();
    baseRow.yield_mode = rec.yieldMode;
    baseRow.signed_order = rec.signedOrder;
    baseRow.signature = rec.signature;
    baseRow.submitted_at = rec.submittedAt;
    baseRow.unfunded = liveRelay.unfunded;
    baseRow.undercollateralized = liveRelay.undercollateralized;
    baseRow.fillable_when_market_opens = liveRelay.fillableWhenMarketOpens;
    baseRow.stale = liveRelay.stale;
  }

  return baseRow;
}

async function handleOrders(ctx: ApiContext, queryObj: Record<string, string>) {
  const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
  const filters = parseOrThrow(ordersQuerySchema, queryObj);
  const meta = await getSnapshotMeta(ctx);
  const signedMap = getSignedOrdersMap(ctx);

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

  if (filters.order_type) {
    params.push(filters.order_type);
    conditions.push(`LOWER(o.order_type) = LOWER($${params.length})`);
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
  const hasSignedOrders = signedMap.size > 0;

  type DbOrderRow = {
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
  };

  const fetchFillsMap = async (hashes: string[]) => {
    const fillsByOrder = new Map<string, unknown[]>();
    if (hashes.length === 0) return fillsByOrder;
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
    return fillsByOrder;
  };

  const countRes = await ctx.db.query<{ cnt: number }>(
    `SELECT COUNT(*)::INT AS cnt FROM orders o ${whereClause}`,
    params
  );
  const dbTotal = Number(countRes.rows[0]?.cnt ?? 0);

  if (!hasSignedOrders) {
    const dataParams = [...params, pag.limit, pag.offset];
    const rowsRes = await ctx.db.query<DbOrderRow>(
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
    const fillsByOrder = await fetchFillsMap(rowsRes.rows.map((r) => r.order_hash));
    const data = rowsRes.rows.map((r) => formatDbOrderRow(r, fillsByOrder, undefined));
    return {
      statusCode: 200,
      body: {
        ...meta,
        pagination: buildPaginationEnvelope(pag.limit, pag.offset, data.length, dbTotal),
        data,
      },
    };
  }

  // Merge verified signed relay orders using batched multicall capped to requested page + TTL cache + DB LIMIT
  const blk = await getLatestBlockForRelay(ctx, BigInt(meta.block_number || '0'));

  const filterMatchedRelays: RelaySignedOrderRecord[] = [];
  for (const rec of signedMap.values()) {
    if (filters.maker && rec.maker.toLowerCase() !== filters.maker.toLowerCase()) continue;
    if (filters.order_type && rec.orderType !== filters.order_type) continue;
    if (filters.asset) {
      if (rec.orderType === 'borrow') {
        if (!rec.collateralToken || rec.collateralToken.toLowerCase() !== filters.asset.toLowerCase()) continue;
      } else if (rec.collateralToken && rec.collateralToken.toLowerCase() !== filters.asset.toLowerCase()) {
        continue;
      }
    }
    filterMatchedRelays.push(rec);
  }

  // Determine which filtered relays are already indexed in ctx.db.orders (bounded chunks, zero full-table scan)
  const indexedRelayHashSet = new Set<string>();
  if (filterMatchedRelays.length > 0 && dbTotal > 0) {
    const relayHashes = filterMatchedRelays.map((r) => r.orderHash.toLowerCase());
    for (let i = 0; i < relayHashes.length; i += 500) {
      const chunk = relayHashes.slice(i, i + 500);
      const ph = chunk.map((_, idx) => `$${idx + 1}`).join(', ');
      const idxHitRes = await ctx.db.query<{ h: string }>(
        `SELECT LOWER(order_hash) AS h FROM orders WHERE LOWER(order_hash) IN (${ph})`,
        chunk
      );
      for (const row of idxHitRes.rows) {
        indexedRelayHashSet.add(row.h);
      }
    }
  }

  const relayOnlyCandidates = filterMatchedRelays.filter(
    (rec) => !indexedRelayHashSet.has(rec.orderHash.toLowerCase())
  );

  // If the filtered candidate list is small (<= 100), refresh them all in one multicall so status filters & counts are exact.
  // If > 100 (e.g. 2000 relayed orders), refresh the requested page slice PLUS a capped oldest-refreshed slice
  // of cached-unfunded records so recovered orders return to open automatically without unbounded RPC work.
  let relayRefreshStale = blk.rpcFailed;
  if (relayOnlyCandidates.length <= 100) {
    if (await batchRefreshRelayRecords(ctx, relayOnlyCandidates, blk.timestamp, blk.number, blk.rpcFailed)) {
      relayRefreshStale = true;
    }
  } else {
    const tentativeActive = relayOnlyCandidates.filter((rec) => {
      const st = deriveRelayLiveState(ctx, rec, blk.timestamp, blk.number);
      if (filters.status) return st.status === filters.status;
      if (filters.include_inactive) return true;
      return st.status === 'open' || st.status === 'partially_filled';
    });
    const pageCandidates = tentativeActive.slice(pag.offset, pag.offset + pag.limit);
    const pageHashSet = new Set(pageCandidates.map((r) => r.orderHash.toLowerCase()));
    const cachedUnfundedSlice = relayOnlyCandidates
      .filter(
        (r) =>
          (r.cachedStatus === 'unfunded' ||
            r.cachedClosedHaircutShortfall ||
            r.cachedOracleStale) &&
          !pageHashSet.has(r.orderHash.toLowerCase())
      )
      .sort((a, b) => (a.lastRefreshedAtMs ?? 0) - (b.lastRefreshedAtMs ?? 0))
      .slice(0, UNFUNDED_REFRESH_SLICE);
    const refreshBatch = [...pageCandidates, ...cachedUnfundedSlice];
    if (await batchRefreshRelayRecords(ctx, refreshBatch, blk.timestamp, blk.number, blk.rpcFailed)) {
      relayRefreshStale = true;
    }
  }

  const relayOnlyStates = relayOnlyCandidates
    .map((rec) => deriveRelayLiveState(ctx, rec, blk.timestamp, blk.number))
    .filter((live) => {
      if (filters.status) return live.status === filters.status;
      if (filters.include_inactive) return true;
      return live.status === 'open' || live.status === 'partially_filled';
    });

  const relayCount = relayOnlyStates.length;
  const total = relayCount + dbTotal;
  const relaySlice = relayOnlyStates.slice(pag.offset, pag.offset + pag.limit);
  const neededFromDb = Math.max(0, pag.limit - relaySlice.length);
  const dbOffset = Math.max(0, pag.offset - relayCount);

  let dbRows: DbOrderRow[] = [];
  if (neededFromDb > 0 && dbTotal > dbOffset) {
    const dataParams = [...params, neededFromDb, dbOffset];
    const rowsRes = await ctx.db.query<DbOrderRow>(
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
    dbRows = rowsRes.rows;
  }

  const dbRelaysOnPage = dbRows
    .map((r) => signedMap.get(r.order_hash.toLowerCase()))
    .filter((r): r is RelaySignedOrderRecord => Boolean(r));
  if (dbRelaysOnPage.length > 0) {
    if (await batchRefreshRelayRecords(ctx, dbRelaysOnPage, blk.timestamp, blk.number, blk.rpcFailed)) {
      relayRefreshStale = true;
    }
  }
  const dbRelayStates = new Map<string, LiveRelayOrderState>();
  for (const rec of dbRelaysOnPage) {
    dbRelayStates.set(rec.orderHash.toLowerCase(), deriveRelayLiveState(ctx, rec, blk.timestamp, blk.number));
  }

  const fillsByOrder = await fetchFillsMap(dbRows.map((r) => r.order_hash));
  const dbFormatted = dbRows.map((r) =>
    formatDbOrderRow(r, fillsByOrder, dbRelayStates.get(r.order_hash.toLowerCase()))
  );

  const pageData = [
    ...relaySlice.map((live) => formatRelayOrderEnvelope(live, [])),
    ...dbFormatted,
  ];
  const anyPageRelayStale =
    relayRefreshStale ||
    relaySlice.some((live) => live.stale) ||
    Array.from(dbRelayStates.values()).some((live) => live.stale);

  return {
    statusCode: 200,
    body: {
      ...meta,
      stale: anyPageRelayStale,
      relay_stale: anyPageRelayStale,
      pagination: buildPaginationEnvelope(pag.limit, pag.offset, pageData.length, total),
      data: pageData,
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

/**
 * Refreshes up to BG_REFRESH_BATCH_LIMIT (100) cached unfunded, closed-haircut-shortfall,
 * or oracle-stale relay records per invocation so recovered or reopened orders update without
 * waiting for paginated GET /orders requests.
 */
export async function runRelayBackgroundRefresh(ctx: ApiContext): Promise<number> {
  const signedMap = getSignedOrdersMap(ctx);
  if (signedMap.size === 0) return 0;

  const candidates = Array.from(signedMap.values())
    .filter(
      (r) =>
        r.cachedStatus === 'unfunded' ||
        r.cachedClosedHaircutShortfall ||
        r.cachedOracleStale
    )
    .sort((a, b) => (a.lastRefreshedAtMs ?? 0) - (b.lastRefreshedAtMs ?? 0))
    .slice(0, BG_REFRESH_BATCH_LIMIT);

  if (candidates.length === 0) return 0;

  const blk = await getLatestBlockForRelay(ctx, 0n);
  if (blk.rpcFailed) return 0;

  await batchRefreshRelayRecords(ctx, candidates, blk.timestamp, blk.number, false, true);
  return candidates.length;
}

export function createApiServer(ctx: ApiContext): http.Server {
  const rateLimiter = new IpRateLimiter(
    ctx.config.rateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );
  const bgIntervalMs = ctx.relayBgRefreshIntervalMs ?? BG_REFRESH_INTERVAL_MS;
  let bgRefreshInFlight = false;
  const bgRefreshTimer =
    bgIntervalMs > 0
      ? setInterval(() => {
          if (bgRefreshInFlight) return;
          bgRefreshInFlight = true;
          void runRelayBackgroundRefresh(ctx)
            .catch(() => {})
            .finally(() => {
              bgRefreshInFlight = false;
            });
        }, bgIntervalMs)
      : null;
  bgRefreshTimer?.unref();

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

      if (pathname === '/orders' && req.method === 'POST') {
        const rawBody = await readJsonBody(req, Math.min(ctx.config.maxBodyBytes, 16_384));
        const result = await handlePostOrder(ctx, rawBody, clientIp);
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
    if (bgRefreshTimer) clearInterval(bgRefreshTimer);
    rateLimiter.close();
  });

  return server;
}
