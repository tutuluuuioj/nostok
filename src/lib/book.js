import {
  ASSETS,
  CLOCK,
  DAY,
  YOU,
  seedClaims,
  seedListings,
  seedLoans,
  seedOrders,
} from './data.js';
import { formatTokens, formatUsd } from './format.js';
import { health, phaseOf, releaseTokens } from './health.js';
import {
  dueInterestCents,
  interestCutCents,
  liveInterestCents,
  positionFeeCents,
  valueCents,
} from './money.js';
import { assess, ltvFits, newLoanBlock } from './origination.js';

export function freshState() {
  return {
    v: 2,
    gate: 'pending',
    orders: seedOrders(),
    loans: seedLoans(),
    listings: seedListings(),
    claims: seedClaims(),
    dismissed: [],
    nextId: 4000,
    notice: '',
    error: '',
    lastLoanId: '',
  };
}

export function records(state) {
  return {
    note: 'NOSTOK preview records. Not a mainnet export. The preview clock is 15 Nov 2026, 12:00 Asia/Dhaka.',
    orders: state.orders,
    loans: state.loans,
    listings: state.listings,
    claims: state.claims,
  };
}

function fail(state, error) {
  return { ...state, error, notice: '' };
}

function succeed(state, patch, notice) {
  return { ...state, ...patch, notice, error: '' };
}

function makeLoan(state, fields) {
  const asset = ASSETS[fields.asset];
  const start = CLOCK;
  return {
    id: String(state.nextId),
    borrower: fields.borrower,
    lender: fields.lender,
    asset: fields.asset,
    tokenMicro: fields.tokenMicro,
    principalCents: fields.principalCents,
    repaidPrincipalCents: 0,
    rateBps: fields.rateBps,
    penaltySpreadBps: 500,
    minInterestDays: 3,
    termDays: fields.termDays,
    start,
    maturity: start + fields.termDays * DAY,
    accrueFrom: start,
    status: 'Active',
    initLtvBps: fields.initLtvBps,
    marginBps: asset.marginBps,
    liqBps: asset.liqBps,
    inKind: Boolean(fields.inKind),
    yieldMode: fields.yieldMode === 'lender' ? 'lender' : 'none',
    auctionStarted: null,
    lifetimeInterestCents: 0,
  };
}

function checkOrderTerms(action, kind) {
  if (!Number.isInteger(action.rateBps) || action.rateBps < 0 || action.rateBps > 4000) {
    return 'The rate has to be between 0% and 40% APR.';
  }
  if (!Number.isInteger(action.termDays) || action.termDays < 7 || action.termDays > 90) {
    return 'The term has to be 7 to 90 days.';
  }
  if (!Number.isInteger(action.usdcCents) || action.usdcCents < 50000) return 'The minimum loan is $500.';
  if (kind === 'borrow' && action.usdcCents > 1000000) return 'Guarded launch caps a loan at $10,000.';
  if (kind === 'lend' && action.usdcCents > 10000000) return 'An offer in this preview stops at $100,000.';
  if (!Number.isInteger(action.minFillCents) || action.minFillCents < 50000) return 'The minimum fill is $500.';
  if (action.minFillCents > action.usdcCents) return 'The minimum fill cannot be larger than the order.';
  if (!Number.isInteger(action.expiryDays) || action.expiryDays < 1 || action.expiryDays > 30) {
    return 'Expiry has to be 1 to 30 days.';
  }
  return '';
}

function placeBorrow(state, action) {
  if (!action.eligible) return fail(state, 'Confirm that you are still eligible to hold this stock.');
  const asset = ASSETS[action.asset];
  const problem = checkOrderTerms(action, 'borrow');
  if (problem) return fail(state, problem);
  if (!Number.isInteger(action.maxLtvBps) || action.maxLtvBps < 100 || action.maxLtvBps > 10000) {
    return fail(state, 'Enter a maximum LTV.');
  }
  const check = assess({
    asset,
    tokenMicro: action.tokenMicro,
    principalCents: action.usdcCents,
    maxLtvBps: action.maxLtvBps,
  });
  if (!check.ok) return fail(state, check.error);
  const id = `b${state.nextId}`;
  const order = {
    id,
    side: 'borrow',
    maker: YOU,
    asset: asset.symbol,
    assets: [asset.symbol],
    tokenMicro: action.tokenMicro,
    remainingTokenMicro: action.tokenMicro,
    usdcCents: action.usdcCents,
    remainingCents: action.usdcCents,
    rateBps: action.rateBps,
    termDays: action.termDays,
    maxLtvBps: action.maxLtvBps,
    minFillCents: action.minFillCents,
    expiry: CLOCK + action.expiryDays * DAY,
    inKind: Boolean(action.inKind),
    yieldMode: action.yieldOn ? 'lender' : 'none',
    status: 'open',
  };
  return succeed(
    state,
    { orders: [order, ...state.orders], nextId: state.nextId + 1, lastLoanId: '' },
    'Borrow order posted. Your stock stays in your wallet until someone fills it.',
  );
}

function placeLend(state, action) {
  if (!action.eligible) return fail(state, 'Confirm that you are eligible to lend and to hold a Position NFT.');
  const problem = checkOrderTerms(action, 'lend');
  if (problem) return fail(state, problem);
  const assets = Array.isArray(action.assets) ? action.assets : [];
  if (assets.length === 0) return fail(state, 'Choose at least one stock.');
  for (const symbol of assets) {
    const block = newLoanBlock(ASSETS[symbol]);
    if (block) return fail(state, block);
  }
  const cap = Math.min(...assets.map((symbol) => ASSETS[symbol].maxInitLtvBps));
  if (!Number.isInteger(action.maxLtvBps) || action.maxLtvBps < 100) return fail(state, 'Enter a maximum LTV.');
  if (action.maxLtvBps > cap) return fail(state, 'The maximum LTV cannot be above the asset cap.');
  const id = `l${state.nextId}`;
  const order = {
    id,
    side: 'lend',
    maker: YOU,
    asset: null,
    assets,
    tokenMicro: 0,
    remainingTokenMicro: 0,
    usdcCents: action.usdcCents,
    remainingCents: action.usdcCents,
    rateBps: action.rateBps,
    termDays: action.termDays,
    maxLtvBps: action.maxLtvBps,
    minFillCents: action.minFillCents,
    expiry: CLOCK + action.expiryDays * DAY,
    inKind: Boolean(action.inKind),
    yieldMode: action.yieldOn ? 'lender' : 'none',
    status: 'open',
  };
  return succeed(
    state,
    { orders: [order, ...state.orders], nextId: state.nextId + 1, lastLoanId: '' },
    'Lend offer posted. Your USDC stays in your wallet until someone fills it.',
  );
}

function cancel(state, id) {
  const order = state.orders.find((item) => item.id === id);
  if (!order) return fail(state, 'That order is not in the book.');
  if (order.maker !== YOU) return fail(state, 'You can cancel only your own order.');
  if (order.remainingCents <= 0) return fail(state, 'That order is already closed.');
  return succeed(
    state,
    {
      orders: state.orders.map((item) => (
        item.id === id ? { ...item, remainingCents: 0, remainingTokenMicro: 0, status: 'cancelled' } : item
      )),
    },
    'Order cancelled. No collateral was locked, so there is nothing to return.',
  );
}

function fill(state, action) {
  const order = state.orders.find((item) => item.id === action.id);
  if (!order || order.remainingCents <= 0) return fail(state, 'That order is no longer open.');
  if (order.expiry <= CLOCK) return fail(state, 'That order has expired.');
  if (order.maker === YOU) return fail(state, 'You cannot fill your own order.');
  const usdc = action.usdcCents;
  if (!Number.isInteger(usdc) || usdc <= 0) return fail(state, 'Enter a USDC amount.');
  if (usdc < 50000) return fail(state, 'The minimum loan is $500.');
  if (usdc < order.minFillCents) return fail(state, `The minimum fill on this order is ${formatUsd(order.minFillCents)}.`);
  if (usdc > order.remainingCents) return fail(state, 'That is more than the order has left.');
  if (usdc > 1000000) return fail(state, 'Guarded launch caps a loan at $10,000.');

  let assetSymbol;
  let tokenMicro;
  let borrower;
  let lender;
  if (order.side === 'borrow') {
    assetSymbol = order.asset;
    tokenMicro = usdc === order.remainingCents
      ? order.remainingTokenMicro
      : Number((BigInt(order.remainingTokenMicro) * BigInt(usdc) + BigInt(order.remainingCents) - 1n) / BigInt(order.remainingCents));
    borrower = order.maker;
    lender = YOU;
  } else {
    assetSymbol = action.asset;
    if (!order.assets.includes(assetSymbol)) return fail(state, 'That stock is not on this offer.');
    tokenMicro = action.tokenMicro;
    if (!Number.isInteger(tokenMicro) || tokenMicro <= 0) return fail(state, 'Enter the stock you will escrow.');
    borrower = YOU;
    lender = order.maker;
  }
  const asset = ASSETS[assetSymbol];
  const check = assess({ asset, tokenMicro, principalCents: usdc, maxLtvBps: order.maxLtvBps });
  if (!check.ok) return fail(state, check.error);
  const loan = makeLoan(state, {
    borrower,
    lender,
    asset: assetSymbol,
    tokenMicro,
    principalCents: usdc,
    rateBps: order.rateBps,
    termDays: order.termDays,
    initLtvBps: Math.floor((usdc * 10000) / check.gross),
    inKind: Boolean(order.inKind && action.inKind),
    yieldMode: order.yieldMode === 'lender' && action.yieldOn ? 'lender' : 'none',
  });
  const orders = state.orders.map((item) => {
    if (item.id !== order.id) return item;
    const remainingCents = item.remainingCents - usdc;
    const remainingTokenMicro = item.side === 'borrow'
      ? Math.max(0, item.remainingTokenMicro - tokenMicro)
      : 0;
    return {
      ...item,
      remainingCents,
      remainingTokenMicro,
      status: remainingCents === 0 ? 'filled' : 'open',
    };
  });
  return succeed(
    state,
    { orders, loans: [loan, ...state.loans], nextId: state.nextId + 1, lastLoanId: loan.id },
    `Loan ${loan.id} is open. The stock is in escrow, and the Position NFT is with the lender.`,
  );
}

function repay(state, action) {
  const loan = state.loans.find((item) => item.id === action.id);
  if (!loan) return fail(state, 'Loan not found.');
  const phase = phaseOf(loan);
  if (phase === 'Repaid' || phase === 'Settled') return fail(state, 'This loan is already closed.');
  const remaining = loan.principalCents - loan.repaidPrincipalCents;
  const portion = action.all ? remaining : action.principalCents;
  if (!Number.isInteger(portion) || portion <= 0) return fail(state, 'Enter a principal amount.');
  if (portion > remaining) return fail(state, 'That is more than the principal left.');
  if (portion < remaining && portion < 100) return fail(state, 'A partial repay is at least $1, or repay all.');
  if (portion < remaining && remaining - portion < 100) return fail(state, 'Leave at least $1 of principal, or repay all.');
  const interest = dueInterestCents(loan, CLOCK, portion);
  const release = releaseTokens(loan, portion, CLOCK);
  const full = portion === remaining;
  const loans = state.loans.map((item) => {
    if (item.id !== loan.id) return item;
    if (full) {
      return {
        ...item,
        repaidPrincipalCents: item.principalCents,
        tokenMicro: 0,
        status: 'Repaid',
        auctionStarted: null,
        lifetimeInterestCents: item.lifetimeInterestCents + interest,
      };
    }
    return {
      ...item,
      repaidPrincipalCents: item.repaidPrincipalCents + portion,
      tokenMicro: item.tokenMicro - release.tokens,
      lifetimeInterestCents: item.lifetimeInterestCents + interest,
    };
  });
  let claims = state.claims;
  let nextId = state.nextId;
  if (loan.lender === YOU) {
    const holderInterest = interest - interestCutCents(interest);
    claims = [{
      id: `c${nextId}`,
      loanId: loan.id,
      cents: portion + holderInterest,
      claimed: false,
      reason: 'Repayment',
    }, ...claims];
    nextId += 1;
  }
  const capNote = !full && release.capped
    ? ' Release is capped so LTV stays at or below the loan’s initial LTV.'
    : '';
  const notice = full
    ? `Repaid ${formatUsd(portion + interest)}. Collateral released to the borrower: ${formatTokens(release.tokens)} ${loan.asset}.`
    : `Repaid ${formatUsd(portion)} of principal plus ${formatUsd(interest)} of interest. Collateral released: ${formatTokens(release.tokens)} ${loan.asset}.${capNote}`;
  return succeed(state, { loans, claims, nextId }, notice);
}

function topUp(state, action) {
  const loan = state.loans.find((item) => item.id === action.id);
  if (!loan) return fail(state, 'Loan not found.');
  const phase = phaseOf(loan);
  if (phase === 'Repaid' || phase === 'Settled') return fail(state, 'This loan is closed.');
  if (!Number.isInteger(action.tokenMicro) || action.tokenMicro <= 0) return fail(state, 'Enter the stock to add.');
  return succeed(
    state,
    {
      loans: state.loans.map((item) => (
        item.id === loan.id ? { ...item, tokenMicro: item.tokenMicro + action.tokenMicro } : item
      )),
    },
    `Added ${formatTokens(action.tokenMicro)} ${loan.asset}. Top-up is allowed even when the market is closed or the asset is frozen.`,
  );
}

function extend(state, action) {
  const loan = state.loans.find((item) => item.id === action.id);
  if (!loan) return fail(state, 'Loan not found.');
  if (loan.borrower !== YOU) return fail(state, 'Only the borrower can accept an extension.');
  const phase = phaseOf(loan);
  if (phase === 'Auction' || phase === 'Repaid' || phase === 'Settled' || phase === 'PastGrace') {
    return fail(state, 'This loan cannot be extended.');
  }
  if (!action.agreed) return fail(state, 'The Position NFT holder has to sign the extension. Nothing changes until they do.');
  const asset = ASSETS[loan.asset];
  const block = newLoanBlock(asset);
  if (block) return fail(state, block);
  if (!Number.isInteger(action.termDays) || action.termDays < 7 || action.termDays > 90) {
    return fail(state, 'The new term has to be 7 to 90 days.');
  }
  if (!Number.isInteger(action.rateBps) || action.rateBps < 0 || action.rateBps > 4000) {
    return fail(state, 'The rate has to be between 0% and 40% APR.');
  }
  const remaining = loan.principalCents - loan.repaidPrincipalCents;
  const accrued = liveInterestCents(loan, CLOCK);
  const newPrincipal = remaining + (action.capitalize ? accrued : 0);
  const check = assess({
    asset,
    tokenMicro: loan.tokenMicro,
    principalCents: newPrincipal,
    maxLtvBps: asset.maxInitLtvBps,
  });
  if (!check.ok) return fail(state, check.error);
  let claims = state.claims;
  let nextId = state.nextId;
  if (!action.capitalize && accrued > 0 && loan.lender === YOU) {
    claims = [{
      id: `c${nextId}`,
      loanId: loan.id,
      cents: accrued - interestCutCents(accrued),
      claimed: false,
      reason: 'Extension interest',
    }, ...claims];
    nextId += 1;
  }
  const loans = state.loans.map((item) => {
    if (item.id !== loan.id) return item;
    return {
      ...item,
      principalCents: newPrincipal,
      repaidPrincipalCents: 0,
      rateBps: action.rateBps,
      termDays: action.termDays,
      start: CLOCK,
      maturity: CLOCK + action.termDays * DAY,
      accrueFrom: CLOCK,
      status: 'Active',
      initLtvBps: Math.floor((newPrincipal * 10000) / check.gross),
      lifetimeInterestCents: item.lifetimeInterestCents + accrued,
    };
  });
  const notice = action.capitalize
    ? `Extension signed. ${formatUsd(accrued)} of interest was added to principal. The new rate is the agreed rate.`
    : `Extension signed. ${formatUsd(accrued)} of interest is paid now, and the loan runs for ${action.termDays} more days.`;
  return succeed(state, { loans, claims, nextId }, notice);
}

function rollover(state, action) {
  const loan = state.loans.find((item) => item.id === action.id);
  if (!loan) return fail(state, 'Loan not found.');
  if (loan.borrower !== YOU) return fail(state, 'Only the borrower can roll a loan.');
  const phase = phaseOf(loan);
  if (phase === 'Auction' || phase === 'Repaid' || phase === 'Settled' || phase === 'PastGrace') {
    return fail(state, 'This loan cannot be rolled.');
  }
  const asset = ASSETS[loan.asset];
  const block = newLoanBlock(asset);
  if (block) return fail(state, block);
  const offer = state.orders.find((item) => item.id === action.offerId && item.side === 'lend' && item.remainingCents > 0);
  if (!offer) return fail(state, 'That lend offer is not open.');
  if (offer.maker === YOU) return fail(state, 'You cannot roll into your own offer.');
  if (offer.expiry <= CLOCK) return fail(state, 'That offer has expired.');
  if (!offer.assets.includes(loan.asset)) return fail(state, 'That offer does not accept this stock.');
  const remaining = loan.principalCents - loan.repaidPrincipalCents;
  const interest = dueInterestCents(loan, CLOCK, remaining);
  if (remaining > offer.remainingCents) return fail(state, 'That offer is smaller than the principal.');
  const check = assess({
    asset,
    tokenMicro: loan.tokenMicro,
    principalCents: remaining,
    maxLtvBps: offer.maxLtvBps,
  });
  if (!check.ok) return fail(state, check.error);
  const next = makeLoan(state, {
    borrower: YOU,
    lender: offer.maker,
    asset: loan.asset,
    tokenMicro: loan.tokenMicro,
    principalCents: remaining,
    rateBps: offer.rateBps,
    termDays: offer.termDays,
    initLtvBps: Math.floor((remaining * 10000) / check.gross),
    inKind: Boolean(offer.inKind),
    yieldMode: offer.yieldMode === 'lender' ? 'lender' : 'none',
  });
  const loans = [
    next,
    ...state.loans.map((item) => (
      item.id === loan.id
        ? {
          ...item,
          status: 'Repaid',
          repaidPrincipalCents: item.principalCents,
          tokenMicro: 0,
          lifetimeInterestCents: item.lifetimeInterestCents + interest,
        }
        : item
    )),
  ];
  const orders = state.orders.map((item) => (
    item.id === offer.id
      ? { ...item, remainingCents: item.remainingCents - remaining, status: item.remainingCents - remaining === 0 ? 'filled' : 'open' }
      : item
  ));
  return succeed(
    state,
    { loans, orders, nextId: state.nextId + 1, lastLoanId: next.id },
    `Rolled loan ${loan.id} into loan ${next.id}. Interest of ${formatUsd(interest)} is settled. The stock never left escrow.`,
  );
}

function list(state, action) {
  const loan = state.loans.find((item) => item.id === action.id);
  if (!loan) return fail(state, 'Loan not found.');
  if (loan.lender !== YOU) return fail(state, 'Only the holder of the Position NFT can list it.');
  const phase = phaseOf(loan);
  if (phase === 'Auction') return fail(state, 'Transfers are locked while the auction runs.');
  if (phase === 'Repaid' || phase === 'Settled') return fail(state, 'This claim is already closed.');
  if (!Number.isInteger(action.priceCents) || action.priceCents < 100) return fail(state, 'Enter a price of at least $1.');
  const listings = [
    { id: `m${state.nextId}`, loanId: loan.id, priceCents: action.priceCents, seller: YOU },
    ...state.listings.filter((item) => item.loanId !== loan.id),
  ];
  const fee = positionFeeCents(action.priceCents);
  return succeed(
    state,
    { listings, nextId: state.nextId + 1 },
    `Listed loan ${loan.id} at ${formatUsd(action.priceCents)}. The sale fee is ${formatUsd(fee)}, paid by you.`,
  );
}

function buy(state, action) {
  const listing = state.listings.find((item) => item.id === action.id);
  if (!listing) return fail(state, 'That listing is gone.');
  const loan = state.loans.find((item) => item.id === listing.loanId);
  if (!loan) return fail(state, 'That loan is gone.');
  if (phaseOf(loan) === 'Auction') return fail(state, 'Transfers are locked while the auction runs.');
  if (listing.seller === YOU) return fail(state, 'Cancel the listing if you no longer want to sell.');
  if (loan.lender === YOU) return fail(state, 'You already hold this claim.');
  const fee = positionFeeCents(listing.priceCents);
  return succeed(
    state,
    {
      loans: state.loans.map((item) => (item.id === loan.id ? { ...item, lender: YOU } : item)),
      listings: state.listings.filter((item) => item.id !== listing.id),
    },
    `You hold the claim on loan ${loan.id}. The stock did not move. The seller pays ${formatUsd(fee)}.`,
  );
}

function claim(state, action) {
  const found = state.claims.find((item) => item.id === action.id && !item.claimed);
  if (!found) return fail(state, 'Nothing to claim.');
  return succeed(
    state,
    { claims: state.claims.map((item) => (item.id === found.id ? { ...item, claimed: true } : item)) },
    `Claimed ${formatUsd(found.cents)}. USDC is pulled to you. It is not pushed.`,
  );
}

export function reducer(state, action) {
  switch (action.type) {
    case 'accept':
      return succeed(state, { gate: 'accepted' }, '');
    case 'restrict':
      return succeed(state, { gate: 'restricted' }, '');
    case 'reset-gate':
      return succeed(state, { gate: 'pending' }, '');
    case 'clear-note':
      if (!state.notice && !state.error) return state;
      return { ...state, notice: '', error: '' };
    case 'place-borrow':
      return placeBorrow(state, action);
    case 'place-lend':
      return placeLend(state, action);
    case 'cancel':
      return cancel(state, action.id);
    case 'cancel-mine': {
      const mine = state.orders.some((item) => item.maker === YOU && item.remainingCents > 0);
      if (!mine) return fail(state, 'You have no open orders.');
      return succeed(
        state,
        {
          orders: state.orders.map((item) => (
            item.maker === YOU && item.remainingCents > 0
              ? { ...item, remainingCents: 0, remainingTokenMicro: 0, status: 'cancelled' }
              : item
          )),
        },
        'Open orders cancelled. No collateral was locked.',
      );
    }
    case 'fill':
      return fill(state, action);
    case 'repay':
      return repay(state, action);
    case 'topup':
      return topUp(state, action);
    case 'extend':
      return extend(state, action);
    case 'rollover':
      return rollover(state, action);
    case 'list':
      return list(state, action);
    case 'cancel-list':
      return succeed(
        state,
        { listings: state.listings.filter((item) => !(item.id === action.id && item.seller === YOU)) },
        'Listing cancelled. The claim stays with you.',
      );
    case 'buy':
      return buy(state, action);
    case 'claim':
      return claim(state, action);
    case 'dismiss':
      if (state.dismissed.includes(action.id)) return state;
      return { ...state, dismissed: [...state.dismissed, action.id], notice: '', error: '' };
    default:
      return state;
  }
}

export function openOrders(state) {
  return state.orders.filter((item) => item.remainingCents > 0 && item.expiry > CLOCK);
}

export function loanHealth(loan) {
  return health(loan);
}
