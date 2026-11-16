import { type Address, getAddress, isAddress } from 'viem';
import { z } from 'zod/v3';

export const ALL_ALERT_TYPES = [
  'loan_margin_call',
  'loan_near_liquidation',
  'liquidation_started',
  'auction_bid',
  'auction_settled',
  'auction_cancelled',
  'maturity_reminder_3d',
  'maturity_reminder_1d',
  'maturity_reminder_6h',
  'loan_grace_entry',
  'penalty_interest_accruing',
  'default_auction_pending',
  'loan_repaid',
  'lender_claimable',
  'asset_frozen_or_corporate_action',
  'oracle_stale',
] as const;

export type AlertType = (typeof ALL_ALERT_TYPES)[number];

export const checksumAddressSchema = z
  .string()
  .trim()
  .refine((val) => isAddress(val) && getAddress(val) === val, {
    message: 'Address must be a valid EIP-55 checksummed hex address',
  })
  .transform((val) => val as Address);

export const nonceRequestSchema = z.object({
  wallet_address: checksumAddressSchema,
});

export const siweVerifyRequestSchema = z.object({
  message: z.string().min(20).max(4096),
  signature: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]+$/, 'Signature must be 0x-prefixed hex'),
});

export const createSubscriptionSchema = z.object({
  channel: z.enum(['email', 'telegram', 'webhook']),
  target: z.string().trim().min(3).max(512),
});

export const updatePreferencesSchema = z
  .object({
    alert_types: z
      .record(z.enum(ALL_ALERT_TYPES), z.boolean())
      .optional(),
    quiet_hours_start: z.number().int().min(0).max(23).nullable().optional(),
    quiet_hours_end: z.number().int().min(0).max(23).nullable().optional(),
    max_per_hour: z.number().int().min(1).max(500).optional(),
  })
  .superRefine((val, ctx) => {
    const hasStart = val.quiet_hours_start !== undefined && val.quiet_hours_start !== null;
    const hasEnd = val.quiet_hours_end !== undefined && val.quiet_hours_end !== null;
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'quiet_hours_start and quiet_hours_end must both be set or both null',
      });
    }
  });

export const unsubscribeBodySchema = z.object({
  token: z.string().trim().min(10).max(2048),
});

export const confirmSubscriptionSchema = z.union([
  z.object({
    token: z.string().trim().min(10).max(2048),
  }),
  z.object({
    subscription_id: z.string().trim().min(4).max(128),
    code: z.string().trim().regex(/^\d{6}$/, 'Verification code must be 6 digits'),
  }),
]);

export function buildPaginationSchema(maxLimit: number) {
  return z
    .object({
      limit: z.coerce
        .number()
        .int('limit must be an integer')
        .min(1)
        .max(maxLimit)
        .default(20),
      offset: z.coerce
        .number()
        .int('offset must be an integer')
        .min(0)
        .max(1_000_000)
        .optional(),
      cursor: z.string().trim().regex(/^\d+$/).optional(),
    })
    .superRefine((val, ctx) => {
      if (val.offset !== undefined && val.cursor !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Specify either offset or cursor, not both',
        });
      }
    })
    .transform((val) => ({
      limit: val.limit,
      offset: val.offset ?? (val.cursor !== undefined ? Number(val.cursor) : 0),
    }));
}

export const redriveDeadLettersSchema = z.object({
  dead_letter_ids: z.array(z.string().trim().min(4).max(128)).max(100).optional(),
  delivery_ids: z.array(z.string().trim().min(4).max(128)).max(100).optional(),
  wallet: checksumAddressSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
