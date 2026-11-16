import 'dotenv/config';
import { type Address, getAddress, isAddress } from 'viem';

export interface RiskConfig {
  port: number;
  host: string;
  rpcUrl: string;
  isFork: boolean;
  forkChainId: number;
  /**
   * Read-only PostgreSQL connection string (must use a SELECT-only role such as nostok_ro when FORK=false).
   */
  databaseUrl: string;
  pollIntervalMs: number;
  alertCooldownMs: number;
  webhookUrl?: string;
  nearLiqBufferBps: number;
  priceDeviationWarnBps: number;
  keeperInactivityAlertSecs: number;
  maxHealthyLagBlocks: number;
  maxHealthyLagSecs: number;
  corsOrigins: string[];
  rateLimitMax: number;
  rateLimitWindowMs: number;
  rateLimitMaxBuckets: number;
  trustProxyHops: number;
  maxBodyBytes: number;
  maxPageLimit: number;
  loanCore: Address;
  liquidationAuction: Address;
  collateralEscrow: Address;
  assetRegistry: Address;
  oracleRouter: Address;
}

export type RiskConfigOverrides = Partial<RiskConfig>;

function requireAddress(value: string | undefined, name: string): Address {
  if (!value || !isAddress(value)) {
    throw new Error(`Invalid or missing contract address for ${name}`);
  }
  return getAddress(value);
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${raw}`);
  }
  return num;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`Invalid non-negative integer for ${name}: ${raw}`);
  }
  return num;
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return ['*'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadRiskConfig(overrides: RiskConfigOverrides = {}): RiskConfig {
  const port = overrides.port ?? parsePositiveInt(process.env.PORT, 3002, 'PORT');
  const host = overrides.host ?? (process.env.HOST?.trim() || '127.0.0.1');
  const rpcUrl = overrides.rpcUrl ?? (process.env.RPC_URL?.trim() || 'http://127.0.0.1:8545');

  let isFork = false;
  if (overrides.isFork !== undefined) {
    isFork = overrides.isFork;
  } else if (process.env.FORK !== undefined) {
    const val = process.env.FORK.trim().toLowerCase();
    isFork = val === 'true' || val === '1' || val === 'yes';
  }

  const forkChainId =
    overrides.forkChainId ?? parsePositiveInt(process.env.FORK_CHAIN_ID, 8453, 'FORK_CHAIN_ID');

  const databaseUrl =
    overrides.databaseUrl ?? (process.env.DATABASE_URL?.trim() || (isFork ? 'memory://' : ''));

  if (!isFork && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    throw new Error(
      'DATABASE_URL must be a postgres:// or postgresql:// connection string when FORK is not enabled.'
    );
  }

  const webhookRaw = overrides.webhookUrl !== undefined ? overrides.webhookUrl : process.env.WEBHOOK_URL?.trim();
  const webhookUrl = webhookRaw && webhookRaw.length > 0 ? webhookRaw : undefined;

  return {
    port,
    host,
    rpcUrl,
    isFork,
    forkChainId,
    databaseUrl,
    pollIntervalMs:
      overrides.pollIntervalMs ?? parsePositiveInt(process.env.POLL_INTERVAL_MS, 10_000, 'POLL_INTERVAL_MS'),
    alertCooldownMs:
      overrides.alertCooldownMs ??
      parseNonNegativeInt(process.env.ALERT_COOLDOWN_MS, 300_000, 'ALERT_COOLDOWN_MS'),
    webhookUrl,
    nearLiqBufferBps:
      overrides.nearLiqBufferBps ??
      parsePositiveInt(process.env.NEAR_LIQ_BUFFER_BPS, 300, 'NEAR_LIQ_BUFFER_BPS'),
    priceDeviationWarnBps:
      overrides.priceDeviationWarnBps ??
      parsePositiveInt(process.env.PRICE_DEVIATION_WARN_BPS, 500, 'PRICE_DEVIATION_WARN_BPS'),
    keeperInactivityAlertSecs:
      overrides.keeperInactivityAlertSecs ??
      parsePositiveInt(process.env.KEEPER_INACTIVITY_ALERT_SECS, 120, 'KEEPER_INACTIVITY_ALERT_SECS'),
    maxHealthyLagBlocks:
      overrides.maxHealthyLagBlocks ??
      parsePositiveInt(process.env.MAX_HEALTHY_LAG_BLOCKS, 20, 'MAX_HEALTHY_LAG_BLOCKS'),
    maxHealthyLagSecs:
      overrides.maxHealthyLagSecs ??
      parsePositiveInt(process.env.MAX_HEALTHY_LAG_SECS, 120, 'MAX_HEALTHY_LAG_SECS'),
    corsOrigins: overrides.corsOrigins ?? parseCorsOrigins(process.env.CORS_ORIGINS),
    rateLimitMax: overrides.rateLimitMax ?? parsePositiveInt(process.env.RATE_LIMIT_MAX, 120, 'RATE_LIMIT_MAX'),
    rateLimitWindowMs:
      overrides.rateLimitWindowMs ??
      parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS'),
    rateLimitMaxBuckets:
      overrides.rateLimitMaxBuckets ??
      parsePositiveInt(process.env.RATE_LIMIT_MAX_BUCKETS, 10_000, 'RATE_LIMIT_MAX_BUCKETS'),
    trustProxyHops:
      overrides.trustProxyHops ?? parseNonNegativeInt(process.env.TRUST_PROXY, 0, 'TRUST_PROXY'),
    maxBodyBytes: overrides.maxBodyBytes ?? parsePositiveInt(process.env.MAX_BODY_BYTES, 65_536, 'MAX_BODY_BYTES'),
    maxPageLimit: overrides.maxPageLimit ?? parsePositiveInt(process.env.MAX_PAGE_LIMIT, 100, 'MAX_PAGE_LIMIT'),
    loanCore: overrides.loanCore ?? requireAddress(process.env.LOAN_CORE_ADDRESS, 'LOAN_CORE_ADDRESS'),
    liquidationAuction:
      overrides.liquidationAuction ??
      requireAddress(process.env.LIQUIDATION_AUCTION_ADDRESS, 'LIQUIDATION_AUCTION_ADDRESS'),
    collateralEscrow:
      overrides.collateralEscrow ??
      requireAddress(process.env.COLLATERAL_ESCROW_ADDRESS, 'COLLATERAL_ESCROW_ADDRESS'),
    assetRegistry:
      overrides.assetRegistry ?? requireAddress(process.env.ASSET_REGISTRY_ADDRESS, 'ASSET_REGISTRY_ADDRESS'),
    oracleRouter:
      overrides.oracleRouter ?? requireAddress(process.env.ORACLE_ROUTER_ADDRESS, 'ORACLE_ROUTER_ADDRESS'),
  };
}
