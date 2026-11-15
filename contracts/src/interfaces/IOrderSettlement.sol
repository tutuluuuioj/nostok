// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOrderSettlement
 * @notice EIP-712 offchain order verification and atomic onchain settlement.
 */
interface IOrderSettlement {
    struct BorrowOrder {
        address borrower;
        address collateralToken;
        uint128 collateralAmount;
        uint128 minUsdc;
        uint32 maxRateBps;
        uint16 termDays;
        uint16 maxLtvBps;
        uint128 minFill;
        uint64 expiry;
        uint256 nonce;
        uint8 yieldMode;
        bool allowInKindSettlement;
    }

    struct LendOffer {
        address lender;
        uint128 usdcAmount;
        uint32 minRateBps;
        uint16 termDays;
        address allowedCollateral;
        uint16 maxLtvBps;
        uint128 minFill;
        uint64 expiry;
        uint256 nonce;
        uint8 yieldMode;
    }

    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        uint256 loanId,
        uint128 fillAmountUsdc,
        uint128 collateralAmount
    );

    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
    event NonceBumped(address indexed maker, uint256 newNonce);

    function fillBorrowOrder(
        BorrowOrder calldata order,
        bytes calldata signature,
        uint128 fillUsdc
    ) external returns (uint256 loanId);

    function fillLendOffer(
        LendOffer calldata offer,
        bytes calldata signature,
        address collateralToken,
        uint128 collateralAmount,
        uint128 fillUsdc
    ) external returns (uint256 loanId);

    function cancelBorrowOrder(BorrowOrder calldata order) external;
    function cancelLendOffer(LendOffer calldata offer) external;
    function bumpNonce() external returns (uint256 newNonce);

    function hashBorrowOrder(BorrowOrder calldata order) external view returns (bytes32);
    function hashLendOffer(LendOffer calldata offer) external view returns (bytes32);
    function isOrderCancelled(bytes32 orderHash) external view returns (bool);
    function getOrderFilledAmount(bytes32 orderHash) external view returns (uint128);
    function getMakerNonce(address maker) external view returns (uint256);
}
