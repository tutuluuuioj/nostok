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

type SqlTokenType = 'WORD' | 'IDENT' | 'STRING' | 'PARAM' | 'OTHER';

interface SqlToken {
  type: SqlTokenType;
  value: string;
}

const ALLOWED_NOTIF_TABLES = new Set([
  'notif_nonces',
  'notif_subscriptions',
  'notif_preferences',
  'notif_deliveries',
  'notif_dead_letters',
  'notif_cursor',
  'notif_alert_episodes',
  'notif_revoked_sessions',
  'notif_blocked_senders',
  'notif_verify_sends',
  'notif_verify_target_state',
]);

const INDEXER_TABLES = new Set([
  'loans',
  'loan_events',
  'orders',
  'order_fills',
  'auctions',
  'auction_buys',
  'positions',
  'claims',
  'assets',
  'indexed_blocks',
  'indexer_state',
]);

const FORBIDDEN_RO_KEYWORDS = new Set([
  'INTO',
  'MERGE',
  'SET',
  'RESET',
  'BEGIN',
  'START',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'LOCK',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE',
  'LISTEN',
  'NOTIFY',
  'UNLISTEN',
  'LOAD',
  'IMPORT',
  'SECURITY',
  'REINDEX',
  'CLUSTER',
  'REFRESH',
  'COMMENT',
  'DISCARD',
  'SHOW',
  'EXPLAIN',
  'ANALYZE',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'CREATE',
  'REPLACE',
  'GRANT',
  'REVOKE',
  'COPY',
  'VACUUM',
  'CALL',
  'DO',
  'UESCAPE',
  'RETURNING',
  'SET_CONFIG',
  'NEXTVAL',
  'SETVAL',
  'CURRVAL',
  'LASTVAL',
  'INFORMATION_SCHEMA',
  'XPATH',
  'XPATH_EXISTS',
  'XMLEXISTS',
  'XMLPARSE',
  'XMLSERIALIZE',
  'XMLTABLE',
  'QUERY_TO_XML',
  'QUERY_TO_XMLSCHEMA',
  'QUERY_TO_XML_AND_XMLSCHEMA',
  'TABLE_TO_XML',
  'TABLE_TO_XMLSCHEMA',
  'TABLE_TO_XML_AND_XMLSCHEMA',
  'CURSOR_TO_XML',
  'CURSOR_TO_XMLSCHEMA',
  'DATABASE_TO_XML',
  'DATABASE_TO_XMLSCHEMA',
  'DATABASE_TO_XML_AND_XMLSCHEMA',
  'SCHEMA_TO_XML',
  'SCHEMA_TO_XMLSCHEMA',
  'SCHEMA_TO_XML_AND_XMLSCHEMA',
]);

const FORBIDDEN_NOTIF_ADMIN_FUNCS = new Set([
  'SET_CONFIG',
  'NEXTVAL',
  'SETVAL',
  'CURRVAL',
  'LASTVAL',
  'INFORMATION_SCHEMA',
  'XPATH',
  'XPATH_EXISTS',
  'XMLEXISTS',
  'XMLPARSE',
  'XMLSERIALIZE',
  'XMLTABLE',
  'PG_SLEEP',
  'PG_TERMINATE_BACKEND',
  'PG_CANCEL_BACKEND',
  'PG_READ_FILE',
  'PG_READ_BINARY_FILE',
  'PG_WRITE_FILE',
  'PG_LS_DIR',
  'PG_STAT_FILE',
  'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE',
]);

function tokenizeSql(sql: string, contextLabel: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const len = sql.length;
  let i = 0;

  while (i < len) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === ';') {
      throw new Error(`${contextLabel} permits single-statement SQL queries only.`);
    }
    if (ch === '\\') {
      throw new Error(`${contextLabel} rejected backslash in SQL.`);
    }
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '*') || (ch === '*' && sql[i + 1] === '/')) {
      throw new Error(`${contextLabel} permits single-statement SQL queries without comments only.`);
    }

    if (ch === '$') {
      const m = sql.slice(i).match(/^\$[1-9]\d*(?![a-zA-Z0-9_$])/);
      if (!m) {
        throw new Error(`${contextLabel} rejected dollar-quoted SQL or invalid parameter.`);
      }
      tokens.push({ type: 'PARAM', value: m[0] });
      i += m[0].length;
      continue;
    }

    if (ch === '\'') {
      if (
        i >= 1 &&
        /[eEbBxX]/.test(sql[i - 1]) &&
        (i === 1 || !/[a-zA-Z0-9_]/.test(sql[i - 2]))
      ) {
        throw new Error(`${contextLabel} rejected escaped SQL literal syntax.`);
      }
      let j = i + 1;
      let closed = false;
      while (j < len) {
        if (sql[j] === '\\') {
          throw new Error(`${contextLabel} rejected backslash inside string literal.`);
        }
        if (sql[j] === '\'') {
          if (sql[j + 1] === '\'') {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        throw new Error('Unterminated SQL string literal.');
      }
      tokens.push({ type: 'STRING', value: "''" });
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let ident = '';
      let closed = false;
      while (j < len) {
        if (sql[j] === '\\') {
          throw new Error(`${contextLabel} rejected backslash inside identifier.`);
        }
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            ident += '"';
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        ident += sql[j];
        j += 1;
      }
      if (!closed || ident.length === 0) {
        throw new Error('Unterminated or empty SQL quoted identifier.');
      }
      tokens.push({ type: 'IDENT', value: ident });
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_]/.test(sql[j])) {
        j += 1;
      }
      const word = sql.slice(i, j);
      if (sql[j] === '$') {
        throw new Error(`${contextLabel} rejected dollar-quoted SQL syntax.`);
      }
      let k = j;
      while (k < len && /\s/.test(sql[k])) k += 1;
      if (word.toUpperCase() === 'U' && sql[k] === '&') {
        throw new Error(`${contextLabel} rejected escaped SQL identifier or literal syntax.`);
      }
      tokens.push({ type: 'WORD', value: word });
      i = j;
      continue;
    }

    tokens.push({ type: 'OTHER', value: ch });
    i += 1;
  }

  return tokens;
}

function isForbiddenRoIdentifierOrKeyword(raw: string): boolean {
  const upper = raw.toUpperCase();
  const lower = raw.toLowerCase();
  if (FORBIDDEN_RO_KEYWORDS.has(upper)) return true;
  if (
    lower.startsWith('pg_') ||
    lower.startsWith('lo_') ||
    lower.startsWith('dblink') ||
    lower.startsWith('txid_') ||
    lower.endsWith('_to_xml') ||
    lower.endsWith('_to_xmlschema')
  ) {
    return true;
  }
  return false;
}

export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('Read-only indexer database permits SELECT queries only.');
  }
  const tokens = tokenizeSql(sql, 'Read-only indexer database');
  if (tokens.length === 0 || tokens[0].type !== 'WORD') {
    throw new Error('Read-only indexer database permits SELECT or WITH queries only.');
  }
  const firstWord = tokens[0].value.toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    throw new Error('Read-only indexer database permits SELECT or WITH queries only.');
  }

  const identWords: string[] = [];
  for (const tok of tokens) {
    if (tok.type === 'WORD' || tok.type === 'IDENT') {
      if (isForbiddenRoIdentifierOrKeyword(tok.value)) {
        throw new Error('Read-only indexer database rejected disallowed SQL keyword or function.');
      }
      identWords.push(tok.value.toUpperCase());
    }
  }
  for (let i = 0; i + 1 < identWords.length; i++) {
    if (
      identWords[i] === 'FOR' &&
      (identWords[i + 1] === 'UPDATE' ||
        identWords[i + 1] === 'SHARE' ||
        identWords[i + 1] === 'NO' ||
        identWords[i + 1] === 'KEY')
    ) {
      throw new Error('Read-only indexer database rejected row-locking FOR clause.');
    }
  }
}

/**
 * Enforces that write queries only touch notif_* tables and never mutate indexer tables.
 */
export function assertNotifTableSql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('Empty SQL rejected');
  }
  const tokens = tokenizeSql(sql, 'Notifications database');
  if (tokens.length === 0 || tokens[0].type !== 'WORD') {
    throw new Error('Notifications database requires a valid SQL statement verb');
  }

  for (const tok of tokens) {
    if (tok.type !== 'WORD' && tok.type !== 'IDENT') continue;
    const upper = tok.value.toUpperCase();
    const lower = tok.value.toLowerCase();
    if (
      FORBIDDEN_NOTIF_ADMIN_FUNCS.has(upper) ||
      lower.startsWith('lo_') ||
      lower.startsWith('dblink') ||
      lower.startsWith('txid_') ||
      lower.endsWith('_to_xml') ||
      lower.endsWith('_to_xmlschema')
    ) {
      throw new Error(`Disallowed SQL function or schema in notifications DB: ${tok.value}`);
    }
    if (INDEXER_TABLES.has(lower)) {
      throw new Error(`Notifications service may only write to notif_* tables (got: ${tok.value})`);
    }
  }

  const verb = tokens[0].value.toUpperCase();
  if (verb === 'SELECT' || verb === 'WITH') {
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (
        (tok.type === 'WORD' || tok.type === 'IDENT') &&
        /^(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE|INTO|COPY|CALL|DO|MERGE|RETURNING|UESCAPE)$/.test(
          tok.value.toUpperCase()
        )
      ) {
        if (
          tok.value.toUpperCase() === 'UPDATE' &&
          tokens[i - 1]?.type === 'WORD' &&
          tokens[i - 1].value.toUpperCase() === 'FOR'
        ) {
          // Allow "FOR UPDATE OF d SKIP LOCKED" when claiming notif_deliveries inside transaction
          continue;
        }
        throw new Error('Write keyword inside SELECT rejected');
      }
    }
    return;
  }

  if (verb !== 'INSERT' && verb !== 'UPDATE' && verb !== 'DELETE') {
    throw new Error(`Disallowed SQL verb in notifications DB: ${verb}`);
  }

  let targetTable: string | undefined;
  if (verb === 'INSERT') {
    if (tokens[1]?.type !== 'WORD' || tokens[1].value.toUpperCase() !== 'INTO') {
      throw new Error('Malformed INSERT in notifications DB');
    }
    targetTable = tokens[2]?.value;
  } else if (verb === 'UPDATE') {
    targetTable = tokens[1]?.value;
  } else if (verb === 'DELETE') {
    if (tokens[1]?.type !== 'WORD' || tokens[1].value.toUpperCase() !== 'FROM') {
      throw new Error('Malformed DELETE in notifications DB');
    }
    targetTable = tokens[2]?.value;
  }

  const cleanTarget = targetTable?.toLowerCase();
  if (!cleanTarget || !ALLOWED_NOTIF_TABLES.has(cleanTarget)) {
    throw new Error(`Notifications service may only write to notif_* tables (got: ${targetTable ?? 'unknown'})`);
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
  private readonly statementTimeout: number;

  constructor(connectionString: string) {
    const rawStmtTimeout = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 5_000);
    this.statementTimeout =
      Number.isInteger(rawStmtTimeout) && rawStmtTimeout > 0 ? rawStmtTimeout : 5_000;

    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: this.statementTimeout,
      options: `-c default_transaction_read_only=on -c statement_timeout=${this.statementTimeout}`,
    });
    this.pool.on('error', (err) => {
      console.error('[NOTIF_INDEXER_POOL_ERROR]', err.message);
    });
  }

  private async runReadOnlyTx<T extends QueryResultRow>(
    sql: string,
    params: unknown[]
  ): Promise<{ rows: T[] }> {
    const client = await this.pool.connect();
    let asyncClientError: Error | null = null;
    const onClientError = (err: Error) => {
      asyncClientError = err;
    };
    client.on('error', onClientError);

    let releaseErr: Error | undefined;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeout}`);
      const res = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return { rows: res.rows };
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

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    assertReadOnlySql(sql);
    try {
      return await this.runReadOnlyTx<T>(sql, params);
    } catch (err) {
      if (isConnectionDropError(err)) {
        return await this.runReadOnlyTx<T>(sql, params);
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
  private mutex: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.db = new PGlite(dataDir === 'memory://' ? undefined : dataDir);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(fn, fn);
    this.mutex = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  async exec(sql: string): Promise<void> {
    return this.enqueue(async () => {
      await this.db.waitReady;
      await this.db.exec(sql);
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    assertNotifTableSql(sql);
    return this.enqueue(async () => {
      await this.db.waitReady;
      const res = await this.db.query<T>(sql, params);
      return { rows: res.rows };
    });
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
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
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

function getConfiguredStatementTimeoutMs(overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isInteger(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  const rawStmtTimeout = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 5_000);
  return Number.isInteger(rawStmtTimeout) && rawStmtTimeout > 0 ? rawStmtTimeout : 5_000;
}

async function runTxWithStatementTimeout<T extends QueryResultRow>(
  execTx: (isTimedOut: () => boolean) => Promise<{ rows: T[] }>,
  timeoutMs: number
): Promise<{ rows: T[] }> {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const txPromise = execTx(() => timedOut);
  txPromise.catch(() => {});

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Read-only query exceeded statement_timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([txPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function wrapIndexerQueryableAsReadOnly(
  queryable: {
    query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ): Promise<{ rows: T[] }>;
    close?: () => Promise<void>;
  },
  opts?: { statementTimeoutMs?: number; skipSetLocalStatementTimeout?: boolean }
): ReadOnlyIndexerDatabase {
  let mutex: Promise<void> = Promise.resolve();
  const statementTimeout = getConfiguredStatementTimeoutMs(opts?.statementTimeoutMs);
  return {
    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
      assertReadOnlySql(sql);
      const run = async (): Promise<{ rows: T[] }> =>
        runTxWithStatementTimeout<T>(async (isTimedOut) => {
          await queryable.query('BEGIN READ ONLY');
          try {
            if (!opts?.skipSetLocalStatementTimeout) {
              await queryable.query(`SET LOCAL statement_timeout = ${statementTimeout}`);
            }
            const res = await queryable.query<T>(sql, params);
            if (isTimedOut()) {
              throw new Error(`Read-only query exceeded statement_timeout (${statementTimeout}ms)`);
            }
            await queryable.query('COMMIT');
            return res;
          } catch (err) {
            await queryable.query('ROLLBACK').catch(() => {});
            throw err;
          }
        }, statementTimeout);
      const next = mutex.then(run, run);
      mutex = next.then(
        () => {},
        () => {}
      );
      return next;
    },
    async close() {
      if (queryable.close) await queryable.close();
    },
  };
}

export async function openReadOnlyIndexerDatabase(
  databaseUrl: string,
  opts?: { statementTimeoutMs?: number }
): Promise<ReadOnlyIndexerDatabase> {
  if (/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    const db = new ReadOnlyPostgresPool(databaseUrl);
    await db.query('SELECT 1 AS ok');
    return db;
  }
  const pg = new PGlite(databaseUrl === 'memory://' ? undefined : databaseUrl);
  await pg.waitReady;
  return wrapIndexerQueryableAsReadOnly(
    {
      query: (sql, params) => pg.query(sql, params),
      close: () => pg.close(),
    },
    opts
  );
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
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      verify_code_hash TEXT,
      verify_expires_at BIGINT,
      verify_attempts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (wallet, channel, target_hash)
    );
    ALTER TABLE notif_subscriptions ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE notif_subscriptions ADD COLUMN IF NOT EXISTS verify_code_hash TEXT;
    ALTER TABLE notif_subscriptions ADD COLUMN IF NOT EXISTS verify_expires_at BIGINT;
    ALTER TABLE notif_subscriptions ADD COLUMN IF NOT EXISTS verify_attempts INT NOT NULL DEFAULT 0;
    ALTER TABLE notif_subscriptions ADD COLUMN IF NOT EXISTS canonical_target_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_notif_subs_wallet ON notif_subscriptions (wallet);
    CREATE INDEX IF NOT EXISTS idx_notif_subs_cth ON notif_subscriptions (canonical_target_hash, verified);

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
      claimed_at BIGINT,
      lease_until BIGINT,
      created_at BIGINT NOT NULL,
      sent_at BIGINT,
      UNIQUE (subscription_id, dedup_key)
    );
    ALTER TABLE notif_deliveries ADD COLUMN IF NOT EXISTS claimed_at BIGINT;
    ALTER TABLE notif_deliveries ADD COLUMN IF NOT EXISTS lease_until BIGINT;
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

    CREATE TABLE IF NOT EXISTS notif_alert_episodes (
      state_key TEXT PRIMARY KEY,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      episode INT NOT NULL DEFAULT 0,
      last_value_bps INT,
      clear_since BIGINT,
      updated_at BIGINT NOT NULL
    );
    ALTER TABLE notif_alert_episodes ADD COLUMN IF NOT EXISTS clear_since BIGINT;

    CREATE TABLE IF NOT EXISTS notif_revoked_sessions (
      jti TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      revoked_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_revoked_wallet ON notif_revoked_sessions (wallet);

    CREATE TABLE IF NOT EXISTS notif_blocked_senders (
      wallet TEXT NOT NULL,
      canonical_target_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (wallet, canonical_target_hash)
    );

    CREATE TABLE IF NOT EXISTS notif_verify_sends (
      id TEXT PRIMARY KEY,
      canonical_target_hash TEXT NOT NULL,
      sent_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_verify_sends_target_time ON notif_verify_sends (canonical_target_hash, sent_at);

    CREATE TABLE IF NOT EXISTS notif_verify_target_state (
      canonical_target_hash TEXT PRIMARY KEY,
      last_digest_sent_at BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL
    );
  `);
}
