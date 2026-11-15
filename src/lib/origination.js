import { valueCents } from './money.js';

export function newLoanBlock(asset) {
  if (!asset || !asset.launch) return 'That stock is not at launch.';
  if (asset.status === 'Frozen' || asset.state === 'FROZEN_CORPORATE_ACTION') {
    return `${asset.symbol} is frozen. New loans are closed. Repay and top-up stay open on existing loans.`;
  }
  if (asset.status === 'ReduceOnly') return `${asset.symbol} is reduce-only. New loans and rollovers are closed.`;
  if (asset.status === 'WindDown') return `${asset.symbol} is winding down. Open loans run to maturity.`;
  if (asset.state === 'STALE_FEED') return 'The oracle is stale. New loans are closed.';
  if (asset.state === 'INVALID_SEQUENCER') return 'The sequencer is down. New loans are closed.';
  if (asset.state === 'DISPUTED') return 'The oracle is disputed. New loans are closed.';
  return '';
}

export function priced(asset, tokenMicro) {
  const gross = valueCents(tokenMicro, asset.oracleCents);
  const haircut = asset.state === 'VALID_CLOSED' ? asset.haircutBps : 0;
  const effective = Number((BigInt(gross) * BigInt(10000 - haircut)) / 10000n);
  return { gross, effective, haircut };
}

export function ltvFits(principalCents, valueAmount, capBps) {
  if (valueAmount <= 0 || capBps <= 0) return false;
  return BigInt(principalCents) * 10000n <= BigInt(valueAmount) * BigInt(capBps);
}

export function assess({ asset, tokenMicro, principalCents, maxLtvBps }) {
  const empty = { ok: false, gross: 0, effective: 0, haircut: 0, capBps: 0 };
  const block = newLoanBlock(asset);
  if (block) return { ...empty, error: block };
  if (!Number.isInteger(principalCents) || principalCents < 50000) {
    return { ...empty, error: 'The minimum loan is $500.' };
  }
  if (principalCents > 1000000) {
    return { ...empty, error: 'Guarded launch caps a loan at $10,000.' };
  }
  const quote = priced(asset, tokenMicro);
  const capBps = Math.min(maxLtvBps, asset.maxInitLtvBps);
  if (!ltvFits(principalCents, quote.effective, capBps)) {
    const error = quote.haircut
      ? 'That loan is above the LTV cap after the closed-market haircut. Add collateral or borrow less.'
      : 'That loan is above the LTV cap. Add collateral or borrow less.';
    return { ok: false, error, ...quote, capBps };
  }
  return { ok: true, error: '', ...quote, capBps };
}
