import 'dotenv/config';
import { type Address, getAddress, isAddress } from 'viem';

export interface NotificationsConfig {
  port: number;
  host: string;
  rpcUrl: string;
  isFork: boolean;
  forkChainId: number;
  databaseUrl: string;
  indexerDatabaseUrl: string;
  riskApiUrl?: string;
  siweDomain: string;
  siweUri: string;
  siweNonceTtlSecs: number;
  sessionTtlSecs: number;
  encryptionKeyId: string;
  encryptionKeys: Record<string, string>;
  unsubscribeSecret: string;
  sessionSecret: string;
  piiHashSecret: string;
  publicBaseUrl: string;
  smtpApiUrl?: string;
  smtpApiKey?: string;
  emailFrom: string;
  telegramBotToken?: string;
  telegramApiBase: string;
  pollIntervalMs: number;
  outboundTimeoutMs: number;
  maxDeliveryAttempts: number;
  retryBaseMs: number;
  userRateLimitPerHour: number;
  corsOrigins: string[];
  rateLimitMax: number;
  rateLimitWindowMs: number;
  rateLimitMaxBuckets: number;
  trustProxyHops: number;
  maxBodyBytes: number;
  maxPageLimit: number;
  loanCore: Address;
  liquidationAuction: Address;
  assetRegistry: Address;
  oracleRouter: Address;
  positionNft: Address;
}

export type NotificationsConfigOverrides = Partial<NotificationsConfig>;

function requireAddress(value: string | undefined, name: string): Address {
  if (!value || !isAddress(value)) {
    throw new Error(`Invalid or missing contract address for ${name}`);
  }
  return getAddress(value);
}

function requireSecret(value: string | undefined, name: string, minLen = 16): string {
  const clean = value?.trim();
  if (!clean || clean.length < minLen) {
    throw new Error(`Missing or weak ${name} (must be provided via env, min length ${minLen})`);
  }
  return clean;
}

function validateHttpUrl(raw: string, name: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL for ${name}: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${name} must use http:// or https:// protocol (got ${u.protocol})`);
  }
  return u.toString().replace(/\/+$/, '');
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

function parseEncryptionKeys(
  rawRing: string | undefined,
  singleKey: string | undefined,
  activeKeyId: string
): Record<string, string> {
  const keys: Record<string, string> = {};
  if (rawRing && rawRing.trim().length > 0) {
    for (const part of rawRing.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) {
        throw new Error('ENCRYPTION_KEYS entries must follow "<keyId>:<64hex>" format');
      }
      keys[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  }
  if (singleKey && singleKey.trim().length > 0 && !keys[activeKeyId]) {
    keys[activeKeyId] = singleKey.trim();
  }
  if (Object.keys(keys).length === 0) {
    throw new Error('Missing ENCRYPTION_KEYS or ENCRYPTION_KEY env variable');
  }
  return keys;
}

export function loadNotificationsConfig(
  overrides: NotificationsConfigOverrides = {}
): NotificationsConfig {
  const port = overrides.port ?? parsePositiveInt(process.env.PORT, 3003, 'PORT');
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
  const indexerDatabaseUrl =
    overrides.indexerDatabaseUrl ??
    (process.env.INDEXER_DATABASE_URL?.trim() || (isFork ? 'memory://' : ''));

  if (!isFork) {
    if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
      throw new Error(
        'DATABASE_URL must be a postgres:// or postgresql:// connection string when FORK is not enabled.'
      );
    }
    if (!/^postgres(ql)?:\/\//i.test(indexerDatabaseUrl)) {
      throw new Error(
        'INDEXER_DATABASE_URL must be a SELECT-only postgres:// or postgresql:// connection string when FORK is not enabled.'
      );
    }
  }

  const riskApiRaw =
    overrides.riskApiUrl !== undefined ? overrides.riskApiUrl : process.env.RISK_API_URL?.trim();
  const riskApiUrl = riskApiRaw && riskApiRaw.length > 0 ? validateHttpUrl(riskApiRaw, 'RISK_API_URL') : undefined;

  const smtpApiRaw =
    overrides.smtpApiUrl !== undefined ? overrides.smtpApiUrl : process.env.SMTP_API_URL?.trim();
  const smtpApiUrl = smtpApiRaw && smtpApiRaw.length > 0 ? validateHttpUrl(smtpApiRaw, 'SMTP_API_URL') : undefined;

  const publicBaseRaw =
    overrides.publicBaseUrl ?? (process.env.PUBLIC_BASE_URL?.trim() || `http://${host}:${port}`);
  const publicBaseUrl = validateHttpUrl(publicBaseRaw, 'PUBLIC_BASE_URL');

  const telegramApiRaw =
    overrides.telegramApiBase ?? (process.env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org');
  const telegramApiBase = validateHttpUrl(telegramApiRaw, 'TELEGRAM_API_BASE');

  const siweDomain = overrides.siweDomain ?? (process.env.SIWE_DOMAIN?.trim() || 'app.nostok.xyz');
  const siweUri = overrides.siweUri ?? validateHttpUrl(process.env.SIWE_URI?.trim() || `https://${siweDomain}`, 'SIWE_URI');

  const encryptionKeyId =
    overrides.encryptionKeyId ?? (process.env.ENCRYPTION_KEY_ID?.trim() || 'k1');
  const encryptionKeys =
    overrides.encryptionKeys ??
    parseEncryptionKeys(process.env.ENCRYPTION_KEYS, process.env.ENCRYPTION_KEY, encryptionKeyId);

  return {
    port,
    host,
    rpcUrl,
    isFork,
    forkChainId,
    databaseUrl,
    indexerDatabaseUrl,
    riskApiUrl,
    siweDomain,
    siweUri,
    siweNonceTtlSecs:
      overrides.siweNonceTtlSecs ??
      parsePositiveInt(process.env.SIWE_NONCE_TTL_SECS, 600, 'SIWE_NONCE_TTL_SECS'),
    sessionTtlSecs:
      overrides.sessionTtlSecs ??
      parsePositiveInt(process.env.SESSION_TTL_SECS, 86_400, 'SESSION_TTL_SECS'),
    encryptionKeyId,
    encryptionKeys,
    unsubscribeSecret:
      overrides.unsubscribeSecret ?? requireSecret(process.env.UNSUBSCRIBE_SECRET, 'UNSUBSCRIBE_SECRET'),
    sessionSecret:
      overrides.sessionSecret ?? requireSecret(process.env.SESSION_SECRET, 'SESSION_SECRET'),
    piiHashSecret:
      overrides.piiHashSecret ?? requireSecret(process.env.PII_HASH_SECRET, 'PII_HASH_SECRET'),
    publicBaseUrl,
    smtpApiUrl,
    smtpApiKey: overrides.smtpApiKey ?? process.env.SMTP_API_KEY?.trim(),
    emailFrom: overrides.emailFrom ?? (process.env.EMAIL_FROM?.trim() || 'alerts@nostok.xyz'),
    telegramBotToken: overrides.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN?.trim(),
    telegramApiBase,
    pollIntervalMs:
      overrides.pollIntervalMs ?? parsePositiveInt(process.env.POLL_INTERVAL_MS, 10_000, 'POLL_INTERVAL_MS'),
    outboundTimeoutMs:
      overrides.outboundTimeoutMs ??
      parsePositiveInt(process.env.OUTBOUND_TIMEOUT_MS, 5_000, 'OUTBOUND_TIMEOUT_MS'),
    maxDeliveryAttempts:
      overrides.maxDeliveryAttempts ??
      parsePositiveInt(process.env.MAX_DELIVERY_ATTEMPTS, 3, 'MAX_DELIVERY_ATTEMPTS'),
    retryBaseMs:
      overrides.retryBaseMs ?? parsePositiveInt(process.env.RETRY_BASE_MS, 1_000, 'RETRY_BASE_MS'),
    userRateLimitPerHour:
      overrides.userRateLimitPerHour ??
      parsePositiveInt(process.env.USER_RATE_LIMIT_PER_HOUR, 30, 'USER_RATE_LIMIT_PER_HOUR'),
    corsOrigins: overrides.corsOrigins ?? parseCorsOrigins(process.env.CORS_ORIGINS),
    rateLimitMax:
      overrides.rateLimitMax ?? parsePositiveInt(process.env.RATE_LIMIT_MAX, 120, 'RATE_LIMIT_MAX'),
    rateLimitWindowMs:
      overrides.rateLimitWindowMs ??
      parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS'),
    rateLimitMaxBuckets:
      overrides.rateLimitMaxBuckets ??
      parsePositiveInt(process.env.RATE_LIMIT_MAX_BUCKETS, 10_000, 'RATE_LIMIT_MAX_BUCKETS'),
    trustProxyHops:
      overrides.trustProxyHops ?? parseNonNegativeInt(process.env.TRUST_PROXY, 0, 'TRUST_PROXY'),
    maxBodyBytes:
      overrides.maxBodyBytes ?? parsePositiveInt(process.env.MAX_BODY_BYTES, 65_536, 'MAX_BODY_BYTES'),
    maxPageLimit:
      overrides.maxPageLimit ?? parsePositiveInt(process.env.MAX_PAGE_LIMIT, 100, 'MAX_PAGE_LIMIT'),
    loanCore: overrides.loanCore ?? requireAddress(process.env.LOAN_CORE_ADDRESS, 'LOAN_CORE_ADDRESS'),
    liquidationAuction:
      overrides.liquidationAuction ??
      requireAddress(process.env.LIQUIDATION_AUCTION_ADDRESS, 'LIQUIDATION_AUCTION_ADDRESS'),
    assetRegistry:
      overrides.assetRegistry ?? requireAddress(process.env.ASSET_REGISTRY_ADDRESS, 'ASSET_REGISTRY_ADDRESS'),
    oracleRouter:
      overrides.oracleRouter ?? requireAddress(process.env.ORACLE_ROUTER_ADDRESS, 'ORACLE_ROUTER_ADDRESS'),
    positionNft:
      overrides.positionNft ?? requireAddress(process.env.POSITION_NFT_ADDRESS, 'POSITION_NFT_ADDRESS'),
  };
}
