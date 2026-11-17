import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Address, type Hex, getAddress } from 'viem';
import { ZodError } from 'zod/v3';
import { resolveAndValidateWebhookTarget, validateChannelTarget } from './channels.js';
import {
  hashVerificationCode,
  maskTarget,
  signBlockSenderToken,
  signConfirmSubscriptionToken,
  signSessionToken,
  signUnsubscribeToken,
  verifyBlockSenderToken,
  verifyConfirmSubscriptionToken,
  verifySessionTokenClaims,
  verifyUnsubscribeToken,
} from './crypto.js';
import { type NotificationsContext, defaultPreferencesMap } from './engine.js';
import { issueSiweNonce, verifySiweAuth } from './siwe.js';
import {
  blockSenderSchema,
  buildPaginationSchema,
  confirmSubscriptionSchema,
  createSubscriptionSchema,
  nonceRequestSchema,
  redriveDeadLettersSchema,
  siweVerifyRequestSchema,
  unsubscribeBodySchema,
  updatePreferencesSchema,
} from './validation.js';

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
      const now = Date.now();
      for (const [k, b] of this.buckets.entries()) {
        if (b.resetAtMs <= now) this.buckets.delete(k);
      }
    }, sweepIntervalMs);
    this.evictionTimer.unref();
  }

  check(key: string): { allowed: boolean; remaining: number; resetEpochSec: number; retryAfterSec: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (bucket && bucket.resetAtMs <= now) {
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        return {
          allowed: false,
          remaining: 0,
          resetEpochSec: Math.ceil((now + this.windowMs) / 1000),
          retryAfterSec: Math.max(1, Math.ceil(this.windowMs / 1000)),
        };
      }
      bucket = { count: 0, resetAtMs: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    return {
      allowed: bucket.count <= this.maxRequests,
      remaining: Math.max(0, this.maxRequests - bucket.count),
      resetEpochSec: Math.ceil(bucket.resetAtMs / 1000),
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000)),
    };
  }

  refund(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.count > 0) {
      bucket.count -= 1;
    }
  }

  close(): void {
    clearInterval(this.evictionTimer);
  }
}

function resolveClientIp(req: IncomingMessage, trustProxyHops: number): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (trustProxyHops <= 0) return remote;
  const xff = req.headers['x-forwarded-for'];
  const headerStr = Array.isArray(xff) ? xff.join(',') : xff;
  if (!headerStr || headerStr.trim().length === 0) return remote;
  const ips = headerStr.split(',').map((s) => s.trim()).filter(Boolean);
  if (ips.length === 0) return remote;
  const idx = ips.length >= trustProxyHops ? ips.length - trustProxyHops : 0;
  return ips[idx];
}

function setSecurityHeaders(res: ServerResponse, isHtml = false): void {
  res.setHeader(
    'Content-Security-Policy',
    isHtml
      ? "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none';"
      : "default-src 'none'; frame-ancestors 'none';"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): void {
  const reqOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (reqOrigin && allowedOrigins.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  setSecurityHeaders(res, false);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  setSecurityHeaders(res, false);
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prefersHtmlResponse(req: IncomingMessage): boolean {
  const accept = typeof req.headers.accept === 'string' ? req.headers.accept : '';
  return accept.includes('text/html') && !accept.includes('application/json');
}

function sendHtmlPage(res: ServerResponse, statusCode: number, title: string, bodyHtml: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  setSecurityHeaders(res, true);
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;background:#f7f5f0;color:#1b1a17}main{background:#fff;border:1px solid #dedad2;border-radius:10px;padding:24px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;margin:0 0 16px}code{background:#f1eee8;padding:2px 6px;border-radius:4px;font-size:13px}.actions{display:flex;flex-wrap:wrap;gap:10px}button{cursor:pointer;padding:10px 16px;border-radius:8px;border:1px solid #1b1a17;background:#1b1a17;color:#fff;font-size:14px;font-weight:600}button.secondary{background:#fff;color:#1b1a17}button.danger{background:#9f1239;border-color:#9f1239}</style></head><body><main>${bodyHtml}</main></body></html>`
  );
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds maximum of ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw).entries()) {
      out[k] = v;
    }
    return out;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Malformed JSON request body');
  }
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
    throw new HttpError(400, 'VALIDATION_ERROR', issues[0]?.message ?? 'Invalid request', issues);
  }
  return result.data;
}

function urlSearchParamsToObject(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of sp.entries()) out[k] = v;
  return out;
}

function enforceScopedRateLimit(
  res: ServerResponse,
  limiter: IpRateLimiter,
  key: string,
  scopeLabel: string
): void {
  const r = limiter.check(key);
  if (!r.allowed) {
    res.setHeader('Retry-After', String(r.retryAfterSec));
    throw new HttpError(
      429,
      'RATE_LIMIT_EXCEEDED',
      `Rate limit exceeded for ${scopeLabel}; retry later.`
    );
  }
}

interface AuthenticatedCaller {
  wallet: Address;
  jti?: string;
  exp?: number;
}

async function authenticateRequest(
  req: IncomingMessage,
  ctx: NotificationsContext,
  body?: unknown
): Promise<AuthenticatedCaller> {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    let claims: { wallet: string; jti: string; exp: number };
    try {
      claims = verifySessionTokenClaims(ctx.config.sessionSecret, token);
    } catch (err) {
      throw new HttpError(401, 'UNAUTHORIZED', err instanceof Error ? err.message : 'Invalid session token');
    }
    const rev = await ctx.notifDb.query<{ jti: string }>(
      'SELECT jti FROM notif_revoked_sessions WHERE jti = $1',
      [claims.jti]
    );
    if (rev.rows.length > 0) {
      throw new HttpError(401, 'SESSION_REVOKED', 'Session token has been revoked');
    }
    return { wallet: getAddress(claims.wallet), jti: claims.jti, exp: claims.exp };
  }

  // Allow direct SIWE payload when present in request body { siwe: { message, signature } }
  if (body && typeof body === 'object' && 'siwe' in body) {
    const siweRaw = (body as { siwe?: unknown }).siwe;
    const parsedSiwe = parseOrThrow(siweVerifyRequestSchema, siweRaw);
    try {
      const wallet = await verifySiweAuth(
        ctx.publicClient,
        ctx.notifDb,
        ctx.config,
        parsedSiwe.message,
        parsedSiwe.signature as Hex
      );
      return { wallet };
    } catch (err) {
      throw new HttpError(401, 'UNAUTHORIZED', err instanceof Error ? err.message : 'SIWE verification failed');
    }
  }

  throw new HttpError(401, 'UNAUTHORIZED', 'Missing Authorization Bearer token or SIWE signature');
}

export const MIN_SYBIL_COST_ETH_WEI = 10_000_000_000_000_000n; // 0.01 ETH on Base
const SYBIL_COST_CACHE_TTL_MS = 15_000;
const SYBIL_COST_CACHE_MAX_ENTRIES = 10_000;
const BLOCK_EXISTING_SUBS_NOTE =
  'Blocking prevents new subscription requests and removes unverified pending requests, but does NOT stop existing verified subscriptions (use the alert email unsubscribe link or Wallet settings to disable those).';

type SybilCostCacheEntry = { qualified: boolean; expiresAtMs: number };

function blockTokenJti(rawToken: string): string {
  return 'blk_' + crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex').slice(0, 48);
}

async function hasOnchainSybilCost(
  ctx: NotificationsContext,
  wallet: Address,
  cache?: Map<string, SybilCostCacheEntry>
): Promise<boolean> {
  const walletLower = wallet.toLowerCase();
  const nowMs = Date.now();
  if (cache) {
    const cached = cache.get(walletLower);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.qualified;
    }
    cache.delete(walletLower);
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const rpcCheck = ctx.publicClient.getBalance({ address: wallet });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('sybil cost RPC check timeout')), 2500);
    });
    const bal = await Promise.race([rpcCheck, timeout]);
    const qualified = bal >= MIN_SYBIL_COST_ETH_WEI;
    if (cache) {
      if (cache.size >= SYBIL_COST_CACHE_MAX_ENTRIES) {
        for (const [k, v] of cache.entries()) {
          if (v.expiresAtMs <= nowMs) cache.delete(k);
        }
        if (cache.size >= SYBIL_COST_CACHE_MAX_ENTRIES) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey) cache.delete(oldestKey);
        }
      }
      cache.set(walletLower, {
        qualified,
        expiresAtMs: nowMs + SYBIL_COST_CACHE_TTL_MS,
      });
    }
    return qualified;
  } catch {
    // Keep strict global cap whenever RPC is unreachable/errors; never cache RPC errors.
    cache?.delete(walletLower);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createNotificationsServer(ctx: NotificationsContext): http.Server {
  const rateLimiter = new IpRateLimiter(
    ctx.config.rateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );
  const nonceIpLimiter = new IpRateLimiter(
    ctx.config.authNonceRateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );
  const verifyIpLimiter = new IpRateLimiter(
    ctx.config.authVerifyRateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );
  const verifyWalletLimiter = new IpRateLimiter(
    ctx.config.authVerifyRateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );
  const subIpLimiter = new IpRateLimiter(
    ctx.config.subscriptionsRateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );
  const subWalletLimiter = new IpRateLimiter(
    ctx.config.subscriptionsRateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );
  const confirmTargetWalletLimiter = new IpRateLimiter(
    ctx.config.confirmTargetPerHourMax,
    3_600_000,
    ctx.config.rateLimitMaxBuckets
  );
  const confirmTargetIpLimiter = new IpRateLimiter(
    ctx.config.confirmTargetPerHourMax,
    3_600_000,
    ctx.config.rateLimitMaxBuckets
  );
  const confirmTargetGlobalLimiter = new IpRateLimiter(
    ctx.config.confirmTargetGlobalPerHourMax,
    3_600_000,
    ctx.config.rateLimitMaxBuckets
  );
  const sybilCostCache = new Map<string, SybilCostCacheEntry>();
  const confirmTargetResendLimiter = new IpRateLimiter(
    Math.max(1, Math.min(3, Math.floor(ctx.config.confirmTargetGlobalPerHourMax / 2))),
    3_600_000,
    ctx.config.rateLimitMaxBuckets
  );
  const pendingWalletsByTarget = new Map<string, { wallets: Set<string>; resetAtMs: number }>();
  const pendingWalletsTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingWalletsByTarget.entries()) {
      if (v.resetAtMs <= now) pendingWalletsByTarget.delete(k);
    }
  }, 60_000);
  pendingWalletsTimer.unref();
  const confirmIpLimiter = new IpRateLimiter(
    ctx.config.confirmRateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );
  const confirmWalletLimiter = new IpRateLimiter(
    ctx.config.confirmRateLimitMax,
    ctx.config.rateLimitWindowMs,
    ctx.config.rateLimitMaxBuckets
  );
  const confirmSubLimiter = new IpRateLimiter(
    ctx.config.confirmRateLimitMax,
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

    const contentLengthHeader = req.headers['content-length'];
    if (contentLengthHeader !== undefined) {
      const len = Number(contentLengthHeader);
      if (!Number.isNaN(len) && len > ctx.config.maxBodyBytes) {
        sendJson(res, 413, {
          error: { code: 'PAYLOAD_TOO_LARGE', message: `Request exceeds ${ctx.config.maxBodyBytes} bytes` },
        });
        return;
      }
    }

    const clientIp = resolveClientIp(req, ctx.config.trustProxyHops);
    const rl = rateLimiter.check(clientIp);
    res.setHeader('X-RateLimit-Limit', String(ctx.config.rateLimitMax));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(rl.resetEpochSec));

    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendJson(res, 429, {
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests; retry later.' },
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
        let notifDbOk = false;
        let indexerDbOk = false;
        try {
          await ctx.notifDb.query('SELECT 1 AS ok');
          notifDbOk = true;
        } catch {
          notifDbOk = false;
        }
        try {
          await ctx.indexerDb.query('SELECT 1 AS ok');
          indexerDbOk = true;
        } catch {
          indexerDbOk = false;
        }
        sendJson(res, notifDbOk && indexerDbOk ? 200 : 503, {
          status: notifDbOk && indexerDbOk ? 'ok' : 'degraded',
          notif_db_ok: notifDbOk,
          indexer_db_ok: indexerDbOk,
          cycle_count: ctx.state.cycleCount,
          last_sync_timestamp: ctx.state.lastSyncTimestamp,
        });
        return;
      }

      if (pathname === '/auth/nonce' && req.method === 'POST') {
        enforceScopedRateLimit(res, nonceIpLimiter, clientIp, '/auth/nonce IP');
        const body = parseOrThrow(nonceRequestSchema, await readJsonBody(req, ctx.config.maxBodyBytes));
        const issued = await issueSiweNonce(ctx.notifDb, body.wallet_address, ctx.config);
        sendJson(res, 200, {
          nonce: issued.nonce,
          domain: ctx.config.siweDomain,
          uri: ctx.config.siweUri,
          chain_id: ctx.config.isFork ? ctx.config.forkChainId : 8453,
          expires_at: issued.expiresAt,
        });
        return;
      }

      if (pathname === '/auth/verify' && req.method === 'POST') {
        enforceScopedRateLimit(res, verifyIpLimiter, clientIp, '/auth/verify IP');
        const body = parseOrThrow(siweVerifyRequestSchema, await readJsonBody(req, ctx.config.maxBodyBytes));
        let wallet: Address;
        try {
          wallet = await verifySiweAuth(
            ctx.publicClient,
            ctx.notifDb,
            ctx.config,
            body.message,
            body.signature as Hex
          );
        } catch (err) {
          throw new HttpError(401, 'UNAUTHORIZED', err instanceof Error ? err.message : 'SIWE authentication failed');
        }
        // Apply per-wallet limiter ONLY after SIWE signature verification succeeds (prevents attacker DoS lockout)
        enforceScopedRateLimit(res, verifyWalletLimiter, wallet.toLowerCase(), '/auth/verify wallet');
        const sess = signSessionToken(ctx.config.sessionSecret, wallet, ctx.config.sessionTtlSecs);
        sendJson(res, 200, {
          wallet_address: wallet,
          token: sess.token,
          jti: sess.jti,
          expires_at: sess.expiresAt,
        });
        return;
      }

      if (pathname === '/auth/logout' && req.method === 'POST') {
        const caller = await authenticateRequest(req, ctx);
        if (!caller.jti || !caller.exp) {
          throw new HttpError(400, 'VALIDATION_ERROR', 'Bearer session token required for logout');
        }
        const nowSec = Math.floor(Date.now() / 1000);
        await ctx.notifDb.query(
          `INSERT INTO notif_revoked_sessions (jti, wallet, expires_at, revoked_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (jti) DO NOTHING`,
          [caller.jti, caller.wallet.toLowerCase(), caller.exp.toString(), nowSec.toString()]
        );
        await ctx.notifDb.query('DELETE FROM notif_revoked_sessions WHERE expires_at < $1', [
          (nowSec - 3600).toString(),
        ]);
        sendJson(res, 200, { revoked: true, jti: caller.jti });
        return;
      }

      if (pathname === '/unsubscribe' && req.method === 'GET') {
        const rawToken = parseOrThrow(unsubscribeBodySchema, { token: queryObj.token }).token;
        let verified: { subId: string; wallet: string };
        try {
          verified = verifyUnsubscribeToken(ctx.config.unsubscribeSecret, rawToken);
        } catch (err) {
          throw new HttpError(400, 'INVALID_UNSUBSCRIBE_TOKEN', err instanceof Error ? err.message : 'Invalid token');
        }
        const found = await ctx.notifDb.query<{ id: string }>(
          'SELECT id FROM notif_subscriptions WHERE id = $1 AND LOWER(wallet) = LOWER($2)',
          [verified.subId, verified.wallet]
        );
        if (found.rows.length === 0) {
          throw new HttpError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found or already deleted');
        }
        sendJson(res, 200, {
          confirmation_required: true,
          method: 'POST',
          subscription_id: verified.subId,
          wallet_address: getAddress(verified.wallet),
        });
        return;
      }

      if (pathname === '/unsubscribe' && req.method === 'POST') {
        const rawBody = await readJsonBody(req, ctx.config.maxBodyBytes);
        const bodyObj =
          rawBody && typeof rawBody === 'object' && 'token' in rawBody
            ? rawBody
            : { token: queryObj.token };
        const rawToken = parseOrThrow(unsubscribeBodySchema, bodyObj).token;
        let verified: { subId: string; wallet: string };
        try {
          verified = verifyUnsubscribeToken(ctx.config.unsubscribeSecret, rawToken);
        } catch (err) {
          throw new HttpError(400, 'INVALID_UNSUBSCRIBE_TOKEN', err instanceof Error ? err.message : 'Invalid token');
        }
        const upd = await ctx.notifDb.query<{ id: string }>(
          `UPDATE notif_subscriptions
           SET enabled = FALSE, updated_at = NOW()
           WHERE id = $1 AND LOWER(wallet) = LOWER($2)
           RETURNING id`,
          [verified.subId, verified.wallet]
        );
        if (upd.rows.length === 0) {
          throw new HttpError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found or already deleted');
        }
        sendJson(res, 200, {
          unsubscribed: true,
          subscription_id: verified.subId,
          wallet_address: getAddress(verified.wallet),
        });
        return;
      }

      if (pathname === '/subscriptions' && req.method === 'POST') {
        enforceScopedRateLimit(res, subIpLimiter, clientIp, '/subscriptions IP');
        const rawBody = await readJsonBody(req, ctx.config.maxBodyBytes);
        const caller = await authenticateRequest(req, ctx, rawBody);
        const wallet = caller.wallet;
        enforceScopedRateLimit(res, subWalletLimiter, wallet.toLowerCase(), '/subscriptions wallet');
        const input = parseOrThrow(createSubscriptionSchema, rawBody);

        let normalizedTarget: string;
        try {
          normalizedTarget = validateChannelTarget(
            input.channel,
            input.target,
            ctx.config.allowedWebhookPorts
          );
          if (input.channel === 'webhook') {
            await resolveAndValidateWebhookTarget(
              normalizedTarget,
              ctx.dnsLookup,
              ctx.config.allowedWebhookPorts
            );
          }
        } catch (err) {
          throw new HttpError(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid target');
        }

        const encrypted = ctx.cipher.encrypt(normalizedTarget);
        const targetHash = ctx.cipher.computeTargetHash(wallet, input.channel, normalizedTarget);

        const existingSub = await ctx.notifDb.query<{ id: string; verified: boolean }>(
          'SELECT id, verified FROM notif_subscriptions WHERE wallet = $1 AND channel = $2 AND target_hash = $3',
          [wallet.toLowerCase(), input.channel, targetHash]
        );
        if (existingSub.rows.length === 0) {
          const cntRes = await ctx.notifDb.query<{ cnt: number }>(
            'SELECT COUNT(*)::INT AS cnt FROM notif_subscriptions WHERE wallet = $1',
            [wallet.toLowerCase()]
          );
          if (Number(cntRes.rows[0]?.cnt ?? 0) >= ctx.config.maxSubscriptionsPerWallet) {
            throw new HttpError(
              400,
              'SUBSCRIPTION_LIMIT_EXCEEDED',
              `Wallet reached maximum cap of ${ctx.config.maxSubscriptionsPerWallet} subscriptions`
            );
          }
        }

        const isWebhook = input.channel === 'webhook';
        const canonicalTargetHash = !isWebhook
          ? ctx.cipher.computeGlobalTargetHash(input.channel, normalizedTarget)
          : '';

        if (!isWebhook) {
          const blockedRes = await ctx.notifDb.query<{ wallet: string }>(
            `SELECT wallet FROM notif_blocked_senders
             WHERE canonical_target_hash = $1 AND (wallet = $2 OR wallet = '*')`,
            [canonicalTargetHash, wallet.toLowerCase()]
          );
          if (blockedRes.rows.some((r) => r.wallet === '*')) {
            throw new HttpError(
              403,
              'TARGET_OPTED_OUT',
              'This recipient address has opted out of all NOSTOK notifications.'
            );
          }
          if (blockedRes.rows.length > 0) {
            throw new HttpError(
              403,
              'SENDER_BLOCKED_BY_RECIPIENT',
              'This wallet has been blocked by the target recipient.'
            );
          }

          if (existingSub.rows[0]?.verified === true) {
            const reEnabled = await ctx.notifDb.query<{
              id: string;
              channel: 'email' | 'telegram' | 'webhook';
              enabled: boolean;
              verified: boolean;
            }>(
              `UPDATE notif_subscriptions
               SET enabled = TRUE, updated_at = NOW()
               WHERE id = $1
               RETURNING id, channel, enabled, verified`,
              [existingSub.rows[0].id]
            );
            const row = reEnabled.rows[0];
            sendJson(res, 201, {
              id: row.id,
              wallet_address: wallet,
              channel: row.channel,
              masked_target: maskTarget(input.channel, normalizedTarget),
              key_id: encrypted.keyId,
              enabled: row.enabled,
              verified: row.verified,
              verification_required: false,
            });
            return;
          }

          // Enforce per-wallet (3/h) and per-IP (3/h) on all wallets.
          // Wallets with real on-chain / protocol sybil cost (ETH balance, tx nonce, SCW code,
          // indexed Nostok activity, or prior verified sub) cannot be locked out by zero-cost
          // botnet exhaustions on the shared target cap (for either plain or +tag addresses).
          // Fresh zero-cost wallets remain strictly capped at 10/h globally per target.
          enforceScopedRateLimit(
            res,
            confirmTargetWalletLimiter,
            `${wallet.toLowerCase()}:${canonicalTargetHash}`,
            `wallet confirmation sends to ${input.channel} target`
          );
          enforceScopedRateLimit(
            res,
            confirmTargetIpLimiter,
            `${clientIp}:${canonicalTargetHash}`,
            `IP confirmation sends to ${input.channel} target`
          );

          const walletHasSybilCost = await hasOnchainSybilCost(ctx, wallet, sybilCostCache);
          if (!walletHasSybilCost) {
            const nowMs = Date.now();
            let seenEntry = pendingWalletsByTarget.get(canonicalTargetHash);
            if (seenEntry && seenEntry.resetAtMs <= nowMs) {
              pendingWalletsByTarget.delete(canonicalTargetHash);
              seenEntry = undefined;
            }
            if (!seenEntry) {
              if (pendingWalletsByTarget.size >= ctx.config.rateLimitMaxBuckets) {
                for (const [k, v] of pendingWalletsByTarget.entries()) {
                  if (v.resetAtMs <= nowMs) pendingWalletsByTarget.delete(k);
                }
              }
              seenEntry = { wallets: new Set(), resetAtMs: nowMs + 3_600_000 };
              if (pendingWalletsByTarget.size < ctx.config.rateLimitMaxBuckets) {
                pendingWalletsByTarget.set(canonicalTargetHash, seenEntry);
              }
            }

            const walletLower = wallet.toLowerCase();
            if (seenEntry.wallets.has(walletLower)) {
              enforceScopedRateLimit(
                res,
                confirmTargetResendLimiter,
                canonicalTargetHash,
                `confirmation resends to ${input.channel} target`
              );
            }

            const globalRl = confirmTargetGlobalLimiter.check(canonicalTargetHash);
            if (!globalRl.allowed) {
              res.setHeader('Retry-After', String(globalRl.retryAfterSec));
              throw new HttpError(
                429,
                'RATE_LIMIT_EXCEEDED',
                `Rate limit exceeded for unverified-wallet confirmation sends to ${input.channel} target; retry later.`
              );
            }

            seenEntry.wallets.add(walletLower);
          }
        }

        const newId = existingSub.rows[0]?.id ?? `sub_${crypto.randomUUID().replace(/-/g, '')}`;
        const verificationCode = isWebhook ? null : String(crypto.randomInt(100_000, 1_000_000));
        const codeHash = verificationCode
          ? hashVerificationCode(ctx.config.confirmSecret, newId, wallet, verificationCode)
          : null;
        const expiresAtSec = verificationCode ? Math.floor(Date.now() / 1000) + 3600 : null;

        const resSub = await ctx.notifDb.query<{
          id: string;
          channel: 'email' | 'telegram' | 'webhook';
          enabled: boolean;
          verified: boolean;
        }>(
          `INSERT INTO notif_subscriptions (
             id, wallet, channel, target_ciphertext, key_id, target_hash, enabled, verified,
             verify_code_hash, verify_expires_at, verify_attempts, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, 0, NOW())
           ON CONFLICT (wallet, channel, target_hash) DO UPDATE SET
             target_ciphertext = EXCLUDED.target_ciphertext,
             key_id = EXCLUDED.key_id,
             enabled = EXCLUDED.enabled,
             verified = EXCLUDED.verified,
             verify_code_hash = EXCLUDED.verify_code_hash,
             verify_expires_at = EXCLUDED.verify_expires_at,
             verify_attempts = 0,
             updated_at = NOW()
           RETURNING id, channel, enabled, verified`,
          [
            newId,
            wallet.toLowerCase(),
            input.channel,
            encrypted.ciphertext,
            encrypted.keyId,
            targetHash,
            isWebhook,
            codeHash,
            expiresAtSec !== null ? expiresAtSec.toString() : null,
          ]
        );

        const created = resSub.rows[0];
        if (!isWebhook && verificationCode && codeHash) {
          const confirmToken = signConfirmSubscriptionToken(
            ctx.config.confirmSecret,
            created.id,
            wallet,
            codeHash,
            3600
          );
          const confirmUrl = `${ctx.config.publicBaseUrl}/subscriptions/confirm?token=${encodeURIComponent(confirmToken)}`;
          const blockToken = signBlockSenderToken(
            ctx.config.confirmSecret,
            created.id,
            wallet,
            canonicalTargetHash,
            86_400
          );
          const blockUrl = `${ctx.config.publicBaseUrl}/subscriptions/block?token=${encodeURIComponent(blockToken)}`;
          const siweAppOrigin = ctx.config.siweUri ? ctx.config.siweUri.replace(/\/+$/, '') : ctx.config.publicBaseUrl;
          const frontendConfirmUrl = `${siweAppOrigin}/subscriptions/confirm?token=${encodeURIComponent(confirmToken)}`;
          const frontendBlockUrl = `${siweAppOrigin}/subscriptions/block?token=${encodeURIComponent(blockToken)}`;
          const unsubToken = signUnsubscribeToken(
            ctx.config.unsubscribeSecret,
            created.id,
            wallet
          );
          const unsubscribeUrl = `${ctx.config.publicBaseUrl}/unsubscribe?token=${encodeURIComponent(unsubToken)}`;
          const verifyMsg = {
            wallet,
            subscriptionId: created.id,
            channel: input.channel,
            target: normalizedTarget,
            alertType: 'subscription_verification',
            severity: 'info' as const,
            title: 'Confirm your NOSTOK alert subscription',
            message: `Verification code: ${verificationCode}. Confirm link: ${confirmUrl}. Not me, block this address: ${blockUrl} (link valid 24h, single-use; stops new requests only, not existing verified subscriptions).`,
            payload: {
              subscription_id: created.id,
              verification_code: verificationCode,
              confirm_token: confirmToken,
              confirm_url: confirmUrl,
              frontend_confirm_url: frontendConfirmUrl,
              block_token: blockToken,
              block_url: blockUrl,
              frontend_block_url: frontendBlockUrl,
            },
            unsubscribeUrl,
          };
          if (input.channel === 'email') {
            await ctx.transports.sendEmail(verifyMsg);
          } else {
            await ctx.transports.sendTelegram(verifyMsg);
          }
        }

        sendJson(res, 201, {
          id: created.id,
          wallet_address: wallet,
          channel: created.channel,
          masked_target: maskTarget(input.channel, normalizedTarget),
          key_id: encrypted.keyId,
          enabled: created.enabled,
          verified: created.verified,
          verification_required: !created.verified,
        });
        return;
      }

      if (pathname === '/subscriptions/block' && req.method === 'GET') {
        enforceScopedRateLimit(res, confirmIpLimiter, clientIp, '/subscriptions/block IP');
        const rawToken = parseOrThrow(unsubscribeBodySchema, { token: queryObj.token }).token;
        let verified: { subId: string; wallet: string; canonicalTargetHash: string; exp: number };
        try {
          verified = verifyBlockSenderToken(ctx.config.confirmSecret, rawToken);
        } catch (err) {
          throw new HttpError(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid token');
        }
        const tokenJti = blockTokenJti(rawToken);
        const usedRes = await ctx.notifDb.query<{ jti: string }>(
          'SELECT jti FROM notif_revoked_sessions WHERE jti = $1 LIMIT 1',
          [tokenJti]
        );
        if (usedRes.rows.length > 0) {
          throw new HttpError(400, 'BLOCK_TOKEN_ALREADY_USED', 'This single-use block link has already been used.');
        }
        const checksumWallet = getAddress(verified.wallet);
        if (prefersHtmlResponse(req)) {
          const escToken = escapeHtml(rawToken);
          const escWallet = escapeHtml(checksumWallet);
          sendHtmlPage(
            res,
            200,
            'Block NOSTOK Alert Sender',
            `<h1>Didn't request this alert subscription?</h1>
<p>A verification email was requested for wallet <code>${escWallet}</code>.</p>
<p class="hint">${escapeHtml(BLOCK_EXISTING_SUBS_NOTE)}</p>
<div class="actions">
  <form method="POST" action="/subscriptions/block">
    <input type="hidden" name="token" value="${escToken}" />
    <input type="hidden" name="scope" value="wallet" />
    <button type="submit" class="secondary">Block this wallet only</button>
  </form>
  <form method="POST" action="/subscriptions/block">
    <input type="hidden" name="token" value="${escToken}" />
    <input type="hidden" name="scope" value="target_all" />
    <input type="hidden" name="block_all" value="true" />
    <button type="submit" class="danger">Block this address entirely (new requests)</button>
  </form>
</div>`
          );
          return;
        }
        sendJson(res, 200, {
          confirmation_required: true,
          method: 'POST',
          subscription_id: verified.subId,
          blocked_wallet: checksumWallet,
          supported_scopes: ['wallet', 'target_all'],
          stops_existing_verified_subscriptions: false,
          note: BLOCK_EXISTING_SUBS_NOTE,
        });
        return;
      }

      if (pathname === '/subscriptions/block' && req.method === 'POST') {
        enforceScopedRateLimit(res, confirmIpLimiter, clientIp, '/subscriptions/block IP');
        const rawBody = await readJsonBody(req, ctx.config.maxBodyBytes);
        const bodyObj =
          rawBody && typeof rawBody === 'object' && 'token' in rawBody
            ? rawBody
            : { token: queryObj.token };
        const parsedBlock = parseOrThrow(blockSenderSchema, bodyObj);
        const blockAll = parsedBlock.scope === 'target_all' || parsedBlock.block_all === true;
        let verified: { subId: string; wallet: string; canonicalTargetHash: string; exp: number };
        try {
          verified = verifyBlockSenderToken(ctx.config.confirmSecret, parsedBlock.token);
        } catch (err) {
          throw new HttpError(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid token');
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const tokenJti = blockTokenJti(parsedBlock.token);
        const consumed = await ctx.notifDb.query<{ jti: string }>(
          `INSERT INTO notif_revoked_sessions (jti, wallet, expires_at, revoked_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (jti) DO NOTHING
           RETURNING jti`,
          [tokenJti, verified.wallet.toLowerCase(), verified.exp.toString(), nowSec.toString()]
        );
        if (consumed.rows.length === 0) {
          throw new HttpError(400, 'BLOCK_TOKEN_ALREADY_USED', 'This single-use block link has already been used.');
        }
        await ctx.notifDb.query('DELETE FROM notif_revoked_sessions WHERE expires_at < $1', [
          (nowSec - 3600).toString(),
        ]);
        const walletLower = verified.wallet.toLowerCase();
        await ctx.notifDb.query(
          `INSERT INTO notif_blocked_senders (wallet, canonical_target_hash)
           VALUES ($1, $2)
           ON CONFLICT (wallet, canonical_target_hash) DO NOTHING`,
          [walletLower, verified.canonicalTargetHash]
        );
        const deletedIds: string[] = [];
        const delRes = await ctx.notifDb.query<{ id: string }>(
          `DELETE FROM notif_subscriptions
           WHERE id = $1 AND LOWER(wallet) = $2 AND verified = FALSE
           RETURNING id`,
          [verified.subId, walletLower]
        );
        for (const r of delRes.rows) deletedIds.push(r.id);

        if (blockAll) {
          await ctx.notifDb.query(
            `INSERT INTO notif_blocked_senders (wallet, canonical_target_hash)
             VALUES ('*', $1)
             ON CONFLICT (wallet, canonical_target_hash) DO NOTHING`,
            [verified.canonicalTargetHash]
          );
          const pendingSubs = await ctx.notifDb.query<{
            id: string;
            channel: 'email' | 'telegram' | 'webhook';
            target_ciphertext: string;
            key_id: string;
          }>(
            `SELECT id, channel, target_ciphertext, key_id
             FROM notif_subscriptions
             WHERE verified = FALSE AND channel IN ('email', 'telegram')`
          );
          const matchingIds: string[] = [];
          for (const sub of pendingSubs.rows) {
            try {
              const targetPlain = ctx.cipher.decrypt(sub.target_ciphertext, sub.key_id);
              const gHash = ctx.cipher.computeGlobalTargetHash(sub.channel, targetPlain);
              if (gHash === verified.canonicalTargetHash) {
                matchingIds.push(sub.id);
              }
            } catch {
              // ignore corrupted or unknown-key rows
            }
          }
          if (matchingIds.length > 0) {
            const ph = matchingIds.map((_, idx) => `$${idx + 1}`).join(', ');
            const bulkDel = await ctx.notifDb.query<{ id: string }>(
              `DELETE FROM notif_subscriptions WHERE id IN (${ph}) RETURNING id`,
              matchingIds
            );
            for (const r of bulkDel.rows) deletedIds.push(r.id);
          }
          confirmTargetGlobalLimiter.refund(verified.canonicalTargetHash);
          confirmTargetResendLimiter.refund(verified.canonicalTargetHash);
          pendingWalletsByTarget.delete(verified.canonicalTargetHash);
        } else if (delRes.rows.length > 0) {
          confirmTargetGlobalLimiter.refund(verified.canonicalTargetHash);
          confirmTargetResendLimiter.refund(verified.canonicalTargetHash);
          pendingWalletsByTarget.get(verified.canonicalTargetHash)?.wallets.delete(walletLower);
        }

        const checksumWallet = getAddress(verified.wallet);
        const scope = blockAll ? 'target_all' : 'wallet';
        if (prefersHtmlResponse(req)) {
          sendHtmlPage(
            res,
            200,
            blockAll ? 'Address Blocked From New Requests' : 'Sender Wallet Blocked',
            blockAll
              ? `<h1>Address blocked from new alert requests</h1><p>No wallet can create new alert subscriptions or send confirmation emails to this address (${deletedIds.length} unverified pending request(s) removed). ${escapeHtml(BLOCK_EXISTING_SUBS_NOTE)}</p>`
              : `<h1>Sender wallet blocked</h1><p>Wallet <code>${escapeHtml(checksumWallet)}</code> can no longer send confirmation requests to this address. ${escapeHtml(BLOCK_EXISTING_SUBS_NOTE)}</p>`
          );
          return;
        }
        sendJson(res, 200, {
          blocked: true,
          scope,
          block_all: blockAll,
          subscription_id: verified.subId,
          blocked_wallet: checksumWallet,
          deleted_pending_count: deletedIds.length,
          stops_existing_verified_subscriptions: false,
          note: BLOCK_EXISTING_SUBS_NOTE,
        });
        return;
      }

      if (pathname === '/subscriptions/confirm' && req.method === 'GET') {
        enforceScopedRateLimit(res, confirmIpLimiter, clientIp, '/subscriptions/confirm IP');
        const rawToken = parseOrThrow(unsubscribeBodySchema, { token: queryObj.token }).token;
        let verified: { subId: string; wallet: string; codeHash: string };
        try {
          verified = verifyConfirmSubscriptionToken(ctx.config.confirmSecret, rawToken);
        } catch (err) {
          throw new HttpError(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid token');
        }
        const checksumWallet = getAddress(verified.wallet);
        if (prefersHtmlResponse(req)) {
          const escToken = escapeHtml(rawToken);
          const escWallet = escapeHtml(checksumWallet);
          sendHtmlPage(
            res,
            200,
            'Confirm NOSTOK Alert Subscription',
            `<h1>Confirm your NOSTOK alert subscription</h1>
<p>Wallet: <code>${escWallet}</code></p>
<form method="POST" action="/subscriptions/confirm">
  <input type="hidden" name="token" value="${escToken}" />
  <button type="submit">Confirm subscription</button>
</form>`
          );
          return;
        }
        sendJson(res, 200, {
          confirmation_required: true,
          method: 'POST',
          subscription_id: verified.subId,
          wallet_address: checksumWallet,
        });
        return;
      }

      if (pathname === '/subscriptions/confirm' && req.method === 'POST') {
        enforceScopedRateLimit(res, confirmIpLimiter, clientIp, '/subscriptions/confirm IP');
        const rawBody = await readJsonBody(req, ctx.config.maxBodyBytes);
        const input = parseOrThrow(confirmSubscriptionSchema, rawBody);
        const nowSec = Math.floor(Date.now() / 1000);

        if ('token' in input) {
          let verified: { subId: string; wallet: string; codeHash: string };
          try {
            verified = verifyConfirmSubscriptionToken(ctx.config.confirmSecret, input.token);
          } catch (err) {
            throw new HttpError(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid token');
          }
          enforceScopedRateLimit(
            res,
            confirmWalletLimiter,
            verified.wallet.toLowerCase(),
            '/subscriptions/confirm wallet'
          );
          enforceScopedRateLimit(res, confirmSubLimiter, verified.subId, '/subscriptions/confirm subscription');

          const subRes = await ctx.notifDb.query<{
            id: string;
            channel: 'email' | 'telegram' | 'webhook';
            verify_code_hash: string | null;
            verify_expires_at: string | null;
            verify_attempts: number;
          }>(
            `SELECT id, channel, verify_code_hash, verify_expires_at::TEXT AS verify_expires_at, verify_attempts
             FROM notif_subscriptions
             WHERE id = $1 AND LOWER(wallet) = LOWER($2)`,
            [verified.subId, verified.wallet]
          );
          const row = subRes.rows[0];
          if (!row) {
            throw new HttpError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
          }
          const aBuf = Buffer.from(row.verify_code_hash ?? '', 'utf8');
          const bBuf = Buffer.from(verified.codeHash, 'utf8');
          if (
            !row.verify_code_hash ||
            Number(row.verify_attempts ?? 0) >= ctx.config.maxVerifyAttempts ||
            aBuf.length !== bBuf.length ||
            !crypto.timingSafeEqual(aBuf, bBuf) ||
            !row.verify_expires_at ||
            nowSec > Number(row.verify_expires_at)
          ) {
            throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid or expired confirmation token');
          }
          await ctx.notifDb.query(
            `UPDATE notif_subscriptions
             SET enabled = TRUE, verified = TRUE, verify_code_hash = NULL, verify_expires_at = NULL,
                 verify_attempts = 0, updated_at = NOW()
             WHERE id = $1`,
            [row.id]
          );
          if (prefersHtmlResponse(req)) {
            sendHtmlPage(
              res,
              200,
              'Subscription Confirmed',
              `<h1>Alert subscription confirmed</h1><p>Subscription <code>${escapeHtml(row.id)}</code> for wallet <code>${escapeHtml(getAddress(verified.wallet))}</code> is now active.</p>`
            );
            return;
          }
          sendJson(res, 200, {
            confirmed: true,
            id: row.id,
            wallet_address: getAddress(verified.wallet),
            channel: row.channel,
            enabled: true,
            verified: true,
          });
          return;
        }

        const caller = await authenticateRequest(req, ctx, rawBody);
        enforceScopedRateLimit(
          res,
          confirmWalletLimiter,
          caller.wallet.toLowerCase(),
          '/subscriptions/confirm wallet'
        );
        enforceScopedRateLimit(
          res,
          confirmSubLimiter,
          input.subscription_id,
          '/subscriptions/confirm subscription'
        );

        const subRes = await ctx.notifDb.query<{
          id: string;
          channel: 'email' | 'telegram' | 'webhook';
          verify_code_hash: string | null;
          verify_expires_at: string | null;
          verify_attempts: number;
        }>(
          `SELECT id, channel, verify_code_hash, verify_expires_at::TEXT AS verify_expires_at, verify_attempts
           FROM notif_subscriptions
           WHERE id = $1 AND wallet = $2`,
          [input.subscription_id, caller.wallet.toLowerCase()]
        );
        const row = subRes.rows[0];
        if (!row) {
          throw new HttpError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
        }
        if (
          !row.verify_code_hash ||
          Number(row.verify_attempts ?? 0) >= ctx.config.maxVerifyAttempts ||
          !row.verify_expires_at ||
          nowSec > Number(row.verify_expires_at)
        ) {
          throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid, expired, or locked verification code');
        }

        const providedHash = hashVerificationCode(
          ctx.config.confirmSecret,
          row.id,
          caller.wallet,
          input.code
        );
        const aBuf = Buffer.from(providedHash, 'utf8');
        const bBuf = Buffer.from(row.verify_code_hash, 'utf8');
        if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
          const nextAttempts = Number(row.verify_attempts ?? 0) + 1;
          if (nextAttempts >= ctx.config.maxVerifyAttempts) {
            await ctx.notifDb.query(
              `UPDATE notif_subscriptions
               SET verify_attempts = $2, verify_code_hash = NULL, verify_expires_at = NULL, updated_at = NOW()
               WHERE id = $1`,
              [row.id, nextAttempts]
            );
          } else {
            await ctx.notifDb.query(
              `UPDATE notif_subscriptions
               SET verify_attempts = $2, updated_at = NOW()
               WHERE id = $1`,
              [row.id, nextAttempts]
            );
          }
          throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid or expired verification code');
        }
        await ctx.notifDb.query(
          `UPDATE notif_subscriptions
           SET enabled = TRUE, verified = TRUE, verify_code_hash = NULL, verify_expires_at = NULL,
               verify_attempts = 0, updated_at = NOW()
           WHERE id = $1`,
          [row.id]
        );
        sendJson(res, 200, {
          confirmed: true,
          id: row.id,
          wallet_address: caller.wallet,
          channel: row.channel,
          enabled: true,
          verified: true,
        });
        return;
      }

      if (pathname === '/subscriptions' && req.method === 'GET') {
        const caller = await authenticateRequest(req, ctx);
        const wallet = caller.wallet;
        const rows = await ctx.notifDb.query<{
          id: string;
          channel: 'email' | 'telegram' | 'webhook';
          target_ciphertext: string;
          key_id: string;
          enabled: boolean;
          verified: boolean;
          created_at: unknown;
        }>(
          `SELECT id, channel, target_ciphertext, key_id, enabled, verified, created_at
           FROM notif_subscriptions
           WHERE wallet = $1
           ORDER BY created_at DESC`,
          [wallet.toLowerCase()]
        );

        const data = rows.rows.map((r) => {
          let masked = '***';
          let decryptionError = false;
          try {
            const decrypted = ctx.cipher.decrypt(r.target_ciphertext, r.key_id);
            masked = maskTarget(r.channel, decrypted);
          } catch {
            decryptionError = true;
          }
          return {
            id: r.id,
            channel: r.channel,
            masked_target: masked,
            key_id: r.key_id,
            enabled: r.enabled,
            verified: r.verified,
            ...(decryptionError ? { decryption_error: true } : {}),
          };
        });
        sendJson(res, 200, { wallet_address: wallet, data });
        return;
      }

      if (pathname === '/preferences' && req.method === 'GET') {
        const caller = await authenticateRequest(req, ctx);
        const wallet = caller.wallet;
        const resPref = await ctx.notifDb.query<{
          alert_types_json: string;
          quiet_hours_start: number | null;
          quiet_hours_end: number | null;
          max_per_hour: number;
        }>(
          'SELECT alert_types_json, quiet_hours_start, quiet_hours_end, max_per_hour FROM notif_preferences WHERE wallet = $1',
          [wallet.toLowerCase()]
        );
        const row = resPref.rows[0];
        sendJson(res, 200, {
          wallet_address: wallet,
          alert_types: row ? JSON.parse(row.alert_types_json) : defaultPreferencesMap(),
          quiet_hours_start: row?.quiet_hours_start ?? null,
          quiet_hours_end: row?.quiet_hours_end ?? null,
          max_per_hour: row?.max_per_hour ?? ctx.config.userRateLimitPerHour,
        });
        return;
      }

      if (pathname === '/preferences' && req.method === 'PUT') {
        const rawBody = await readJsonBody(req, ctx.config.maxBodyBytes);
        const caller = await authenticateRequest(req, ctx, rawBody);
        const wallet = caller.wallet;
        const input = parseOrThrow(updatePreferencesSchema, rawBody);

        const existingRes = await ctx.notifDb.query<{
          alert_types_json: string;
          quiet_hours_start: number | null;
          quiet_hours_end: number | null;
          max_per_hour: number;
        }>(
          'SELECT alert_types_json, quiet_hours_start, quiet_hours_end, max_per_hour FROM notif_preferences WHERE wallet = $1',
          [wallet.toLowerCase()]
        );
        const prev = existingRes.rows[0];
        const mergedAlertTypes = {
          ...(prev ? (JSON.parse(prev.alert_types_json) as Record<string, boolean>) : defaultPreferencesMap()),
          ...(input.alert_types ?? {}),
        };
        const quietStart =
          input.quiet_hours_start !== undefined ? input.quiet_hours_start : (prev?.quiet_hours_start ?? null);
        const quietEnd =
          input.quiet_hours_end !== undefined ? input.quiet_hours_end : (prev?.quiet_hours_end ?? null);
        const maxPerHour =
          input.max_per_hour !== undefined
            ? input.max_per_hour
            : (prev?.max_per_hour ?? ctx.config.userRateLimitPerHour);

        await ctx.notifDb.query(
          `INSERT INTO notif_preferences (wallet, alert_types_json, quiet_hours_start, quiet_hours_end, max_per_hour, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (wallet) DO UPDATE SET
             alert_types_json = EXCLUDED.alert_types_json,
             quiet_hours_start = EXCLUDED.quiet_hours_start,
             quiet_hours_end = EXCLUDED.quiet_hours_end,
             max_per_hour = EXCLUDED.max_per_hour,
             updated_at = NOW()`,
          [wallet.toLowerCase(), JSON.stringify(mergedAlertTypes), quietStart, quietEnd, maxPerHour]
        );

        sendJson(res, 200, {
          wallet_address: wallet,
          alert_types: mergedAlertTypes,
          quiet_hours_start: quietStart,
          quiet_hours_end: quietEnd,
          max_per_hour: maxPerHour,
        });
        return;
      }

      if (pathname === '/deliveries' && req.method === 'GET') {
        const caller = await authenticateRequest(req, ctx);
        const wallet = caller.wallet;
        const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
        const rows = await ctx.notifDb.query<{
          id: string;
          subscription_id: string;
          channel: string;
          alert_type: string;
          severity: string;
          dedup_key: string;
          title: string;
          message: string;
          status: string;
          attempts: number;
          created_at: string;
          sent_at: string | null;
        }>(
          `SELECT id, subscription_id, channel, alert_type, severity, dedup_key, title, message,
                  status, attempts, created_at::TEXT AS created_at, sent_at::TEXT AS sent_at
           FROM notif_deliveries
           WHERE wallet = $1
           ORDER BY created_at DESC, id ASC
           LIMIT $2 OFFSET $3`,
          [wallet.toLowerCase(), pag.limit, pag.offset]
        );
        sendJson(res, 200, { wallet_address: wallet, data: rows.rows });
        return;
      }

      if (pathname === '/dead-letters' && req.method === 'GET') {
        const caller = await authenticateRequest(req, ctx);
        const wallet = caller.wallet;
        const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
        const rows = await ctx.notifDb.query<{
          id: string;
          delivery_id: string;
          subscription_id: string;
          channel: string;
          alert_type: string;
          dedup_key: string;
          attempts: number;
          failed_at: string;
        }>(
          `SELECT id, delivery_id, subscription_id, channel, alert_type, dedup_key, attempts, failed_at::TEXT AS failed_at
           FROM notif_dead_letters
           WHERE wallet = $1
           ORDER BY failed_at DESC, id ASC
           LIMIT $2 OFFSET $3`,
          [wallet.toLowerCase(), pag.limit, pag.offset]
        );
        const data = rows.rows.map((r) => ({
          ...r,
          last_error: 'delivery failed',
        }));
        sendJson(res, 200, { wallet_address: wallet, data });
        return;
      }

      if (pathname === '/dead-letters/redrive' && req.method === 'POST') {
        const rawBody = await readJsonBody(req, ctx.config.maxBodyBytes);
        const adminHeaderRaw = req.headers['x-admin-secret'];
        let isAdmin = false;
        let callerWallet: string | null = null;

        if (adminHeaderRaw !== undefined) {
          const providedSecret = Array.isArray(adminHeaderRaw) ? adminHeaderRaw[0] : adminHeaderRaw;
          const expectedSecret = ctx.config.adminSecret ?? '';
          const aBuf = Buffer.from(providedSecret, 'utf8');
          const bBuf = Buffer.from(expectedSecret, 'utf8');
          if (!ctx.config.adminSecret || aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
            throw new HttpError(401, 'UNAUTHORIZED', 'Invalid admin secret');
          }
          isAdmin = true;
        } else {
          const caller = await authenticateRequest(req, ctx, rawBody);
          callerWallet = caller.wallet.toLowerCase();
        }

        const input = parseOrThrow(redriveDeadLettersSchema, rawBody);
        if (!isAdmin && input.wallet && input.wallet.toLowerCase() !== callerWallet) {
          throw new HttpError(403, 'FORBIDDEN', 'Cannot redrive dead letters for another wallet');
        }

        const nowMs = Date.now();
        const redrivenDeliveryIds = await ctx.notifDb.transaction(async (tx) => {
          const whereParts: string[] = [];
          const params: unknown[] = [];

          const filterWallet = isAdmin ? input.wallet?.toLowerCase() : callerWallet;
          if (filterWallet) {
            whereParts.push(`wallet = $${params.push(filterWallet)}`);
          }
          if (input.dead_letter_ids && input.dead_letter_ids.length > 0) {
            const ph = input.dead_letter_ids.map((id) => `$${params.push(id)}`).join(', ');
            whereParts.push(`id IN (${ph})`);
          }
          if (input.delivery_ids && input.delivery_ids.length > 0) {
            const ph = input.delivery_ids.map((id) => `$${params.push(id)}`).join(', ');
            whereParts.push(`delivery_id IN (${ph})`);
          }

          const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
          const limitIdx = params.push(input.limit);
          const dlqSel = await tx.query<{ id: string; delivery_id: string }>(
            `SELECT id, delivery_id
             FROM notif_dead_letters
             ${whereSql}
             ORDER BY failed_at ASC
             LIMIT $${limitIdx}`,
            params
          );
          if (dlqSel.rows.length === 0) {
            return [] as string[];
          }

          const dlqIds = dlqSel.rows.map((r) => r.id);
          const dlvIds = Array.from(new Set(dlqSel.rows.map((r) => r.delivery_id)));

          const dlvParams: unknown[] = [nowMs.toString()];
          const dlvPh = dlvIds.map((id) => `$${dlvParams.push(id)}`).join(', ');
          await tx.query(
            `UPDATE notif_deliveries
             SET status = 'pending', attempts = 0, next_attempt_at = $1,
                 claimed_at = NULL, lease_until = NULL, last_error = NULL
             WHERE id IN (${dlvPh})`,
            dlvParams
          );

          const delParams: unknown[] = [];
          const delPh = dlqIds.map((id) => `$${delParams.push(id)}`).join(', ');
          await tx.query(`DELETE FROM notif_dead_letters WHERE id IN (${delPh})`, delParams);

          return dlvIds;
        });

        sendJson(res, 200, {
          status: 'ok',
          redriven_count: redrivenDeliveryIds.length,
          delivery_ids: redrivenDeliveryIds,
        });
        return;
      }

      if (pathname === '/user/data' && req.method === 'DELETE') {
        const rawBody = await readJsonBody(req, ctx.config.maxBodyBytes);
        const caller = await authenticateRequest(req, ctx, rawBody);
        const wallet = caller.wallet;
        const w = wallet.toLowerCase();

        await ctx.notifDb.transaction(async (tx) => {
          await tx.query('DELETE FROM notif_dead_letters WHERE wallet = $1', [w]);
          await tx.query('DELETE FROM notif_deliveries WHERE wallet = $1', [w]);
          await tx.query('DELETE FROM notif_preferences WHERE wallet = $1', [w]);
          await tx.query('DELETE FROM notif_subscriptions WHERE wallet = $1', [w]);
          await tx.query('DELETE FROM notif_nonces WHERE wallet = $1', [w]);
        });

        sendJson(res, 200, { deleted: true, wallet_address: wallet });
        return;
      }

      throw new HttpError(404, 'NOT_FOUND', `Route not found: ${pathname}`);
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
      console.error('[NOTIF_API_ERROR]', err instanceof Error ? err.message : String(err));
      sendJson(res, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred.',
        },
      });
    }
  });

  server.on('close', () => {
    rateLimiter.close();
    nonceIpLimiter.close();
    verifyIpLimiter.close();
    verifyWalletLimiter.close();
    subIpLimiter.close();
    subWalletLimiter.close();
    confirmTargetWalletLimiter.close();
    confirmTargetIpLimiter.close();
    confirmTargetGlobalLimiter.close();
    confirmTargetResendLimiter.close();
    sybilCostCache.clear();
    clearInterval(pendingWalletsTimer);
    confirmIpLimiter.close();
    confirmWalletLimiter.close();
    confirmSubLimiter.close();
  });

  return server;
}
