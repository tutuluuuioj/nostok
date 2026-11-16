import { type Address, type Hex, getAddress, isAddress } from 'viem';
import { z } from 'zod';

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
  maker: checksumAddressSchema.optional(),
  asset: checksumAddressSchema.optional(),
});

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
