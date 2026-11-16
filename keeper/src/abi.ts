export const OracleState = {
  VALID_OPEN: 0,
  VALID_CLOSED: 1,
  FROZEN_CORPORATE_ACTION: 2,
  STALE_FEED: 3,
  INVALID_SEQUENCER: 4,
  DISPUTED: 5,
} as const;

export type OracleStateValue = (typeof OracleState)[keyof typeof OracleState];

export const ORACLE_STATE_NAMES: Record<number, string> = {
  0: 'VALID_OPEN',
  1: 'VALID_CLOSED',
  2: 'FROZEN_CORPORATE_ACTION',
  3: 'STALE_FEED',
  4: 'INVALID_SEQUENCER',
  5: 'DISPUTED',
};

export const LoanStatus = {
  Active: 0,
  Grace: 1,
  Auction: 2,
  Repaid: 3,
  SettledDefault: 4,
  SettledLiquidated: 5,
} as const;

export const AuctionStatus = {
  Active: 0,
  Settled: 1,
  Cancelled: 2,
} as const;

export const AssetStatus = {
  Active: 0,
  ReduceOnly: 1,
  WindDown: 2,
  Frozen: 3,
} as const;

/**
 * IB20Token & IERC20Metadata (contracts/src/OracleRouter.sol:4, 12-14)
 */
export const b20TokenAbi = [
  {
    type: 'function',
    name: 'uiMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
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
] as const;

/**
 * OracleRouter (contracts/src/OracleRouter.sol)
 */
export const oracleRouterAbi = [
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'InvalidAnswer', inputs: [] },
  { type: 'error', name: 'AssetNotConfigured', inputs: [] },
  { type: 'error', name: 'CorporateActionSplitPending', inputs: [] },
  {
    type: 'function',
    name: 'recordedMultiplier',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'syncMultiplier',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'current', type: 'uint256' }],
  },
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
    name: 'getOracleState',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'state', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'isMarketOpen',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isSequencerValid',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * AssetRegistry (contracts/src/AssetRegistry.sol)
 */
export const assetRegistryAbi = [
  { type: 'error', name: 'AssetNotSupported', inputs: [] },
  {
    type: 'function',
    name: 'isAssetSupported',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getAssetStatus',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint8' }],
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

/**
 * LoanCore (contracts/src/LoanCore.sol)
 */
export const loanCoreAbi = [
  { type: 'error', name: 'UnauthorizedCaller', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'ProtocolPaused', inputs: [] },
  { type: 'error', name: 'OracleInvalidForAction', inputs: [] },
  { type: 'error', name: 'LoanNotActive', inputs: [] },
  { type: 'error', name: 'LoanNotInGrace', inputs: [] },
  { type: 'error', name: 'LoanNotLiquidatable', inputs: [] },
  { type: 'error', name: 'AssetNotSupported', inputs: [] },
  { type: 'error', name: 'CorporateActionSplitPending', inputs: [] },
  {
    type: 'function',
    name: 'nextLoanId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'GRACE_PERIOD_SECONDS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'loanActiveAuction',
    stateMutability: 'view',
    inputs: [{ name: 'loanId', type: 'uint256' }],
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
  {
    type: 'function',
    name: 'getDueInterest',
    stateMutability: 'view',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'startLiquidation',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [{ name: 'auctionId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'startDefaultAuction',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [{ name: 'auctionId', type: 'uint256' }],
  },
] as const;

/**
 * LiquidationAuction (contracts/src/LiquidationAuction.sol)
 */
export const liquidationAuctionAbi = [
  { type: 'error', name: 'AuctionNotActive', inputs: [] },
  { type: 'error', name: 'InvalidAuctionAmount', inputs: [] },
  { type: 'error', name: 'AuctionExpired', inputs: [] },
  {
    type: 'function',
    name: 'nextAuctionId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getAuction',
    stateMutability: 'view',
    inputs: [{ name: 'auctionId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'loanId', type: 'uint256' },
          { name: 'borrower', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'collateralTotal', type: 'uint128' },
          { name: 'collateralRemaining', type: 'uint128' },
          { name: 'debtPrincipalRemaining', type: 'uint128' },
          { name: 'debtInterestRemaining', type: 'uint128' },
          { name: 'startPrice', type: 'uint256' },
          { name: 'floorPrice', type: 'uint256' },
          { name: 'startTime', type: 'uint64' },
          { name: 'duration', type: 'uint64' },
          { name: 'keeper', type: 'address' },
          { name: 'status', type: 'uint8' },
          { name: 'isDefaultAuction', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getCurrentPrice',
    stateMutability: 'view',
    inputs: [{ name: 'auctionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'restartOrCancelAuction',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'auctionId', type: 'uint256' }],
    outputs: [],
  },
] as const;

/**
 * AggregatorV3Interface (contracts/src/interfaces/AggregatorV3Interface.sol)
 */
export const aggregatorV3Abi = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;
