import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Address, type Chain, type PublicClient, type Transport, createPublicClient, defineChain, getAddress, http as viemHttp } from 'viem';
import { base } from 'viem/chains';
import { ZodError } from 'zod';
import {
  ASSET_STATUS_NAMES,
  AUCTION_STATUS_NAMES,
  LOAN_STATUS_NAMES,
  ORACLE_STATE_NAMES,
  OracleState,
  assetRegistryAbi,
  erc20MetaAbi,
  loanCoreAbi,
  oracleRouterAbi,
} from './abi.js';
import type { ApiConfig } from './config.js';
import { type ReadOnlyDatabase, openReadOnlyDatabase, toBigInt } from './db.js';
import { formatAmount, formatRawString } from './format.js';
import { computeLoanQuote } from './quote.js';
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

export interface ApiContext {
  config: ApiConfig;
  publicClient: PublicClient<Transport, Chain>;
  db: ReadOnlyDatabase;
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

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(ip: string): { allowed: boolean; remaining: number; resetEpochSec: number; retryAfterSec: number } {
    const now = Date.now();
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets.entries()) {
        if (b.resetAtMs <= now) this.buckets.delete(k);
      }
    }

    let bucket = this.buckets.get(ip);
    if (!bucket || bucket.resetAtMs <= now) {
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
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'Malformed JSON request body'));
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
  } else if (filters.status === 'filled') {
    conditions.push('o.cancelled = FALSE AND o.filled_usdc > 0');
  } else if (filters.status === 'open') {
    conditions.push('o.cancelled = FALSE AND o.filled_usdc = 0');
  }

  if (filters.maker) {
    params.push(filters.maker);
    conditions.push(`LOWER(o.maker) = LOWER($${params.length})`);
  }

  if (filters.asset) {
    params.push(filters.asset);
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM order_fills ofi
        JOIN loans l ON l.loan_id = ofi.loan_id
        WHERE ofi.order_hash = o.order_hash
          AND LOWER(l.collateral_token) = LOWER($${params.length})
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
    filled_usdc: string;
    cancelled: boolean;
    maker_nonce: string;
    first_seen_block: string;
    last_updated_block: string;
    fills_count: number;
  }>(
    `SELECT
       o.order_hash,
       o.maker,
       o.filled_usdc::TEXT AS filled_usdc,
       o.cancelled,
       o.maker_nonce::TEXT AS maker_nonce,
       o.first_seen_block::TEXT AS first_seen_block,
       o.last_updated_block::TEXT AS last_updated_block,
       (SELECT COUNT(*)::INT FROM order_fills ofi WHERE ofi.order_hash = o.order_hash) AS fills_count
     FROM orders o
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
    const derivedStatus = r.cancelled ? 'cancelled' : filled > 0n ? 'filled' : 'open';
    return {
      order_hash: r.order_hash,
      maker: getAddress(r.maker),
      status: derivedStatus,
      filled_usdc: formatAmount(filled, USDC_DECIMALS, 'USDC'),
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

  const chainHead = await ctx.publicClient.getBlockNumber();
  const [globalCap, totalOutstanding] = await Promise.all([
    ctx.publicClient.readContract({
      address: ctx.config.loanCore,
      abi: loanCoreAbi,
      functionName: 'globalUsdcCap',
      blockNumber: chainHead,
    }),
    ctx.publicClient.readContract({
      address: ctx.config.loanCore,
      abi: loanCoreAbi,
      functionName: 'totalOutstandingPrincipal',
      blockNumber: chainHead,
    }),
  ]);

  const data = await Promise.all(
    rowsRes.rows.map(async (r) => {
      const tokenAddr = getAddress(r.token);
      const tokenDecimals = r.decimals !== null ? Number(r.decimals) : 18;
      const feedDecimalsDefault = r.feed_decimals !== null ? Number(r.feed_decimals) : FEED_DECIMALS_DEFAULT;

      let livePrice = 0n;
      let livePriceDec = feedDecimalsDefault;
      let oracleState: number = OracleState.STALE_FEED;
      let assetOutstanding = 0n;
      let liveRecMult = r.recorded_multiplier ? toBigInt(r.recorded_multiplier) : 0n;
      let liveUiMult: bigint | null = null;
      let livePerLoanCap = r.per_loan_cap ? toBigInt(r.per_loan_cap) : 0n;
      let liveAssetCap = r.asset_cap ? toBigInt(r.asset_cap) : 0n;
      let liveStatus = r.status !== null ? Number(r.status) : 0;

      try {
        const [supported, assetOut, recMult] = await Promise.all([
          ctx.publicClient.readContract({
            address: ctx.config.assetRegistry,
            abi: assetRegistryAbi,
            functionName: 'isAssetSupported',
            args: [tokenAddr],
            blockNumber: chainHead,
          }),
          ctx.publicClient.readContract({
            address: ctx.config.loanCore,
            abi: loanCoreAbi,
            functionName: 'assetOutstandingPrincipal',
            args: [tokenAddr],
            blockNumber: chainHead,
          }),
          ctx.publicClient.readContract({
            address: ctx.config.oracleRouter,
            abi: oracleRouterAbi,
            functionName: 'recordedMultiplier',
            args: [tokenAddr],
            blockNumber: chainHead,
          }),
        ]);
        assetOutstanding = assetOut;
        liveRecMult = recMult;

        if (supported) {
          const [cfg, priceRes] = await Promise.all([
            ctx.publicClient.readContract({
              address: ctx.config.assetRegistry,
              abi: assetRegistryAbi,
              functionName: 'getAssetConfig',
              args: [tokenAddr],
              blockNumber: chainHead,
            }),
            ctx.publicClient.readContract({
              address: ctx.config.oracleRouter,
              abi: oracleRouterAbi,
              functionName: 'getPrice',
              args: [tokenAddr],
              blockNumber: chainHead,
            }),
          ]);
          livePerLoanCap = cfg.perLoanCap;
          liveAssetCap = cfg.assetCap;
          liveStatus = Number(cfg.status);
          livePrice = priceRes[0];
          livePriceDec = Number(priceRes[1]);
          oracleState = Number(priceRes[2]);
        }
      } catch {
        // Keep DB snapshot fields if an unlisted/legacy token cannot be read onchain
      }

      try {
        liveUiMult = await ctx.publicClient.readContract({
          address: tokenAddr,
          abi: erc20MetaAbi,
          functionName: 'uiMultiplier',
          blockNumber: chainHead,
        });
      } catch {
        liveUiMult = null;
      }

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
    })
  );

  return {
    statusCode: 200,
    body: {
      ...meta,
      live_block_number: chainHead.toString(),
      pagination: buildPaginationEnvelope(pag.limit, pag.offset, data.length, total),
      data,
    },
  };
}

export function createApiServer(ctx: ApiContext): http.Server {
  const rateLimiter = new IpRateLimiter(ctx.config.rateLimitMax, ctx.config.rateLimitWindowMs);

  return http.createServer(async (req, res) => {
    setCorsHeaders(req, res, ctx.config.corsOrigins);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const clientIp = req.socket.remoteAddress ?? 'unknown';
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

      const knownPaths = new Set(['/health', '/orders', '/loans', '/positions', '/auctions', '/assets', '/quote']);
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
}
