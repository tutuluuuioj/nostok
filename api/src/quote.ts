import { type Address, type Chain, type PublicClient, type Transport, zeroAddress } from 'viem';
import {
  ASSET_STATUS_NAMES,
  ORACLE_STATE_NAMES,
  OracleState,
  assetRegistryAbi,
  eligibilityGateAbi,
  erc20MetaAbi,
  feeCollectorAbi,
  liquidationAuctionAbi,
  loanCoreAbi,
  oracleRouterAbi,
} from './abi.js';
import type { ApiConfig } from './config.js';
import type { ReadOnlyDatabase } from './db.js';
import { type FormattedAmount, ceilDiv, formatAmount, formatRay18 } from './format.js';
import type { QuoteInput } from './validation.js';

const USDC_DECIMALS = 6;
const UINT128_MAX = (1n << 128n) - 1n;
const LOAN_MIN_PRINCIPAL_RAW = 500n * 1_000_000n; // $500 USDC (LoanCore.sol:211)
const MAX_TOTAL_TERM_DAYS = 90; // LoanCore.sol:211 & :527
const MIN_NEW_LOAN_TERM_DAYS = 7; // LoanCore.sol:211
const MAX_APR_BPS = 4000; // 40.00% APR (LoanCore.sol:211 & :526)
const MIN_INTEREST_DAYS_LOW = 1; // LoanCore.sol:215
const MIN_INTEREST_DAYS_HIGH = 30; // LoanCore.sol:215

export class RpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcUnavailableError';
  }
}

async function rpcRead<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RpcUnavailableError(`RPC read failed (${label}): ${reason}`);
  }
}

export function computeLiquidationPrice(
  debt: bigint,
  liqLtvBps: bigint,
  collateralRaw: bigint,
  priceScale: bigint
): bigint {
  if (debt <= 0n || liqLtvBps <= 0n || collateralRaw <= 0n) return 0n;
  // LoanCore.startLiquidation checks floor(D * 10_000 / G) >= liqLtvBps where G = floor(c * p * 1e6 / S).
  // Any G <= gMax = floor(D * 10_000 / liqLtvBps) triggers liquidation; G >= gMax + 1 is the safe region.
  // Therefore the first strictly non-liquidating price is ceil((gMax + 1) * S / (c * 1e6)), which is
  // guaranteed >= highestLiquidatingPrice + 1.
  const gMax = (debt * 10_000n) / liqLtvBps;
  return ceilDiv((gMax + 1n) * priceScale, collateralRaw * 1_000_000n);
}

export interface QuoteRejection {
  code: string;
  message: string;
}

export interface QuoteWarning {
  code: string;
  message: string;
}

export interface QuoteResponse {
  accepted: boolean;
  rejection_reasons: QuoteRejection[];
  warnings: QuoteWarning[];
  block_number: string;
  indexed_block_number: string | null;
  freshness_timestamp: string;
  asset: {
    token: Address;
    symbol: string;
    decimals: number;
    status: number | null;
    status_name: string;
    restricted: boolean;
    oracle_state: number;
    oracle_state_name: string;
    oracle_price: FormattedAmount;
    closed_market_haircut_bps: number;
    max_init_ltv_bps: number;
    allowed_ltv_bps: number;
    margin_call_ltv_bps: number;
    liq_ltv_bps: number;
    bad_debt_ltv_bps: number;
    recorded_multiplier: FormattedAmount;
  };
  terms: {
    term_days: number;
    existing_elapsed_days: number;
    total_term_days: number;
    apr_bps: number;
    min_interest_days: number;
    yield_mode: number;
  };
  amounts: {
    principal: FormattedAmount;
    collateral_required: FormattedAmount;
    collateral_gross_value_usdc: FormattedAmount;
    collateral_effective_value_usdc: FormattedAmount;
    origination_fee: FormattedAmount;
    origination_fee_bps: number;
    net_proceeds: FormattedAmount;
    interest_maturity: FormattedAmount;
    min_interest_floor: FormattedAmount;
    origination_debt: FormattedAmount;
    protocol_interest_cut: FormattedAmount;
    protocol_interest_cut_bps: number;
    lender_net_interest: FormattedAmount;
    total_repayment_at_maturity: FormattedAmount;
  };
  risk: {
    initial_ltv_bps: number;
    health_factor: { raw: string; formatted: string; decimals: number };
    liquidation_price: FormattedAmount;
    liquidation_price_at_origination: FormattedAmount;
    liquidation_price_at_maturity: FormattedAmount;
    liquidation_fee_bps: number;
    min_buy_usdc: FormattedAmount;
  };
  caps: {
    global_usdc_cap: FormattedAmount;
    total_outstanding_principal: FormattedAmount;
    global_remaining: FormattedAmount;
    per_loan_cap: FormattedAmount;
    asset_cap: FormattedAmount;
    asset_outstanding_principal: FormattedAmount;
    asset_remaining: FormattedAmount;
    protocol_paused: boolean;
    eligibility_permissionless: boolean;
  };
}

function computeGrossUsdc(
  rawCollateral: bigint,
  price: bigint,
  tokenDecimals: number,
  feedDecimals: number
): bigint {
  if (rawCollateral === 0n || price === 0n) return 0n;
  const denom = 10n ** BigInt(tokenDecimals) * 10n ** BigInt(feedDecimals);
  return (rawCollateral * price * 1_000_000n) / denom;
}

function computeEffectiveUsdc(
  grossUsdc: bigint,
  oracleState: number,
  closedHaircutBps: number
): bigint {
  if (oracleState === OracleState.VALID_CLOSED && closedHaircutBps > 0) {
    const haircut = (grossUsdc * BigInt(closedHaircutBps)) / 10_000n;
    return grossUsdc - haircut;
  }
  return grossUsdc;
}

export async function computeLoanQuote(params: {
  publicClient: PublicClient<Transport, Chain>;
  db: ReadOnlyDatabase;
  config: ApiConfig;
  input: QuoteInput;
}): Promise<QuoteResponse> {
  const { publicClient, db, config, input } = params;
  const freshnessTimestamp = new Date().toISOString();

  const blockNumber = await rpcRead(() => publicClient.getBlockNumber(), 'getBlockNumber');
  const stateRow = await db
    .query<{ last_indexed_block: string }>('SELECT last_indexed_block::TEXT AS last_indexed_block FROM indexer_state WHERE id = 1')
    .catch(() => ({ rows: [] as Array<{ last_indexed_block: string }> }));
  const indexedBlockNumber = stateRow.rows[0]?.last_indexed_block ?? null;

  const rejections: QuoteRejection[] = [];
  const warnings: QuoteWarning[] = [];

  if (input.principal !== undefined && input.principal > UINT128_MAX) {
    rejections.push({
      code: 'PRINCIPAL_EXCEEDS_UINT128_MAX',
      message: `Requested principal (${input.principal}) exceeds uint128 maximum (${UINT128_MAX})`,
    });
  }
  if (input.collateralAmount !== undefined && input.collateralAmount > UINT128_MAX) {
    rejections.push({
      code: 'COLLATERAL_EXCEEDS_UINT128_MAX',
      message: `Requested collateral (${input.collateralAmount}) exceeds uint128 maximum (${UINT128_MAX})`,
    });
  }

  // Read global protocol parameters at the exact quote blockNumber
  const [
    paused,
    globalCap,
    totalOutstanding,
    secondsPerYear,
    originationFeeBpsRaw,
    interestCutBpsRaw,
    liquidationFeeBpsRaw,
    minBuyUsdc,
    permissionlessMode,
    supported,
  ] = await rpcRead(
    () =>
      Promise.all([
        publicClient.readContract({
          address: config.loanCore,
          abi: loanCoreAbi,
          functionName: 'paused',
          blockNumber,
        }),
        publicClient.readContract({
          address: config.loanCore,
          abi: loanCoreAbi,
          functionName: 'globalUsdcCap',
          blockNumber,
        }),
        publicClient.readContract({
          address: config.loanCore,
          abi: loanCoreAbi,
          functionName: 'totalOutstandingPrincipal',
          blockNumber,
        }),
        publicClient.readContract({
          address: config.loanCore,
          abi: loanCoreAbi,
          functionName: 'SECONDS_PER_YEAR',
          blockNumber,
        }),
        publicClient.readContract({
          address: config.feeCollector,
          abi: feeCollectorAbi,
          functionName: 'originationFeeBps',
          blockNumber,
        }),
        publicClient.readContract({
          address: config.feeCollector,
          abi: feeCollectorAbi,
          functionName: 'interestCutBps',
          blockNumber,
        }),
        publicClient.readContract({
          address: config.feeCollector,
          abi: feeCollectorAbi,
          functionName: 'liquidationFeeBps',
          blockNumber,
        }),
        publicClient.readContract({
          address: config.liquidationAuction,
          abi: liquidationAuctionAbi,
          functionName: 'MIN_BUY_USDC',
          blockNumber,
        }),
        publicClient.readContract({
          address: config.eligibilityGate,
          abi: eligibilityGateAbi,
          functionName: 'permissionlessMode',
          blockNumber,
        }),
        publicClient.readContract({
          address: config.assetRegistry,
          abi: assetRegistryAbi,
          functionName: 'isAssetSupported',
          args: [input.asset],
          blockNumber,
        }),
      ]),
    'globalProtocolParams'
  );

  if (paused) {
    rejections.push({ code: 'PROTOCOL_PAUSED', message: 'LoanCore protocol is currently paused' });
  }

  let tokenDecimals = 18;
  let tokenSymbol = 'UNKNOWN';
  try {
    const [dec, sym] = await Promise.all([
      publicClient.readContract({
        address: input.asset,
        abi: erc20MetaAbi,
        functionName: 'decimals',
        blockNumber,
      }),
      publicClient.readContract({
        address: input.asset,
        abi: erc20MetaAbi,
        functionName: 'symbol',
        blockNumber,
      }),
    ]);
    tokenDecimals = Number(dec);
    tokenSymbol = sym;
  } catch {
    const assetRow = await db.query<{ symbol: string | null; decimals: number | null }>(
      'SELECT symbol, decimals FROM assets WHERE LOWER(token) = LOWER($1)',
      [input.asset]
    );
    if (assetRow.rows.length > 0) {
      if (assetRow.rows[0].decimals !== null) tokenDecimals = Number(assetRow.rows[0].decimals);
      if (assetRow.rows[0].symbol) tokenSymbol = assetRow.rows[0].symbol;
    }
  }

  if (!supported) {
    rejections.push({
      code: 'ASSET_NOT_SUPPORTED',
      message: `Collateral asset ${input.asset} is not supported by AssetRegistry`,
    });
    return {
      accepted: false,
      rejection_reasons: rejections,
      warnings,
      block_number: blockNumber.toString(),
      indexed_block_number: indexedBlockNumber,
      freshness_timestamp: freshnessTimestamp,
      asset: {
        token: input.asset,
        symbol: tokenSymbol,
        decimals: tokenDecimals,
        status: null,
        status_name: 'Unsupported',
        restricted: true,
        oracle_state: OracleState.FROZEN_CORPORATE_ACTION,
        oracle_state_name: ORACLE_STATE_NAMES[OracleState.FROZEN_CORPORATE_ACTION],
        oracle_price: formatAmount(0n, 8, 'USD'),
        closed_market_haircut_bps: 0,
        max_init_ltv_bps: 0,
        allowed_ltv_bps: 0,
        margin_call_ltv_bps: 0,
        liq_ltv_bps: 0,
        bad_debt_ltv_bps: 0,
        recorded_multiplier: formatAmount(0n, 18),
      },
      terms: {
        term_days: input.termDays,
        existing_elapsed_days: input.existingElapsedDays,
        total_term_days: input.existingElapsedDays + input.termDays,
        apr_bps: input.aprBps,
        min_interest_days: input.minInterestDays,
        yield_mode: 0,
      },
      amounts: {
        principal: formatAmount(input.principal ?? 0n, USDC_DECIMALS, 'USDC'),
        collateral_required: formatAmount(input.collateralAmount ?? 0n, tokenDecimals, tokenSymbol),
        collateral_gross_value_usdc: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        collateral_effective_value_usdc: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        origination_fee: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        origination_fee_bps: Number(originationFeeBpsRaw),
        net_proceeds: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        interest_maturity: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        min_interest_floor: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        origination_debt: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        protocol_interest_cut: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        protocol_interest_cut_bps: Number(interestCutBpsRaw),
        lender_net_interest: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        total_repayment_at_maturity: formatAmount(0n, USDC_DECIMALS, 'USDC'),
      },
      risk: {
        initial_ltv_bps: 0,
        health_factor: formatRay18(0n),
        liquidation_price: formatAmount(0n, 8, 'USD'),
        liquidation_price_at_origination: formatAmount(0n, 8, 'USD'),
        liquidation_price_at_maturity: formatAmount(0n, 8, 'USD'),
        liquidation_fee_bps: Number(liquidationFeeBpsRaw),
        min_buy_usdc: formatAmount(minBuyUsdc, USDC_DECIMALS, 'USDC'),
      },
      caps: {
        global_usdc_cap: formatAmount(globalCap, USDC_DECIMALS, 'USDC'),
        total_outstanding_principal: formatAmount(totalOutstanding, USDC_DECIMALS, 'USDC'),
        global_remaining: formatAmount(globalCap > totalOutstanding ? globalCap - totalOutstanding : 0n, USDC_DECIMALS, 'USDC'),
        per_loan_cap: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        asset_cap: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        asset_outstanding_principal: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        asset_remaining: formatAmount(0n, USDC_DECIMALS, 'USDC'),
        protocol_paused: paused,
        eligibility_permissionless: permissionlessMode,
      },
    };
  }

  const [cfg, assetOutstanding, priceResult, recordedMultiplier] = await rpcRead(
    () =>
      Promise.all([
        publicClient.readContract({
          address: config.assetRegistry,
          abi: assetRegistryAbi,
          functionName: 'getAssetConfig',
          args: [input.asset],
          blockNumber,
        }),
        publicClient.readContract({
          address: config.loanCore,
          abi: loanCoreAbi,
          functionName: 'assetOutstandingPrincipal',
          args: [input.asset],
          blockNumber,
        }),
        publicClient.readContract({
          address: config.oracleRouter,
          abi: oracleRouterAbi,
          functionName: 'getPrice',
          args: [input.asset],
          blockNumber,
        }),
        publicClient.readContract({
          address: config.oracleRouter,
          abi: oracleRouterAbi,
          functionName: 'recordedMultiplier',
          args: [input.asset],
          blockNumber,
        }),
      ]),
    `assetParams(${input.asset})`
  );

  const [oraclePrice, oracleDecimalsRaw, oracleStateRaw] = priceResult;
  const oracleDecimals = Number(oracleDecimalsRaw);
  const oracleState = Number(oracleStateRaw);
  const oracleStateName = ORACLE_STATE_NAMES[oracleState] ?? `UNKNOWN(${oracleState})`;
  const assetStatus = Number(cfg.status);
  const assetStatusName = ASSET_STATUS_NAMES[assetStatus] ?? `UNKNOWN(${assetStatus})`;

  if (assetStatus !== 0) {
    rejections.push({
      code: 'ASSET_NOT_ACTIVE',
      message: `Asset ${tokenSymbol} is in status ${assetStatusName} (must be Active to originate new loans)`,
    });
  }

  const oracleUsable =
    oracleState === OracleState.VALID_OPEN || oracleState === OracleState.VALID_CLOSED;
  if (!oracleUsable || oraclePrice === 0n) {
    rejections.push({
      code: 'ORACLE_INVALID',
      message: `Oracle state for ${tokenSymbol} is ${oracleStateName} (VALID_OPEN or VALID_CLOSED required)`,
    });
  }

  // Requirement 2: ALWAYS check EligibilityGate.isEligible (even when permissionlessMode is true,
  // because revoked accounts are still rejected; pass optional signed attestation bytes as context).
  if (input.borrower && input.borrower !== zeroAddress) {
    const ok = await rpcRead(
      () =>
        publicClient.readContract({
          address: config.eligibilityGate,
          abi: eligibilityGateAbi,
          functionName: 'isEligible',
          args: [input.borrower!, input.borrowerAttestation],
          blockNumber,
        }),
      'eligibilityGate.isEligible(borrower)'
    );
    if (!ok) {
      rejections.push({
        code: 'BORROWER_INELIGIBLE',
        message: `Borrower ${input.borrower} failed EligibilityGate check (revoked or missing allowlist/attestation)`,
      });
    }
  }
  if (input.lender && input.lender !== zeroAddress) {
    const ok = await rpcRead(
      () =>
        publicClient.readContract({
          address: config.eligibilityGate,
          abi: eligibilityGateAbi,
          functionName: 'isEligible',
          args: [input.lender!, input.lenderAttestation],
          blockNumber,
        }),
      'eligibilityGate.isEligible(lender)'
    );
    if (!ok) {
      rejections.push({
        code: 'LENDER_INELIGIBLE',
        message: `Lender ${input.lender} failed EligibilityGate check (revoked or missing allowlist/attestation)`,
      });
    }
  }

  // Validate loan terms: 7-day minimum applies ONLY to new loans (existingElapsedDays === 0), not extensions
  const totalTermDays = input.existingElapsedDays + input.termDays;
  const minTermForMode = input.existingElapsedDays === 0 ? MIN_NEW_LOAN_TERM_DAYS : 1;
  if (input.termDays < minTermForMode || input.termDays > MAX_TOTAL_TERM_DAYS) {
    rejections.push({
      code: 'TERM_OUT_OF_RANGE',
      message: `term_days must be between ${minTermForMode} and ${MAX_TOTAL_TERM_DAYS} days`,
    });
  } else if (totalTermDays > MAX_TOTAL_TERM_DAYS) {
    rejections.push({
      code: 'MAX_90_DAY_TOTAL_TERM_EXCEEDED',
      message: `Total loan duration (${input.existingElapsedDays} + ${input.termDays} = ${totalTermDays} days) exceeds 90-day maximum`,
    });
  }

  if (input.aprBps > MAX_APR_BPS) {
    rejections.push({
      code: 'APR_EXCEEDS_MAX',
      message: `APR ${input.aprBps} bps exceeds protocol maximum of ${MAX_APR_BPS} bps (40.00%)`,
    });
  }

  if (
    input.minInterestDays < MIN_INTEREST_DAYS_LOW ||
    input.minInterestDays > MIN_INTEREST_DAYS_HIGH
  ) {
    rejections.push({
      code: 'MIN_INTEREST_DAYS_OUT_OF_RANGE',
      message: `min_interest_days must be between ${MIN_INTEREST_DAYS_LOW} and ${MIN_INTEREST_DAYS_HIGH}`,
    });
  }

  const maxInitLtvBps = Number(cfg.maxInitLtvBps);
  const allowedLtvBps =
    input.maxLtvBps !== undefined ? Math.min(input.maxLtvBps, maxInitLtvBps) : maxInitLtvBps;

  // Derive principal and/or collateralRequired using exact contract integer math
  let quotedPrincipal = input.principal ?? 0n;
  let collateralRequired = input.collateralAmount ?? 0n;

  if (oraclePrice > 0n) {
    const denomScale = 10n ** BigInt(tokenDecimals) * 10n ** BigInt(oracleDecimals);
    const haircutBps = BigInt(cfg.closedMarketHaircutBps);

    if (input.collateralAmount !== undefined && input.principal === undefined) {
      const grossFromInput = computeGrossUsdc(
        input.collateralAmount,
        oraclePrice,
        tokenDecimals,
        oracleDecimals
      );
      const effFromInput = computeEffectiveUsdc(
        grossFromInput,
        oracleState,
        Number(cfg.closedMarketHaircutBps)
      );
      quotedPrincipal = (effFromInput * BigInt(allowedLtvBps)) / 10_000n;
      collateralRequired = input.collateralAmount;
    } else if (input.principal !== undefined && input.collateralAmount === undefined) {
      quotedPrincipal = input.principal;
      const minEffUsdc = ceilDiv(quotedPrincipal * 10_000n, BigInt(allowedLtvBps));
      const minGrossUsdc =
        oracleState === OracleState.VALID_CLOSED && haircutBps > 0n && haircutBps < 10_000n
          ? ceilDiv(minEffUsdc * 10_000n, 10_000n - haircutBps)
          : minEffUsdc;
      collateralRequired = ceilDiv(minGrossUsdc * denomScale, oraclePrice * 1_000_000n);
      while (
        computeEffectiveUsdc(
          computeGrossUsdc(collateralRequired, oraclePrice, tokenDecimals, oracleDecimals),
          oracleState,
          Number(cfg.closedMarketHaircutBps)
        ) < minEffUsdc
      ) {
        collateralRequired += 1n;
      }
    }
  }

  if (
    quotedPrincipal > UINT128_MAX &&
    !rejections.some((r) => r.code === 'PRINCIPAL_EXCEEDS_UINT128_MAX')
  ) {
    rejections.push({
      code: 'PRINCIPAL_EXCEEDS_UINT128_MAX',
      message: `Derived principal (${quotedPrincipal}) exceeds uint128 maximum (${UINT128_MAX})`,
    });
  }
  if (
    collateralRequired > UINT128_MAX &&
    !rejections.some((r) => r.code === 'COLLATERAL_EXCEEDS_UINT128_MAX')
  ) {
    rejections.push({
      code: 'COLLATERAL_EXCEEDS_UINT128_MAX',
      message: `Collateral amount (${collateralRequired}) exceeds uint128 maximum (${UINT128_MAX})`,
    });
  }

  // Evaluate exact onchain getValue for the quoted/provided collateral
  let grossValueUsdc = computeGrossUsdc(collateralRequired, oraclePrice, tokenDecimals, oracleDecimals);
  let effectiveValueUsdc = computeEffectiveUsdc(
    grossValueUsdc,
    oracleState,
    Number(cfg.closedMarketHaircutBps)
  );
  if (oracleUsable && collateralRequired > 0n && collateralRequired <= UINT128_MAX) {
    const [onchainGross, onchainEff] = await rpcRead(
      () =>
        publicClient.readContract({
          address: config.oracleRouter,
          abi: oracleRouterAbi,
          functionName: 'getValue',
          args: [input.asset, collateralRequired],
          blockNumber,
        }),
      'oracleRouter.getValue'
    );
    grossValueUsdc = onchainGross;
    effectiveValueUsdc = onchainEff;
  }

  // Validate principal floors & caps against quotedPrincipal
  if (quotedPrincipal < LOAN_MIN_PRINCIPAL_RAW) {
    rejections.push({
      code: 'PRINCIPAL_BELOW_MINIMUM',
      message: `Principal ${quotedPrincipal} is below LoanCore $500 minimum (${LOAN_MIN_PRINCIPAL_RAW} raw USDC)`,
    });
  }
  if (quotedPrincipal < minBuyUsdc) {
    warnings.push({
      code: 'BELOW_MIN_BUY_USDC',
      message: `Principal ${quotedPrincipal} is below LiquidationAuction MIN_BUY_USDC (${minBuyUsdc} raw USDC)`,
    });
  }
  if (cfg.perLoanCap > 0n && quotedPrincipal > cfg.perLoanCap) {
    rejections.push({
      code: 'PER_LOAN_CAP_EXCEEDED',
      message: `Principal ${quotedPrincipal} exceeds asset perLoanCap of ${cfg.perLoanCap}`,
    });
  }
  if (cfg.assetCap > 0n && assetOutstanding + quotedPrincipal > cfg.assetCap) {
    rejections.push({
      code: 'ASSET_CAP_EXCEEDED',
      message: `Asset outstanding (${assetOutstanding}) + principal (${quotedPrincipal}) exceeds assetCap (${cfg.assetCap})`,
    });
  }
  if (totalOutstanding + quotedPrincipal > globalCap) {
    rejections.push({
      code: 'GLOBAL_CAP_EXCEEDED',
      message: `Total outstanding (${totalOutstanding}) + principal (${quotedPrincipal}) exceeds globalUsdcCap (${globalCap})`,
    });
  }
  if (oracleUsable && quotedPrincipal * 10_000n > effectiveValueUsdc * BigInt(allowedLtvBps)) {
    rejections.push({
      code: 'LTV_EXCEEDED',
      message: `Requested principal (${quotedPrincipal}) exceeds allowed ${allowedLtvBps} bps LTV against effective collateral value (${effectiveValueUsdc})`,
    });
  }

  // Fees & interest math matching FeeCollector.sol and LoanCore.sol
  const originationFee =
    quotedPrincipal > 0n && quotedPrincipal <= UINT128_MAX
      ? await rpcRead(
          () =>
            publicClient.readContract({
              address: config.feeCollector,
              abi: feeCollectorAbi,
              functionName: 'calculateOriginationFee',
              args: [quotedPrincipal],
              blockNumber,
            }),
          'feeCollector.calculateOriginationFee'
        )
      : quotedPrincipal > 0n
        ? ceilDiv(quotedPrincipal * BigInt(originationFeeBpsRaw), 10_000n)
        : 0n;
  const netProceeds = quotedPrincipal > originationFee ? quotedPrincipal - originationFee : 0n;

  const interestDenom = 10_000n * secondsPerYear;
  const maturityInterest =
    quotedPrincipal > 0n
      ? ceilDiv(quotedPrincipal * BigInt(input.aprBps) * BigInt(input.termDays) * 86_400n, interestDenom)
      : 0n;
  const minInterestFloor =
    quotedPrincipal > 0n
      ? ceilDiv(
          quotedPrincipal * BigInt(input.aprBps) * BigInt(input.minInterestDays) * 86_400n,
          interestDenom
        )
      : 0n;

  const protocolInterestCut =
    maturityInterest > 0n && maturityInterest <= UINT128_MAX
      ? await rpcRead(
          () =>
            publicClient.readContract({
              address: config.feeCollector,
              abi: feeCollectorAbi,
              functionName: 'calculateInterestCut',
              args: [maturityInterest],
              blockNumber,
            }),
          'feeCollector.calculateInterestCut'
        )
      : maturityInterest > 0n
        ? ceilDiv(maturityInterest * BigInt(interestCutBpsRaw), 10_000n)
        : 0n;
  const lenderNetInterest = maturityInterest - protocolInterestCut;
  const originationDebt = quotedPrincipal + minInterestFloor;
  const totalRepayment = quotedPrincipal + maturityInterest;

  // Risk metrics matching LoanCore.startLiquidation:
  // debt = principal + minInterestFloor (at origination) vs GROSS collateral value.
  const initialLtvBps =
    grossValueUsdc > 0n ? Number((originationDebt * 10_000n) / grossValueUsdc) : 0;
  const liqLtvBps = BigInt(cfg.liqLtvBps);
  const healthFactorRaw =
    originationDebt > 0n && grossValueUsdc > 0n
      ? (grossValueUsdc * liqLtvBps * 10n ** 14n) / originationDebt
      : 0n;

  const priceScale = 10n ** BigInt(tokenDecimals) * 10n ** BigInt(oracleDecimals);
  // First strictly non-liquidating price: ceil((floor(D * 1e4 / liq) + 1) * S / (c * 1e6))
  const liqPriceOrig = computeLiquidationPrice(originationDebt, liqLtvBps, collateralRequired, priceScale);
  const liqPriceMat = computeLiquidationPrice(totalRepayment, liqLtvBps, collateralRequired, priceScale);

  const globalRemaining = globalCap > totalOutstanding ? globalCap - totalOutstanding : 0n;
  const assetRemaining =
    cfg.assetCap > 0n ? (cfg.assetCap > assetOutstanding ? cfg.assetCap - assetOutstanding : 0n) : globalRemaining;

  return {
    accepted: rejections.length === 0,
    rejection_reasons: rejections,
    warnings,
    block_number: blockNumber.toString(),
    indexed_block_number: indexedBlockNumber,
    freshness_timestamp: freshnessTimestamp,
    asset: {
      token: input.asset,
      symbol: tokenSymbol,
      decimals: tokenDecimals,
      status: assetStatus,
      status_name: assetStatusName,
      restricted: cfg.restricted,
      oracle_state: oracleState,
      oracle_state_name: oracleStateName,
      oracle_price: formatAmount(oraclePrice, oracleDecimals, 'USD'),
      closed_market_haircut_bps: Number(cfg.closedMarketHaircutBps),
      max_init_ltv_bps: maxInitLtvBps,
      allowed_ltv_bps: allowedLtvBps,
      margin_call_ltv_bps: Number(cfg.marginCallLtvBps),
      liq_ltv_bps: Number(cfg.liqLtvBps),
      bad_debt_ltv_bps: Number(cfg.badDebtLtvBps),
      recorded_multiplier: formatAmount(recordedMultiplier, 18),
    },
    terms: {
      term_days: input.termDays,
      existing_elapsed_days: input.existingElapsedDays,
      total_term_days: totalTermDays,
      apr_bps: input.aprBps,
      min_interest_days: input.minInterestDays,
      yield_mode: 0,
    },
    amounts: {
      principal: formatAmount(quotedPrincipal, USDC_DECIMALS, 'USDC'),
      collateral_required: formatAmount(collateralRequired, tokenDecimals, tokenSymbol),
      collateral_gross_value_usdc: formatAmount(grossValueUsdc, USDC_DECIMALS, 'USDC'),
      collateral_effective_value_usdc: formatAmount(effectiveValueUsdc, USDC_DECIMALS, 'USDC'),
      origination_fee: formatAmount(originationFee, USDC_DECIMALS, 'USDC'),
      origination_fee_bps: Number(originationFeeBpsRaw),
      net_proceeds: formatAmount(netProceeds, USDC_DECIMALS, 'USDC'),
      interest_maturity: formatAmount(maturityInterest, USDC_DECIMALS, 'USDC'),
      min_interest_floor: formatAmount(minInterestFloor, USDC_DECIMALS, 'USDC'),
      origination_debt: formatAmount(originationDebt, USDC_DECIMALS, 'USDC'),
      protocol_interest_cut: formatAmount(protocolInterestCut, USDC_DECIMALS, 'USDC'),
      protocol_interest_cut_bps: Number(interestCutBpsRaw),
      lender_net_interest: formatAmount(lenderNetInterest, USDC_DECIMALS, 'USDC'),
      total_repayment_at_maturity: formatAmount(totalRepayment, USDC_DECIMALS, 'USDC'),
    },
    risk: {
      initial_ltv_bps: initialLtvBps,
      health_factor: formatRay18(healthFactorRaw),
      liquidation_price: formatAmount(liqPriceOrig, oracleDecimals, 'USD'),
      liquidation_price_at_origination: formatAmount(liqPriceOrig, oracleDecimals, 'USD'),
      liquidation_price_at_maturity: formatAmount(liqPriceMat, oracleDecimals, 'USD'),
      liquidation_fee_bps: Number(liquidationFeeBpsRaw),
      min_buy_usdc: formatAmount(minBuyUsdc, USDC_DECIMALS, 'USDC'),
    },
    caps: {
      global_usdc_cap: formatAmount(globalCap, USDC_DECIMALS, 'USDC'),
      total_outstanding_principal: formatAmount(totalOutstanding, USDC_DECIMALS, 'USDC'),
      global_remaining: formatAmount(globalRemaining, USDC_DECIMALS, 'USDC'),
      per_loan_cap: formatAmount(cfg.perLoanCap, USDC_DECIMALS, 'USDC'),
      asset_cap: formatAmount(cfg.assetCap, USDC_DECIMALS, 'USDC'),
      asset_outstanding_principal: formatAmount(assetOutstanding, USDC_DECIMALS, 'USDC'),
      asset_remaining: formatAmount(assetRemaining, USDC_DECIMALS, 'USDC'),
      protocol_paused: paused,
      eligibility_permissionless: permissionlessMode,
    },
  };
}
