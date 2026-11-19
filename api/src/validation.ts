import { type Address, type Hex, getAddress, isAddress, zeroAddress } from 'viem';
import { z } from 'zod/v3';

/**
 * Zod validator requiring strictly EIP-55 checksummed EVM addresses.
 */
export const checksumAddressSchema = z
  .string()
  .trim()
  .refine((val) => isAddress(val) && getAddress(val) === val, {
    message: 'Address must be a valid EIP-55 checksummed hex address',
  })
  .transform((val) => val as Address);

export function safeParseBigInt(val: string): bigint | null {
  try {
    return BigInt(val);
  } catch {
    return null;
  }
}

export const unsignedBigIntStringSchema = z
  .string({
    invalid_type_error: 'Amount must be provided as a decimal string',
  })
  .trim()
  .regex(/^\d+$/, 'Must be a non-negative base-10 integer string')
  .refine((val) => val.length <= 78, 'Integer string exceeds uint256 width')
  .refine((val) => {
    const parsed = safeParseBigInt(val);
    return parsed !== null && parsed >= 0n;
  }, 'Invalid integer value');

export const positiveBigIntStringSchema = unsignedBigIntStringSchema.refine((val) => {
  const parsed = safeParseBigInt(val);
  return parsed !== null && parsed > 0n;
}, 'Amount must be greater than zero');

export const hexBytesSchema = z
  .string()
  .trim()
  .regex(/^0x([0-9a-fA-F]{2})*$/, 'Attestation must be an even-length 0x hex string')
  .refine((val) => val.length <= 4098, 'Attestation hex payload too large')
  .transform((val) => val.toLowerCase() as Hex);

export function buildPaginationSchema(maxLimit: number) {
  return z
    .object({
      limit: z.coerce
        .number()
        .int('limit must be an integer')
        .min(1, 'limit must be >= 1')
        .max(maxLimit, `limit must be <= ${maxLimit}`)
        .default(20),
      offset: z.coerce
        .number()
        .int('offset must be an integer')
        .min(0, 'offset must be >= 0')
        .max(1_000_000, 'offset too large')
        .optional(),
      cursor: z
        .string()
        .trim()
        .regex(/^\d+$/, 'cursor must be a non-negative integer offset')
        .optional(),
    })
    .superRefine((val, ctx) => {
      if (val.offset !== undefined && val.cursor !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Specify either offset or cursor, not both',
        });
      }
      if (val.cursor !== undefined) {
        const parsed = Number(val.cursor);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'cursor out of range',
          });
        }
      }
    })
    .transform((val) => ({
      limit: val.limit,
      offset: val.offset ?? (val.cursor !== undefined ? Number(val.cursor) : 0),
    }));
}

export const ordersQuerySchema = z.object({
  status: z.enum(['cancelled', 'partially_filled', 'filled', 'unknown']).optional(),
  order_hash: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'order_hash must be a 32-byte 0x hex string')
    .transform((v) => v.toLowerCase())
    .optional(),
  maker: checksumAddressSchema.optional(),
  asset: checksumAddressSchema.optional(),
  order_type: z.enum(['borrow', 'lend']).optional(),
  include_inactive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  exclude_final: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const addressLikeSchema = z
  .string()
  .trim()
  .refine((val) => isAddress(val), {
    message: 'Invalid EVM address',
  })
  .transform((val) => getAddress(val));

const uintStringOrSafeIntSchema = z.union([
  unsignedBigIntStringSchema,
  z
    .number()
    .int()
    .nonnegative()
    .refine((n) => Number.isSafeInteger(n), 'Integer exceeds MAX_SAFE_INTEGER')
    .transform((n) => String(n)),
]);

const positiveUintStringOrSafeIntSchema = uintStringOrSafeIntSchema.refine((val) => {
  const parsed = safeParseBigInt(val);
  return parsed !== null && parsed > 0n;
}, 'Amount must be greater than zero');

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MIN_PRINCIPAL_USDC = 500_000_000n;
export const MAX_ORDER_EXPIRY_SECS = 30n * 86_400n;

const orderExpiryStringSchema = positiveUintStringOrSafeIntSchema
  .refine((val) => {
    const parsed = safeParseBigInt(val);
    return parsed !== null && parsed > 0n && parsed <= MAX_UINT64;
  }, 'Order expiry exceeds uint64 bounds')
  .refine((val) => {
    const parsed = safeParseBigInt(val);
    const maxWallClockExpiry = BigInt(Math.floor(Date.now() / 1000)) + 365n * 86_400n;
    return parsed !== null && parsed <= maxWallClockExpiry;
  }, 'Order expiry is too far in the future (max 30 days on-chain)');

const positiveUint128StringOrSafeIntSchema = positiveUintStringOrSafeIntSchema.refine((val) => {
  const parsed = safeParseBigInt(val);
  return parsed !== null && parsed > 0n && parsed <= MAX_UINT128;
}, 'Amount exceeds uint128 bounds');

const principalUsdcStringOrSafeIntSchema = positiveUint128StringOrSafeIntSchema.refine((val) => {
  const parsed = safeParseBigInt(val);
  return parsed !== null && parsed >= MIN_PRINCIPAL_USDC;
}, 'USDC principal / minFill must be at least $500.00 (500000000 raw USDC)');

export const borrowOrderPayloadSchema = z.object({
  borrower: addressLikeSchema,
  collateralToken: addressLikeSchema,
  collateralAmount: positiveUint128StringOrSafeIntSchema,
  minUsdc: principalUsdcStringOrSafeIntSchema,
  maxRateBps: z.coerce.number().int().min(0, 'maxRateBps must be >= 0').max(4000, 'maxRateBps cannot exceed 4000 (40.00% APR)'),
  termDays: z.coerce.number().int().min(7, 'termDays must be between 7 and 90').max(90, 'termDays must be between 7 and 90'),
  maxLtvBps: z.coerce.number().int().min(100, 'maxLtvBps must be >= 100').max(9000, 'maxLtvBps cannot exceed 9000'),
  minFill: principalUsdcStringOrSafeIntSchema,
  expiry: orderExpiryStringSchema,
  nonce: uintStringOrSafeIntSchema,
  yieldMode: z.coerce.number().int().min(0).max(255).default(0),
  allowInKindSettlement: z.boolean().default(false),
});

export const lendOfferPayloadSchema = z.object({
  lender: addressLikeSchema,
  usdcAmount: principalUsdcStringOrSafeIntSchema,
  minRateBps: z.coerce.number().int().min(0, 'minRateBps must be >= 0').max(4000, 'minRateBps cannot exceed 4000 (40.00% APR)'),
  termDays: z.coerce.number().int().min(7, 'termDays must be between 7 and 90').max(90, 'termDays must be between 7 and 90'),
  allowedCollateral: addressLikeSchema,
  maxLtvBps: z.coerce.number().int().min(100, 'maxLtvBps must be >= 100').max(9000, 'maxLtvBps cannot exceed 9000'),
  minFill: principalUsdcStringOrSafeIntSchema,
  expiry: orderExpiryStringSchema,
  nonce: uintStringOrSafeIntSchema,
  yieldMode: z.coerce.number().int().min(0).max(255).default(0),
});

export const postOrderSchema = z.discriminatedUnion('order_type', [
  z.object({
    order_type: z.literal('borrow'),
    order: borrowOrderPayloadSchema,
    signature: z
      .string()
      .trim()
      .regex(/^0x[0-9a-fA-F]{130,}$/, 'Signature must be a valid 0x-prefixed hex string'),
  }),
  z.object({
    order_type: z.literal('lend'),
    order: lendOfferPayloadSchema,
    signature: z
      .string()
      .trim()
      .regex(/^0x[0-9a-fA-F]{130,}$/, 'Signature must be a valid 0x-prefixed hex string'),
  }),
]);

const LOAN_STATUS_MAP: Record<string, number> = {
  '0': 0,
  active: 0,
  '1': 1,
  grace: 1,
  '2': 2,
  auction: 2,
  '3': 3,
  repaid: 3,
  '4': 4,
  settleddefault: 4,
  settled_default: 4,
  '5': 5,
  settledliquidated: 5,
  settled_liquidated: 5,
};

export const loansQuerySchema = z.object({
  borrower: checksumAddressSchema.optional(),
  lender: checksumAddressSchema.optional(),
  asset: checksumAddressSchema.optional(),
  status: z
    .string()
    .trim()
    .transform((s) => s.toLowerCase())
    .refine((s) => s in LOAN_STATUS_MAP, {
      message: 'status must be Active(0), Grace(1), Auction(2), Repaid(3), SettledDefault(4), or SettledLiquidated(5)',
    })
    .transform((s) => LOAN_STATUS_MAP[s])
    .optional(),
});

const boolQuerySchema = z.enum(['true', 'false']).transform((v) => v === 'true');

export const positionsQuerySchema = z.object({
  owner: checksumAddressSchema.optional(),
  auction_locked: boolQuerySchema.optional(),
  burned: boolQuerySchema.optional(),
});

const AUCTION_STATUS_MAP: Record<string, number> = {
  '0': 0,
  active: 0,
  '1': 1,
  settled: 1,
  '2': 2,
  cancelled: 2,
};

export const auctionsQuerySchema = z.object({
  status: z
    .string()
    .trim()
    .transform((s) => s.toLowerCase())
    .refine((s) => s in AUCTION_STATUS_MAP, {
      message: 'status must be active(0), settled(1), or cancelled(2)',
    })
    .transform((s) => AUCTION_STATUS_MAP[s])
    .optional(),
  loan: positiveBigIntStringSchema.optional(),
  loan_id: positiveBigIntStringSchema.optional(),
});

const ASSET_STATUS_MAP: Record<string, number> = {
  '0': 0,
  active: 0,
  '1': 1,
  reduceonly: 1,
  reduce_only: 1,
  '2': 2,
  winddown: 2,
  wind_down: 2,
  '3': 3,
  frozen: 3,
};

export const assetsQuerySchema = z.object({
  status: z
    .string()
    .trim()
    .transform((s) => s.toLowerCase())
    .refine((s) => s in ASSET_STATUS_MAP, {
      message: 'status must be Active(0), ReduceOnly(1), WindDown(2), or Frozen(3)',
    })
    .transform((s) => ASSET_STATUS_MAP[s])
    .optional(),
  asset: checksumAddressSchema.optional(),
  token: checksumAddressSchema.optional(),
});

export const quoteRequestSchema = z
  .object({
    asset: checksumAddressSchema,
    collateral_amount: positiveBigIntStringSchema.optional(),
    collateralAmount: positiveBigIntStringSchema.optional(),
    principal: positiveBigIntStringSchema.optional(),
    term_days: z.coerce.number().int('term_days must be an integer').min(1, 'term_days must be >= 1').max(3650).optional(),
    termDays: z.coerce.number().int('termDays must be an integer').min(1, 'termDays must be >= 1').max(3650).optional(),
    apr_bps: z.coerce.number().int('apr_bps must be an integer').min(0, 'apr_bps must be >= 0').max(100_000).optional(),
    aprBps: z.coerce.number().int('aprBps must be an integer').min(0, 'aprBps must be >= 0').max(100_000).optional(),
    max_ltv_bps: z.coerce.number().int('max_ltv_bps must be an integer').min(1).max(10_000).optional(),
    maxLtvBps: z.coerce.number().int('maxLtvBps must be an integer').min(1).max(10_000).optional(),
    min_interest_days: z.coerce.number().int().min(0).max(365).optional(),
    minInterestDays: z.coerce.number().int().min(0).max(365).optional(),
    existing_elapsed_days: z.coerce.number().int().min(0).max(3650).optional(),
    existingElapsedDays: z.coerce.number().int().min(0).max(3650).optional(),
    borrower: checksumAddressSchema.optional(),
    lender: checksumAddressSchema.optional(),
    borrower_attestation: hexBytesSchema.optional(),
    borrowerAttestation: hexBytesSchema.optional(),
    lender_attestation: hexBytesSchema.optional(),
    lenderAttestation: hexBytesSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const col = val.collateral_amount ?? val.collateralAmount;
    const prin = val.principal;
    if (col === undefined && prin === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either collateral_amount or principal must be provided as a decimal string',
      });
    }
    if (val.term_days === undefined && val.termDays === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'term_days is required',
      });
    }
    if (val.apr_bps === undefined && val.aprBps === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'apr_bps is required',
      });
    }
    if (col !== undefined && safeParseBigInt(col) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid collateral_amount integer string',
      });
    }
    if (prin !== undefined && safeParseBigInt(prin) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid principal integer string',
      });
    }
  })
  .transform((val) => {
    const colStr = val.collateral_amount ?? val.collateralAmount;
    const collateralAmount = colStr !== undefined ? (safeParseBigInt(colStr) ?? 0n) : undefined;
    const principal = val.principal !== undefined ? (safeParseBigInt(val.principal) ?? 0n) : undefined;
    return {
      asset: val.asset,
      collateralAmount,
      principal,
      termDays: (val.term_days ?? val.termDays)!,
      aprBps: (val.apr_bps ?? val.aprBps)!,
      maxLtvBps: val.max_ltv_bps ?? val.maxLtvBps,
      minInterestDays: val.min_interest_days ?? val.minInterestDays ?? 3,
      existingElapsedDays: val.existing_elapsed_days ?? val.existingElapsedDays ?? 0,
      borrower: val.borrower,
      lender: val.lender,
      borrowerAttestation: (val.borrower_attestation ?? val.borrowerAttestation ?? '0x') as Hex,
      lenderAttestation: (val.lender_attestation ?? val.lenderAttestation ?? '0x') as Hex,
    };
  });

export type QuoteInput = z.infer<typeof quoteRequestSchema>;

const nonZeroChecksumAddressSchema = checksumAddressSchema.refine(
  (addr) => addr.toLowerCase() !== zeroAddress,
  'Zero address is not allowed for eligibility screening'
);

export const eligibilityQuerySchema = z
  .object({
    account: nonZeroChecksumAddressSchema.optional(),
    attestation: hexBytesSchema.optional(),
  })
  .transform((val) => ({
    account: val.account,
    attestation: (val.attestation ?? '0x') as Hex,
  }));

export const eligibilityDeclarationSchema = z
  .object({
    account: nonZeroChecksumAddressSchema,
    nonce: unsignedBigIntStringSchema,
    issuedAt: unsignedBigIntStringSchema,
    expiresAt: positiveBigIntStringSchema,
    jurisdiction: z
      .string()
      .trim()
      .regex(/^(?:[A-Za-z]{2}|NON_US_SELF_DECLARED)$/, 'jurisdiction must be an ISO-3166 alpha-2 code or NON_US_SELF_DECLARED')
      .transform((v) => v.toUpperCase()),
    statementHash: z
      .string()
      .trim()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'statementHash must be a 32-byte 0x hex string')
      .transform((v) => v.toLowerCase() as Hex),
  })
  .strict();

export const eligibilityVerifyBodySchema = z
  .object({
    declaration: eligibilityDeclarationSchema,
    signature: hexBytesSchema.refine(
      (s) => s.length >= 132,
      'signature must be at least 65 bytes (0x + 130 hex chars)'
    ),
    attestation: hexBytesSchema.optional(),
  })
  .strict()
  .transform((val) => ({
    declaration: val.declaration,
    signature: val.signature,
    attestation: (val.attestation ?? '0x') as Hex,
  }));
