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

export const loanCoreAbi = [
  {
    type: 'event',
    name: 'LoanOpened',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'borrower', type: 'address', indexed: true },
      { name: 'lender', type: 'address', indexed: true },
      { name: 'collateralToken', type: 'address', indexed: false },
      { name: 'collateralAmount', type: 'uint128', indexed: false },
      { name: 'principal', type: 'uint128', indexed: false },
      { name: 'rateBps', type: 'uint32', indexed: false },
      { name: 'maturity', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Repaid',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'principalPaid', type: 'uint128', indexed: false },
      { name: 'interestPaid', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PartialRepaid',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'principalPaid', type: 'uint128', indexed: false },
      { name: 'interestPaid', type: 'uint128', indexed: false },
      { name: 'collateralReleased', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ToppedUp',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'funder', type: 'address', indexed: true },
      { name: 'additionalCollateral', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Extended',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'newMaturity', type: 'uint64', indexed: false },
      { name: 'newRateBps', type: 'uint32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'StatusSynced',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'status', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Claimed',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BadDebtRecorded',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'shortfall', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'nextLoanId',
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
  {
    type: 'function',
    name: 'loanActiveAuction',
    stateMutability: 'view',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getClaimable',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint128' }],
  },
] as const;

export const orderSettlementAbi = [
  {
    type: 'event',
    name: 'OrderFilled',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true },
      { name: 'maker', type: 'address', indexed: true },
      { name: 'taker', type: 'address', indexed: true },
      { name: 'loanId', type: 'uint256', indexed: false },
      { name: 'fillAmountUsdc', type: 'uint128', indexed: false },
      { name: 'collateralAmount', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OrderCancelled',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true },
      { name: 'maker', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'NonceBumped',
    inputs: [
      { name: 'maker', type: 'address', indexed: true },
      { name: 'newNonce', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'isOrderCancelled',
    stateMutability: 'view',
    inputs: [{ name: 'orderHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getOrderFilledAmount',
    stateMutability: 'view',
    inputs: [{ name: 'orderHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'getMakerNonce',
    stateMutability: 'view',
    inputs: [{ name: 'maker', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fillBorrowOrder',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'borrower', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'collateralAmount', type: 'uint128' },
          { name: 'minUsdc', type: 'uint128' },
          { name: 'maxRateBps', type: 'uint32' },
          { name: 'termDays', type: 'uint16' },
          { name: 'maxLtvBps', type: 'uint16' },
          { name: 'minFill', type: 'uint128' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
          { name: 'yieldMode', type: 'uint8' },
          { name: 'allowInKindSettlement', type: 'bool' },
        ],
      },
      { name: 'signature', type: 'bytes' },
      { name: 'fillUsdc', type: 'uint128' },
    ],
    outputs: [{ name: 'loanId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fillBorrowOrderWithAttestations',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'borrower', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'collateralAmount', type: 'uint128' },
          { name: 'minUsdc', type: 'uint128' },
          { name: 'maxRateBps', type: 'uint32' },
          { name: 'termDays', type: 'uint16' },
          { name: 'maxLtvBps', type: 'uint16' },
          { name: 'minFill', type: 'uint128' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
          { name: 'yieldMode', type: 'uint8' },
          { name: 'allowInKindSettlement', type: 'bool' },
        ],
      },
      { name: 'signature', type: 'bytes' },
      { name: 'fillUsdc', type: 'uint128' },
      { name: 'borrowerAttestation', type: 'bytes' },
      { name: 'lenderAttestation', type: 'bytes' },
    ],
    outputs: [{ name: 'loanId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'cancelBorrowOrder',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'borrower', type: 'address' },
          { name: 'collateralToken', type: 'address' },
          { name: 'collateralAmount', type: 'uint128' },
          { name: 'minUsdc', type: 'uint128' },
          { name: 'maxRateBps', type: 'uint32' },
          { name: 'termDays', type: 'uint16' },
          { name: 'maxLtvBps', type: 'uint16' },
          { name: 'minFill', type: 'uint128' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
          { name: 'yieldMode', type: 'uint8' },
          { name: 'allowInKindSettlement', type: 'bool' },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'fillLendOffer',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'offer',
        type: 'tuple',
        components: [
          { name: 'lender', type: 'address' },
          { name: 'usdcAmount', type: 'uint128' },
          { name: 'minRateBps', type: 'uint32' },
          { name: 'termDays', type: 'uint16' },
          { name: 'allowedCollateral', type: 'address' },
          { name: 'maxLtvBps', type: 'uint16' },
          { name: 'minFill', type: 'uint128' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
          { name: 'yieldMode', type: 'uint8' },
        ],
      },
      { name: 'signature', type: 'bytes' },
      { name: 'collateralToken', type: 'address' },
      { name: 'collateralAmount', type: 'uint128' },
      { name: 'fillUsdc', type: 'uint128' },
    ],
    outputs: [{ name: 'loanId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fillLendOfferWithAttestations',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'offer',
        type: 'tuple',
        components: [
          { name: 'lender', type: 'address' },
          { name: 'usdcAmount', type: 'uint128' },
          { name: 'minRateBps', type: 'uint32' },
          { name: 'termDays', type: 'uint16' },
          { name: 'allowedCollateral', type: 'address' },
          { name: 'maxLtvBps', type: 'uint16' },
          { name: 'minFill', type: 'uint128' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
          { name: 'yieldMode', type: 'uint8' },
        ],
      },
      { name: 'signature', type: 'bytes' },
      { name: 'collateralToken', type: 'address' },
      { name: 'collateralAmount', type: 'uint128' },
      { name: 'fillUsdc', type: 'uint128' },
      { name: 'borrowerAttestation', type: 'bytes' },
      { name: 'lenderAttestation', type: 'bytes' },
    ],
    outputs: [{ name: 'loanId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'cancelLendOffer',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'offer',
        type: 'tuple',
        components: [
          { name: 'lender', type: 'address' },
          { name: 'usdcAmount', type: 'uint128' },
          { name: 'minRateBps', type: 'uint32' },
          { name: 'termDays', type: 'uint16' },
          { name: 'allowedCollateral', type: 'address' },
          { name: 'maxLtvBps', type: 'uint16' },
          { name: 'minFill', type: 'uint128' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint256' },
          { name: 'yieldMode', type: 'uint8' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export const liquidationAuctionAbi = [
  {
    type: 'event',
    name: 'AuctionStarted',
    inputs: [
      { name: 'auctionId', type: 'uint256', indexed: true },
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'borrower', type: 'address', indexed: true },
      { name: 'collateralToken', type: 'address', indexed: false },
      { name: 'collateralAmount', type: 'uint128', indexed: false },
      { name: 'startPrice', type: 'uint256', indexed: false },
      { name: 'floorPrice', type: 'uint256', indexed: false },
      { name: 'isDefaultAuction', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AuctionBought',
    inputs: [
      { name: 'auctionId', type: 'uint256', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'collateralPurchased', type: 'uint128', indexed: false },
      { name: 'usdcPaid', type: 'uint128', indexed: false },
      { name: 'clearingPrice', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AuctionSettled',
    inputs: [
      { name: 'auctionId', type: 'uint256', indexed: true },
      { name: 'totalUsdcCollected', type: 'uint128', indexed: false },
      { name: 'debtPaid', type: 'uint128', indexed: false },
      { name: 'feePaid', type: 'uint128', indexed: false },
      { name: 'surplusToBorrower', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AuctionCancelled',
    inputs: [
      { name: 'auctionId', type: 'uint256', indexed: true },
      { name: 'loanId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'AuctionRestarted',
    inputs: [
      { name: 'auctionId', type: 'uint256', indexed: true },
      { name: 'newStartPrice', type: 'uint256', indexed: false },
      { name: 'newFloorPrice', type: 'uint256', indexed: false },
    ],
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
] as const;

export const positionNftAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'LoanClaimMinted',
    inputs: [
      { name: 'to', type: 'address', indexed: true },
      { name: 'loanId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'LoanClaimBurned',
    inputs: [{ name: 'loanId', type: 'uint256', indexed: true }],
  },
  {
    type: 'event',
    name: 'LoanAuctionLocked',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'locked', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isAuctionLocked',
    stateMutability: 'view',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export const assetRegistryAbi = [
  {
    type: 'event',
    name: 'AssetConfigSet',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      {
        name: 'config',
        type: 'tuple',
        indexed: false,
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
  {
    type: 'event',
    name: 'AssetStatusSet',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'status', type: 'uint8', indexed: false },
    ],
  },
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
    type: 'event',
    name: 'MultiplierSynced',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'multiplier', type: 'uint256', indexed: false },
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

export const collateralEscrowAbi = [
  {
    type: 'event',
    name: 'CollateralDeposited',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CollateralReleased',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export const b20Erc20Abi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
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
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'uiMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
