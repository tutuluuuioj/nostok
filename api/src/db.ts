import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const { Pool } = pg;

export interface QueryResultRow {
  [column: string]: unknown;
}

/**
 * Strict read-only database interface exposed to the API.
 * Contains NO write helpers and enforces SELECT-only SQL statements.
 */
export interface ReadOnlyDatabase {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

const FORBIDDEN_SQL_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE|COPY|VACUUM|CALL|DO)\b/i;

export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  const withoutComments = trimmed.replace(/^(--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/g, '').trim();
  if (!/^(SELECT|WITH)\b/i.test(withoutComments) || FORBIDDEN_SQL_PATTERN.test(withoutComments)) {
    throw new Error('Read-only API database permits SELECT queries only.');
  }
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
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    const rawMax = Number(process.env.PG_POOL_MAX ?? 5);
    const max = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : 5;
    this.pool = new Pool({
      connectionString,
      max,
      options: '-c default_transaction_read_only=on',
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    assertReadOnlySql(sql);
    const res = await this.pool.query<T>(sql, params);
    return { rows: res.rows };
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

export async function openReadOnlyDatabase(databaseUrl: string): Promise<ReadOnlyDatabase> {
  const isExternalPg = /^postgres(ql)?:\/\//i.test(databaseUrl);
  const db: ReadOnlyDatabase = isExternalPg
    ? new ReadOnlyPostgresPool(databaseUrl)
    : new ReadOnlyPGliteAdapter(databaseUrl || 'memory://');

  await db.query('SELECT 1 AS ok');
  return db;
}
