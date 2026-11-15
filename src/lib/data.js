export const CLOCK = Date.parse('2026-11-15T12:00:00+06:00');
export const DAY = 86400000;
export const YOU = 'you';

export function partyName(id) {
  if (id === YOU) return 'You';
  if (id === 'sample-lender') return 'Sample lender';
  if (id === 'sample-borrower') return 'Sample borrower';
  return 'Counterparty';
}

const tierA = {
  tier: 'A',
  maxInitLtvBps: 6000,
  marginBps: 7000,
  liqBps: 7800,
  badBps: 9000,
  discountBps: 600,
  haircutBps: 500,
  launch: true,
};

const tierB = {
  tier: 'B',
  oracleCents: 0,
  marketCents: 0,
  state: 'UNLISTED',
  status: 'Not at launch',
  maxInitLtvBps: 4500,
  marginBps: 5500,
  liqBps: 6500,
  badBps: 8000,
  discountBps: 1000,
  haircutBps: 1000,
  launch: false,
};

export const ASSETS = {
  NVDAc: { symbol: 'NVDAc', name: 'NVIDIA', ...tierA, oracleCents: 17840, marketCents: 17605, state: 'VALID_OPEN', status: 'Active' },
  AAPLc: { symbol: 'AAPLc', name: 'Apple', ...tierA, oracleCents: 22810, marketCents: 22140, state: 'VALID_CLOSED', status: 'Active' },
  MSFTc: { symbol: 'MSFTc', name: 'Microsoft', ...tierA, oracleCents: 42825, marketCents: 42610, state: 'VALID_OPEN', status: 'Active' },
  GOOGLc: { symbol: 'GOOGLc', name: 'Alphabet', ...tierA, oracleCents: 17890, marketCents: 17740, state: 'VALID_OPEN', status: 'Active' },
  AMZNc: { symbol: 'AMZNc', name: 'Amazon', ...tierA, oracleCents: 19755, marketCents: 19620, state: 'VALID_OPEN', status: 'Active' },
  METAc: { symbol: 'METAc', name: 'Meta', ...tierA, oracleCents: 58230, marketCents: 57500, state: 'FROZEN_CORPORATE_ACTION', status: 'Frozen' },
  TSLAc: { symbol: 'TSLAc', name: 'TSLAc', ...tierB },
  MSTRc: { symbol: 'MSTRc', name: 'MSTRc', ...tierB },
  SNDKc: { symbol: 'SNDKc', name: 'SNDKc', ...tierB },
  SPCXc: { symbol: 'SPCXc', name: 'SPCXc', ...tierB },
};

export const ASSET_ORDER = ['NVDAc', 'AAPLc', 'MSFTc', 'GOOGLc', 'AMZNc', 'METAc', 'TSLAc', 'MSTRc', 'SNDKc', 'SPCXc'];

export const ORACLE_STATES = [
  { id: 'VALID_OPEN', label: 'Market open', loans: 'Yes', liquidation: 'Yes', repay: 'Yes' },
  { id: 'VALID_CLOSED', label: 'Market closed', loans: 'Yes, with a haircut', liquidation: 'No', repay: 'Yes' },
  { id: 'FROZEN_CORPORATE_ACTION', label: 'Corporate action', loans: 'No', liquidation: 'No', repay: 'Yes' },
  { id: 'STALE_FEED', label: 'Stale feed', loans: 'No', liquidation: 'No', repay: 'Yes' },
  { id: 'INVALID_SEQUENCER', label: 'Sequencer down', loans: 'No', liquidation: 'No', repay: 'Yes' },
  { id: 'DISPUTED', label: 'Disputed', loans: 'No', liquidation: 'No', repay: 'Yes' },
];

export const FEES = [
  { name: 'Origination', payer: 'Borrower', rate: '0.10% of principal', cap: '1.00%', when: 'Taken from proceeds at fill' },
  { name: 'Interest cut', payer: 'Lender', rate: '10% of interest', cap: '20%', when: 'Taken at repayment' },
  { name: 'Liquidation', payer: 'Borrower, from proceeds', rate: '1.00% of collateral sold', cap: '3.00%', when: 'Includes the keeper reward' },
  { name: 'Yield cut', payer: 'Lender', rate: '10% of venue yield', cap: '25%', when: 'Only if the yield module is on. It ships off.' },
  { name: 'Position sale', payer: 'Seller', rate: '0.25% of the price', cap: '1.00%', when: 'When a claim is sold' },
];

export function stateLabel(state) {
  const found = ORACLE_STATES.find((item) => item.id === state);
  if (found) return found.label;
  if (state === 'UNLISTED') return 'Not at launch';
  return state;
}

function loan(fields) {
  return {
    penaltySpreadBps: 500,
    minInterestDays: 3,
    inKind: false,
    yieldMode: 'none',
    auctionStarted: null,
    lifetimeInterestCents: 0,
    repaidPrincipalCents: 0,
    status: 'Active',
    ...fields,
  };
}

export function seedLoans() {
  return [
    loan({
      id: '1842',
      borrower: YOU,
      lender: 'sample-lender',
      asset: 'NVDAc',
      tokenMicro: 56053812,
      principalCents: 500000,
      rateBps: 800,
      termDays: 30,
      start: CLOCK - 14 * DAY,
      maturity: CLOCK - 14 * DAY + 30 * DAY,
      accrueFrom: CLOCK - 14 * DAY,
      initLtvBps: 5000,
      marginBps: 7000,
      liqBps: 7800,
    }),
    loan({
      id: '1844',
      borrower: YOU,
      lender: 'sample-lender',
      asset: 'AAPLc',
      tokenMicro: 49641298,
      principalCents: 800000,
      rateBps: 900,
      termDays: 45,
      start: CLOCK - 20 * DAY,
      maturity: CLOCK - 20 * DAY + 45 * DAY,
      accrueFrom: CLOCK - 20 * DAY,
      initLtvBps: 6000,
      marginBps: 7000,
      liqBps: 7800,
    }),
    loan({
      id: '1846',
      borrower: YOU,
      lender: 'sample-lender',
      asset: 'MSFTc',
      tokenMicro: 16679183,
      principalCents: 300000,
      rateBps: 750,
      termDays: 21,
      start: CLOCK - 12 * 3600000 - 21 * DAY,
      maturity: CLOCK - 12 * 3600000,
      accrueFrom: CLOCK - 12 * 3600000 - 21 * DAY,
      initLtvBps: 5000,
      marginBps: 7000,
      liqBps: 7800,
    }),
    loan({
      id: '1848',
      borrower: YOU,
      lender: 'sample-lender',
      asset: 'METAc',
      tokenMicro: 9681161,
      principalCents: 450000,
      rateBps: 800,
      termDays: 30,
      start: CLOCK - 10 * DAY,
      maturity: CLOCK - 10 * DAY + 30 * DAY,
      accrueFrom: CLOCK - 10 * DAY,
      initLtvBps: 6000,
      marginBps: 7000,
      liqBps: 7800,
    }),
    loan({
      id: '1850',
      borrower: 'sample-borrower',
      lender: YOU,
      asset: 'AMZNc',
      tokenMicro: 31637561,
      principalCents: 250000,
      rateBps: 820,
      termDays: 20,
      start: CLOCK - 4 * DAY,
      maturity: CLOCK - 4 * DAY + 20 * DAY,
      accrueFrom: CLOCK - 4 * DAY,
      initLtvBps: 4000,
      marginBps: 7000,
      liqBps: 7800,
    }),
    loan({
      id: '1852',
      borrower: 'sample-borrower',
      lender: 'sample-lender',
      asset: 'NVDAc',
      tokenMicro: 22421525,
      principalCents: 180000,
      rateBps: 880,
      termDays: 40,
      start: CLOCK - 8 * DAY,
      maturity: CLOCK - 8 * DAY + 40 * DAY,
      accrueFrom: CLOCK - 8 * DAY,
      initLtvBps: 4500,
      marginBps: 7000,
      liqBps: 7800,
    }),
    loan({
      id: '1854',
      borrower: 'sample-borrower',
      lender: YOU,
      asset: 'GOOGLc',
      tokenMicro: 72200504,
      principalCents: 620000,
      rateBps: 860,
      termDays: 30,
      start: CLOCK - 12 * DAY,
      maturity: CLOCK - 12 * DAY + 30 * DAY,
      accrueFrom: CLOCK - 12 * DAY,
      initLtvBps: 4800,
      marginBps: 7000,
      liqBps: 7800,
      status: 'Auction',
      auctionStarted: CLOCK - 10 * 60 * 1000,
    }),
    loan({
      id: '1860',
      borrower: 'sample-borrower',
      lender: YOU,
      asset: 'AMZNc',
      tokenMicro: 0,
      principalCents: 150000,
      repaidPrincipalCents: 150000,
      rateBps: 800,
      termDays: 14,
      start: CLOCK - 20 * DAY,
      maturity: CLOCK - 6 * DAY,
      accrueFrom: CLOCK - 20 * DAY,
      status: 'Repaid',
      initLtvBps: 5000,
      marginBps: 7000,
      liqBps: 7800,
      lifetimeInterestCents: 460,
    }),
  ];
}

export function seedOrders() {
  return [
    {
      id: 'b2201',
      side: 'borrow',
      maker: 'sample-borrower',
      asset: 'NVDAc',
      assets: ['NVDAc'],
      tokenMicro: 47085202,
      remainingTokenMicro: 47085202,
      usdcCents: 420000,
      remainingCents: 420000,
      rateBps: 900,
      termDays: 21,
      maxLtvBps: 5500,
      minFillCents: 50000,
      expiry: CLOCK + 5 * DAY,
      inKind: false,
      yieldMode: 'none',
      status: 'open',
    },
    {
      id: 'b2202',
      side: 'borrow',
      maker: 'sample-borrower',
      asset: 'METAc',
      assets: ['METAc'],
      tokenMicro: 5000000,
      remainingTokenMicro: 5000000,
      usdcCents: 200000,
      remainingCents: 200000,
      rateBps: 1000,
      termDays: 14,
      maxLtvBps: 5000,
      minFillCents: 50000,
      expiry: CLOCK + 2 * DAY,
      inKind: false,
      yieldMode: 'none',
      status: 'open',
    },
    {
      id: 'l3301',
      side: 'lend',
      maker: 'sample-lender',
      asset: null,
      assets: ['NVDAc', 'MSFTc', 'AAPLc', 'GOOGLc', 'AMZNc'],
      tokenMicro: 0,
      remainingTokenMicro: 0,
      usdcCents: 2500000,
      remainingCents: 2500000,
      rateBps: 750,
      termDays: 30,
      maxLtvBps: 5000,
      minFillCents: 50000,
      expiry: CLOCK + 5 * DAY,
      inKind: false,
      yieldMode: 'none',
      status: 'open',
    },
  ];
}

export function seedListings() {
  return [{ id: 'lst1', loanId: '1852', priceCents: 190000, seller: 'sample-lender' }];
}

export function seedClaims() {
  return [{ id: 'cl1', loanId: '1860', cents: 152340, claimed: false, reason: 'Repayment' }];
}
