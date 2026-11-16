import { type Address, getAddress, isAddress } from 'viem';
import { z } from 'zod';

export const checksumAddressSchema = z
  .string()
  .trim()
  .refine((val) => isAddress(val) && getAddress(val) === val, {
    message: 'Address must be a valid EIP-55 checksummed hex address',
  })
  .transform((val) => val as Address);

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

export const riskLoansQuerySchema = z.object({
  status: z.enum(['healthy', 'margin_call', 'near_liquidation', 'liquidatable']).optional(),
  asset: checksumAddressSchema.optional(),
});

export const riskAlertsQuerySchema = z.object({
  severity: z.enum(['info', 'warning', 'critical', 'page']).optional(),
  status: z.enum(['active', 'resolved']).optional(),
  category: z.string().trim().min(1).max(64).optional(),
});
