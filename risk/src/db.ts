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

type SqlTokenType = 'WORD' | 'IDENT' | 'STRING' | 'PARAM' | 'OTHER';

interface SqlToken {
  type: SqlTokenType;
  value: string;
}

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

function tokenizeSql(sql: string): SqlToken[] {
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
      throw new Error('Read-only risk monitor database permits single-statement SELECT queries only.');
    }
    if (ch === '\\') {
      throw new Error('Read-only risk monitor database rejected backslash in SQL.');
    }
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '*') || (ch === '*' && sql[i + 1] === '/')) {
      throw new Error('Read-only risk monitor database permits single-statement SELECT queries without comments only.');
    }

    if (ch === '$') {
      const m = sql.slice(i).match(/^\$[1-9]\d*(?![a-zA-Z0-9_$])/);
      if (!m) {
        throw new Error('Read-only risk monitor database rejected dollar-quoted SQL or invalid parameter.');
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
        throw new Error('Read-only risk monitor database rejected escaped SQL literal syntax.');
      }
      let j = i + 1;
      let closed = false;
      while (j < len) {
        if (sql[j] === '\\') {
          throw new Error('Read-only risk monitor database rejected backslash inside string literal.');
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
          throw new Error('Read-only risk monitor database rejected backslash inside identifier.');
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
        throw new Error('Read-only risk monitor database rejected dollar-quoted SQL syntax.');
      }
      let k = j;
      while (k < len && /\s/.test(sql[k])) k += 1;
      if (word.toUpperCase() === 'U' && sql[k] === '&') {
        throw new Error('Read-only risk monitor database rejected escaped SQL identifier or literal syntax.');
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

function isForbiddenIdentifierOrKeyword(raw: string): boolean {
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
    throw new Error('Read-only risk monitor database permits SELECT queries only.');
  }
  const tokens = tokenizeSql(sql);
  if (tokens.length === 0 || tokens[0].type !== 'WORD') {
    throw new Error('Read-only risk monitor database permits SELECT or WITH queries only.');
  }
  const firstWord = tokens[0].value.toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    throw new Error('Read-only risk monitor database permits SELECT or WITH queries only.');
  }

  const identWords: string[] = [];
  for (const tok of tokens) {
    if (tok.type === 'WORD' || tok.type === 'IDENT') {
      if (isForbiddenIdentifierOrKeyword(tok.value)) {
        throw new Error('Read-only risk monitor database rejected disallowed SQL keyword or function.');
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
      throw new Error('Read-only risk monitor database rejected row-locking FOR clause.');
    }
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
  private readonly statementTimeout: number;

  constructor(connectionString: string) {
    const rawMax = Number(process.env.PG_POOL_MAX ?? 5);
    const max = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : 5;
    const rawIdle = Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000);
    const idleTimeoutMillis = Number.isInteger(rawIdle) && rawIdle >= 0 ? rawIdle : 30_000;
    const rawStmtTimeout = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 5_000);
    this.statementTimeout =
      Number.isInteger(rawStmtTimeout) && rawStmtTimeout > 0 ? rawStmtTimeout : 5_000;

    this.pool = new Pool({
      connectionString,
      max,
      idleTimeoutMillis,
      statement_timeout: this.statementTimeout,
      options: `-c default_transaction_read_only=on -c statement_timeout=${this.statementTimeout}`,
    });
    this.pool.on('error', (err) => {
      console.error('[RISK_DB_POOL_ERROR] Idle PostgreSQL client error:', err.message);
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
        console.warn('[RISK_DB_RETRY] PostgreSQL connection dropped during query; retrying once...');
        return await this.runReadOnlyTx<T>(sql, params);
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
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
  // Prevent unhandled rejection when timeoutPromise wins the race and txPromise rejects later
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

class ReadOnlyPGliteAdapter implements ReadOnlyDatabase {
  private readonly db: PGlite;
  private readonly statementTimeout: number;
  private mutex: Promise<void> = Promise.resolve();

  constructor(dataDir: string, statementTimeoutMs?: number) {
    this.db = new PGlite(dataDir === 'memory://' ? undefined : dataDir);
    this.statementTimeout = getConfiguredStatementTimeoutMs(statementTimeoutMs);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    assertReadOnlySql(sql);
    const run = async (): Promise<{ rows: T[] }> => {
      await this.db.waitReady;
      return runTxWithStatementTimeout<T>(async (isTimedOut) => {
        await this.db.query('BEGIN READ ONLY');
        try {
          await this.db.query(`SET LOCAL statement_timeout = ${this.statementTimeout}`);
          const res = await this.db.query<T>(sql, params);
          if (isTimedOut()) {
            throw new Error(`Read-only query exceeded statement_timeout (${this.statementTimeout}ms)`);
          }
          await this.db.query('COMMIT');
          return { rows: res.rows };
        } catch (err) {
          await this.db.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }, this.statementTimeout);
    };
    const next = this.mutex.then(run, run);
    this.mutex = next.then(
      () => {},
      () => {}
    );
    return next;
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
  },
  opts?: { statementTimeoutMs?: number; skipSetLocalStatementTimeout?: boolean }
): ReadOnlyDatabase {
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
      if (queryable.close) {
        await queryable.close();
      }
    },
  };
}

export async function openReadOnlyDatabase(
  databaseUrl: string,
  allowDegradedBoot = true,
  opts?: { statementTimeoutMs?: number }
): Promise<{ db: ReadOnlyDatabase; bootError?: string }> {
  const isExternalPg = /^postgres(ql)?:\/\//i.test(databaseUrl);
  const db: ReadOnlyDatabase = isExternalPg
    ? new ReadOnlyPostgresPool(databaseUrl)
    : new ReadOnlyPGliteAdapter(databaseUrl || 'memory://', opts?.statementTimeoutMs);

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
