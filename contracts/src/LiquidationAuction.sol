// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {ILiquidationAuction} from "./interfaces/ILiquidationAuction.sol";
import {ICollateralEscrow} from "./interfaces/ICollateralEscrow.sol";
import {ILoanCore} from "./interfaces/ILoanCore.sol";
import {IFeeCollector} from "./interfaces/IFeeCollector.sol";

/**
 * @title LiquidationAuction
 * @notice Reverse Dutch auction engine for partial and full collateral liquidation.
 * Sells just enough collateral to cover debt, with all residual surplus refunded to the borrower.
 */
contract LiquidationAuction is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    ILiquidationAuction
{
    using SafeERC20 for IERC20;

    address public escrow;
    address public loanCore;
    address public feeCollector;
    address public usdc;

    uint256 public nextAuctionId;
    mapping(uint256 => Auction) public auctions;

    error UnauthorizedCaller();
    error ZeroAddress();
    error AuctionNotActive();
    error InvalidAuctionAmount();
    error SlippageExceeded();

    modifier onlyLoanCore() {
        if (msg.sender != loanCore) revert UnauthorizedCaller();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        address initialEscrow,
        address initialLoanCore,
        address initialFeeCollector,
        address initialUsdc
    ) external initializer {
        if (
            initialOwner == address(0) ||
            initialEscrow == address(0) ||
            initialLoanCore == address(0) ||
            initialFeeCollector == address(0) ||
            initialUsdc == address(0)
        ) {
            revert ZeroAddress();
        }
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        escrow = initialEscrow;
        loanCore = initialLoanCore;
        feeCollector = initialFeeCollector;
        usdc = initialUsdc;
        nextAuctionId = 1;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setLoanCore(address newCore) external onlyOwner {
        if (newCore == address(0)) revert ZeroAddress();
        loanCore = newCore;
    }

    function setEscrow(address newEscrow) external onlyOwner {
        if (newEscrow == address(0)) revert ZeroAddress();
        escrow = newEscrow;
    }

    function setFeeCollector(address newCollector) external onlyOwner {
        if (newCollector == address(0)) revert ZeroAddress();
        feeCollector = newCollector;
    }

    /**
     * @notice Initiates a Dutch auction for a liquidatable or defaulted loan.
     */
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
        bool isFullLiquidation
    ) external override onlyLoanCore returns (uint256 auctionId) {
        if (collateralAmount == 0 || oraclePrice == 0) revert InvalidAuctionAmount();

        auctionId = nextAuctionId++;

        // Start at oracle price minus 1% (99%)
        uint256 startPrice = (oraclePrice * 99) / 100;
        // Floor price decays down to oracle price minus max discount
        uint256 floorPrice = (oraclePrice * (10000 - maxDiscountBps)) / 10000;

        auctions[auctionId] = Auction({
            loanId: loanId,
            borrower: borrower,
            collateralToken: collateralToken,
            collateralTotal: collateralAmount,
            collateralRemaining: collateralAmount,
            debtPrincipal: debtPrincipal,
            debtInterest: debtInterest,
            startPrice: startPrice,
            floorPrice: floorPrice,
            startTime: uint64(block.timestamp),
            duration: 1800, // 30 minutes
            keeper: keeper,
            status: AuctionStatus.Active,
            isFullLiquidation: isFullLiquidation
        });

        emit AuctionStarted(
            auctionId,
            loanId,
            borrower,
            collateralToken,
            collateralAmount,
            startPrice,
            floorPrice,
            isFullLiquidation
        );
    }

    /**
     * @notice Returns the current decaying price of the auction.
     */
    function getCurrentPrice(uint256 auctionId) public view override returns (uint256) {
        Auction storage a = auctions[auctionId];
        if (a.status != AuctionStatus.Active) return a.floorPrice;

        uint256 elapsed = block.timestamp - a.startTime;
        if (elapsed >= a.duration) {
            return a.floorPrice;
        }

        uint256 priceDrop = ((a.startPrice - a.floorPrice) * elapsed) / a.duration;
        return a.startPrice - priceDrop;
    }

    /**
     * @notice Purchases collateral from an active auction.
     */
    function buy(
        uint256 auctionId,
        uint128 collateralAmount,
        uint128 maxUsdcPayment
    ) external override nonReentrant returns (uint128 usdcPaid) {
        Auction storage a = auctions[auctionId];
        if (a.status != AuctionStatus.Active) revert AuctionNotActive();
        if (collateralAmount == 0 || collateralAmount > a.collateralRemaining) {
            revert InvalidAuctionAmount();
        }

        uint256 currentPrice = getCurrentPrice(auctionId);
        uint8 tokenDecimals = IERC20Metadata(a.collateralToken).decimals();

        // Feed prices are 8 decimals; collateral has tokenDecimals; USDC has 6 decimals
        // usdcCost = (collateralAmount * currentPrice * 1e6) / (10^tokenDecimals * 10^8)
        uint256 numerator = uint256(collateralAmount) * currentPrice * 1e6;
        uint256 denominator = (10 ** tokenDecimals) * 1e8;
        usdcPaid = uint128((numerator + denominator - 1) / denominator);

        if (usdcPaid > maxUsdcPayment) revert SlippageExceeded();

        a.collateralRemaining -= collateralAmount;

        // Pull USDC from buyer
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcPaid);

        // Release collateral from escrow to buyer
        ICollateralEscrow(escrow).releaseCollateral(a.collateralToken, msg.sender, collateralAmount);

        // Settle distribution:
        // 1. Fee calculation
        (uint128 protocolFee, uint128 keeperReward) = IFeeCollector(feeCollector).calculateLiquidationFee(usdcPaid);
        uint128 totalFee = protocolFee + keeperReward;

        if (keeperReward > 0 && a.keeper != address(0)) {
            IERC20(usdc).safeTransfer(a.keeper, keeperReward);
        }
        if (protocolFee > 0) {
            IERC20(usdc).forceApprove(feeCollector, protocolFee);
            IFeeCollector(feeCollector).distributeFees(usdc, protocolFee);
        }

        uint128 netProceeds = usdcPaid - totalFee;
        uint128 totalDebt = a.debtPrincipal + a.debtInterest;
        uint128 debtPayment = netProceeds > totalDebt ? totalDebt : netProceeds;
        uint128 surplus = netProceeds > totalDebt ? netProceeds - totalDebt : 0;

        // Send debt payment to LoanCore
        IERC20(usdc).forceApprove(loanCore, debtPayment);
        ILoanCore(loanCore).onAuctionSettlement(
            a.loanId,
            debtPayment,
            collateralAmount,
            a.isFullLiquidation
        );

        // Refund any surplus USDC directly to borrower (Core Fairness Property D3)
        if (surplus > 0) {
            IERC20(usdc).safeTransfer(a.borrower, surplus);
        }

        emit AuctionBought(auctionId, msg.sender, collateralAmount, usdcPaid, currentPrice);

        if (a.collateralRemaining == 0 || debtPayment >= totalDebt) {
            a.status = AuctionStatus.Settled;
            // If collateral remains but debt was fully settled, return leftover collateral to borrower
            if (a.collateralRemaining > 0) {
                ICollateralEscrow(escrow).releaseCollateral(
                    a.collateralToken,
                    a.borrower,
                    a.collateralRemaining
                );
                a.collateralRemaining = 0;
            }

            emit AuctionSettled(auctionId, usdcPaid, debtPayment, totalFee, surplus);
        }
    }

    function getAuction(uint256 auctionId) external view override returns (Auction memory) {
        return auctions[auctionId];
    }
}
