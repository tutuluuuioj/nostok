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

export interface DatabaseAdapter extends Queryable {
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function toBigInt(val: unknown): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(val);
  if (typeof val === 'string') return BigInt(val);
  throw new Error(`Cannot convert database value to bigint: ${String(val)}`);
}

class PGliteAdapter implements DatabaseAdapter {
  private readonly db: PGlite;

  constructor(dataDir: string) {
    this.db = new PGlite(dataDir === 'memory://' ? undefined : dataDir);
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    const res = await this.db.query<T>(sql, params);
    return { rows: res.rows };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (pgTx) => {
      const q: Queryable = {
        async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
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

class PostgresPoolAdapter implements DatabaseAdapter {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    const rawMax = Number(process.env.PG_POOL_MAX ?? 1);
    const max = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : 1;
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
    });
    this.pool.on('error', (err) => {
      console.error('[INDEXER_DB_POOL_ERROR] Idle PostgreSQL client error:', err.message);
    });
  }

  async exec(sql: string): Promise<void> {
    try {
      await this.pool.query(sql);
    } catch (err) {
      if (isConnectionDropError(err)) {
        console.warn('[INDEXER_DB_RETRY] Connection dropped during exec; retrying once...');
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
    try {
      const res = await this.pool.query<T>(sql, params);
      return { rows: res.rows };
    } catch (err) {
      if (isConnectionDropError(err)) {
        console.warn('[INDEXER_DB_RETRY] Connection dropped during query; retrying once...');
        const res = await this.pool.query<T>(sql, params);
        return { rows: res.rows };
      }
      throw err;
    }
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const q: Queryable = {
        async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
          const res = await client.query<R>(sql, params);
          return { rows: res.rows };
        },
      };
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function openDatabase(databaseUrl: string): Promise<DatabaseAdapter> {
  const isExternalPg =
    databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://');
  const db: DatabaseAdapter = isExternalPg
    ? new PostgresPoolAdapter(databaseUrl)
    : new PGliteAdapter(databaseUrl || 'memory://');

  await initSchema(db);
  return db;
}

export async function initSchema(db: DatabaseAdapter): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      id INT PRIMARY KEY,
      last_indexed_block BIGINT NOT NULL,
      chain_id INT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS indexed_blocks (
      block_number BIGINT PRIMARY KEY,
      block_hash TEXT NOT NULL,
      parent_hash TEXT NOT NULL,
      block_timestamp BIGINT NOT NULL,
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS assets (
      token TEXT PRIMARY KEY,
      symbol TEXT,
      decimals INT,
      feed TEXT,
      feed_decimals INT,
      tier INT,
      max_init_ltv_bps INT,
      margin_call_ltv_bps INT,
      liq_ltv_bps INT,
      bad_debt_ltv_bps INT,
      max_discount_bps INT,
      closed_market_haircut_bps INT,
      per_loan_cap NUMERIC(78, 0),
      asset_cap NUMERIC(78, 0),
      max_stale_open_secs INT,
      status INT,
      restricted BOOLEAN,
      recorded_multiplier NUMERIC(78, 0),
      escrow_balance_raw NUMERIC(78, 0) NOT NULL DEFAULT 0,
      updated_block BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS loans (
      loan_id NUMERIC(78, 0) PRIMARY KEY,
      borrower TEXT NOT NULL,
      lender TEXT,
      collateral_token TEXT NOT NULL,
      collateral_raw NUMERIC(78, 0) NOT NULL,
      principal NUMERIC(78, 0) NOT NULL,
      start_time BIGINT NOT NULL,
      maturity BIGINT NOT NULL,
      rate_bps INT NOT NULL,
      penalty_spread_bps INT NOT NULL,
      init_ltv_bps INT NOT NULL,
      margin_call_ltv_bps INT NOT NULL,
      liq_ltv_bps INT NOT NULL,
      min_interest_days INT NOT NULL,
      status INT NOT NULL,
      yield_mode INT NOT NULL,
      core_version INT NOT NULL,
      interest_paid NUMERIC(78, 0) NOT NULL,
      principal_repaid NUMERIC(78, 0) NOT NULL,
      active_auction_id NUMERIC(78, 0) NOT NULL DEFAULT 0,
      bad_debt_shortfall NUMERIC(78, 0) NOT NULL DEFAULT 0,
      opened_block BIGINT NOT NULL,
      last_updated_block BIGINT NOT NULL,
      row_version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS loan_events (
      id BIGSERIAL PRIMARY KEY,
      block_number BIGINT NOT NULL,
      block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INT NOT NULL,
      contract_address TEXT NOT NULL,
      event_name TEXT NOT NULL,
      loan_id NUMERIC(78, 0),
      token TEXT,
      actor TEXT,
      counterparty TEXT,
      amount_raw NUMERIC(78, 0),
      secondary_amount NUMERIC(78, 0),
      payload JSONB NOT NULL,
      block_timestamp BIGINT NOT NULL,
      UNIQUE (block_number, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_loan_events_loan_id ON loan_events (loan_id);
    CREATE INDEX IF NOT EXISTS idx_loan_events_block ON loan_events (block_number);

    CREATE TABLE IF NOT EXISTS orders (
      order_hash TEXT PRIMARY KEY,
      maker TEXT NOT NULL,
      collateral_token TEXT,
      min_usdc NUMERIC(78, 0) NOT NULL DEFAULT 0,
      filled_usdc NUMERIC(78, 0) NOT NULL DEFAULT 0,
      order_type TEXT NOT NULL DEFAULT 'borrow',
      cancelled BOOLEAN NOT NULL DEFAULT FALSE,
      maker_nonce NUMERIC(78, 0) NOT NULL DEFAULT 0,
      first_seen_block BIGINT NOT NULL,
      last_updated_block BIGINT NOT NULL
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS collateral_token TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS min_usdc NUMERIC(78, 0) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'borrow';

    CREATE TABLE IF NOT EXISTS order_fills (
      id BIGSERIAL PRIMARY KEY,
      order_hash TEXT NOT NULL,
      maker TEXT NOT NULL,
      taker TEXT NOT NULL,
      loan_id NUMERIC(78, 0) NOT NULL,
      fill_amount_usdc NUMERIC(78, 0) NOT NULL,
      collateral_amount NUMERIC(78, 0) NOT NULL,
      block_number BIGINT NOT NULL,
      block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INT NOT NULL,
      block_timestamp BIGINT NOT NULL,
      UNIQUE (block_number, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_order_fills_hash ON order_fills (order_hash);
    CREATE INDEX IF NOT EXISTS idx_order_fills_loan ON order_fills (loan_id);

    CREATE TABLE IF NOT EXISTS auctions (
      auction_id NUMERIC(78, 0) PRIMARY KEY,
      loan_id NUMERIC(78, 0) NOT NULL,
      borrower TEXT NOT NULL,
      collateral_token TEXT NOT NULL,
      collateral_total NUMERIC(78, 0) NOT NULL,
      collateral_remaining NUMERIC(78, 0) NOT NULL,
      debt_principal_remaining NUMERIC(78, 0) NOT NULL,
      debt_interest_remaining NUMERIC(78, 0) NOT NULL,
      start_price NUMERIC(78, 0) NOT NULL,
      floor_price NUMERIC(78, 0) NOT NULL,
      start_time BIGINT NOT NULL,
      duration BIGINT NOT NULL,
      keeper TEXT NOT NULL,
      status INT NOT NULL,
      is_default_auction BOOLEAN NOT NULL,
      total_usdc_collected NUMERIC(78, 0) NOT NULL DEFAULT 0,
      debt_paid NUMERIC(78, 0) NOT NULL DEFAULT 0,
      fee_paid NUMERIC(78, 0) NOT NULL DEFAULT 0,
      surplus_to_borrower NUMERIC(78, 0) NOT NULL DEFAULT 0,
      created_block BIGINT NOT NULL,
      last_updated_block BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_auctions_loan_id ON auctions (loan_id);

    CREATE TABLE IF NOT EXISTS auction_buys (
      id BIGSERIAL PRIMARY KEY,
      auction_id NUMERIC(78, 0) NOT NULL,
      buyer TEXT NOT NULL,
      collateral_purchased NUMERIC(78, 0) NOT NULL,
      usdc_paid NUMERIC(78, 0) NOT NULL,
      clearing_price NUMERIC(78, 0) NOT NULL,
      block_number BIGINT NOT NULL,
      block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INT NOT NULL,
      block_timestamp BIGINT NOT NULL,
      UNIQUE (block_number, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_auction_buys_auction ON auction_buys (auction_id);

    CREATE TABLE IF NOT EXISTS positions (
      loan_id NUMERIC(78, 0) PRIMARY KEY,
      owner TEXT NOT NULL,
      auction_locked BOOLEAN NOT NULL DEFAULT FALSE,
      is_burned BOOLEAN NOT NULL DEFAULT FALSE,
      minted_block BIGINT NOT NULL,
      last_updated_block BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claims (
      id BIGSERIAL PRIMARY KEY,
      recipient TEXT NOT NULL,
      amount NUMERIC(78, 0) NOT NULL,
      block_number BIGINT NOT NULL,
      block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INT NOT NULL,
      block_timestamp BIGINT NOT NULL,
      UNIQUE (block_number, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_claims_recipient ON claims (recipient);
  `);
}
