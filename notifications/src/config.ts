import 'dotenv/config';
import { type Address, getAddress, isAddress } from 'viem';
import { assertDistinctSecrets, assertSecretEntropy } from './crypto.js';

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
  confirmSecret: string;
  sessionSecret: string;
  piiHashSecret: string;
  webhookSigningSecret: string;
  adminSecret?: string;
  publicBaseUrl: string;
  smtpApiUrl?: string;
  smtpApiKey?: string;
  emailFrom: string;
  telegramBotToken?: string;
  telegramApiBase: string;
  pollIntervalMs: number;
  outboundTimeoutMs: number;
  maxDeliveryAttempts: number;
  maxCriticalDeliveryAttempts: number;
  retryBaseMs: number;
  sendingLeaseMs: number;
  episodeClearDampingMs: number;
  allowedWebhookPorts: number[];
  userRateLimitPerHour: number;
  maxSubscriptionsPerWallet: number;
  maxVerifyAttempts: number;
  confirmRateLimitMax: number;
  confirmTargetPerHourMax: number;
  authNonceRateLimitMax: number;
  authVerifyRateLimitMax: number;
  subscriptionsRateLimitMax: number;
  deliveryConcurrency: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
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

function requireSecret(value: string | undefined, name: string, minLen = 24): string {
  const clean = value?.trim();
  if (!clean) {
    throw new Error(`Missing ${name} (must be provided via env, min length ${minLen})`);
  }
  return assertSecretEntropy(clean, name, { minLen, minUnique: 8, minEntropyBits: 2.8 });
}

function validateHttpUrl(raw: string, name: string, requireHttps = false): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL for ${name}: ${raw}`);
  }
  if (requireHttps) {
    if (u.protocol !== 'https:') {
      throw new Error(`${name} must use https:// when FORK is not enabled (got ${u.protocol})`);
    }
  } else if (u.protocol !== 'http:' && u.protocol !== 'https:') {
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

function parsePortList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw || raw.trim() === '') return fallback;
  const ports = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => Number(p));
  if (ports.length === 0 || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65_535)) {
    throw new Error(`Invalid ALLOWED_WEBHOOK_PORTS: ${raw}`);
  }
  return Array.from(new Set(ports));
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`Invalid non-negative integer for ${name}: ${raw}`);
  }
  return num;
}

function parseCorsOrigins(raw: string | undefined, isFork: boolean): string[] {
  if (!raw || raw.trim() === '') {
    if (!isFork) {
      throw new Error('CORS_ORIGINS is required when FORK is not enabled (wildcard "*" is disallowed).');
    }
    return ['https://app.nostok.xyz'];
  }
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS cannot be empty.');
  }
  const normalized: string[] = [];
  for (const origin of origins) {
    if (origin === '*') {
      throw new Error('CORS_ORIGINS cannot contain wildcard "*". Specify explicit origin(s).');
    }
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin URL: ${origin}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Invalid CORS origin protocol: ${origin}`);
    }
    normalized.push(u.origin);
  }
  return normalized;
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
    overrides.publicBaseUrl ??
    (process.env.PUBLIC_BASE_URL?.trim() || (isFork ? `http://${host}:${port}` : ''));
  if (!publicBaseRaw) {
    throw new Error('PUBLIC_BASE_URL is required and must use https:// when FORK is not enabled.');
  }
  const publicBaseUrl = validateHttpUrl(publicBaseRaw, 'PUBLIC_BASE_URL', !isFork);

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
  for (const [kId, kVal] of Object.entries(encryptionKeys)) {
    assertSecretEntropy(kVal, `ENCRYPTION_KEYS[${kId}]`, {
      minLen: 64,
      minUnique: 8,
      minEntropyBits: 2.8,
    });
  }

  const unsubscribeSecret = requireSecret(
    overrides.unsubscribeSecret ?? process.env.UNSUBSCRIBE_SECRET,
    'UNSUBSCRIBE_SECRET'
  );
  const confirmSecret = requireSecret(
    overrides.confirmSecret ?? process.env.CONFIRM_SECRET,
    'CONFIRM_SECRET'
  );
  const sessionSecret = requireSecret(
    overrides.sessionSecret ?? process.env.SESSION_SECRET,
    'SESSION_SECRET'
  );
  const piiHashSecret = requireSecret(
    overrides.piiHashSecret ?? process.env.PII_HASH_SECRET,
    'PII_HASH_SECRET'
  );
  const webhookSigningSecret = requireSecret(
    overrides.webhookSigningSecret ?? process.env.WEBHOOK_SIGNING_SECRET,
    'WEBHOOK_SIGNING_SECRET'
  );
  const rawAdminSecret =
    overrides.adminSecret !== undefined ? overrides.adminSecret : process.env.ADMIN_SECRET?.trim();
  const adminSecret =
    rawAdminSecret && rawAdminSecret.length > 0
      ? assertSecretEntropy(rawAdminSecret, 'ADMIN_SECRET', { minLen: 24, minUnique: 8, minEntropyBits: 2.8 })
      : undefined;

  const secretCheckMap: Record<string, string> = {
    UNSUBSCRIBE_SECRET: unsubscribeSecret,
    CONFIRM_SECRET: confirmSecret,
    SESSION_SECRET: sessionSecret,
    PII_HASH_SECRET: piiHashSecret,
    WEBHOOK_SIGNING_SECRET: webhookSigningSecret,
  };
  if (adminSecret) {
    secretCheckMap.ADMIN_SECRET = adminSecret;
  }
  for (const [kId, kVal] of Object.entries(encryptionKeys)) {
    secretCheckMap[`ENCRYPTION_KEYS[${kId}]`] = kVal;
  }
  assertDistinctSecrets(secretCheckMap);

  const corsOrigins =
    overrides.corsOrigins !== undefined
      ? parseCorsOrigins(overrides.corsOrigins.join(','), isFork)
      : parseCorsOrigins(process.env.CORS_ORIGINS, isFork);

  const allowedWebhookPortsRaw = overrides.allowedWebhookPorts ?? parsePortList(process.env.ALLOWED_WEBHOOK_PORTS, [443]);
  const maxDeliveryAttempts =
    overrides.maxDeliveryAttempts ??
    parsePositiveInt(process.env.MAX_DELIVERY_ATTEMPTS, 3, 'MAX_DELIVERY_ATTEMPTS');
  const maxCriticalDeliveryAttempts =
    overrides.maxCriticalDeliveryAttempts ??
    parsePositiveInt(process.env.MAX_CRITICAL_DELIVERY_ATTEMPTS, 6, 'MAX_CRITICAL_DELIVERY_ATTEMPTS');
  if (maxCriticalDeliveryAttempts < 6) {
    throw new Error('MAX_CRITICAL_DELIVERY_ATTEMPTS must be at least 6');
  }

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
    unsubscribeSecret,
    confirmSecret,
    sessionSecret,
    piiHashSecret,
    webhookSigningSecret,
    adminSecret,
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
    maxDeliveryAttempts,
    maxCriticalDeliveryAttempts,
    retryBaseMs:
      overrides.retryBaseMs ?? parsePositiveInt(process.env.RETRY_BASE_MS, 60_000, 'RETRY_BASE_MS'),
    sendingLeaseMs:
      overrides.sendingLeaseMs ?? parsePositiveInt(process.env.SENDING_LEASE_MS, 120_000, 'SENDING_LEASE_MS'),
    episodeClearDampingMs:
      overrides.episodeClearDampingMs ??
      parseNonNegativeInt(process.env.EPISODE_CLEAR_DAMPING_MS, 120_000, 'EPISODE_CLEAR_DAMPING_MS'),
    allowedWebhookPorts: allowedWebhookPortsRaw,
    userRateLimitPerHour:
      overrides.userRateLimitPerHour ??
      parsePositiveInt(process.env.USER_RATE_LIMIT_PER_HOUR, 30, 'USER_RATE_LIMIT_PER_HOUR'),
    maxSubscriptionsPerWallet:
      overrides.maxSubscriptionsPerWallet ??
      parsePositiveInt(process.env.MAX_SUBSCRIPTIONS_PER_WALLET, 5, 'MAX_SUBSCRIPTIONS_PER_WALLET'),
    maxVerifyAttempts:
      overrides.maxVerifyAttempts ?? parsePositiveInt(process.env.MAX_VERIFY_ATTEMPTS, 5, 'MAX_VERIFY_ATTEMPTS'),
    confirmRateLimitMax:
      overrides.confirmRateLimitMax ?? parsePositiveInt(process.env.CONFIRM_RATE_LIMIT_MAX, 10, 'CONFIRM_RATE_LIMIT_MAX'),
    confirmTargetPerHourMax:
      overrides.confirmTargetPerHourMax ??
      parsePositiveInt(process.env.CONFIRM_TARGET_PER_HOUR_MAX, 3, 'CONFIRM_TARGET_PER_HOUR_MAX'),
    authNonceRateLimitMax:
      overrides.authNonceRateLimitMax ??
      parsePositiveInt(process.env.AUTH_NONCE_RATE_LIMIT_MAX, 20, 'AUTH_NONCE_RATE_LIMIT_MAX'),
    authVerifyRateLimitMax:
      overrides.authVerifyRateLimitMax ??
      parsePositiveInt(process.env.AUTH_VERIFY_RATE_LIMIT_MAX, 20, 'AUTH_VERIFY_RATE_LIMIT_MAX'),
    subscriptionsRateLimitMax:
      overrides.subscriptionsRateLimitMax ??
      parsePositiveInt(process.env.SUBSCRIPTIONS_RATE_LIMIT_MAX, 15, 'SUBSCRIPTIONS_RATE_LIMIT_MAX'),
    deliveryConcurrency:
      overrides.deliveryConcurrency ??
      parsePositiveInt(process.env.DELIVERY_CONCURRENCY, 5, 'DELIVERY_CONCURRENCY'),
    circuitBreakerThreshold:
      overrides.circuitBreakerThreshold ??
      parsePositiveInt(process.env.CIRCUIT_BREAKER_THRESHOLD, 3, 'CIRCUIT_BREAKER_THRESHOLD'),
    circuitBreakerCooldownMs:
      overrides.circuitBreakerCooldownMs ??
      parsePositiveInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS, 30_000, 'CIRCUIT_BREAKER_COOLDOWN_MS'),
    corsOrigins,
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
