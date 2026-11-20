import { pathToFileURL } from 'node:url';
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToBytes,
  zeroAddress,
} from 'viem';
import { base } from 'viem/chains';
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  aggregatorV3Abi,
  assetRegistryAbi,
  collateralEscrowAbi,
  eligibilityGateAbi,
  erc20Abi,
  feeCollectorAbi,
  liquidationAuctionAbi,
  loanCoreAbi,
  oracleRouterAbi,
  orderSettlementAbi,
  positionNftAbi,
} from '../src/lib/contracts.js';

export const BASE_SEQUENCER_FEED_ADDRESS = '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433';
export const BASE_MAINNET_SMOKE_ASSETS = Object.freeze({
  NVDAc: Object.freeze({
    symbol: 'NVDAc',
    token: '0xb20000000000000000000078ee7ce2fE4908108C',
    feed: '0x04689a41629776563E6822F76f2e57D148d28513',
    decimals: 8,
  }),
  METAc: Object.freeze({
    symbol: 'METAc',
    token: '0xb2000000000000000000008bC8786B856E61707C',
    feed: '0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D',
    decimals: 8,
  }),
});
export const DEFAULT_INITIALIZER_GLOBAL_CAP_RAW = 250_000_000_000n; // LoanCore.initialize default 250,000 USDC
export const MIN_LOAN_PRINCIPAL_RAW = 500_000_000n; // LoanCore.openLoan min 500 USDC
export const RECOMMENDED_SMOKE_PER_LOAN_CAP_RAW = 1_000_000_000n; // $1,000 USDC max per smoke loan
export const MAX_INITIAL_GLOBAL_CAP_RAW = 25_000_000_000n; // $25,000 USDC max guarded aggregate launch cap
export const TIMELOCK_MIN_DELAY_SECS = 172_800n; // 48 hours
export const MIN_STALE_OPEN_SECS = 1800;
export const MAX_STALE_OPEN_SECS = 86_400;
export const RECOMMENDED_MAX_STALE_OPEN_SECS = 21_600;
export const EIP7702_DELEGATION_PREFIX = '0xef0100';

export const TIER_A_CEILINGS = {
  maxInitLtvBps: 6000,
  marginCallLtvBps: 7000,
  liqLtvBps: 7800,
  badDebtLtvBps: 9000,
};

const ORACLE_STATE_NAMES = {
  0: 'VALID_OPEN',
  1: 'VALID_CLOSED',
  2: 'FROZEN_CORPORATE_ACTION',
  3: 'STALE_FEED',
  4: 'INVALID_SEQUENCER',
  5: 'DISPUTED',
};

const ASSET_STATUS_NAMES = {
  0: 'Active',
  1: 'ReduceOnly',
  2: 'WindDown',
  3: 'Frozen',
};

const ownableAbi = parseAbi(['function owner() view returns (address)']);
const loanCoreWiringAbi = parseAbi([
  'function guardian() view returns (address)',
  'function usdc() view returns (address)',
  'function orderSettlement() view returns (address)',
  'function liquidationAuction() view returns (address)',
  'function positionNft() view returns (address)',
]);
const assetRegistryExtraAbi = parseAbi(['function guardian() view returns (address)']);
const authorizedCoreViewAbi = parseAbi([
  'function isAuthorizedCore(address account) view returns (bool)',
]);
const timelockViewAbi = parseAbi([
  'function getMinDelay() view returns (uint256)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
]);
const safeMultisigAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
]);
const erc20NameAbi = parseAbi(['function name() view returns (string)']);
const eligibilityAllowlistViewAbi = parseAbi([
  'function allowlist(address account) view returns (bool)',
]);

const DEFAULT_ADMIN_ROLE =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const PROPOSER_ROLE = keccak256(stringToBytes('PROPOSER_ROLE'));
const EXECUTOR_ROLE = keccak256(stringToBytes('EXECUTOR_ROLE'));

function normalizeOptAddress(value) {
  if (!value || !isAddress(String(value))) return null;
  const addr = getAddress(String(value));
  return addr === zeroAddress ? null : addr;
}

function sameAddr(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/**
 * Redacts HTTP(S)/WS(S) credentials, paths (including RPC API keys), and query strings from
 * error strings before printing to terminal or CI logs.
 */
export function sanitizeRpcErrorMessage(err) {
  const raw =
    err && typeof err === 'object'
      ? String(err.shortMessage || err.message || err)
      : String(err ?? 'Unknown error');
  return raw.replace(
    /((?:https?|wss?):\/\/)(?:[^@\s/]+@)?([^/\s:?#]+(?::\d+)?)(?:[^\s"')\]`]*)?/gi,
    '$1$2/[redacted]'
  );
}

/**
 * Pure validator for an out-of-band Safe multisig snapshot (`WS4.6`), verifying non-zero
 * contract bytecode (rejecting EIP-7702 delegated EOAs starting with `0xef0100`), canonical
 * Safe `getOwners`/`getThreshold` state, and role separation from deployer / attestation signer.
 */
export function evaluateSafeSnapshot(
  roleName,
  address,
  { code, owners = [], threshold = 0n, version = null, minOwners = 1, minThreshold = 1, deployer = null, attestationSigner = null } = {}
) {
  const normalized = normalizeOptAddress(address);
  if (!normalized) {
    return { ok: false, detail: `${roleName} address missing or zero.` };
  }
  const normalizedDeployer = normalizeOptAddress(deployer);
  if (normalizedDeployer && sameAddr(normalized, normalizedDeployer)) {
    return { ok: false, detail: `${roleName} (${normalized}) matches DEPLOYER address.` };
  }
  const normalizedAttSigner = normalizeOptAddress(attestationSigner);
  if (normalizedAttSigner && sameAddr(normalized, normalizedAttSigner)) {
    return { ok: false, detail: `${roleName} (${normalized}) matches ATTESTATION_SIGNER.` };
  }
  const codeHex = typeof code === 'string' ? code.toLowerCase() : '';
  if (!codeHex || codeHex === '0x') {
    return { ok: false, detail: `${roleName} (${normalized}) is an EOA (no contract bytecode).` };
  }
  if (codeHex.startsWith(EIP7702_DELEGATION_PREFIX)) {
    return {
      ok: false,
      detail: `${roleName} (${normalized}) uses EIP-7702 delegation (${EIP7702_DELEGATION_PREFIX}), not a canonical Safe multisig.`,
    };
  }
  if (!Array.isArray(owners) || owners.length === 0) {
    return { ok: false, detail: `${roleName} (${normalized}) failed Safe.getOwners().` };
  }
  const thresholdBig = BigInt(threshold ?? 0n);
  if (thresholdBig < BigInt(minThreshold) || thresholdBig > BigInt(owners.length)) {
    return {
      ok: false,
      detail: `${roleName} (${normalized}) threshold=${thresholdBig} out of bounds for ${owners.length} owners (minThreshold=${minThreshold}).`,
    };
  }
  if (owners.length < minOwners) {
    return {
      ok: false,
      detail: `${roleName} (${normalized}) has ${owners.length} owners (< minOwners=${minOwners}).`,
    };
  }
  const uniqueOwners = new Set(
    owners.map((o) => normalizeOptAddress(o)).filter(Boolean).map((o) => o.toLowerCase())
  );
  if (uniqueOwners.size !== owners.length) {
    return { ok: false, detail: `${roleName} (${normalized}) has zero or duplicate Safe owners.` };
  }
  return {
    ok: true,
    detail: `${roleName}=${normalized} Safe v${version ?? 'unknown'} (${thresholdBig}/${owners.length} multisig, ${Math.floor((codeHex.length - 2) / 2)}B runtime)`,
  };
}

/**
 * Verifies an Owner or Guardian Safe multisig on-chain via bytecode + Safe ABI reads.
 */
export async function validateSafeMultisigContract(
  publicClient,
  roleName,
  address,
  { minOwners = 1, minThreshold = 1, deployer = null, attestationSigner = null } = {}
) {
  const normalized = normalizeOptAddress(address);
  if (!normalized) {
    return { ok: false, detail: `${roleName} address missing or zero.` };
  }
  const code = await publicClient.getCode({ address: normalized });
  let owners = [];
  let threshold = 0n;
  let version = null;
  if (code && code !== '0x' && !code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX)) {
    try {
      const [ownersRes, thresholdRes, versionRes] = await Promise.all([
        publicClient.readContract({
          address: normalized,
          abi: safeMultisigAbi,
          functionName: 'getOwners',
        }),
        publicClient.readContract({
          address: normalized,
          abi: safeMultisigAbi,
          functionName: 'getThreshold',
        }),
        publicClient
          .readContract({
            address: normalized,
            abi: safeMultisigAbi,
            functionName: 'VERSION',
          })
          .catch(() => null),
      ]);
      owners = ownersRes ?? [];
      threshold = BigInt(thresholdRes ?? 0n);
      version = versionRes;
    } catch (err) {
      return {
        ok: false,
        detail: `${roleName} (${normalized}) failed Safe.getOwners/getThreshold call: ${sanitizeRpcErrorMessage(err)}`,
      };
    }
  }
  return evaluateSafeSnapshot(roleName, normalized, {
    code,
    owners,
    threshold,
    version,
    minOwners,
    minThreshold,
    deployer,
    attestationSigner,
  });
}

/**
 * Validates AssetRegistry + OracleRouter + metadata settings for a WS4.7 smoke test asset.
 */
export function validateSmokeAssetConfig(
  {
    symbol,
    tokenName = '',
    tokenAddress,
    tokenDecimals = null,
    feedDescription = '',
    supported,
    config,
    recordedMultiplier,
    oraclePrice,
    oracleState,
  },
  {
    maxPerLoanCapRaw = RECOMMENDED_SMOKE_PER_LOAN_CAP_RAW,
    maxAssetCapRaw = MAX_INITIAL_GLOBAL_CAP_RAW,
    disallowMocks = true,
    requirePinnedAssets = disallowMocks,
    pinnedAssets = BASE_MAINNET_SMOKE_ASSETS,
    allowClosedMarket = true,
    allowHigherLtvs = false,
  } = {}
) {
  const errors = [];
  const label = `${symbol || tokenAddress}`;
  if (!supported) {
    errors.push(`${label}: AssetRegistry.isAssetSupported == false.`);
    return { ok: false, errors };
  }
  if (!config) {
    errors.push(`${label}: missing AssetRegistry config.`);
    return { ok: false, errors };
  }
  if (Number(config.status) !== 0) {
    const statusLabel = ASSET_STATUS_NAMES[Number(config.status)] ?? String(config.status);
    errors.push(`${label}: AssetRegistry status=${statusLabel} (${config.status}; expected Active=0).`);
  }
  const perLoanCap = BigInt(config.perLoanCap ?? 0n);
  const assetCap = BigInt(config.assetCap ?? 0n);
  if (perLoanCap < MIN_LOAN_PRINCIPAL_RAW) {
    errors.push(`${label}: perLoanCap=${perLoanCap} < LoanCore min 500 USDC (${MIN_LOAN_PRINCIPAL_RAW}).`);
  }
  if (perLoanCap > BigInt(maxPerLoanCapRaw)) {
    errors.push(`${label}: perLoanCap=${perLoanCap} exceeds guarded smoke max ${maxPerLoanCapRaw}.`);
  }
  if (assetCap > BigInt(maxAssetCapRaw)) {
    errors.push(`${label}: assetCap=${assetCap} exceeds guarded launch max ${maxAssetCapRaw}.`);
  }
  if (assetCap < perLoanCap) {
    errors.push(`${label}: assetCap=${assetCap} < perLoanCap=${perLoanCap}.`);
  }
  const staleSecs = Number(config.maxStaleOpenSecs ?? 0);
  if (staleSecs < MIN_STALE_OPEN_SECS || staleSecs > MAX_STALE_OPEN_SECS) {
    errors.push(`${label}: maxStaleOpenSecs=${staleSecs} outside [${MIN_STALE_OPEN_SECS}, ${MAX_STALE_OPEN_SECS}].`);
  }
  if (!allowHigherLtvs) {
    if (
      Number(config.maxInitLtvBps) > TIER_A_CEILINGS.maxInitLtvBps ||
      Number(config.marginCallLtvBps) > TIER_A_CEILINGS.marginCallLtvBps ||
      Number(config.liqLtvBps) > TIER_A_CEILINGS.liqLtvBps ||
      Number(config.badDebtLtvBps) > TIER_A_CEILINGS.badDebtLtvBps
    ) {
      errors.push(
        `${label}: LTVs (${config.maxInitLtvBps}/${config.marginCallLtvBps}/${config.liqLtvBps}/${config.badDebtLtvBps}) exceed Tier A ceilings (6000/7000/7800/9000).`
      );
    }
  }
  if (BigInt(recordedMultiplier ?? 0n) <= 0n) {
    errors.push(`${label}: OracleRouter.recordedMultiplier == 0 (call syncMultiplier before trading).`);
  }
  const allowedStates = allowClosedMarket ? new Set([0, 1]) : new Set([0]);
  if (!allowedStates.has(Number(oracleState))) {
    const stateLabel = ORACLE_STATE_NAMES[Number(oracleState)] ?? String(oracleState);
    errors.push(`${label}: oracle state ${stateLabel} (${oracleState}) blocks live smoke execution.`);
  }
  if (BigInt(oraclePrice ?? 0n) <= 0n && Number(oracleState) <= 1) {
    errors.push(`${label}: OracleRouter.getPrice returned non-positive price ${oraclePrice}.`);
  }
  if (disallowMocks) {
    const isMockLabel = (value) =>
      /(?:^|[^a-zA-Z])[Mm][Oo][Cc][Kk](?:[^a-z]|$)|mock(?:token|aggregator|feed|oracle|sequencer|erc20|b20)/i.test(
        String(value)
      );
    if (isMockLabel(tokenName) || isMockLabel(symbol)) {
      errors.push(`${label}: mock token detected ("${tokenName}" / "${symbol}"); WS4.7 prohibits mock tokens.`);
    }
    if (isMockLabel(feedDescription)) {
      errors.push(`${label}: mock price feed detected ("${feedDescription}"); WS4.7 requires real Chainlink feeds.`);
    }
  }
  if (requirePinnedAssets) {
    const pinnedEntries = Object.values(pinnedAssets || {});
    const normalizedToken = normalizeOptAddress(tokenAddress);
    const normalizedFeed = normalizeOptAddress(config.feed);
    const pinnedMatch =
      pinnedEntries.find((p) => symbol && p.symbol.toLowerCase() === String(symbol).toLowerCase()) ??
      pinnedEntries.find((p) => normalizedToken && sameAddr(p.token, normalizedToken)) ??
      null;
    if (!pinnedMatch) {
      errors.push(`${label}: token (${normalizedToken}) is not in pinned Base Mainnet WS4.7 B20 asset registry.`);
    } else {
      if (!normalizedToken || !sameAddr(normalizedToken, pinnedMatch.token)) {
        errors.push(
          `${label}: token address (${normalizedToken}) does not match pinned Base ${pinnedMatch.symbol} (${pinnedMatch.token}).`
        );
      }
      if (!normalizedFeed || !sameAddr(normalizedFeed, pinnedMatch.feed)) {
        errors.push(
          `${label}: feed address (${normalizedFeed}) does not match pinned Base Chainlink ${pinnedMatch.symbol} feed (${pinnedMatch.feed}).`
        );
      }
      if (tokenDecimals !== null && tokenDecimals !== undefined && Number(tokenDecimals) !== pinnedMatch.decimals) {
        errors.push(
          `${label}: token decimals (${tokenDecimals}) != pinned ${pinnedMatch.decimals}.`
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Pure launch-cap check ensuring LoanCore.globalUsdcCap was explicitly lowered from the
 * 250,000 USDC LoanCore.initialize() default prior to originating WS4.7 smoke loans.
 */
export function validateGlobalSmokeCap(
  globalCapRaw,
  totalOutstandingRaw,
  { maxGlobalCapRaw = MAX_INITIAL_GLOBAL_CAP_RAW } = {}
) {
  const cap = BigInt(globalCapRaw ?? 0n);
  const outstanding = BigInt(totalOutstandingRaw ?? 0n);
  if (cap <= 0n) {
    return { ok: false, detail: 'LoanCore.globalUsdcCap is zero.' };
  }
  if (cap >= DEFAULT_INITIALIZER_GLOBAL_CAP_RAW) {
    return {
      ok: false,
      detail: `LoanCore.globalUsdcCap (${cap}) is still at/above initialize() default 250,000 USDC (${DEFAULT_INITIALIZER_GLOBAL_CAP_RAW}); lower via Timelock/Owner before first smoke loan.`,
    };
  }
  if (cap > BigInt(maxGlobalCapRaw)) {
    return {
      ok: false,
      detail: `LoanCore.globalUsdcCap (${cap}) exceeds guarded smoke maximum (${maxGlobalCapRaw}).`,
    };
  }
  if (outstanding > cap) {
    return {
      ok: false,
      detail: `LoanCore.totalOutstandingPrincipal (${outstanding}) exceeds globalUsdcCap (${cap}).`,
    };
  }
  return {
    ok: true,
    detail: `globalUsdcCap=${cap} raw ($${Number(cap) / 1e6} USDC), outstanding=${outstanding} raw.`,
  };
}

/**
 * Runs complete on-chain WS4.7 preflight verification across Safe multisigs, NostokTimelock,
 * LoanCore caps, EligibilityGate allowlist, OracleRouter sequencer health, FeeCollector bounds,
 * and registered B20 collateral tokens / Chainlink feeds.
 */
export async function runGuardedSmokePreflight({
  publicClient,
  contracts,
  ownerSafe,
  guardianSafe,
  deployer = null,
  usdcAddress = BASE_USDC_ADDRESS,
  expectedSequencerFeed = BASE_SEQUENCER_FEED_ADDRESS,
  assets = [],
  allowlistWallets = [],
  maxGlobalCapRaw = MAX_INITIAL_GLOBAL_CAP_RAW,
  maxPerLoanCapRaw = RECOMMENDED_SMOKE_PER_LOAN_CAP_RAW,
  maxAssetCapRaw = MAX_INITIAL_GLOBAL_CAP_RAW,
  minSafeOwners = 2,
  minSafeThreshold = 2,
  disallowMocks = true,
  requirePinnedAssets = disallowMocks,
  pinnedAssets = BASE_MAINNET_SMOKE_ASSETS,
  allowClosedMarket = true,
  allowHigherLtvs = false,
} = {}) {
  const checks = [];
  const record = (id, ok, detail) => {
    checks.push({ id, ok: Boolean(ok), detail });
  };

  const requiredKeys = [
    'loanCore',
    'orderSettlement',
    'liquidationAuction',
    'positionNft',
    'collateralEscrow',
    'assetRegistry',
    'oracleRouter',
    'eligibilityGate',
    'feeCollector',
    'nostokTimelock',
  ];
  const resolved = {};
  for (const key of requiredKeys) {
    const addr = normalizeOptAddress(contracts?.[key]);
    if (!addr) {
      record(`address.${key}`, false, `Missing or invalid ${key} contract address.`);
    } else {
      resolved[key] = addr;
    }
  }
  const ownerSafeAddr = normalizeOptAddress(ownerSafe);
  const guardianSafeAddr = normalizeOptAddress(guardianSafe);
  const usdcAddr = normalizeOptAddress(usdcAddress) ?? BASE_USDC_ADDRESS;
  const deployerAddr = normalizeOptAddress(deployer);

  const chainId = await publicClient.getChainId();
  record(
    'chain.id',
    Number(chainId) === BASE_CHAIN_ID,
    `Connected RPC chainId=${chainId} (expected Base Mainnet ${BASE_CHAIN_ID}).`
  );

  if (Object.keys(resolved).length < requiredKeys.length) {
    const failures = checks.filter((c) => !c.ok);
    return {
      ok: false,
      chainId: Number(chainId),
      checks,
      failures,
      summary: `${checks.length - failures.length}/${checks.length} checks passed; missing contract addresses aborted deep inspection.`,
    };
  }

  // 1. Core wiring & ownership verification
  const [
    coreOwner,
    coreGuardian,
    coreUsdc,
    coreEscrow,
    coreNft,
    coreSettlement,
    coreAuction,
    coreRegistry,
    coreOracle,
    coreFees,
    paused,
    globalCap,
    totalOutstanding,
    regOwner,
    regGuardian,
    oracleOwner,
    escrowOwner,
    nftOwner,
    settlementOwner,
    auctionOwner,
    feeOwner,
    escrowAuthCore,
    escrowAuthAuction,
    nftAuthCore,
  ] = await Promise.all([
    publicClient.readContract({ address: resolved.loanCore, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreWiringAbi, functionName: 'guardian' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreWiringAbi, functionName: 'usdc' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreAbi, functionName: 'escrow' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreWiringAbi, functionName: 'positionNft' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreWiringAbi, functionName: 'orderSettlement' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreWiringAbi, functionName: 'liquidationAuction' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreAbi, functionName: 'assetRegistry' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreAbi, functionName: 'oracleRouter' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreAbi, functionName: 'feeCollector' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreAbi, functionName: 'paused' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreAbi, functionName: 'globalUsdcCap' }),
    publicClient.readContract({ address: resolved.loanCore, abi: loanCoreAbi, functionName: 'totalOutstandingPrincipal' }),
    publicClient.readContract({ address: resolved.assetRegistry, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: resolved.assetRegistry, abi: assetRegistryExtraAbi, functionName: 'guardian' }),
    publicClient.readContract({ address: resolved.oracleRouter, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: resolved.collateralEscrow, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: resolved.positionNft, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: resolved.orderSettlement, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: resolved.liquidationAuction, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: resolved.feeCollector, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: resolved.collateralEscrow, abi: authorizedCoreViewAbi, functionName: 'isAuthorizedCore', args: [resolved.loanCore] }),
    publicClient.readContract({ address: resolved.collateralEscrow, abi: authorizedCoreViewAbi, functionName: 'isAuthorizedCore', args: [resolved.liquidationAuction] }),
    publicClient.readContract({ address: resolved.positionNft, abi: authorizedCoreViewAbi, functionName: 'isAuthorizedCore', args: [resolved.loanCore] }),
  ]);

  const wiringOk =
    sameAddr(coreUsdc, usdcAddr) &&
    sameAddr(coreEscrow, resolved.collateralEscrow) &&
    sameAddr(coreNft, resolved.positionNft) &&
    sameAddr(coreSettlement, resolved.orderSettlement) &&
    sameAddr(coreAuction, resolved.liquidationAuction) &&
    sameAddr(coreRegistry, resolved.assetRegistry) &&
    sameAddr(coreOracle, resolved.oracleRouter) &&
    sameAddr(coreFees, resolved.feeCollector) &&
    Boolean(escrowAuthCore) &&
    Boolean(escrowAuthAuction) &&
    Boolean(nftAuthCore);
  record(
    'wiring.contracts',
    wiringOk,
    wiringOk
      ? 'LoanCore, CollateralEscrow, PositionNFT, OrderSettlement, LiquidationAuction, FeeCollector, AssetRegistry & OracleRouter wired cleanly.'
      : `Contract wiring mismatch (usdc=${coreUsdc}, escrowAuthCore=${escrowAuthCore}, escrowAuthAuction=${escrowAuthAuction}, nftAuthCore=${nftAuthCore}).`
  );

  const timelockOwnedOk = [
    coreOwner,
    regOwner,
    oracleOwner,
    escrowOwner,
    nftOwner,
    settlementOwner,
    auctionOwner,
    feeOwner,
  ].every((o) => sameAddr(o, resolved.nostokTimelock));
  record(
    'governance.timelock_owners',
    timelockOwnedOk,
    timelockOwnedOk
      ? `All 8 core contracts owned by 48h NostokTimelock (${resolved.nostokTimelock}).`
      : `Not all core contracts are owned by NostokTimelock (${resolved.nostokTimelock}).`
  );

  // 2. NostokTimelock self-administration & role checks
  const [minDelay, proposerOk, executorOk, deployerAdmin] = await Promise.all([
    publicClient.readContract({ address: resolved.nostokTimelock, abi: timelockViewAbi, functionName: 'getMinDelay' }),
    ownerSafeAddr
      ? publicClient.readContract({ address: resolved.nostokTimelock, abi: timelockViewAbi, functionName: 'hasRole', args: [PROPOSER_ROLE, ownerSafeAddr] })
      : false,
    ownerSafeAddr
      ? publicClient.readContract({ address: resolved.nostokTimelock, abi: timelockViewAbi, functionName: 'hasRole', args: [EXECUTOR_ROLE, ownerSafeAddr] })
      : false,
    deployerAddr
      ? publicClient.readContract({ address: resolved.nostokTimelock, abi: timelockViewAbi, functionName: 'hasRole', args: [DEFAULT_ADMIN_ROLE, deployerAddr] })
      : false,
  ]);
  const timelockDelayOk = BigInt(minDelay ?? 0n) === TIMELOCK_MIN_DELAY_SECS;
  record(
    'governance.timelock_delay',
    timelockDelayOk && Boolean(proposerOk) && Boolean(executorOk) && !deployerAdmin,
    `minDelay=${minDelay}s (expected ${TIMELOCK_MIN_DELAY_SECS}s), proposer=${Boolean(proposerOk)}, executor=${Boolean(executorOk)}, deployerAdmin=${Boolean(deployerAdmin)}.`
  );

  // 3. Guardian wiring + Safe multisig out-of-band contract verification (WS4.6)
  record(
    'governance.guardian_wiring',
    Boolean(guardianSafeAddr && sameAddr(coreGuardian, guardianSafeAddr) && sameAddr(regGuardian, guardianSafeAddr)),
    `LoanCore.guardian=${coreGuardian}, AssetRegistry.guardian=${regGuardian} (expected ${guardianSafeAddr}).`
  );

  const [gateOwner, gatePermissionless, gateSigner] = await Promise.all([
    publicClient.readContract({ address: resolved.eligibilityGate, abi: ownableAbi, functionName: 'owner' }),
    publicClient.readContract({ address: resolved.eligibilityGate, abi: eligibilityGateAbi, functionName: 'permissionlessMode' }),
    publicClient.readContract({ address: resolved.eligibilityGate, abi: eligibilityGateAbi, functionName: 'attestationSigner' }),
  ]);

  const [ownerSafeCheck, guardianSafeCheck] = await Promise.all([
    validateSafeMultisigContract(publicClient, 'OWNER_SAFE', ownerSafeAddr, {
      minOwners: minSafeOwners,
      minThreshold: minSafeThreshold,
      deployer: deployerAddr,
      attestationSigner: gateSigner,
    }),
    validateSafeMultisigContract(publicClient, 'GUARDIAN_SAFE', guardianSafeAddr, {
      minOwners: minSafeOwners,
      minThreshold: minSafeThreshold,
      deployer: deployerAddr,
      attestationSigner: gateSigner,
    }),
  ]);
  record('safe.owner', ownerSafeCheck.ok, ownerSafeCheck.detail);
  record('safe.guardian', guardianSafeCheck.ok, guardianSafeCheck.detail);

  // 4. EligibilityGate hardening & allowlist
  const signerNormalized = normalizeOptAddress(gateSigner);
  const gateHardenedOk =
    Boolean(ownerSafeAddr && sameAddr(gateOwner, ownerSafeAddr)) &&
    gatePermissionless === false &&
    Boolean(signerNormalized) &&
    (!deployerAddr || !sameAddr(signerNormalized, deployerAddr));
  record(
    'eligibility.gate_mode',
    gateHardenedOk,
    `owner=${gateOwner}, permissionlessMode=${gatePermissionless}, attestationSigner=${gateSigner}.`
  );

  if (Array.isArray(allowlistWallets) && allowlistWallets.length > 0) {
    const walletStatuses = await Promise.all(
      allowlistWallets.map(async (w) => {
        const addr = normalizeOptAddress(w);
        if (!addr) return { addr: String(w), allowed: false, revoked: true };
        const [allowed, revoked] = await Promise.all([
          publicClient.readContract({ address: resolved.eligibilityGate, abi: eligibilityAllowlistViewAbi, functionName: 'allowlist', args: [addr] }),
          publicClient.readContract({ address: resolved.eligibilityGate, abi: eligibilityGateAbi, functionName: 'isRevoked', args: [addr] }),
        ]);
        return { addr, allowed: Boolean(allowed), revoked: Boolean(revoked) };
      })
    );
    const badWallets = walletStatuses.filter((s) => !s.allowed || s.revoked);
    record(
      'eligibility.allowlist',
      badWallets.length === 0,
      badWallets.length === 0
        ? `All ${walletStatuses.length} internal smoke wallet(s) allowlisted & unrevoked.`
        : `Wallets missing allowlist or revoked: ${badWallets.map((w) => `${w.addr}(allowed=${w.allowed},revoked=${w.revoked})`).join(', ')}`
    );
  }

  // 5. LoanCore pause state & lowered globalUsdcCap
  record('loancore.unpaused', paused === false, `LoanCore.paused=${paused}.`);
  const capCheck = validateGlobalSmokeCap(globalCap, totalOutstanding, { maxGlobalCapRaw });
  record('loancore.global_cap', capCheck.ok, capCheck.detail);

  // 6. OracleRouter sequencer & FeeCollector ceilings
  const [seqFeed, seqValid, maxClosedStale, origBps, intCutBps, liqBps, resShareBps, treasury, reserve] =
    await Promise.all([
      publicClient.readContract({ address: resolved.oracleRouter, abi: oracleRouterAbi, functionName: 'sequencerUptimeFeed' }),
      publicClient.readContract({ address: resolved.oracleRouter, abi: oracleRouterAbi, functionName: 'isSequencerValid' }),
      publicClient.readContract({ address: resolved.oracleRouter, abi: oracleRouterAbi, functionName: 'maxStaleClosedSecs' }),
      publicClient.readContract({ address: resolved.feeCollector, abi: feeCollectorAbi, functionName: 'originationFeeBps' }),
      publicClient.readContract({ address: resolved.feeCollector, abi: feeCollectorAbi, functionName: 'interestCutBps' }),
      publicClient.readContract({ address: resolved.feeCollector, abi: feeCollectorAbi, functionName: 'liquidationFeeBps' }),
      publicClient.readContract({ address: resolved.feeCollector, abi: feeCollectorAbi, functionName: 'safetyReserveShareBps' }),
      publicClient.readContract({ address: resolved.feeCollector, abi: feeCollectorAbi, functionName: 'treasury' }),
      publicClient.readContract({ address: resolved.feeCollector, abi: feeCollectorAbi, functionName: 'safetyReserve' }),
    ]);

  const seqMatchesExpected = !expectedSequencerFeed || sameAddr(seqFeed, expectedSequencerFeed);
  record(
    'oracle.sequencer',
    seqFeed !== zeroAddress && seqValid === true && seqMatchesExpected && Number(maxClosedStale) > 0,
    `sequencerFeed=${seqFeed}, isSequencerValid=${seqValid}, maxStaleClosedSecs=${maxClosedStale}.`
  );

  const feesOk =
    Number(origBps) <= 100 &&
    Number(intCutBps) <= 2000 &&
    Number(liqBps) <= 300 &&
    Number(resShareBps) <= 10_000 &&
    treasury !== zeroAddress &&
    reserve !== zeroAddress;
  record(
    'fees.ceilings',
    feesOk,
    `orig=${origBps}bps, intCut=${intCutBps}bps, liq=${liqBps}bps, reserveShare=${resShareBps}bps, treasury=${treasury}, reserve=${reserve}.`
  );

  // 7. Collateral assets, Chainlink feeds & anti-mock validation
  if (!Array.isArray(assets) || assets.length === 0) {
    record('assets.configured', false, 'At least one collateral asset (e.g. NVDAc / METAc) must be supplied for preflight.');
  } else {
    for (const assetInput of assets) {
      const tokenAddr = normalizeOptAddress(typeof assetInput === 'string' ? assetInput : assetInput?.address);
      const expectedSymbol = typeof assetInput === 'string' ? null : assetInput?.symbol;
      if (!tokenAddr) {
        record(`asset.${String(assetInput)}`, false, 'Invalid collateral token address.');
        continue;
      }
      const supported = await publicClient.readContract({
        address: resolved.assetRegistry,
        abi: assetRegistryAbi,
        functionName: 'isAssetSupported',
        args: [tokenAddr],
      });
      if (!supported) {
        record(`asset.${expectedSymbol || tokenAddr}`, false, `${tokenAddr} is not supported in AssetRegistry.`);
        continue;
      }
      const [config, tokenName, symbol, tokenDecimals, recMult, priceTuple] = await Promise.all([
        publicClient.readContract({ address: resolved.assetRegistry, abi: assetRegistryAbi, functionName: 'getAssetConfig', args: [tokenAddr] }),
        publicClient.readContract({ address: tokenAddr, abi: erc20NameAbi, functionName: 'name' }).catch(() => ''),
        publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol' }).catch(() => ''),
        publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }).catch(() => null),
        publicClient.readContract({ address: resolved.oracleRouter, abi: oracleRouterAbi, functionName: 'recordedMultiplier', args: [tokenAddr] }),
        publicClient
          .readContract({ address: resolved.oracleRouter, abi: oracleRouterAbi, functionName: 'getPrice', args: [tokenAddr] })
          .catch(() => [0n, 8, 3]),
      ]);
      const feedDesc = await publicClient
        .readContract({ address: config.feed, abi: aggregatorV3Abi, functionName: 'description' })
        .catch(() => '');

      const assetRes = validateSmokeAssetConfig(
        {
          symbol: expectedSymbol || symbol || tokenAddr,
          tokenName,
          tokenAddress: tokenAddr,
          tokenDecimals,
          feedDescription: feedDesc,
          supported,
          config,
          recordedMultiplier: recMult,
          oraclePrice: priceTuple[0],
          oracleState: priceTuple[2],
        },
        {
          maxPerLoanCapRaw,
          maxAssetCapRaw,
          disallowMocks,
          requirePinnedAssets,
          pinnedAssets,
          allowClosedMarket,
          allowHigherLtvs,
        }
      );
      if (expectedSymbol && symbol && expectedSymbol !== symbol) {
        assetRes.ok = false;
        assetRes.errors.push(`Expected symbol ${expectedSymbol}, on-chain ERC20.symbol()="${symbol}".`);
      }
      record(
        `asset.${expectedSymbol || symbol || tokenAddr}`,
        assetRes.ok,
        assetRes.ok
          ? `${symbol} (${tokenAddr}): feed="${feedDesc || config.feed}", price=${priceTuple[0]} (${ORACLE_STATE_NAMES[Number(priceTuple[2])] ?? priceTuple[2]}), perLoanCap=${config.perLoanCap}, assetCap=${config.assetCap}, maxStaleOpen=${config.maxStaleOpenSecs}s, mult=${recMult}`
          : assetRes.errors.join(' ')
      );
    }
  }

  const failures = checks.filter((c) => !c.ok);
  return {
    ok: failures.length === 0,
    chainId: Number(chainId),
    checks,
    failures,
    summary: `${checks.length - failures.length}/${checks.length} WS4.7 guarded preflight checks passed.`,
  };
}

function parseCliArgs(argv) {
  const opts = {
    help: false,
    json: false,
    allowMocks: false,
    allowSingleSignerSafe: false,
    allowRemoteFork: false,
    rpcUrl: process.env.RPC_URL || process.env.BASE_RPC_URL || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--production') {
      // Production safeguards are now enabled by default on Base Mainnet (8453); accepted as no-op.
    } else if (a === '--allow-mocks') opts.allowMocks = true;
    else if (a === '--allow-1of1-safe') opts.allowSingleSignerSafe = true;
    else if (a === '--allow-remote-fork') opts.allowRemoteFork = true;
    else if (a === '--rpc-url' && argv[i + 1]) opts.rpcUrl = argv[++i];
  }
  return opts;
}

function isLoopbackRpcUrl(rpcUrl) {
  try {
    const parsed = new URL(rpcUrl);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  } catch {
    return false;
  }
}

async function runCli() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        'WS4.7 Guarded Base Mainnet Smoke Preflight Validator (production checks enabled by default on 8453)',
        '',
        'Usage: node scripts/ws4_7_smoke_lib.mjs --rpc-url <BASE_RPC_URL> [--json] [--allow-mocks] [--allow-1of1-safe]',
        '',
        'Required environment variables:',
        '  OWNER_SAFE_ADDRESS, GUARDIAN_SAFE_ADDRESS, NOSTOK_TIMELOCK_ADDRESS,',
        '  LOANCORE_ADDRESS, ORDER_SETTLEMENT_ADDRESS, LIQUIDATION_AUCTION_ADDRESS,',
        '  POSITION_NFT_ADDRESS, COLLATERAL_ESCROW_ADDRESS, ASSET_REGISTRY_ADDRESS,',
        '  ORACLE_ROUTER_ADDRESS, ELIGIBILITY_GATE_ADDRESS, FEE_COLLECTOR_ADDRESS,',
        '  SMOKE_ASSETS (comma-separated SYMBOL:0xToken, e.g. NVDAc:0x...,METAc:0x...)',
        'Optional: SMOKE_ALLOWLIST (comma-separated internal wallet addresses), DEPLOYER_ADDRESS',
      ].join('\n')
    );
    return;
  }
  if (!opts.rpcUrl) {
    console.error('Missing --rpc-url or BASE_RPC_URL/RPC_URL.');
    process.exit(1);
  }
  if ((opts.allowMocks || opts.allowSingleSignerSafe) && !isLoopbackRpcUrl(opts.rpcUrl) && !opts.allowRemoteFork) {
    console.error(
      'Refusing --allow-mocks / --allow-1of1-safe against a non-loopback RPC URL (pass --allow-remote-fork only for remote fork tests).'
    );
    process.exit(1);
  }
  const chain = defineChain({
    ...base,
    id: BASE_CHAIN_ID,
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(opts.rpcUrl),
    cacheTime: 0,
  });
  const assets = (process.env.SMOKE_ASSETS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [left, right] = entry.split(':');
      return right ? { symbol: left.trim(), address: right.trim() } : { address: left.trim() };
    });
  const allowlistWallets = (process.env.SMOKE_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const report = await runGuardedSmokePreflight({
    publicClient,
    contracts: {
      loanCore: process.env.LOANCORE_ADDRESS,
      orderSettlement: process.env.ORDER_SETTLEMENT_ADDRESS,
      liquidationAuction: process.env.LIQUIDATION_AUCTION_ADDRESS,
      positionNft: process.env.POSITION_NFT_ADDRESS,
      collateralEscrow: process.env.COLLATERAL_ESCROW_ADDRESS,
      assetRegistry: process.env.ASSET_REGISTRY_ADDRESS,
      oracleRouter: process.env.ORACLE_ROUTER_ADDRESS,
      eligibilityGate: process.env.ELIGIBILITY_GATE_ADDRESS,
      feeCollector: process.env.FEE_COLLECTOR_ADDRESS,
      nostokTimelock: process.env.NOSTOK_TIMELOCK_ADDRESS,
    },
    ownerSafe: process.env.OWNER_SAFE_ADDRESS,
    guardianSafe: process.env.GUARDIAN_SAFE_ADDRESS,
    deployer: process.env.DEPLOYER_ADDRESS,
    assets,
    allowlistWallets,
    minSafeOwners: opts.allowSingleSignerSafe ? 1 : 2,
    minSafeThreshold: opts.allowSingleSignerSafe ? 1 : 2,
    disallowMocks: !opts.allowMocks,
    requirePinnedAssets: !opts.allowMocks,
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const c of report.checks) {
      console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.id}: ${c.detail}`);
    }
    console.log(`\n${report.summary}`);
  }
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => {
    console.error(`[WS4.7_PREFLIGHT_ERROR] ${sanitizeRpcErrorMessage(err)}`);
    process.exit(1);
  });
}
