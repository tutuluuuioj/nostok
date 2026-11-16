import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import type { AlertSeverity } from './alerts.js';
import type { RiskContext } from './monitor.js';
import {
  buildPaginationSchema,
  riskAlertsQuerySchema,
  riskLoansQuerySchema,
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
  const ips = headerStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
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

function urlSearchParamsToObject(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of sp.entries()) {
    out[k] = v;
  }
  return out;
}

function escapePromLabel(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function renderPrometheusMetrics(ctx: RiskContext): string {
  const lines: string[] = [];
  const s = ctx.state.latestSummary;

  lines.push('# HELP nostok_risk_monitor_up 1 if latest RPC/DB scan succeeded, 0 if degraded');
  lines.push('# TYPE nostok_risk_monitor_up gauge');
  lines.push(`nostok_risk_monitor_up ${ctx.state.monitorDegraded ? 0 : 1}`);

  lines.push('# HELP nostok_risk_scans_total Total risk monitor scan cycles executed');
  lines.push('# TYPE nostok_risk_scans_total counter');
  lines.push(`nostok_risk_scans_total ${ctx.state.scanCount}`);

  lines.push('# HELP nostok_risk_rpc_errors_total Total RPC errors observed by risk monitor');
  lines.push('# TYPE nostok_risk_rpc_errors_total counter');
  lines.push(`nostok_risk_rpc_errors_total ${ctx.state.rpcErrorsTotal}`);

  lines.push('# HELP nostok_risk_last_scan_timestamp_seconds Unix epoch seconds of latest scan');
  lines.push('# TYPE nostok_risk_last_scan_timestamp_seconds gauge');
  const scanTs = s ? Math.floor(Date.parse(s.last_scan_timestamp) / 1000) : Math.floor(Date.now() / 1000);
  lines.push(`nostok_risk_last_scan_timestamp_seconds ${scanTs}`);

  lines.push('# HELP nostok_risk_chain_head_block Latest observed chain head block number');
  lines.push('# TYPE nostok_risk_chain_head_block gauge');
  lines.push(`nostok_risk_chain_head_block ${s?.chain_head_block ?? 0}`);

  lines.push('# HELP nostok_risk_indexer_last_block Latest indexed block number');
  lines.push('# TYPE nostok_risk_indexer_last_block gauge');
  lines.push(`nostok_risk_indexer_last_block ${s?.indexer.last_indexed_block ?? 0}`);

  lines.push('# HELP nostok_risk_indexer_lag_blocks Indexer lag behind chain head in blocks');
  lines.push('# TYPE nostok_risk_indexer_lag_blocks gauge');
  lines.push(`nostok_risk_indexer_lag_blocks ${s?.indexer.lag_blocks ?? 0}`);

  lines.push('# HELP nostok_risk_protocol_paused 1 if LoanCore is paused, 0 otherwise');
  lines.push('# TYPE nostok_risk_protocol_paused gauge');
  lines.push(`nostok_risk_protocol_paused ${s?.protocol_paused ? 1 : 0}`);

  lines.push('# HELP nostok_risk_global_cap_utilization_bps Global USDC cap utilization in bps');
  lines.push('# TYPE nostok_risk_global_cap_utilization_bps gauge');
  lines.push(`nostok_risk_global_cap_utilization_bps ${s?.global_cap_utilization_bps ?? 0}`);

  lines.push('# HELP nostok_risk_open_loans_count Open loans grouped by risk status');
  lines.push('# TYPE nostok_risk_open_loans_count gauge');
  for (const status of ['healthy', 'margin_call', 'near_liquidation', 'liquidatable'] as const) {
    lines.push(`nostok_risk_open_loans_count{status="${status}"} ${s?.loan_counts[status] ?? 0}`);
  }

  lines.push('# HELP nostok_risk_active_alerts Active alerts grouped by severity');
  lines.push('# TYPE nostok_risk_active_alerts gauge');
  const alertCounts = ctx.alerts.getActiveCountBySeverity();
  for (const sev of ['info', 'warning', 'critical', 'page'] as AlertSeverity[]) {
    lines.push(`nostok_risk_active_alerts{severity="${sev}"} ${alertCounts[sev]}`);
  }

  lines.push('# HELP nostok_risk_loan_ltv_bps Current gross LTV in bps per open loan');
  lines.push('# TYPE nostok_risk_loan_ltv_bps gauge');
  lines.push('# HELP nostok_risk_loan_health_factor Health factor per open loan');
  lines.push('# TYPE nostok_risk_loan_health_factor gauge');
  for (const loan of ctx.state.latestLoans) {
    const lbl = `loan_id="${escapePromLabel(loan.loan_id)}",asset="${escapePromLabel(loan.collateral_token)}"`;
    lines.push(`nostok_risk_loan_ltv_bps{${lbl}} ${loan.current_ltv_bps}`);
    lines.push(`nostok_risk_loan_health_factor{${lbl}} ${loan.health_factor.formatted}`);
  }

  if (s) {
    lines.push('# HELP nostok_risk_asset_oracle_age_seconds Chainlink feed age in seconds per asset');
    lines.push('# TYPE nostok_risk_asset_oracle_age_seconds gauge');
    lines.push('# HELP nostok_risk_asset_multiplier_drift_bps B20 uiMultiplier drift in bps per asset');
    lines.push('# TYPE nostok_risk_asset_multiplier_drift_bps gauge');
    lines.push('# HELP nostok_risk_asset_cap_utilization_bps Per-asset cap utilization in bps');
    lines.push('# TYPE nostok_risk_asset_cap_utilization_bps gauge');
    for (const a of s.assets) {
      const lbl = `asset="${escapePromLabel(a.token)}",symbol="${escapePromLabel(a.symbol ?? a.token)}"`;
      lines.push(`nostok_risk_asset_oracle_age_seconds{${lbl}} ${a.feed_age_seconds}`);
      lines.push(`nostok_risk_asset_multiplier_drift_bps{${lbl}} ${a.multiplier_drift_bps}`);
      lines.push(`nostok_risk_asset_cap_utilization_bps{${lbl}} ${a.asset_cap_utilization_bps}`);
    }
  }

  return lines.join('\n') + '\n';
}

export function createRiskServer(ctx: RiskContext): http.Server {
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
      const contentLength = Number(contentLengthHeader);
      if (!Number.isNaN(contentLength) && contentLength > ctx.config.maxBodyBytes) {
        sendJson(res, 413, {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Request exceeds maximum size of ${ctx.config.maxBodyBytes} bytes`,
          },
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

      if (req.method !== 'GET') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Risk monitor HTTP API is strictly GET/read-only');
      }

      if (pathname === '/metrics') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.end(renderPrometheusMetrics(ctx));
        return;
      }

      if (pathname === '/risk/summary' || pathname === '/health') {
        const summary = ctx.state.latestSummary;
        if (!summary) {
          sendJson(res, 503, {
            error: { code: 'SCAN_PENDING', message: 'Initial risk scan has not completed yet' },
          });
          return;
        }
        sendJson(res, summary.monitor_degraded ? 503 : 200, summary);
        return;
      }

      if (pathname === '/risk/loans') {
        const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
        const filters = parseOrThrow(riskLoansQuerySchema, queryObj);
        let rows = ctx.state.latestLoans;
        if (filters.status) {
          rows = rows.filter((l) => l.risk_status === filters.status);
        }
        if (filters.asset) {
          const target = filters.asset.toLowerCase();
          rows = rows.filter((l) => l.collateral_token.toLowerCase() === target);
        }
        rows = [...rows].sort((a, b) => {
          const bi = BigInt(a.loan_id);
          const bj = BigInt(b.loan_id);
          return bi < bj ? -1 : bi > bj ? 1 : 0;
        });
        const total = rows.length;
        const pageData = rows.slice(pag.offset, pag.offset + pag.limit);
        const nextOffset = pag.offset + pageData.length < total ? pag.offset + pageData.length : null;

        sendJson(res, 200, {
          block_number: ctx.state.latestSummary?.chain_head_block ?? '0',
          freshness_timestamp: ctx.state.latestSummary?.last_scan_timestamp ?? new Date().toISOString(),
          pagination: {
            limit: pag.limit,
            offset: pag.offset,
            cursor: String(pag.offset),
            next_cursor: nextOffset !== null ? String(nextOffset) : null,
            has_more: nextOffset !== null,
            total,
          },
          data: pageData,
        });
        return;
      }

      if (pathname === '/risk/alerts') {
        const pag = parseOrThrow(buildPaginationSchema(ctx.config.maxPageLimit), queryObj);
        const filters = parseOrThrow(riskAlertsQuerySchema, queryObj);
        let rows = ctx.alerts.getAllAlerts();
        if (filters.severity) {
          rows = rows.filter((a) => a.severity === filters.severity);
        }
        if (filters.status) {
          rows = rows.filter((a) => a.status === filters.status);
        }
        if (filters.category) {
          rows = rows.filter((a) => a.category === filters.category);
        }
        const total = rows.length;
        const pageData = rows.slice(pag.offset, pag.offset + pag.limit);
        const nextOffset = pag.offset + pageData.length < total ? pag.offset + pageData.length : null;

        sendJson(res, 200, {
          block_number: ctx.state.latestSummary?.chain_head_block ?? '0',
          freshness_timestamp: ctx.state.latestSummary?.last_scan_timestamp ?? new Date().toISOString(),
          pagination: {
            limit: pag.limit,
            offset: pag.offset,
            cursor: String(pag.offset),
            next_cursor: nextOffset !== null ? String(nextOffset) : null,
            has_more: nextOffset !== null,
            total,
          },
          data: pageData,
        });
        return;
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

      console.error('[RISK_API_ERROR]', err instanceof Error ? err.message : String(err));
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
