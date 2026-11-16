import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Address, type Hex, getAddress } from 'viem';
import { ZodError } from 'zod';
import { validateChannelTarget } from './channels.js';
import {
  maskTarget,
  signSessionToken,
  verifySessionToken,
  verifyUnsubscribeToken,
} from './crypto.js';
import { type NotificationsContext, defaultPreferencesMap } from './engine.js';
import { issueSiweNonce, verifySiweAuth } from './siwe.js';
import {
  buildPaginationSchema,
  createSubscriptionSchema,
  nonceRequestSchema,
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

  check(ip: string): { allowed: boolean; remaining: number; resetEpochSec: number; retryAfterSec: number } {
    const now = Date.now();
    let bucket = this.buckets.get(ip);
    if (bucket && bucket.resetAtMs <= now) {
      this.buckets.delete(ip);
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
      this.buckets.set(ip, bucket);
    }

    bucket.count += 1;
    return {
      allowed: bucket.count <= this.maxRequests,
      remaining: Math.max(0, this.maxRequests - bucket.count),
      resetEpochSec: Math.ceil(bucket.resetAtMs / 1000),
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000)),
    };
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

function setCorsHeaders(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): void {
  const reqOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (allowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (reqOrigin && allowedOrigins.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
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

async function authenticateRequest(
  req: IncomingMessage,
  ctx: NotificationsContext,
  body?: unknown
): Promise<Address> {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    try {
      return getAddress(verifySessionToken(ctx.config.sessionSecret, token));
    } catch (err) {
      throw new HttpError(401, 'UNAUTHORIZED', err instanceof Error ? err.message : 'Invalid session token');
    }
  }

  // Allow direct SIWE payload when present in request body { siwe: { message, signature } }
  if (body && typeof body === 'object' && 'siwe' in body) {
    const siweRaw = (body as { siwe?: unknown }).siwe;
    const parsedSiwe = parseOrThrow(siweVerifyRequestSchema, siweRaw);
    try {
      return await verifySiweAuth(
        ctx.publicClient,
        ctx.notifDb,
        ctx.config,
        parsedSiwe.message,
        parsedSiwe.signature as Hex
      );
    } catch (err) {
      throw new HttpError(401, 'UNAUTHORIZED', err instanceof Error ? err.message : 'SIWE verification failed');
    }
  }

  throw new HttpError(401, 'UNAUTHORIZED', 'Missing Authorization Bearer token or SIWE signature');
}

export function createNotificationsServer(ctx: NotificationsContext): http.Server {
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

    const rl = rateLimiter.check(resolveClientIp(req, ctx.config.trustProxyHops));
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
        const sess = signSessionToken(ctx.config.sessionSecret, wallet, ctx.config.sessionTtlSecs);
        sendJson(res, 200, {
          wallet_address: wallet,
          token: sess.token,
          expires_at: sess.expiresAt,
        });
        return;
      }

      if (pathname === '/unsubscribe' && (req.method === 'GET' || req.method === 'POST')) {
        let rawToken: string;
        if (req.method === 'GET') {
          rawToken = parseOrThrow(unsubscribeBodySchema, { token: queryObj.token }).token;
        } else {
          rawToken = parseOrThrow(
            unsubscribeBodySchema,
            await readJsonBody(req, ctx.config.maxBodyBytes)
          ).token;
        }
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
        const rawBody = await readJsonBody(req, ctx.config.maxBodyBytes);
        const wallet = await authenticateRequest(req, ctx, rawBody);
        const input = parseOrThrow(createSubscriptionSchema, rawBody);

        let normalizedTarget: string;
        try {
          normalizedTarget = validateChannelTarget(input.channel, input.target);
        } catch (err) {
          throw new HttpError(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : 'Invalid target');
        }

        const encrypted = ctx.cipher.encrypt(normalizedTarget);
        const targetHash = ctx.cipher.computeTargetHash(wallet, input.channel, normalizedTarget);
        const newId = `sub_${crypto.randomUUID().replace(/-/g, '')}`;

        const resSub = await ctx.notifDb.query<{
          id: string;
          channel: 'email' | 'telegram' | 'webhook';
          enabled: boolean;
        }>(
          `INSERT INTO notif_subscriptions (
             id, wallet, channel, target_ciphertext, key_id, target_hash, enabled, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
           ON CONFLICT (wallet, channel, target_hash) DO UPDATE SET
             target_ciphertext = EXCLUDED.target_ciphertext,
             key_id = EXCLUDED.key_id,
             enabled = TRUE,
             updated_at = NOW()
           RETURNING id, channel, enabled`,
          [newId, wallet.toLowerCase(), input.channel, encrypted.ciphertext, encrypted.keyId, targetHash]
        );

        sendJson(res, 201, {
          id: resSub.rows[0].id,
          wallet_address: wallet,
          channel: resSub.rows[0].channel,
          masked_target: maskTarget(input.channel, normalizedTarget),
          key_id: encrypted.keyId,
          enabled: resSub.rows[0].enabled,
        });
        return;
      }

      if (pathname === '/subscriptions' && req.method === 'GET') {
        const wallet = await authenticateRequest(req, ctx);
        const rows = await ctx.notifDb.query<{
          id: string;
          channel: 'email' | 'telegram' | 'webhook';
          target_ciphertext: string;
          key_id: string;
          enabled: boolean;
          created_at: unknown;
        }>(
          `SELECT id, channel, target_ciphertext, key_id, enabled, created_at
           FROM notif_subscriptions
           WHERE wallet = $1
           ORDER BY created_at DESC`,
          [wallet.toLowerCase()]
        );

        const data = rows.rows.map((r) => {
          const decrypted = ctx.cipher.decrypt(r.target_ciphertext, r.key_id);
          return {
            id: r.id,
            channel: r.channel,
            masked_target: maskTarget(r.channel, decrypted),
            key_id: r.key_id,
            enabled: r.enabled,
          };
        });
        sendJson(res, 200, { wallet_address: wallet, data });
        return;
      }

      if (pathname === '/preferences' && req.method === 'GET') {
        const wallet = await authenticateRequest(req, ctx);
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
        const wallet = await authenticateRequest(req, ctx, rawBody);
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
        const wallet = await authenticateRequest(req, ctx);
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
        const wallet = await authenticateRequest(req, ctx);
        const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
        const rows = await ctx.notifDb.query<{
          id: string;
          delivery_id: string;
          subscription_id: string;
          channel: string;
          alert_type: string;
          dedup_key: string;
          attempts: number;
          last_error: string;
          failed_at: string;
        }>(
          `SELECT id, delivery_id, subscription_id, channel, alert_type, dedup_key, attempts, last_error, failed_at::TEXT AS failed_at
           FROM notif_dead_letters
           WHERE wallet = $1
           ORDER BY failed_at DESC, id ASC
           LIMIT $2 OFFSET $3`,
          [wallet.toLowerCase(), pag.limit, pag.offset]
        );
        sendJson(res, 200, { wallet_address: wallet, data: rows.rows });
        return;
      }

      if (pathname === '/user/data' && req.method === 'DELETE') {
        const rawBody = await readJsonBody(req, ctx.config.maxBodyBytes);
        const wallet = await authenticateRequest(req, ctx, rawBody);
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
  });

  return server;
}
