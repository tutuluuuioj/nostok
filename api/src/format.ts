import { formatUnits } from 'viem';

export interface FormattedAmount {
  raw: string;
  formatted: string;
  decimals: number;
  symbol?: string;
}

/**
 * Formats integer raw token/USDC/USD values using viem's exact bigint string formatter.
 * Never converts monetary amounts to JS floating point.
 */
export function formatAmount(raw: bigint, decimals: number, symbol?: string): FormattedAmount {
  return {
    raw: raw.toString(),
    formatted: formatUnits(raw, decimals),
    decimals,
    ...(symbol !== undefined ? { symbol } : {}),
  };
}

export function formatRawString(rawValue: string | number | bigint, decimals: number, symbol?: string): FormattedAmount {
  const raw = BigInt(rawValue);
  return formatAmount(raw, decimals, symbol);
}

/**
 * Formats an unsigned 1e18 fixed-point ratio (e.g. health factor or multiplier) into decimal string.
 */
export function formatRay18(raw: bigint): { raw: string; formatted: string; decimals: number } {
  return {
    raw: raw.toString(),
    formatted: formatUnits(raw, 18),
    decimals: 18,
  };
}

/**
 * Integer ceiling division for positive bigints: ceil(a / b).
 */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('Division by non-positive integer');
  if (a === 0n) return 0n;
  return (a + b - 1n) / b;
}
