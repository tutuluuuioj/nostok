export const OracleState = {
  VALID_OPEN: 0,
  VALID_CLOSED: 1,
  FROZEN_CORPORATE_ACTION: 2,
  STALE_FEED: 3,
  INVALID_SEQUENCER: 4,
  DISPUTED: 5,
} as const;

export const ORACLE_STATE_NAMES: Record<number, string> = {
  0: 'VALID_OPEN',
  1: 'VALID_CLOSED',
  2: 'FROZEN_CORPORATE_ACTION',
  3: 'STALE_FEED',
  4: 'INVALID_SEQUENCER',
  5: 'DISPUTED',
};

export const ASSET_STATUS_NAMES: Record<number, string> = {
  0: 'Active',
  1: 'ReduceOnly',
  2: 'WindDown',
  3: 'Frozen',
};

export const LOAN_STATUS_NAMES: Record<number, string> = {
  0: 'Active',
  1: 'Grace',
  2: 'Auction',
  3: 'Repaid',
  4: 'SettledDefault',
  5: 'SettledLiquidated',
};

export const AUCTION_STATUS_NAMES: Record<number, string> = {
  0: 'Active',
  1: 'Settled',
  2: 'Cancelled',
};

export const loanCoreAbi = [
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'globalUsdcCap',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'totalOutstandingPrincipal',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'assetOutstandingPrincipal',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'SECONDS_PER_YEAR',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getLoan',
    stateMutability: 'view',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'borrower', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'collateralRaw', type: 'uint128' },
          { name: 'principal', type: 'uint128' },
          { name: 'startTime', type: 'uint64' },
          { name: 'maturity', type: 'uint64' },
          { name: 'rateBps', type: 'uint32' },
          { name: 'penaltySpreadBps', type: 'uint32' },
          { name: 'initLtvBps', type: 'uint16' },
          { name: 'marginCallLtvBps', type: 'uint16' },
          { name: 'liqLtvBps', type: 'uint16' },
          { name: 'minInterestDays', type: 'uint16' },
          { name: 'status', type: 'uint8' },
          { name: 'yieldMode', type: 'uint8' },
          { name: 'coreVersion', type: 'uint8' },
          { name: 'interestPaid', type: 'uint128' },
          { name: 'principalRepaid', type: 'uint128' },
        ],
      },
    ],
  },
] as const;

export const assetRegistryAbi = [
  {
    type: 'function',
    name: 'isAssetSupported',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getAssetConfig',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'feed', type: 'address' },
          { name: 'feedDecimals', type: 'uint8' },
          { name: 'tier', type: 'uint8' },
          { name: 'maxInitLtvBps', type: 'uint16' },
          { name: 'marginCallLtvBps', type: 'uint16' },
          { name: 'liqLtvBps', type: 'uint16' },
          { name: 'badDebtLtvBps', type: 'uint16' },
          { name: 'maxDiscountBps', type: 'uint16' },
          { name: 'closedMarketHaircutBps', type: 'uint16' },
          { name: 'perLoanCap', type: 'uint128' },
          { name: 'assetCap', type: 'uint128' },
          { name: 'maxStaleOpenSecs', type: 'uint32' },
          { name: 'status', type: 'uint8' },
          { name: 'restricted', type: 'bool' },
        ],
      },
    ],
  },
] as const;

export const oracleRouterAbi = [
  {
    type: 'function',
    name: 'getPrice',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'price', type: 'uint256' },
      { name: 'decimals', type: 'uint8' },
      { name: 'state', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'getValue',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'rawAmount', type: 'uint256' },
    ],
    outputs: [
      { name: 'grossValueUsdc', type: 'uint256' },
      { name: 'effectiveValueUsdc', type: 'uint256' },
      { name: 'state', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'recordedMultiplier',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export const feeCollectorAbi = [
  {
    type: 'function',
    name: 'originationFeeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'interestCutBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'liquidationFeeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'safetyReserveShareBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'calculateOriginationFee',
    stateMutability: 'view',
    inputs: [{ name: 'principal', type: 'uint128' }],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'calculateInterestCut',
    stateMutability: 'view',
    inputs: [{ name: 'interest', type: 'uint128' }],
    outputs: [{ name: '', type: 'uint128' }],
  },
] as const;

export const liquidationAuctionAbi = [
  {
    type: 'function',
    name: 'MIN_BUY_USDC',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
] as const;

export const eligibilityGateAbi = [
  {
    type: 'function',
    name: 'permissionlessMode',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isEligible',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'context', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export const erc20MetaAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'uiMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
