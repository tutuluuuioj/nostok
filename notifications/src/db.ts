import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const { Pool } = pg;

export interface QueryResultRow {
  [column: string]: unknown;
}

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
}

/**
 * Strictly read-only client for indexer tables (loans, loan_events, auctions, positions, claims, assets).
 */
export interface ReadOnlyIndexerDatabase extends Queryable {
  close(): Promise<void>;
}

/**
 * Notifications service state DB: writes are strictly restricted to notif_* tables.
 */
export interface NotifDatabase extends Queryable {
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const FORBIDDEN_RO_SQL_PATTERN =
  /\b(INTO|MERGE|SET|RESET|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOCK|PREPARE|EXECUTE|DEALLOCATE|LISTEN|NOTIFY|UNLISTEN|LOAD|IMPORT|SECURITY|REINDEX|CLUSTER|REFRESH|COMMENT|DISCARD|SHOW|EXPLAIN|ANALYZE|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE|COPY|VACUUM|CALL|DO|UESCAPE|FOR\s+UPDATE|FOR\s+SHARE|set_config)\b|\b(pg_|lo_|dblink)[a-zA-Z0-9_]*/i;

export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('Read-only indexer database permits SELECT queries only.');
  }
  if (sql.includes(';') || sql.includes('$$') || /(--|\/\*|\*\/)/.test(sql)) {
    throw new Error('Read-only indexer database permits single-statement SELECT queries only.');
  }
  const trimmed = sql.trim();
  const firstTokenMatch = trimmed.match(/^([a-zA-Z_]+)/);
  const firstToken = firstTokenMatch?.[1]?.toUpperCase();
  if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
    throw new Error('Read-only indexer database permits SELECT or WITH queries only.');
  }
  if (/(^|[^a-zA-Z0-9_])[uU]\s*&/.test(trimmed) || /(^|[^a-zA-Z0-9_])[eE]'/.test(trimmed)) {
    throw new Error('Read-only indexer database rejected escaped SQL identifier or literal syntax.');
  }
  const withoutStrings = trimmed.replace(/'(?:''|[^'])*'/g, "''");
  if (withoutStrings.includes('\\')) {
    throw new Error('Read-only indexer database rejected backslash outside string literal.');
  }
  const normalizedIdentifiers = withoutStrings.replace(/"/g, '');
  if (FORBIDDEN_RO_SQL_PATTERN.test(normalizedIdentifiers)) {
    throw new Error('Read-only indexer database rejected disallowed SQL keyword or function.');
  }
}

/**
 * Enforces that write queries only touch notif_* tables and never mutate indexer tables.
 */
export function assertNotifTableSql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('Empty SQL rejected');
  }
  if (sql.includes(';') || sql.includes('$$') || /(--|\/\*|\*\/)/.test(sql)) {
    throw new Error('Single-statement SQL only');
  }
  const trimmed = sql.trim();
  const withoutStrings = trimmed.replace(/'(?:''|[^'])*'/g, "''");
  if (/^\s*(SELECT|WITH)\b/i.test(withoutStrings)) {
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|INTO)\b/i.test(withoutStrings)) {
      throw new Error('Write keyword inside SELECT rejected');
    }
    return;
  }
  const insertMatch = withoutStrings.match(/^\s*INSERT\s+INTO\s+([a-zA-Z0-9_."]+)/i);
  const updateMatch = withoutStrings.match(/^\s*UPDATE\s+([a-zA-Z0-9_."]+)/i);
  const deleteMatch = withoutStrings.match(/^\s*DELETE\s+FROM\s+([a-zA-Z0-9_."]+)/i);
  const target = (insertMatch?.[1] ?? updateMatch?.[1] ?? deleteMatch?.[1])?.replace(/"/g, '').split('.').pop();
  if (!target || !target.toLowerCase().startsWith('notif_')) {
    throw new Error(`Notifications service may only write to notif_* tables (got: ${target ?? 'unknown'})`);
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

class ReadOnlyPostgresPool implements ReadOnlyIndexerDatabase {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      options: '-c default_transaction_read_only=on',
    });
    this.pool.on('error', (err) => {
      console.error('[NOTIF_INDEXER_POOL_ERROR]', err.message);
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

class NotifPostgresPool implements NotifDatabase {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
    this.pool.on('error', (err) => {
      console.error('[NOTIF_DB_POOL_ERROR]', err.message);
    });
  }

  async exec(sql: string): Promise<void> {
    try {
      await this.pool.query(sql);
    } catch (err) {
      if (isConnectionDropError(err)) {
        await this.pool.query(sql);
        return;
      }
      throw err;
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    assertNotifTableSql(sql);
    try {
      const res = await this.pool.query<T>(sql, params);
      return { rows: res.rows };
    } catch (err) {
      if (isConnectionDropError(err)) {
        const res = await this.pool.query<T>(sql, params);
        return { rows: res.rows };
      }
      throw err;
    }
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let asyncClientError: Error | null = null;
    const onClientError = (err: Error) => {
      asyncClientError = err;
      console.error('[NOTIF_DB_TX_CLIENT_ERROR]', err.message);
    };
    client.on('error', onClientError);

    let releaseErr: Error | undefined;
    try {
      await client.query('BEGIN');
      const q: Queryable = {
        async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
          assertNotifTableSql(sql);
          const res = await client.query<R>(sql, params);
          return { rows: res.rows };
        },
      };
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      const dropped = isConnectionDropError(err) || asyncClientError !== null;
      if (dropped) {
        releaseErr = err instanceof Error ? err : new Error(String(err));
      } else {
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          releaseErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        }
      }
      throw err;
    } finally {
      client.removeListener('error', onClientError);
      if (releaseErr) client.on('error', () => {});
      client.release(releaseErr);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class NotifPGliteAdapter implements NotifDatabase {
  private readonly db: PGlite;

  constructor(dataDir: string) {
    this.db = new PGlite(dataDir === 'memory://' ? undefined : dataDir);
  }

  async exec(sql: string): Promise<void> {
    await this.db.waitReady;
    await this.db.exec(sql);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    assertNotifTableSql(sql);
    await this.db.waitReady;
    const res = await this.db.query<T>(sql, params);
    return { rows: res.rows };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    await this.db.waitReady;
    return this.db.transaction(async (pgTx) => {
      const q: Queryable = {
        async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
          assertNotifTableSql(sql);
          const res = await pgTx.query<R>(sql, params);
          return { rows: res.rows };
        },
      };
      return fn(q);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export function wrapIndexerQueryableAsReadOnly(
  queryable: {
    query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ): Promise<{ rows: T[] }>;
    close?: () => Promise<void>;
  }
): ReadOnlyIndexerDatabase {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
      assertReadOnlySql(sql);
      return queryable.query<T>(sql, params);
    },
    async close() {
      if (queryable.close) await queryable.close();
    },
  };
}

export async function openReadOnlyIndexerDatabase(databaseUrl: string): Promise<ReadOnlyIndexerDatabase> {
  if (/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    const db = new ReadOnlyPostgresPool(databaseUrl);
    await db.query('SELECT 1 AS ok');
    return db;
  }
  const pg = new PGlite(databaseUrl === 'memory://' ? undefined : databaseUrl);
  await pg.waitReady;
  return wrapIndexerQueryableAsReadOnly({
    query: (sql, params) => pg.query(sql, params),
    close: () => pg.close(),
  });
}

export async function openNotifDatabase(databaseUrl: string): Promise<NotifDatabase> {
  const isExternalPg = /^postgres(ql)?:\/\//i.test(databaseUrl);
  const db: NotifDatabase = isExternalPg
    ? new NotifPostgresPool(databaseUrl)
    : new NotifPGliteAdapter(databaseUrl || 'memory://');
  await initNotifSchema(db);
  return db;
}

export async function initNotifSchema(db: NotifDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notif_nonces (
      nonce TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      domain TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notif_subscriptions (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      channel TEXT NOT NULL,
      target_ciphertext TEXT NOT NULL,
      key_id TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (wallet, channel, target_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_notif_subs_wallet ON notif_subscriptions (wallet);

    CREATE TABLE IF NOT EXISTS notif_preferences (
      wallet TEXT PRIMARY KEY,
      alert_types_json TEXT NOT NULL,
      quiet_hours_start INT,
      quiet_hours_end INT,
      max_per_hour INT NOT NULL DEFAULT 30,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notif_deliveries (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at BIGINT NOT NULL,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      sent_at BIGINT,
      UNIQUE (subscription_id, dedup_key)
    );
    CREATE INDEX IF NOT EXISTS idx_notif_deliv_wallet ON notif_deliveries (wallet);
    CREATE INDEX IF NOT EXISTS idx_notif_deliv_status ON notif_deliveries (status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS notif_dead_letters (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INT NOT NULL,
      last_error TEXT NOT NULL,
      failed_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_dlq_wallet ON notif_dead_letters (wallet);

    CREATE TABLE IF NOT EXISTS notif_cursor (
      id INT PRIMARY KEY,
      last_event_id BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
