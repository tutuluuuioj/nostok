// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ILoanCore
 * @notice Central loan state machine, bullet interest math, and lifecycle operations.
 */
interface ILoanCore {
    enum LoanStatus {
        Active,             // 0: Normal live loan
        Grace,              // 1: Maturity passed, within 24h grace window, penalty interest
        Auction,            // 2: Liquidation auction in progress, NFT transfer locked
        Repaid,             // 3: Successfully repaid, collateral released to borrower
        SettledDefault,     // 4: Settled after grace expired default auction
        SettledLiquidated   // 5: Settled via LTV liquidation auction
    }

    struct Loan {
        address borrower;
        address collateralToken;
        uint128 collateralRaw;
        uint128 principal;
        uint64 startTime;
        uint64 maturity;
        uint32 rateBps;
        uint32 penaltySpreadBps;
        uint16 initLtvBps;
        uint16 marginCallLtvBps;
        uint16 liqLtvBps;
        uint16 minInterestDays;
        uint8 status;
        uint8 yieldMode;
        uint8 coreVersion;
        uint128 interestPaid;
        uint128 principalRepaid;
    }

    event LoanOpened(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed lender,
        address collateralToken,
        uint128 collateralAmount,
        uint128 principal,
        uint32 rateBps,
        uint64 maturity
    );

    event Repaid(uint256 indexed loanId, address indexed payer, uint128 principalPaid, uint128 interestPaid);
    event PartialRepaid(uint256 indexed loanId, address indexed payer, uint128 principalPaid, uint128 interestPaid, uint128 collateralReleased);
    event ToppedUp(uint256 indexed loanId, address indexed funder, uint128 additionalCollateral);
    event Extended(uint256 indexed loanId, uint64 newMaturity, uint32 newRateBps);
    event StatusSynced(uint256 indexed loanId, LoanStatus status);
    event RolledOver(uint256 indexed oldLoanId, uint256 indexed newLoanId);
    event Claimed(address indexed recipient, uint128 amount);
    event BadDebtRecorded(uint256 indexed loanId, uint128 shortfall);

    function openLoan(
        address borrower,
        address lender,
        address collateralToken,
        uint128 collateralAmount,
        uint128 principal,
        uint32 rateBps,
        uint16 termDays,
        uint16 maxLtvBps,
        uint16 minInterestDays,
        uint8 yieldMode
    ) external returns (uint256 loanId);

    function repay(uint256 loanId) external returns (uint128 totalPaid);
    function partialRepay(uint256 loanId, uint128 principalRepayAmount) external returns (uint128 totalPaid);
    function topUp(uint256 loanId, uint128 additionalCollateral) external;
    function extend(
        uint256 loanId,
        uint64 newMaturity,
        uint32 newRateBps,
        uint64 deadline,
        bytes calldata counterpartySig
    ) external;
    function startLiquidation(uint256 loanId) external returns (uint256 auctionId);
    function startDefaultAuction(uint256 loanId) external returns (uint256 auctionId);
    function onAuctionSettlement(
        uint256 loanId,
        uint128 principalPaid,
        uint128 interestPaid,
        uint128 collateralSold,
        bool isAuctionCollateralDepleted,
        bool isDefault
    ) external;
    function onAuctionCancelled(uint256 loanId) external;
    function claim(address to) external returns (uint128 claimedAmount);
    function syncStatus(uint256 loanId) external returns (LoanStatus);

    function getLoan(uint256 loanId) external view returns (Loan memory);
    function getDueInterest(uint256 loanId) external view returns (uint128 interestOwed);
    function getClaimable(address account) external view returns (uint128 amount);
    function loanLastInterestAccruedTime(uint256 loanId) external view returns (uint64);
    function loanUnpaidInterest(uint256 loanId) external view returns (uint128);
    function oracleRouter() external view returns (address);
    function assetRegistry() external view returns (address);
}
