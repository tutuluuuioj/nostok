import { ASSETS, CLOCK } from './data.js';
import { formatLeft } from './format.js';
import { liveInterestCents, valueCents } from './money.js';

export function phaseOf(loan, now = CLOCK) {
  if (loan.status === 'Repaid' || loan.status === 'Settled' || loan.status === 'Auction') return loan.status;
  if (now < loan.maturity) return 'Active';
  if (now <= loan.maturity + 86400000) return 'Grace';
  return 'PastGrace';
}

export function health(loan, now = CLOCK) {
  const asset = ASSETS[loan.asset];
  const phase = phaseOf(loan, now);
  const remaining = Math.max(0, loan.principalCents - loan.repaidPrincipalCents);
  const closed = phase === 'Repaid' || phase === 'Settled' || remaining <= 0;
  const interest = closed ? 0 : liveInterestCents(loan, now);
  const debt = remaining + interest;
  const oracleValue = asset ? valueCents(loan.tokenMicro, asset.oracleCents) : 0;
  const marketValue = asset?.marketCents ? valueCents(loan.tokenMicro, asset.marketCents) : 0;
  const margin = !closed && oracleValue > 0 && debt * 10000 >= oracleValue * loan.marginBps;
  const atLiq = !closed && oracleValue > 0 && debt * 10000 >= oracleValue * loan.liqBps;
  return { asset, phase, remaining, interest, debt, oracleValue, marketValue, margin, atLiq, closed };
}

export function releaseTokens(loan, portion, now = CLOCK) {
  const asset = ASSETS[loan.asset];
  const remaining = loan.principalCents - loan.repaidPrincipalCents;
  if (portion >= remaining) return { tokens: loan.tokenMicro, capped: false };
  const left = remaining - portion;
  const leftInterest = liveInterestCents(loan, now, left);
  const debt = left + leftInterest;
  const proRata = Number((BigInt(loan.tokenMicro) * BigInt(portion)) / BigInt(remaining));
  const tokensLeft = loan.tokenMicro - proRata;
  const valueLeft = valueCents(tokensLeft, asset.oracleCents);
  const init = loan.initLtvBps;
  if (init > 0 && valueLeft > 0 && debt * 10000 <= valueLeft * init) {
    return { tokens: proRata, capped: false };
  }
  if (!init) return { tokens: 0, capped: true };
  const valueNeeded = Number((BigInt(debt) * 10000n + BigInt(init) - 1n) / BigInt(init));
  const keep = Number((BigInt(valueNeeded) * 1000000n + BigInt(asset.oracleCents) - 1n) / BigInt(asset.oracleCents));
  const release = Math.max(0, Math.min(proRata, loan.tokenMicro - keep));
  return { tokens: release, capped: true };
}

export function buildAlerts(state, now = CLOCK) {
  const items = [];
  for (const loan of state.loans) {
    if (loan.borrower !== 'you' && loan.lender !== 'you') continue;
    const view = health(loan, now);
    if (view.closed) continue;
    const asset = view.asset;
    const frozen = asset && (asset.status === 'Frozen' || asset.state === 'FROZEN_CORPORATE_ACTION');
    if (frozen) {
      items.push({
        id: `freeze-${loan.id}`,
        href: `/loans/${loan.id}`,
        title: `${asset.symbol} is frozen`,
        body: 'Repay and top-up stay open. Default and liquidation clocks are paused.',
      });
    }
    if (view.phase === 'Grace') {
      items.push({
        id: `grace-${loan.id}`,
        href: `/loans/${loan.id}`,
        title: `Grace ends in ${formatLeft(loan.maturity + 86400000 - now)}`,
        body: `${loan.asset} loan ${loan.id} can still be repaid. Penalty interest is accruing.`,
      });
    } else if (view.phase === 'Auction') {
      items.push({
        id: `auction-${loan.id}`,
        href: `/loans/${loan.id}`,
        title: `Auction on loan ${loan.id}`,
        body: 'The claim cannot be transferred while the auction runs. Surplus returns to the borrower.',
      });
    } else if (view.phase === 'Active' && view.margin && !frozen) {
      const closed = asset.state === 'VALID_CLOSED';
      items.push({
        id: `margin-${loan.id}`,
        href: `/loans/${loan.id}`,
        title: `Margin call on ${loan.asset}`,
        body: closed
          ? 'Oracle LTV is at the margin level. Liquidation cannot start while the market is closed. Add collateral or repay.'
          : 'Oracle LTV is at the margin level. Add collateral or repay.',
      });
    } else if (view.phase === 'Active' && !frozen) {
      const left = loan.maturity - now;
      if (left > 0 && left <= 72 * 3600000) {
        items.push({
          id: `due-${loan.id}`,
          href: `/loans/${loan.id}`,
          title: `${loan.asset} matures in ${formatLeft(left)}`,
          body: 'Repay by maturity, or agree an extension with the holder of the Position NFT.',
        });
      }
    }
  }
  return items.filter((item) => !state.dismissed.includes(item.id));
}

export function bookStats(loans) {
  const live = loans.filter((loan) => {
    const view = health(loan);
    return !view.closed;
  });
  const outstanding = live.reduce((sum, loan) => sum + (loan.principalCents - loan.repaidPrincipalCents), 0);
  const originated = loans.reduce((sum, loan) => sum + loan.principalCents, 0);
  const weighted = live.reduce((sum, loan) => sum + (loan.principalCents - loan.repaidPrincipalCents) * loan.rateBps, 0);
  return {
    outstanding,
    originated,
    live: live.length,
    margin: live.filter((loan) => health(loan).margin).length,
    grace: live.filter((loan) => health(loan).phase === 'Grace').length,
    auction: live.filter((loan) => health(loan).phase === 'Auction').length,
    averageBps: outstanding > 0 ? Math.round(weighted / outstanding) : 0,
  };
}
