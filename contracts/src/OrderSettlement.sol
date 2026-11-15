// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {IOrderSettlement} from "./interfaces/IOrderSettlement.sol";
import {ILoanCore} from "./interfaces/ILoanCore.sol";
import {IEligibilityGate} from "./interfaces/IEligibilityGate.sol";

/**
 * @title OrderSettlement
 * @notice EIP-712 offchain orderbook validation, nonces, fill tracking, and atomic execution.
 */
contract OrderSettlement is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    EIP712Upgradeable,
    IOrderSettlement
{
    bytes32 public constant BORROW_ORDER_TYPEHASH = keccak256(
        "BorrowOrder(address borrower,address collateralToken,uint128 collateralAmount,uint128 minUsdc,uint32 maxRateBps,uint16 termDays,uint16 maxLtvBps,uint128 minFill,uint64 expiry,uint256 nonce,uint8 yieldMode,bool allowInKindSettlement)"
    );

    bytes32 public constant LEND_OFFER_TYPEHASH = keccak256(
        "LendOffer(address lender,uint128 usdcAmount,uint32 minRateBps,uint16 termDays,address allowedCollateral,uint16 maxLtvBps,uint128 minFill,uint64 expiry,uint256 nonce,uint8 yieldMode)"
    );

    address public loanCore;
    address public eligibilityGate;

    mapping(bytes32 => bool) public override isOrderCancelled;
    mapping(bytes32 => uint128) public override getOrderFilledAmount;
    mapping(address => uint256) public override getMakerNonce;

    error Unauthorized();
    error ZeroAddress();
    error OrderExpired();
    error OrderCancelledAlready();
    error InvalidNonce();
    error InvalidSignature();
    error FillAmountTooLow();
    error OrderExceeded();
    error IneligibleCounterparty();
    error CollateralMismatch();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        address initialLoanCore,
        address initialGate
    ) external initializer {
        if (initialOwner == address(0) || initialLoanCore == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __EIP712_init("NOSTOK Order Settlement", "1");

        loanCore = initialLoanCore;
        eligibilityGate = initialGate;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setLoanCore(address newCore) external onlyOwner {
        if (newCore == address(0)) revert ZeroAddress();
        loanCore = newCore;
    }

    function setEligibilityGate(address newGate) external onlyOwner {
        eligibilityGate = newGate;
    }

    function cancelBorrowOrder(BorrowOrder calldata order) external override {
        if (msg.sender != order.borrower) revert Unauthorized();
        bytes32 orderHash = hashBorrowOrder(order);
        isOrderCancelled[orderHash] = true;
        emit OrderCancelled(orderHash, msg.sender);
    }

    function cancelLendOffer(LendOffer calldata offer) external override {
        if (msg.sender != offer.lender) revert Unauthorized();
        bytes32 orderHash = hashLendOffer(offer);
        isOrderCancelled[orderHash] = true;
        emit OrderCancelled(orderHash, msg.sender);
    }

    function bumpNonce() external override returns (uint256 newNonce) {
        newNonce = ++getMakerNonce[msg.sender];
        emit NonceBumped(msg.sender, newNonce);
    }

    function hashBorrowOrder(BorrowOrder calldata o) public view override returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    BORROW_ORDER_TYPEHASH,
                    o.borrower,
                    o.collateralToken,
                    o.collateralAmount,
                    o.minUsdc,
                    o.maxRateBps,
                    o.termDays,
                    o.maxLtvBps,
                    o.minFill,
                    o.expiry,
                    o.nonce,
                    o.yieldMode,
                    o.allowInKindSettlement
                )
            )
        );
    }

    function hashLendOffer(LendOffer calldata o) public view override returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LEND_OFFER_TYPEHASH,
                    o.lender,
                    o.usdcAmount,
                    o.minRateBps,
                    o.termDays,
                    o.allowedCollateral,
                    o.maxLtvBps,
                    o.minFill,
                    o.expiry,
                    o.nonce,
                    o.yieldMode
                )
            )
        );
    }

    /**
     * @notice Taker (Lender) fills an offchain signed Borrow Order.
     */
    function fillBorrowOrder(
        BorrowOrder calldata order,
        bytes calldata signature,
        uint128 fillUsdc
    ) external override returns (uint256 loanId) {
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (order.nonce != getMakerNonce[order.borrower]) revert InvalidNonce();

        bytes32 orderHash = hashBorrowOrder(order);
        if (isOrderCancelled[orderHash]) revert OrderCancelledAlready();

        address recovered = ECDSA.recover(orderHash, signature);
        if (recovered != order.borrower) revert InvalidSignature();

        if (eligibilityGate != address(0)) {
            if (
                !IEligibilityGate(eligibilityGate).isEligible(order.borrower, "") ||
                !IEligibilityGate(eligibilityGate).isEligible(msg.sender, "")
            ) {
                revert IneligibleCounterparty();
            }
        }

        uint128 filled = getOrderFilledAmount[orderHash];
        uint128 remaining = order.minUsdc - filled;
        if (fillUsdc > remaining) revert OrderExceeded();
        if (fillUsdc < order.minFill && fillUsdc != remaining) revert FillAmountTooLow();

        // Pro-rata collateral calculation (rounded up in escrow's favor)
        uint128 collateralForFill = uint128(
            (uint256(order.collateralAmount) * fillUsdc + (order.minUsdc - 1)) / order.minUsdc
        );

        getOrderFilledAmount[orderHash] = filled + fillUsdc;

        loanId = ILoanCore(loanCore).openLoan(
            order.borrower,
            msg.sender, // Lender
            order.collateralToken,
            collateralForFill,
            fillUsdc,
            order.maxRateBps,
            order.termDays,
            order.maxLtvBps,
            3,
            order.yieldMode
        );

        emit OrderFilled(orderHash, order.borrower, msg.sender, loanId, fillUsdc, collateralForFill);
    }

    /**
     * @notice Taker (Borrower) fills an offchain signed Lend Offer.
     */
    function fillLendOffer(
        LendOffer calldata offer,
        bytes calldata signature,
        address collateralToken,
        uint128 collateralAmount,
        uint128 fillUsdc
    ) external override returns (uint256 loanId) {
        if (block.timestamp > offer.expiry) revert OrderExpired();
        if (offer.nonce != getMakerNonce[offer.lender]) revert InvalidNonce();
        if (offer.allowedCollateral != address(0) && collateralToken != offer.allowedCollateral) {
            revert CollateralMismatch();
        }

        bytes32 orderHash = hashLendOffer(offer);
        if (isOrderCancelled[orderHash]) revert OrderCancelledAlready();

        address recovered = ECDSA.recover(orderHash, signature);
        if (recovered != offer.lender) revert InvalidSignature();

        if (eligibilityGate != address(0)) {
            if (
                !IEligibilityGate(eligibilityGate).isEligible(offer.lender, "") ||
                !IEligibilityGate(eligibilityGate).isEligible(msg.sender, "")
            ) {
                revert IneligibleCounterparty();
            }
        }

        uint128 filled = getOrderFilledAmount[orderHash];
        uint128 remaining = offer.usdcAmount - filled;
        if (fillUsdc > remaining) revert OrderExceeded();
        if (fillUsdc < offer.minFill && fillUsdc != remaining) revert FillAmountTooLow();

        getOrderFilledAmount[orderHash] = filled + fillUsdc;

        loanId = ILoanCore(loanCore).openLoan(
            msg.sender, // Borrower
            offer.lender,
            collateralToken,
            collateralAmount,
            fillUsdc,
            offer.minRateBps,
            offer.termDays,
            offer.maxLtvBps,
            3,
            offer.yieldMode
        );

        emit OrderFilled(orderHash, offer.lender, msg.sender, loanId, fillUsdc, collateralAmount);
    }
}
