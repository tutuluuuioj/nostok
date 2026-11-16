import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const { Pool } = pg;

export interface QueryResultRow {
  [column: string]: unknown;
}

/**
 * Strictly read-only indexer DB client.
 * Never writes to indexer tables; uses SELECT/WITH allowlist + pool error handling + drop retry.
 */
export interface ReadOnlyDatabase {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

const FORBIDDEN_SQL_PATTERN =
  /\b(INTO|MERGE|SET|RESET|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOCK|PREPARE|EXECUTE|DEALLOCATE|LISTEN|NOTIFY|UNLISTEN|LOAD|IMPORT|SECURITY|REINDEX|CLUSTER|REFRESH|COMMENT|DISCARD|SHOW|EXPLAIN|ANALYZE|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE|COPY|VACUUM|CALL|DO|UESCAPE|FOR\s+UPDATE|FOR\s+SHARE|set_config)\b|\b(pg_|lo_|dblink)[a-zA-Z0-9_]*/i;

export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('Read-only risk monitor database permits SELECT queries only.');
  }
  if (sql.includes(';') || sql.includes('$$') || /(--|\/\*|\*\/)/.test(sql)) {
    throw new Error('Read-only risk monitor database permits single-statement SELECT queries only.');
  }
  const trimmed = sql.trim();
  const firstTokenMatch = trimmed.match(/^([a-zA-Z_]+)/);
  const firstToken = firstTokenMatch?.[1]?.toUpperCase();
  if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
    throw new Error('Read-only risk monitor database permits SELECT or WITH queries only.');
  }
  if (/(^|[^a-zA-Z0-9_])[uU]\s*&/.test(trimmed) || /(^|[^a-zA-Z0-9_])[eE]'/.test(trimmed)) {
    throw new Error('Read-only risk monitor database rejected escaped SQL identifier or literal syntax.');
  }
  const withoutStrings = trimmed.replace(/'(?:''|[^'])*'/g, "''");
  if (withoutStrings.includes('\\')) {
    throw new Error('Read-only risk monitor database rejected backslash outside string literal.');
  }
  const normalizedIdentifiers = withoutStrings.replace(/"/g, '');
  if (FORBIDDEN_SQL_PATTERN.test(normalizedIdentifiers)) {
    throw new Error('Read-only risk monitor database rejected disallowed SQL keyword or function.');
  }
}

const DROP_PG_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08003', '08006']);
const DROP_MSG_SNIPPETS = [
  'connection terminated',
  'terminating connection',
  'client has encountered a connection error',
  'econnreset',
  'epipe',
  'socket hang up',
  'connection closed',
];

export function isConnectionDropError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const obj = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof obj.code === 'string' && DROP_PG_CODES.has(obj.code.toUpperCase())) {
    return true;
  }
  const msg = typeof obj.message === 'string' ? obj.message.toLowerCase() : '';
  if (DROP_MSG_SNIPPETS.some((s) => msg.includes(s))) {
    return true;
  }
  return obj.cause ? isConnectionDropError(obj.cause) : false;
}

export function toBigInt(val: unknown): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isSafeInteger(val)) {
      throw new Error(`Unsafe numeric database value: ${val}`);
    }
    return BigInt(val);
  }
  if (typeof val === 'string') return BigInt(val);
  throw new Error(`Cannot convert database value to bigint: ${String(val)}`);
}

class ReadOnlyPostgresPool implements ReadOnlyDatabase {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    const rawMax = Number(process.env.PG_POOL_MAX ?? 5);
    const max = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : 5;
    const rawIdle = Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000);
    const idleTimeoutMillis = Number.isInteger(rawIdle) && rawIdle >= 0 ? rawIdle : 30_000;
    const rawStmtTimeout = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000);
    const statementTimeout =
      Number.isInteger(rawStmtTimeout) && rawStmtTimeout > 0 ? rawStmtTimeout : 15_000;

    this.pool = new Pool({
      connectionString,
      max,
      idleTimeoutMillis,
      statement_timeout: statementTimeout,
      options: '-c default_transaction_read_only=on',
    });
    this.pool.on('error', (err) => {
      console.error('[RISK_DB_POOL_ERROR] Idle PostgreSQL client error:', err.message);
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    assertReadOnlySql(sql);
    try {
      const res = await this.pool.query<T>(sql, params);
      return { rows: res.rows };
    } catch (err) {
      if (isConnectionDropError(err)) {
        console.warn('[RISK_DB_RETRY] PostgreSQL connection dropped during query; retrying once...');
        const res = await this.pool.query<T>(sql, params);
        return { rows: res.rows };
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class ReadOnlyPGliteAdapter implements ReadOnlyDatabase {
  private readonly db: PGlite;

  constructor(dataDir: string) {
    this.db = new PGlite(dataDir === 'memory://' ? undefined : dataDir);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    assertReadOnlySql(sql);
    await this.db.waitReady;
    const res = await this.db.query<T>(sql, params);
    return { rows: res.rows };
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export function wrapQueryableAsReadOnly(
  queryable: {
    query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ): Promise<{ rows: T[] }>;
    close?: () => Promise<void>;
  }
): ReadOnlyDatabase {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
      assertReadOnlySql(sql);
      return queryable.query<T>(sql, params);
    },
    async close() {
      if (queryable.close) {
        await queryable.close();
      }
    },
  };
}

export async function openReadOnlyDatabase(
  databaseUrl: string,
  allowDegradedBoot = true
): Promise<{ db: ReadOnlyDatabase; bootError?: string }> {
  const isExternalPg = /^postgres(ql)?:\/\//i.test(databaseUrl);
  const db: ReadOnlyDatabase = isExternalPg
    ? new ReadOnlyPostgresPool(databaseUrl)
    : new ReadOnlyPGliteAdapter(databaseUrl || 'memory://');

  try {
    await db.query('SELECT 1 AS ok');
    return { db };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!allowDegradedBoot) {
      await db.close().catch(() => {});
      throw err;
    }
    console.warn(`[RISK_DB_BOOT_DEGRADED] Initial DB probe failed (continuing degraded): ${msg}`);
    return { db, bootError: msg };
  }
}
