import { createPublicClient, defineChain, getAddress, http, isAddress, keccak256, stringToBytes } from 'viem';
import { base } from 'viem/chains';

export const BASE_CHAIN_ID = 8453;
export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_DECIMALS = 6;
export const ETH_DECIMALS = 18;
export const DEFAULT_B20_DECIMALS = 18;

export const OracleState = {
  VALID_OPEN: 0,
  VALID_CLOSED: 1,
  FROZEN_CORPORATE_ACTION: 2,
  STALE_FEED: 3,
  INVALID_SEQUENCER: 4,
  DISPUTED: 5,
};

export const ORACLE_STATE_NAMES = {
  0: 'VALID_OPEN',
  1: 'VALID_CLOSED',
  2: 'FROZEN_CORPORATE_ACTION',
  3: 'STALE_FEED',
  4: 'INVALID_SEQUENCER',
  5: 'DISPUTED',
};

export const ASSET_STATUS_NAMES = {
  0: 'Active',
  1: 'ReduceOnly',
  2: 'WindDown',
  3: 'Frozen',
};

export const ASSET_TIER_NAMES = {
  0: 'Tier A',
  1: 'Tier B',
};

export const LOAN_STATUS_NAMES = {
  0: 'Active',
  1: 'Grace',
  2: 'Auction',
  3: 'Repaid',
  4: 'SettledDefault',
  5: 'SettledLiquidated',
};

export const erc20Abi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  { type: 'function', name: 'uiMultiplier', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  {
    type: 'error',
    name: 'ERC20InsufficientBalance',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'balance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientAllowance',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'allowance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'ERC20InvalidSender', inputs: [{ name: 'sender', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidReceiver', inputs: [{ name: 'receiver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidApprover', inputs: [{ name: 'approver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidSpender', inputs: [{ name: 'spender', type: 'address' }] },
];

export const eligibilityGateAbi = [
  { type: 'function', name: 'ATTESTATION_TYPEHASH', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'attestationSigner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'permissionlessMode', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'allowlist', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'isOperator', stateMutability: 'view', inputs: [{ name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'userNonce', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  {
    type: 'function',
    name: 'getAttestationDigest',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'expiry', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'decodeAttestation',
    stateMutability: 'pure',
    inputs: [{ name: 'context', type: 'bytes' }],
    outputs: [
      { name: 'expiry', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
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
  { type: 'function', name: 'bumpMyNonce', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'event',
    name: 'AccountEligibilityUpdated',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'isAllowed', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'UserRevocationUpdated',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'isRevoked', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'UserNonceBumped',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'newNonce', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AttestationSignerUpdated',
    inputs: [{ name: 'newSigner', type: 'address', indexed: true }],
  },
  {
    type: 'event',
    name: 'PermissionlessModeUpdated',
    inputs: [{ name: 'enabled', type: 'bool', indexed: false }],
  },
  {
    type: 'event',
    name: 'OperatorUpdated',
    inputs: [
      { name: 'operator', type: 'address', indexed: true },
      { name: 'isAllowed', type: 'bool', indexed: false },
    ],
  },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'Unauthorized', inputs: [] },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
];

export const ELIGIBILITY_ATTESTATION_TYPEHASH_STRING =
  'Attestation(uint256 chainId,address gate,address account,uint256 nonce,uint256 expiry)';

export const ELIGIBILITY_DECLARATION_DOMAIN_NAME = 'NOSTOK Eligibility Declaration';
export const ELIGIBILITY_DECLARATION_DOMAIN_VERSION = '1';

export const ELIGIBILITY_DECLARATION_EIP712_TYPES = {
  EligibilityDeclaration: [
    { name: 'account', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'jurisdiction', type: 'string' },
    { name: 'statementHash', type: 'bytes32' },
  ],
};

export const RESTRICTED_JURISDICTIONS = ['US', 'CU', 'IR', 'KP', 'SY', 'RU', 'BY', 'MM'];

export const ELIGIBILITY_DECLARATION_STATEMENT =
  'I declare under Regulation S that I am an eligible non-US person located outside the United States and outside any sanctioned or restricted jurisdiction; I understand collateral sits in CollateralEscrow, lenders receive a PositionNFT debt claim, liquidation auctions return borrower surplus, liquidations pause when markets are closed or feeds are stale/frozen, and orders interact with NOSTOK contracts on Base.';

export const ELIGIBILITY_DECLARATION_STATEMENT_HASH = keccak256(
  stringToBytes(ELIGIBILITY_DECLARATION_STATEMENT)
);

export const DEFAULT_DECLARATION_TTL_SECS = 86_400n; // 24 hours
export const MAX_DECLARATION_TTL_SECS = 86_400n; // 24 hours max
export const MIN_DECLARATION_TTL_SECS = 60n; // 1 minute min

export const loanCoreAbi = [
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'globalUsdcCap', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint128' }] },
  { type: 'function', name: 'totalOutstandingPrincipal', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint128' }] },
  { type: 'function', name: 'assetOutstandingPrincipal', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint128' }] },
  { type: 'function', name: 'nextLoanId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'feeCollector', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'escrow', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'assetRegistry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'oracleRouter', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'SECONDS_PER_YEAR', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
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
  { type: 'function', name: 'getDueInterest', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: 'interestOwed', type: 'uint128' }] },
  { type: 'function', name: 'getClaimable', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: 'amount', type: 'uint128' }] },
  { type: 'function', name: 'loanExtensionNonce', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'loanActiveAuction', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'loanLastInterestAccruedTime', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'loanTotalRealInterestAccrued', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: '', type: 'uint128' }] },
  { type: 'function', name: 'loanInitialRateBps', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: '', type: 'uint32' }] },
  { type: 'function', name: 'GRACE_PERIOD_SECONDS', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'repay', stateMutability: 'nonpayable', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: 'totalPaid', type: 'uint128' }] },
  {
    type: 'function',
    name: 'partialRepay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'loanId', type: 'uint256' },
      { name: 'principalRepayAmount', type: 'uint128' },
    ],
    outputs: [{ name: 'totalPaid', type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'topUp',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'loanId', type: 'uint256' },
      { name: 'additionalCollateral', type: 'uint128' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'extend',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'loanId', type: 'uint256' },
      { name: 'newMaturity', type: 'uint64' },
      { name: 'newRateBps', type: 'uint32' },
      { name: 'deadline', type: 'uint64' },
      { name: 'counterpartySig', type: 'bytes' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }], outputs: [{ name: 'claimedAmount', type: 'uint128' }] },
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
  { type: 'error', name: 'UnauthorizedCaller', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'ProtocolPaused', inputs: [] },
  { type: 'error', name: 'GlobalCapExceeded', inputs: [] },
  { type: 'error', name: 'PerLoanCapExceeded', inputs: [] },
  { type: 'error', name: 'AssetCapExceeded', inputs: [] },
  { type: 'error', name: 'AssetNotActive', inputs: [] },
  { type: 'error', name: 'OracleInvalidForAction', inputs: [] },
  { type: 'error', name: 'LtvExceeded', inputs: [] },
  { type: 'error', name: 'InvalidLoanTerms', inputs: [] },
  { type: 'error', name: 'LoanNotActive', inputs: [] },
  { type: 'error', name: 'LoanNotInGrace', inputs: [] },
  { type: 'error', name: 'LoanNotLiquidatable', inputs: [] },
  { type: 'error', name: 'InsufficientPayment', inputs: [] },
  { type: 'error', name: 'OrderExpired', inputs: [] },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
];

export const LOAN_CORE_DOMAIN_NAME = 'NOSTOK Loan Core';
export const LOAN_CORE_DOMAIN_VERSION = '1';

export const EXTEND_ORDER_EIP712_TYPES = {
  ExtendOrder: [
    { name: 'loanId', type: 'uint256' },
    { name: 'newMaturity', type: 'uint64' },
    { name: 'newRateBps', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
};

export const ORDER_SETTLEMENT_DOMAIN_NAME = 'NOSTOK Order Settlement';
export const ORDER_SETTLEMENT_DOMAIN_VERSION = '1';

export const BORROW_ORDER_EIP712_TYPES = {
  BorrowOrder: [
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
};

export const LEND_OFFER_EIP712_TYPES = {
  LendOffer: [
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
};

export const orderSettlementAbi = [
  { type: 'function', name: 'getMakerNonce', stateMutability: 'view', inputs: [{ name: 'maker', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getOrderFilledAmount', stateMutability: 'view', inputs: [{ name: 'orderHash', type: 'bytes32' }], outputs: [{ name: '', type: 'uint128' }] },
  { type: 'function', name: 'isOrderCancelled', stateMutability: 'view', inputs: [{ name: 'orderHash', type: 'bytes32' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'bumpNonce', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'newNonce', type: 'uint256' }] },
  {
    type: 'function',
    name: 'hashBorrowOrder',
    stateMutability: 'view',
    inputs: [
      {
        name: 'o',
        type: 'tuple',
        components: BORROW_ORDER_EIP712_TYPES.BorrowOrder,
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'hashLendOffer',
    stateMutability: 'view',
    inputs: [
      {
        name: 'o',
        type: 'tuple',
        components: LEND_OFFER_EIP712_TYPES.LendOffer,
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'cancelBorrowOrder',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: BORROW_ORDER_EIP712_TYPES.BorrowOrder,
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelLendOffer',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'offer',
        type: 'tuple',
        components: LEND_OFFER_EIP712_TYPES.LendOffer,
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'fillBorrowOrder',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: BORROW_ORDER_EIP712_TYPES.BorrowOrder,
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
        components: BORROW_ORDER_EIP712_TYPES.BorrowOrder,
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
    name: 'fillLendOffer',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'offer',
        type: 'tuple',
        components: LEND_OFFER_EIP712_TYPES.LendOffer,
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
        components: LEND_OFFER_EIP712_TYPES.LendOffer,
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
  { type: 'error', name: 'Unauthorized', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'OrderExpired', inputs: [] },
  { type: 'error', name: 'OrderCancelledAlready', inputs: [] },
  { type: 'error', name: 'InvalidNonce', inputs: [] },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
  { type: 'error', name: 'FillAmountTooLow', inputs: [] },
  { type: 'error', name: 'OrderExceeded', inputs: [] },
  { type: 'error', name: 'IneligibleCounterparty', inputs: [] },
  { type: 'error', name: 'CollateralMismatch', inputs: [] },
];

export const assetRegistryAbi = [
  { type: 'function', name: 'isAssetSupported', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'getAssetStatus', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'oracleRouter', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
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
  { type: 'error', name: 'UnauthorizedCaller', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'AssetNotSupported', inputs: [] },
  { type: 'error', name: 'InvalidLtvParameters', inputs: [] },
  { type: 'error', name: 'InvalidDiscountParameters', inputs: [] },
  { type: 'error', name: 'GuardianCanOnlyTighten', inputs: [] },
  { type: 'error', name: 'InvalidStaleParameters', inputs: [] },
];

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
  { type: 'function', name: 'getOracleState', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: 'state', type: 'uint8' }] },
  { type: 'function', name: 'recordedMultiplier', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'isMarketOpen', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'isSequencerValid', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'maxStaleClosedSecs', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }] },
  { type: 'function', name: 'useManualMarketSession', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'isMarketOpenManual', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'sequencerUptimeFeed', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'assetRegistry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'InvalidAnswer', inputs: [] },
  { type: 'error', name: 'AssetNotConfigured', inputs: [] },
  { type: 'error', name: 'CorporateActionSplitPending', inputs: [] },
];

export const aggregatorV3Abi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
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
];

export const feeCollectorAbi = [
  { type: 'function', name: 'MAX_ORIGINATION_BPS', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'MAX_INTEREST_CUT_BPS', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'MAX_LIQUIDATION_BPS', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'originationFeeBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'interestCutBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'liquidationFeeBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'safetyReserveShareBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
  { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'safetyReserve', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'FeeCapExceeded', inputs: [] },
];

export const positionNftAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'isAuctionLocked', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'error', name: 'UnauthorizedCaller', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'AuctionTransferLocked', inputs: [] },
  { type: 'error', name: 'IneligibleRecipient', inputs: [] },
];

export const collateralEscrowAbi = [
  { type: 'function', name: 'getBalance', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'error', name: 'UnauthorizedCaller', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'InsufficientBalance', inputs: [] },
];

export const liquidationAuctionAbi = [
  { type: 'function', name: 'MIN_BUY_USDC', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint128' }] },
  { type: 'function', name: 'getCurrentPrice', stateMutability: 'view', inputs: [{ name: 'auctionId', type: 'uint256' }], outputs: [{ name: 'price', type: 'uint256' }] },
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
  { type: 'error', name: 'UnauthorizedCaller', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'AuctionNotActive', inputs: [] },
  { type: 'error', name: 'InvalidAuctionAmount', inputs: [] },
  { type: 'error', name: 'SlippageExceeded', inputs: [] },
  { type: 'error', name: 'BuyAmountTooSmall', inputs: [] },
  { type: 'error', name: 'AuctionExpired', inputs: [] },
  { type: 'error', name: 'OracleNotStaleOrFrozen', inputs: [] },
  { type: 'error', name: 'EmergencyCancelCooldownActive', inputs: [] },
];

const EXTRA_SYSTEM_ERROR_ABI = [
  { type: 'error', name: 'ECDSAInvalidSignature', inputs: [] },
  { type: 'error', name: 'ECDSAInvalidSignatureLength', inputs: [{ name: 'length', type: 'uint256' }] },
  { type: 'error', name: 'ECDSAInvalidSignatureS', inputs: [{ name: 's', type: 'bytes32' }] },
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'FeeCapExceeded', inputs: [] },
];

export const PROTOCOL_ERROR_ABI = Array.from(
  new Map(
    [
      ...orderSettlementAbi,
      ...loanCoreAbi,
      ...eligibilityGateAbi,
      ...assetRegistryAbi,
      ...oracleRouterAbi,
      ...feeCollectorAbi,
      ...positionNftAbi,
      ...collateralEscrowAbi,
      ...liquidationAuctionAbi,
      ...erc20Abi,
      ...EXTRA_SYSTEM_ERROR_ABI,
    ]
      .filter((item) => item.type === 'error')
      .map((item) => [`${item.name}(${(item.inputs ?? []).map((i) => i.type).join(',')})`, item])
  ).values()
);

export const REQUIRED_CONTRACT_KEYS = [
  'loanCore',
  'orderSettlement',
  'liquidationAuction',
  'positionNft',
  'collateralEscrow',
  'assetRegistry',
  'oracleRouter',
  'eligibilityGate',
];

let configOverrides = {};

function readEnv(key) {
  const viteEnv =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env[key]
      : undefined;
  if (viteEnv !== undefined && String(viteEnv).trim() !== '') {
    return String(viteEnv).trim();
  }
  const nodeEnv =
    typeof process !== 'undefined' && process.env
      ? process.env[key]
      : undefined;
  if (nodeEnv !== undefined && String(nodeEnv).trim() !== '') {
    return String(nodeEnv).trim();
  }
  return undefined;
}

function normalizeOptionalAddress(raw) {
  if (!raw || !isAddress(raw)) return undefined;
  return getAddress(raw);
}

function stripTrailingSlash(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function isProductionEnv(overrides) {
  if (typeof overrides.isProd === 'boolean') return overrides.isProd;
  const viteProd =
    typeof import.meta !== 'undefined' && import.meta.env
      ? Boolean(import.meta.env.PROD)
      : false;
  const nodeProd =
    typeof process !== 'undefined' && process.env
      ? process.env.NODE_ENV === 'production'
      : false;
  return viteProd || nodeProd;
}

function isForkEnv(overrides, isProd) {
  if (isProd) return false;
  if (typeof overrides.isFork === 'boolean') return overrides.isFork;
  return readEnv('VITE_IS_FORK') === 'true' || readEnv('FORK') === 'true';
}

export function getMissingContractAddresses(cfg) {
  const c = cfg?.contracts ?? {};
  return REQUIRED_CONTRACT_KEYS.filter((key) => !c[key]);
}

export function setFrontendConfigOverrides(overrides = {}) {
  configOverrides = { ...overrides };
}

export function getFrontendConfig() {
  const isProd = isProductionEnv(configOverrides);
  const isFork = isForkEnv(configOverrides, isProd);
  const rawChainId = configOverrides.chainId ?? readEnv('VITE_CHAIN_ID');
  const hasChainId = rawChainId !== undefined && String(rawChainId).trim() !== '';
  const parsedChainId = hasChainId ? Number(rawChainId) : (isProd ? NaN : BASE_CHAIN_ID);
  const chainId = Number.isInteger(parsedChainId) && parsedChainId > 0 ? parsedChainId : NaN;

  const rpcUrl = stripTrailingSlash(configOverrides.rpcUrl ?? readEnv('VITE_RPC_URL') ?? 'https://mainnet.base.org');
  const apiUrl = stripTrailingSlash(
    configOverrides.apiUrl ?? readEnv('VITE_API_URL') ?? 'http://127.0.0.1:3001'
  );
  const notificationsUrl = stripTrailingSlash(
    configOverrides.notificationsUrl ?? readEnv('VITE_NOTIFICATIONS_URL') ?? 'http://127.0.0.1:3003'
  );
  const riskUrl = stripTrailingSlash(
    configOverrides.riskUrl ?? readEnv('VITE_RISK_URL') ?? (isProd ? '' : 'http://127.0.0.1:3002')
  );
  const siweDomain = configOverrides.siweDomain ?? readEnv('VITE_SIWE_DOMAIN');
  const siweOrigin = configOverrides.siweOrigin ?? readEnv('VITE_SIWE_ORIGIN');

  const rawUsdc = configOverrides.usdcAddress ?? readEnv('VITE_USDC_ADDRESS');
  const cleanUsdc = rawUsdc !== undefined ? String(rawUsdc).trim() : '';
  if (cleanUsdc !== '' && !isAddress(cleanUsdc)) {
    throw new Error(`Invalid VITE_USDC_ADDRESS: "${cleanUsdc}".`);
  }
  const normalizedUsdcOverride = cleanUsdc ? getAddress(cleanUsdc) : undefined;
  if ((!isFork || isProd) && normalizedUsdcOverride && normalizedUsdcOverride !== BASE_USDC_ADDRESS) {
    throw new Error(
      `VITE_USDC_ADDRESS override (${normalizedUsdcOverride}) is prohibited outside fork/test mode; Base USDC is pinned to ${BASE_USDC_ADDRESS}.`
    );
  }
  const usdcAddress = isFork && !isProd ? (normalizedUsdcOverride ?? BASE_USDC_ADDRESS) : BASE_USDC_ADDRESS;

  const contracts = {
    loanCore: normalizeOptionalAddress(configOverrides.loanCore ?? readEnv('VITE_LOAN_CORE_ADDRESS')),
    orderSettlement: normalizeOptionalAddress(
      configOverrides.orderSettlement ?? readEnv('VITE_ORDER_SETTLEMENT_ADDRESS')
    ),
    liquidationAuction: normalizeOptionalAddress(
      configOverrides.liquidationAuction ?? readEnv('VITE_LIQUIDATION_AUCTION_ADDRESS')
    ),
    positionNft: normalizeOptionalAddress(configOverrides.positionNft ?? readEnv('VITE_POSITION_NFT_ADDRESS')),
    collateralEscrow: normalizeOptionalAddress(
      configOverrides.collateralEscrow ?? readEnv('VITE_COLLATERAL_ESCROW_ADDRESS')
    ),
    assetRegistry: normalizeOptionalAddress(
      configOverrides.assetRegistry ?? readEnv('VITE_ASSET_REGISTRY_ADDRESS')
    ),
    oracleRouter: normalizeOptionalAddress(configOverrides.oracleRouter ?? readEnv('VITE_ORACLE_ROUTER_ADDRESS')),
    eligibilityGate: normalizeOptionalAddress(
      configOverrides.eligibilityGate ?? readEnv('VITE_ELIGIBILITY_GATE_ADDRESS')
    ),
  };

  if (isProd) {
    if (chainId !== BASE_CHAIN_ID) {
      throw new Error(
        `Production builds require VITE_CHAIN_ID=${BASE_CHAIN_ID} (got ${hasChainId ? rawChainId : 'unset'}).`
      );
    }
    if (!rpcUrl.startsWith('https://') || rpcUrl === 'https://mainnet.base.org') {
      throw new Error(
        'Production builds require a private https:// Base RPC endpoint in VITE_RPC_URL (public https://mainnet.base.org is disallowed).'
      );
    }
    if (!apiUrl.startsWith('https://')) {
      throw new Error(`Production builds require an https:// VITE_API_URL (got "${apiUrl}").`);
    }
    if (!notificationsUrl.startsWith('https://')) {
      throw new Error(`Production builds require an https:// VITE_NOTIFICATIONS_URL (got "${notificationsUrl}").`);
    }
    if (riskUrl && !riskUrl.startsWith('https://')) {
      throw new Error(`Production builds require an https:// VITE_RISK_URL (got "${riskUrl}").`);
    }
    const missing = REQUIRED_CONTRACT_KEYS.filter((k) => !contracts[k]);
    if (missing.length > 0) {
      throw new Error(`Production build missing required protocol contract address(es): ${missing.join(', ')}.`);
    }
  }

  return {
    isProd,
    isFork,
    chainId: Number.isInteger(chainId) ? chainId : BASE_CHAIN_ID,
    rpcUrl,
    apiUrl,
    notificationsUrl,
    riskUrl,
    siweDomain: siweDomain ? String(siweDomain).trim() : undefined,
    siweOrigin: siweOrigin ? stripTrailingSlash(siweOrigin) : undefined,
    usdcAddress,
    contracts,
  };
}

export function buildContentSecurityPolicy(
  cfg = getFrontendConfig(),
  { includeFrameAncestors = true, allowDevInlineScripts = false } = {}
) {
  const connectSources = new Set(["'self'"]);
  const urls = [cfg?.rpcUrl, cfg?.apiUrl, cfg?.notificationsUrl, cfg?.riskUrl, cfg?.siweOrigin];
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        connectSources.add(parsed.origin);
      }
    } catch {
      // ignore malformed URL
    }
  }
  if (!cfg?.isProd) {
    connectSources.add('http://127.0.0.1:*');
    connectSources.add('http://localhost:*');
    connectSources.add('ws://127.0.0.1:*');
    connectSources.add('ws://localhost:*');
  }
  const scriptSrc =
    !cfg?.isProd && allowDevInlineScripts ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  const directives = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${Array.from(connectSources).join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  if (includeFrameAncestors) {
    directives.push("frame-ancestors 'none'");
  }
  return `${directives.join('; ')};`;
}

export function createProtocolPublicClient(cfg = getFrontendConfig()) {
  const chain = defineChain({
    ...base,
    id: cfg.chainId,
    name: 'Base',
    rpcUrls: {
      default: { http: [cfg.rpcUrl] },
    },
  });
  return createPublicClient({
    chain,
    transport: http(cfg.rpcUrl),
  });
}
