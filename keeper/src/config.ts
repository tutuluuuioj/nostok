import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { type Address, type Hex, getAddress, isAddress, parseEther } from 'viem';

export interface KeeperFileConfig {
  rpcUrl?: string;
  oracleRouter?: string;
  assetRegistry?: string;
  loanCore?: string;
  liquidationAuction?: string;
  assets?: string[];
  pollIntervalMs?: number;
  dryRun?: boolean;
  minKeeperEth?: string;
  telegramWebhookUrl?: string;
  telegramChatId?: string;
}

export interface KeeperConfig {
  rpcUrl: string;
  keeperPrivateKey: Hex;
  oracleRouter: Address;
  assetRegistry: Address;
  loanCore: Address;
  liquidationAuction: Address;
  assets: Address[];
  pollIntervalMs: number;
  dryRun: boolean;
  minKeeperEthWei: bigint;
  telegramWebhookUrl?: string;
  telegramChatId?: string;
}

export type KeeperConfigOverrides = Partial<KeeperConfig>;

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

function loadFileConfig(configPath?: string): KeeperFileConfig {
  if (!configPath) return {};
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found at CONFIG_PATH=${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if ('keeperPrivateKey' in parsed || 'KEEPER_PRIVATE_KEY' in parsed) {
    throw new Error('Security violation: keeperPrivateKey must not be stored in JSON config file; use KEEPER_PRIVATE_KEY env var');
  }
  return parsed as KeeperFileConfig;
}

function parseKeeperPrivateKeyFromEnv(): Hex {
  const raw = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error('Missing KEEPER_PRIVATE_KEY environment variable');
  }
  const normalized = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('Invalid KEEPER_PRIVATE_KEY format (expected 32-byte hex string)');
  }
  return normalized as Hex;
}

export function loadConfig(overrides: KeeperConfigOverrides = {}): KeeperConfig {
  const fileConfig = loadFileConfig(process.env.CONFIG_PATH);

  const keeperPrivateKey = overrides.keeperPrivateKey ?? parseKeeperPrivateKeyFromEnv();
  const rpcUrl = overrides.rpcUrl ?? process.env.RPC_URL ?? fileConfig.rpcUrl ?? 'http://127.0.0.1:8545';

  const oracleRouter = overrides.oracleRouter ?? requireAddress(
    process.env.ORACLE_ROUTER_ADDRESS ?? fileConfig.oracleRouter,
    'ORACLE_ROUTER_ADDRESS'
  );
  const assetRegistry = overrides.assetRegistry ?? requireAddress(
    process.env.ASSET_REGISTRY_ADDRESS ?? fileConfig.assetRegistry,
    'ASSET_REGISTRY_ADDRESS'
  );
  const loanCore = overrides.loanCore ?? requireAddress(
    process.env.LOAN_CORE_ADDRESS ?? fileConfig.loanCore,
    'LOAN_CORE_ADDRESS'
  );
  const liquidationAuction = overrides.liquidationAuction ?? requireAddress(
    process.env.LIQUIDATION_AUCTION_ADDRESS ?? fileConfig.liquidationAuction,
    'LIQUIDATION_AUCTION_ADDRESS'
  );

  const assets = overrides.assets ?? parseAssetList(process.env.ASSET_LIST, fileConfig.assets);

  const rawPoll = process.env.POLL_INTERVAL_MS
    ? Number(process.env.POLL_INTERVAL_MS)
    : fileConfig.pollIntervalMs ?? 15_000;
  const pollIntervalMs = overrides.pollIntervalMs ?? rawPoll;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(`Invalid POLL_INTERVAL_MS: ${pollIntervalMs}`);
  }

  let dryRun = true;
  if (overrides.dryRun !== undefined) {
    dryRun = overrides.dryRun;
  } else if (process.env.DRY_RUN !== undefined) {
    const val = process.env.DRY_RUN.trim().toLowerCase();
    dryRun = !(val === 'false' || val === '0' || val === 'no');
  } else if (fileConfig.dryRun !== undefined) {
    dryRun = Boolean(fileConfig.dryRun);
  }

  const minKeeperEthWei =
    overrides.minKeeperEthWei ??
    parseEther(process.env.MIN_KEEPER_ETH ?? fileConfig.minKeeperEth ?? '0.01');

  const telegramWebhookUrl =
    overrides.telegramWebhookUrl ??
    (process.env.TELEGRAM_WEBHOOK_URL?.trim() || fileConfig.telegramWebhookUrl);

  const telegramChatId =
    overrides.telegramChatId ??
    (process.env.TELEGRAM_CHAT_ID?.trim() || fileConfig.telegramChatId);

  return {
    rpcUrl,
    keeperPrivateKey,
    oracleRouter,
    assetRegistry,
    loanCore,
    liquidationAuction,
    assets,
    pollIntervalMs,
    dryRun,
    minKeeperEthWei,
    telegramWebhookUrl,
    telegramChatId,
  };
}
