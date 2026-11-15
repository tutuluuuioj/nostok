const DEN = 10000n * 365n * 86400n;

function raw(principalCents, rateBps, seconds) {
  const sec = Math.floor(seconds);
  if (principalCents <= 0 || rateBps <= 0 || sec <= 0) return 0n;
  return BigInt(principalCents) * BigInt(rateBps) * BigInt(sec);
}

function fromRaw(n) {
  if (n <= 0n) return 0;
  return Number((n + DEN - 1n) / DEN);
}

export function interestCents(principalCents, rateBps, seconds) {
  return fromRaw(raw(principalCents, rateBps, seconds));
}

export function originationCents(principalCents) {
  if (principalCents <= 0) return 0;
  return Number((BigInt(principalCents) * 10n + 9999n) / 10000n);
}

export function interestCutCents(interest) {
  if (interest <= 0) return 0;
  return Number((BigInt(interest) * 1000n + 9999n) / 10000n);
}

export function positionFeeCents(priceCents) {
  if (priceCents <= 0) return 0;
  return Number((BigInt(priceCents) * 25n + 9999n) / 10000n);
}

export function valueCents(tokenMicro, priceCents) {
  if (tokenMicro <= 0 || priceCents <= 0) return 0;
  return Number((BigInt(tokenMicro) * BigInt(priceCents)) / 1000000n);
}

export function tokensForValue(valueAmount, priceCents) {
  if (valueAmount <= 0 || priceCents <= 0) return 0;
  return Number((BigInt(valueAmount) * 1000000n + BigInt(priceCents) - 1n) / BigInt(priceCents));
}

export function effectiveHundredths(numerCents, denomCents, days) {
  if (denomCents <= 0 || days <= 0) return null;
  const den = BigInt(denomCents) * BigInt(days);
  const num = BigInt(numerCents) * 365n * 10000n + den / 2n;
  return Number(num / den);
}

export function termSheet({ principalCents, rateBps, termDays }) {
  const interest = interestCents(principalCents, rateBps, termDays * 86400);
  const fee = originationCents(principalCents);
  const proceeds = principalCents - fee;
  const repay = principalCents + interest;
  const cut = interestCutCents(interest);
  const holderInterest = interest - cut;
  return {
    interest,
    fee,
    proceeds,
    repay,
    cut,
    holderInterest,
    holder: principalCents + holderInterest,
    borrowerApr: proceeds > 0 ? effectiveHundredths(interest + fee, proceeds, termDays) : null,
    lenderApr: principalCents > 0 ? effectiveHundredths(holderInterest, principalCents, termDays) : null,
  };
}

function termSeconds(loan) {
  return Math.max(0, Math.floor((loan.maturity - loan.accrueFrom) / 1000));
}

export function liveInterestCents(loan, now, principalOverride) {
  const principal = principalOverride ?? (loan.principalCents - loan.repaidPrincipalCents);
  if (principal <= 0) return 0;
  const term = termSeconds(loan);
  if (now <= loan.maturity) {
    const elapsed = Math.max(0, Math.floor((now - loan.accrueFrom) / 1000));
    return fromRaw(raw(principal, loan.rateBps, Math.min(elapsed, term)));
  }
  const grace = Math.min(86400, Math.max(0, Math.floor((now - loan.maturity) / 1000)));
  return fromRaw(
    raw(principal, loan.rateBps, term) +
      raw(principal, loan.rateBps + loan.penaltySpreadBps, grace),
  );
}

export function dueInterestCents(loan, now, portion) {
  const remaining = loan.principalCents - loan.repaidPrincipalCents;
  const part = Math.min(Math.max(portion, 0), remaining);
  if (part <= 0) return 0;
  const term = termSeconds(loan);
  if (now <= loan.maturity) {
    const elapsed = Math.max(0, Math.floor((now - loan.accrueFrom) / 1000));
    let n = raw(part, loan.rateBps, Math.min(elapsed, term));
    const minN = raw(part, loan.rateBps, Math.min(loan.minInterestDays * 86400, term));
    if (minN > n) n = minN;
    const termN = raw(part, loan.rateBps, term);
    if (n > termN) n = termN;
    return fromRaw(n);
  }
  const grace = Math.min(86400, Math.max(0, Math.floor((now - loan.maturity) / 1000)));
  return fromRaw(
    raw(part, loan.rateBps, term) +
      raw(part, loan.rateBps + loan.penaltySpreadBps, grace),
  );
}

export function auctionPriceCents(oracleCents, maxDiscountBps, elapsedSeconds) {
  const windowSecs = 30 * 60;
  const t = Math.min(windowSecs, Math.max(0, elapsedSeconds));
  const off = Math.round(100 + (maxDiscountBps - 100) * (t / windowSecs));
  return {
    offBps: off,
    priceCents: Number((BigInt(oracleCents) * BigInt(10000 - off)) / 10000n),
  };
}
