import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { type Address, getAddress, isAddress } from 'viem';

export interface IndexerFileConfig {
  rpcUrl?: string;
  fork?: boolean;
  forkChainId?: number;
  databaseUrl?: string;
  startBlock?: number;
  confirmations?: number;
  pollIntervalMs?: number;
  blockBatchSize?: number;
  loanCore?: string;
  orderSettlement?: string;
  liquidationAuction?: string;
  positionNft?: string;
  collateralEscrow?: string;
  assetRegistry?: string;
  oracleRouter?: string;
  assets?: string[];
}

export interface IndexerConfig {
  rpcUrl: string;
  isFork: boolean;
  forkChainId: number;
  databaseUrl: string;
  startBlock: bigint;
  confirmations: number;
  pollIntervalMs: number;
  blockBatchSize: number;
  loanCore: Address;
  orderSettlement: Address;
  liquidationAuction: Address;
  positionNft: Address;
  collateralEscrow: Address;
  assetRegistry: Address;
  oracleRouter: Address;
  assets: Address[];
}

export type IndexerConfigOverrides = Partial<IndexerConfig>;

function requireAddress(value: string | undefined, name: string): Address {
  if (!value || !isAddress(value)) {
    throw new Error(`Invalid or missing contract address for ${name}`);
  }
  return getAddress(value);
}

function parseAssetList(envVal: string | undefined, fileAssets: string[] | undefined): Address[] {
  const rawList =
    envVal !== undefined && envVal.trim().length > 0
      ? envVal.split(',').map((s) => s.trim()).filter(Boolean)
      : fileAssets ?? [];

  const deduped = new Set<Address>();
  for (const entry of rawList) {
    if (!isAddress(entry)) {
      throw new Error(`Invalid asset address in asset list: ${entry}`);
    }
    deduped.add(getAddress(entry));
  }
  return Array.from(deduped);
}

function loadFileConfig(configPath?: string): IndexerFileConfig {
  if (!configPath) return {};
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found at CONFIG_PATH=${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as IndexerFileConfig;
}

export function loadConfig(overrides: IndexerConfigOverrides = {}): IndexerConfig {
  const fileConfig = loadFileConfig(process.env.CONFIG_PATH);

  const rpcUrl = overrides.rpcUrl ?? process.env.RPC_URL ?? fileConfig.rpcUrl ?? 'http://127.0.0.1:8545';

  let isFork = false;
  if (overrides.isFork !== undefined) {
    isFork = overrides.isFork;
  } else if (process.env.FORK !== undefined) {
    const val = process.env.FORK.trim().toLowerCase();
    isFork = val === 'true' || val === '1' || val === 'yes';
  } else if (fileConfig.fork !== undefined) {
    isFork = Boolean(fileConfig.fork);
  }

  const rawForkChainId = process.env.FORK_CHAIN_ID
    ? Number(process.env.FORK_CHAIN_ID)
    : fileConfig.forkChainId ?? 8453;
  const forkChainId = overrides.forkChainId ?? rawForkChainId;
  if (!Number.isInteger(forkChainId) || forkChainId <= 0) {
    throw new Error(`Invalid FORK_CHAIN_ID: ${forkChainId}`);
  }

  const databaseUrl =
    overrides.databaseUrl ??
    (process.env.DATABASE_URL?.trim() || fileConfig.databaseUrl || (isFork ? 'memory://' : ''));

  if (!isFork && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    throw new Error(
      'DATABASE_URL must be a postgres:// or postgresql:// connection string when FORK is not enabled (memory:// and PGlite are only allowed when FORK=true).'
    );
  }

  const rawStartBlock = process.env.START_BLOCK
    ? Number(process.env.START_BLOCK)
    : fileConfig.startBlock ?? 0;
  const startBlock = overrides.startBlock ?? BigInt(rawStartBlock);
  if (startBlock < 0n) {
    throw new Error(`Invalid START_BLOCK: ${startBlock}`);
  }

  const rawConfirmations = process.env.CONFIRMATIONS
    ? Number(process.env.CONFIRMATIONS)
    : fileConfig.confirmations ?? 12;
  const confirmations = overrides.confirmations ?? rawConfirmations;
  if (!Number.isInteger(confirmations) || confirmations < 0) {
    throw new Error(`Invalid CONFIRMATIONS: ${confirmations}`);
  }

  const rawPoll = process.env.POLL_INTERVAL_MS
    ? Number(process.env.POLL_INTERVAL_MS)
    : fileConfig.pollIntervalMs ?? 4_000;
  const pollIntervalMs = overrides.pollIntervalMs ?? rawPoll;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(`Invalid POLL_INTERVAL_MS: ${pollIntervalMs}`);
  }

  const rawBatch = process.env.BLOCK_BATCH_SIZE
    ? Number(process.env.BLOCK_BATCH_SIZE)
    : fileConfig.blockBatchSize ?? 200;
  const blockBatchSize = overrides.blockBatchSize ?? rawBatch;
  if (!Number.isInteger(blockBatchSize) || blockBatchSize <= 0) {
    throw new Error(`Invalid BLOCK_BATCH_SIZE: ${blockBatchSize}`);
  }

  const loanCore = overrides.loanCore ?? requireAddress(
    process.env.LOAN_CORE_ADDRESS ?? fileConfig.loanCore,
    'LOAN_CORE_ADDRESS'
  );
  const orderSettlement = overrides.orderSettlement ?? requireAddress(
    process.env.ORDER_SETTLEMENT_ADDRESS ?? fileConfig.orderSettlement,
    'ORDER_SETTLEMENT_ADDRESS'
  );
  const liquidationAuction = overrides.liquidationAuction ?? requireAddress(
    process.env.LIQUIDATION_AUCTION_ADDRESS ?? fileConfig.liquidationAuction,
    'LIQUIDATION_AUCTION_ADDRESS'
  );
  const positionNft = overrides.positionNft ?? requireAddress(
    process.env.POSITION_NFT_ADDRESS ?? fileConfig.positionNft,
    'POSITION_NFT_ADDRESS'
  );
  const collateralEscrow = overrides.collateralEscrow ?? requireAddress(
    process.env.COLLATERAL_ESCROW_ADDRESS ?? fileConfig.collateralEscrow,
    'COLLATERAL_ESCROW_ADDRESS'
  );
  const assetRegistry = overrides.assetRegistry ?? requireAddress(
    process.env.ASSET_REGISTRY_ADDRESS ?? fileConfig.assetRegistry,
    'ASSET_REGISTRY_ADDRESS'
  );
  const oracleRouter = overrides.oracleRouter ?? requireAddress(
    process.env.ORACLE_ROUTER_ADDRESS ?? fileConfig.oracleRouter,
    'ORACLE_ROUTER_ADDRESS'
  );

  const assets = overrides.assets ?? parseAssetList(process.env.ASSET_LIST, fileConfig.assets);

  return {
    rpcUrl,
    isFork,
    forkChainId,
    databaseUrl,
    startBlock,
    confirmations,
    pollIntervalMs,
    blockBatchSize,
    loanCore,
    orderSettlement,
    liquidationAuction,
    positionNft,
    collateralEscrow,
    assetRegistry,
    oracleRouter,
    assets,
  };
}
