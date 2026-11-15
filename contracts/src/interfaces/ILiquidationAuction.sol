// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ILiquidationAuction
 * @notice Dutch auction pricing engine for partial and full liquidation of collateral.
 */
interface ILiquidationAuction {
    enum AuctionStatus {
        Active,
        Settled,
        Cancelled
    }

    struct Auction {
        uint256 loanId;
        address borrower;
        address collateralToken;
        uint128 collateralTotal;
        uint128 collateralRemaining;
        uint128 debtPrincipalRemaining;
        uint128 debtInterestRemaining;
        uint256 startPrice;
        uint256 floorPrice;
        uint64 startTime;
        uint64 duration;
        address keeper;
        AuctionStatus status;
        bool isDefaultAuction;
    }

    event AuctionStarted(
        uint256 indexed auctionId,
        uint256 indexed loanId,
        address indexed borrower,
        address collateralToken,
        uint128 collateralAmount,
        uint256 startPrice,
        uint256 floorPrice,
        bool isDefaultAuction
    );

    event AuctionBought(
        uint256 indexed auctionId,
        address indexed buyer,
        uint128 collateralPurchased,
        uint128 usdcPaid,
        uint256 clearingPrice
    );

    event AuctionSettled(
        uint256 indexed auctionId,
        uint128 totalUsdcCollected,
        uint128 debtPaid,
        uint128 feePaid,
        uint128 surplusToBorrower
    );

    event AuctionCancelled(uint256 indexed auctionId, uint256 indexed loanId);
    event AuctionRestarted(uint256 indexed auctionId, uint256 newStartPrice, uint256 newFloorPrice);

    function startAuction(
        uint256 loanId,
        address borrower,
        address collateralToken,
        uint128 collateralAmount,
        uint128 debtPrincipal,
        uint128 debtInterest,
        uint256 oraclePrice,
        uint16 maxDiscountBps,
        address keeper,
        bool isDefaultAuction
    ) external returns (uint256 auctionId);

    function buy(
        uint256 auctionId,
        uint128 collateralAmount,
        uint128 maxUsdcPayment
    ) external returns (uint128 usdcPaid);

    function cancelAuction(uint256 auctionId) external;
    function restartOrCancelAuction(uint256 auctionId) external;

    function getCurrentPrice(uint256 auctionId) external view returns (uint256 price);
    function getAuction(uint256 auctionId) external view returns (Auction memory);
}
