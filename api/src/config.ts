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
  geoCountryHeader: string;
  geoRequireHeader: boolean;
  geoDisabled: boolean;
  trustedProxyCidrs: string[];
  restrictedCountries: string[];
  sanctionedAddresses: Address[];
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

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const val = raw.trim().toLowerCase();
  return val === 'true' || val === '1' || val === 'yes';
}

function parseCountryCodes(raw: string | undefined, fallback: readonly string[]): string[] {
  if (!raw || raw.trim() === '') return [...fallback];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const code = part.trim().toUpperCase();
    if (!code) continue;
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new Error(`Invalid ISO-3166 alpha-2 country code in GEO_RESTRICTED_COUNTRIES: "${part}"`);
    }
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

function parseAddressList(raw: string | undefined, name: string): Address[] {
  if (!raw || raw.trim() === '') return [];
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const clean = part.trim();
    if (!clean) continue;
    if (!isAddress(clean)) {
      throw new Error(`Invalid EVM address in ${name}: "${clean}"`);
    }
    const checksummed = getAddress(clean);
    const key = checksummed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(checksummed);
    }
  }
  return out;
}

function parseIpv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let val = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const oct = Number(part);
    if (!Number.isInteger(oct) || oct < 0 || oct > 255) return null;
    val = (val << 8n) | BigInt(oct);
  }
  return val;
}

export function parseIpAddress(rawIp: string): { family: 4 | 6; value: bigint } | null {
  let clean = rawIp.trim();
  if (!clean) return null;
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1);
  }
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx !== -1) clean = clean.slice(0, zoneIdx);

  const v4Direct = parseIpv4ToBigInt(clean);
  if (v4Direct !== null) {
    return { family: 4, value: v4Direct };
  }

  // Handle IPv4-mapped / IPv6 addresses cleanly (e.g. ::ffff:173.245.48.1 -> v4)
  const doubleColonParts = clean.split('::');
  if (doubleColonParts.length > 2) return null;

  let groups: number[] = [];
  const parseHalf = (side: string, target: number[]): boolean => {
    if (!side) return true;
    const segs = side.split(':');
    for (let i = 0; i < segs.length; i += 1) {
      const seg = segs[i];
      if (seg.includes('.')) {
        if (i !== segs.length - 1) return false;
        const v4 = parseIpv4ToBigInt(seg);
        if (v4 === null) return false;
        target.push(Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return false;
        target.push(Number.parseInt(seg, 16));
      }
    }
    return true;
  };

  if (doubleColonParts.length === 1) {
    if (!parseHalf(clean, groups) || groups.length !== 8) return null;
  } else {
    const left: number[] = [];
    const right: number[] = [];
    if (!parseHalf(doubleColonParts[0], left) || !parseHalf(doubleColonParts[1], right)) {
      return null;
    }
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill(0), ...right];
  }

  let v6Val = 0n;
  for (const g of groups) {
    v6Val = (v6Val << 16n) | BigInt(g);
  }

  // Normalize ::ffff:0:0/96 IPv4-mapped IPv6 addresses to IPv4 so IPv4 CIDRs match dual-stack peers
  if ((v6Val >> 32n) === 0xffffn) {
    return { family: 4, value: v6Val & 0xffff_ffffn };
  }
  return { family: 6, value: v6Val };
}

export function parseCidrBlock(rawCidr: string): { family: 4 | 6; network: bigint; prefix: number } | null {
  const clean = rawCidr.trim();
  if (!clean) return null;
  const slashIdx = clean.indexOf('/');
  const ipStr = slashIdx === -1 ? clean : clean.slice(0, slashIdx);
  const parsed = parseIpAddress(ipStr);
  if (!parsed) return null;
  const maxBits = parsed.family === 4 ? 32 : 128;
  let prefix = maxBits;
  if (slashIdx !== -1) {
    const prefixStr = clean.slice(slashIdx + 1);
    if (!/^(?:0|[1-9]\d{0,2})$/.test(prefixStr)) return null;
    prefix = Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) return null;
  }
  const hostBits = BigInt(maxBits - prefix);
  const network = hostBits === BigInt(maxBits) ? 0n : (parsed.value >> hostBits) << hostBits;
  return { family: parsed.family, network, prefix };
}

export function isIpInCidrList(remoteIp: string | undefined, cidrs: readonly string[]): boolean {
  if (!remoteIp || cidrs.length === 0) return false;
  const parsedIp = parseIpAddress(remoteIp);
  if (!parsedIp) return false;
  for (const rawCidr of cidrs) {
    const cidr = parseCidrBlock(rawCidr);
    if (!cidr || cidr.family !== parsedIp.family) continue;
    if (cidr.prefix === 0) return true;
    const totalBits = cidr.family === 4 ? 32 : 128;
    const shift = BigInt(totalBits - cidr.prefix);
    if ((parsedIp.value >> shift) === (cidr.network >> shift)) {
      return true;
    }
  }
  return false;
}

function parseCidrList(raw: string | undefined, name: string): string[] {
  if (!raw || raw.trim() === '') return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const clean = part.trim();
    if (!clean) continue;
    if (!parseCidrBlock(clean)) {
      throw new Error(`Invalid IP or CIDR entry in ${name}: "${clean}"`);
    }
    out.push(clean);
  }
  return out;
}

const DEFAULT_GEO_RESTRICTED_COUNTRIES = ['US', 'CU', 'IR', 'KP', 'SY', 'RU', 'BY', 'MM'] as const;

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

  const rawGeoHeader = (overrides.geoCountryHeader ?? process.env.GEO_COUNTRY_HEADER ?? 'cf-ipcountry')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9-]+$/.test(rawGeoHeader)) {
    throw new Error(`Invalid GEO_COUNTRY_HEADER name: "${rawGeoHeader}"`);
  }
  const geoDisabled = overrides.geoDisabled ?? parseBoolEnv(process.env.GEO_DISABLED, false);
  const geoRequireHeader =
    overrides.geoRequireHeader ?? parseBoolEnv(process.env.GEO_REQUIRE_HEADER, false);
  const trustedProxyCidrs =
    overrides.trustedProxyCidrs !== undefined
      ? overrides.trustedProxyCidrs.map((c) => {
          const clean = c.trim();
          if (!parseCidrBlock(clean)) {
            throw new Error(`Invalid IP or CIDR entry in trustedProxyCidrs: "${c}"`);
          }
          return clean;
        })
      : parseCidrList(process.env.TRUSTED_PROXY_CIDRS, 'TRUSTED_PROXY_CIDRS');

  if (!isFork && !geoDisabled && (trustProxyHops < 1 || !geoRequireHeader)) {
    throw new Error(
      'Production API (FORK=false) refuses to start without verified edge geoblock: set TRUST_PROXY>=1 and GEO_REQUIRE_HEADER=true (behind a trusted proxy/Cloudflare), or set GEO_DISABLED=true to explicitly override.'
    );
  }

  const restrictedCountries =
    overrides.restrictedCountries !== undefined
      ? overrides.restrictedCountries.map((c) => {
          const code = c.trim().toUpperCase();
          if (!/^[A-Z]{2}$/.test(code)) {
            throw new Error(`Invalid ISO-3166 alpha-2 country code in restrictedCountries: "${c}"`);
          }
          return code;
        })
      : parseCountryCodes(process.env.GEO_RESTRICTED_COUNTRIES, DEFAULT_GEO_RESTRICTED_COUNTRIES);
  const sanctionedAddresses =
    overrides.sanctionedAddresses !== undefined
      ? overrides.sanctionedAddresses.map((a) => requireAddress(a, 'sanctionedAddresses'))
      : parseAddressList(process.env.SANCTIONED_ADDRESSES, 'SANCTIONED_ADDRESSES');

  if (sanctionedAddresses.length === 0) {
    console.warn(
      '[API_SECURITY_WARNING] SANCTIONED_ADDRESSES is empty; wallet sanctions screening has no blocked addresses configured.'
    );
  }
  if (geoDisabled) {
    console.warn(
      '[API_SECURITY_WARNING] GEO_DISABLED=true; IP geoblock enforcement is explicitly disabled.'
    );
  } else if (!isFork && trustProxyHops >= 1 && trustedProxyCidrs.length === 0) {
    console.warn(
      '[API_SECURITY_WARNING] TRUST_PROXY>=1 without TRUSTED_PROXY_CIDRS: ensure inbound API traffic is restricted strictly to Cloudflare / your trusted proxy IPs at the firewall.'
    );
  }

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
    geoCountryHeader: rawGeoHeader,
    geoRequireHeader,
    geoDisabled,
    trustedProxyCidrs,
    restrictedCountries,
    sanctionedAddresses,
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
