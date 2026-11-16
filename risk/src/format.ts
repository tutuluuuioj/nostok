import { formatUnits } from 'viem';

export interface FormattedAmount {
  raw: string;
  formatted: string;
  decimals: number;
  symbol?: string;
}

export function formatAmount(raw: bigint, decimals: number, symbol?: string): FormattedAmount {
  return {
    raw: raw.toString(),
    formatted: formatUnits(raw, decimals),
    decimals,
    ...(symbol !== undefined ? { symbol } : {}),
  };
}

export function formatRay18(raw: bigint): { raw: string; formatted: string; decimals: number } {
  return {
    raw: raw.toString(),
    formatted: formatUnits(raw, 18),
    decimals: 18,
  };
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('Division by non-positive integer');
  if (a === 0n) return 0n;
  return (a + b - 1n) / b;
}
