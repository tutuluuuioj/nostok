import 'dotenv/config';
import { type Address, getAddress, isAddress } from 'viem';

export interface ApiConfig {
  port: number;
  host: string;
  rpcUrl: string;
  isFork: boolean;
  forkChainId: number;
  /**
   * Only secret read by the API.
   * Must be postgres:// or postgresql:// when FORK is not enabled.
   */
  databaseUrl: string;
  corsOrigins: string[];
  rateLimitMax: number;
  rateLimitWindowMs: number;
  rateLimitMaxBuckets: number;
  trustProxyHops: number;
  maxBodyBytes: number;
  maxPageLimit: number;
  maxHealthyLagBlocks: number;
  loanCore: Address;
  orderSettlement: Address;
  liquidationAuction: Address;
  positionNft: Address;
  collateralEscrow: Address;
  assetRegistry: Address;
  oracleRouter: Address;
  feeCollector: Address;
  eligibilityGate: Address;
  usdc: Address;
}

export type ApiConfigOverrides = Partial<ApiConfig>;

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

export function loadApiConfig(overrides: ApiConfigOverrides = {}): ApiConfig {
  const port = overrides.port ?? parsePositiveInt(process.env.PORT, 3001, 'PORT');
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

  const corsOrigins = overrides.corsOrigins ?? parseCorsOrigins(process.env.CORS_ORIGINS);
  const rateLimitMax = overrides.rateLimitMax ?? parsePositiveInt(process.env.RATE_LIMIT_MAX, 120, 'RATE_LIMIT_MAX');
  const rateLimitWindowMs =
    overrides.rateLimitWindowMs ??
    parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS');
  const rateLimitMaxBuckets =
    overrides.rateLimitMaxBuckets ??
    parsePositiveInt(process.env.RATE_LIMIT_MAX_BUCKETS, 10_000, 'RATE_LIMIT_MAX_BUCKETS');
  const trustProxyHops =
    overrides.trustProxyHops ?? parseNonNegativeInt(process.env.TRUST_PROXY, 0, 'TRUST_PROXY');
  const maxBodyBytes = overrides.maxBodyBytes ?? parsePositiveInt(process.env.MAX_BODY_BYTES, 65_536, 'MAX_BODY_BYTES');
  const maxPageLimit = overrides.maxPageLimit ?? parsePositiveInt(process.env.MAX_PAGE_LIMIT, 100, 'MAX_PAGE_LIMIT');
  const maxHealthyLagBlocks =
    overrides.maxHealthyLagBlocks ??
    parsePositiveInt(process.env.MAX_HEALTHY_LAG_BLOCKS, 20, 'MAX_HEALTHY_LAG_BLOCKS');

  return {
    port,
    host,
    rpcUrl,
    isFork,
    forkChainId,
    databaseUrl,
    corsOrigins,
    rateLimitMax,
    rateLimitWindowMs,
    rateLimitMaxBuckets,
    trustProxyHops,
    maxBodyBytes,
    maxPageLimit,
    maxHealthyLagBlocks,
    loanCore: overrides.loanCore ?? requireAddress(process.env.LOAN_CORE_ADDRESS, 'LOAN_CORE_ADDRESS'),
    orderSettlement:
      overrides.orderSettlement ?? requireAddress(process.env.ORDER_SETTLEMENT_ADDRESS, 'ORDER_SETTLEMENT_ADDRESS'),
    liquidationAuction:
      overrides.liquidationAuction ??
      requireAddress(process.env.LIQUIDATION_AUCTION_ADDRESS, 'LIQUIDATION_AUCTION_ADDRESS'),
    positionNft: overrides.positionNft ?? requireAddress(process.env.POSITION_NFT_ADDRESS, 'POSITION_NFT_ADDRESS'),
    collateralEscrow:
      overrides.collateralEscrow ?? requireAddress(process.env.COLLATERAL_ESCROW_ADDRESS, 'COLLATERAL_ESCROW_ADDRESS'),
    assetRegistry:
      overrides.assetRegistry ?? requireAddress(process.env.ASSET_REGISTRY_ADDRESS, 'ASSET_REGISTRY_ADDRESS'),
    oracleRouter:
      overrides.oracleRouter ?? requireAddress(process.env.ORACLE_ROUTER_ADDRESS, 'ORACLE_ROUTER_ADDRESS'),
    feeCollector:
      overrides.feeCollector ?? requireAddress(process.env.FEE_COLLECTOR_ADDRESS, 'FEE_COLLECTOR_ADDRESS'),
    eligibilityGate:
      overrides.eligibilityGate ?? requireAddress(process.env.ELIGIBILITY_GATE_ADDRESS, 'ELIGIBILITY_GATE_ADDRESS'),
    usdc:
      overrides.usdc ??
      requireAddress(process.env.USDC_ADDRESS ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC_ADDRESS'),
  };
}
