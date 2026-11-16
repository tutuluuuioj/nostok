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
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";

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

    uint128 public constant MIN_BUY_USDC = 10 * 1e6; // $10 USDC min buy to prevent dust griefing
    uint256 public constant EMERGENCY_CANCEL_COOLDOWN = 1 hours;

    address public escrow;
    address public loanCore;
    address public feeCollector;
    address public usdc;

    uint256 public nextAuctionId;
    mapping(uint256 => Auction) public auctions;
    mapping(uint256 => uint256) public lastEmergencyCancelTime; // loanId => timestamp

    error UnauthorizedCaller();
    error ZeroAddress();
    error AuctionNotActive();
    error InvalidAuctionAmount();
    error SlippageExceeded();
    error BuyAmountTooSmall();
    error AuctionExpired();
    error OracleNotStaleOrFrozen();
    error EmergencyCancelCooldownActive();

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
        bool isDefaultAuction
    ) external override onlyLoanCore returns (uint256 auctionId) {
        if (collateralAmount == 0 || oraclePrice == 0) revert InvalidAuctionAmount();

        auctionId = nextAuctionId++;

        uint256 startPrice = (oraclePrice * 99) / 100;
        uint256 floorPrice = (oraclePrice * (10000 - maxDiscountBps)) / 10000;

        auctions[auctionId] = Auction({
            loanId: loanId,
            borrower: borrower,
            collateralToken: collateralToken,
            collateralTotal: collateralAmount,
            collateralRemaining: collateralAmount,
            debtPrincipalRemaining: debtPrincipal,
            debtInterestRemaining: debtInterest,
            startPrice: startPrice,
            floorPrice: floorPrice,
            startTime: uint64(block.timestamp),
            duration: 1800, // 30 minutes
            keeper: keeper,
            status: AuctionStatus.Active,
            isDefaultAuction: isDefaultAuction
        });

        emit AuctionStarted(
            auctionId,
            loanId,
            borrower,
            collateralToken,
            collateralAmount,
            startPrice,
            floorPrice,
            isDefaultAuction
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
        address router = ILoanCore(loanCore).oracleRouter();
        (, , IOracleRouter.OracleState oState) = IOracleRouter(router).getPrice(a.collateralToken);
        bool isStaleOrFrozen = (oState == IOracleRouter.OracleState.STALE_FEED || oState == IOracleRouter.OracleState.FROZEN_CORPORATE_ACTION);
        bool marketOpen = IOracleRouter(router).isMarketOpen();

        // Require fresh Dutch auction restart during open market unless oracle feed is stale or frozen.
        // During closed market (weekend) or stale/frozen feeds, floor buys are permitted to prevent deadlock.
        if (block.timestamp > a.startTime + a.duration && marketOpen && !isStaleOrFrozen) {
            revert AuctionExpired();
        }
        if (collateralAmount == 0 || collateralAmount > a.collateralRemaining) {
            revert InvalidAuctionAmount();
        }

        uint256 currentPrice = getCurrentPrice(auctionId);
        uint8 tokenDecimals = IERC20Metadata(a.collateralToken).decimals();

        uint256 numerator = uint256(collateralAmount) * currentPrice * 1e6;
        uint256 denominator = (10 ** tokenDecimals) * 1e8;
        usdcPaid = uint128((numerator + denominator - 1) / denominator);

        // Enforce min buy size unless purchasing the remainder of the auction
        if (usdcPaid < MIN_BUY_USDC && collateralAmount != a.collateralRemaining) {
            revert BuyAmountTooSmall();
        }

        if (usdcPaid > maxUsdcPayment) revert SlippageExceeded();

        a.collateralRemaining -= collateralAmount;

        // Auto-close dust remainder: if remaining collateral value is under MIN_BUY_USDC ($10),
        // nobody will spend gas to buy it. Send dust to borrower and close auction.
        uint128 dustCollateral = 0;
        if (a.collateralRemaining > 0) {
            uint256 remVal = (uint256(a.collateralRemaining) * currentPrice * 1e6) /
                ((10 ** tokenDecimals) * 1e8);
            if (remVal < MIN_BUY_USDC) {
                dustCollateral = a.collateralRemaining;
                a.collateralRemaining = 0;
                if (a.borrower != address(0)) {
                    ICollateralEscrow(escrow).releaseCollateral(a.collateralToken, a.borrower, dustCollateral);
                }
            }
        }

        // Pull USDC from buyer
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcPaid);

        // Release collateral from escrow to buyer
        ICollateralEscrow(escrow).releaseCollateral(a.collateralToken, msg.sender, collateralAmount);

        // Protocol & keeper fee calculation
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

        // Recompute real-time due interest so zero interest is dropped between auction snapshot and buy
        uint128 currentDueInterest = ILoanCore(loanCore).getDueInterest(a.loanId);
        a.debtInterestRemaining = currentDueInterest;

        // Debt waterfall: Interest paid first, then principal
        uint128 interestPayment = netProceeds > a.debtInterestRemaining
            ? a.debtInterestRemaining
            : netProceeds;
        a.debtInterestRemaining -= interestPayment;

        uint128 principalAvailable = netProceeds - interestPayment;
        uint128 principalPayment = principalAvailable > a.debtPrincipalRemaining
            ? a.debtPrincipalRemaining
            : principalAvailable;
        a.debtPrincipalRemaining -= principalPayment;

        uint128 surplus = principalAvailable - principalPayment;
        uint128 totalDebtPaid = interestPayment + principalPayment;

        // Auction completes when its collateral is depleted OR all debt is paid
        bool isAuctionCollateralDepleted = (a.collateralRemaining == 0);
        bool debtZero = (a.debtPrincipalRemaining == 0 && a.debtInterestRemaining == 0);
        bool isAuctionSettled = isAuctionCollateralDepleted || debtZero;

        // If debt is fully paid and collateral remains, clear remaining collateral in auction.
        // Leftover collateral is released to borrower in LoanCore.onAuctionSettlement.
        if (debtZero && a.collateralRemaining > 0) {
            a.collateralRemaining = 0;
        }

        // Refund any surplus USDC directly to borrower
        if (surplus > 0) {
            IERC20(usdc).safeTransfer(a.borrower, surplus);
        }

        // Send debt payment to LoanCore and update state
        if (totalDebtPaid > 0) {
            IERC20(usdc).forceApprove(loanCore, totalDebtPaid);
        }

        ILoanCore(loanCore).onAuctionSettlement(
            a.loanId,
            principalPayment,
            interestPayment,
            collateralAmount + dustCollateral,
            isAuctionCollateralDepleted,
            a.isDefaultAuction
        );

        emit AuctionBought(auctionId, msg.sender, collateralAmount, usdcPaid, currentPrice);

        if (isAuctionSettled) {
            a.status = AuctionStatus.Settled;
            emit AuctionSettled(auctionId, usdcPaid, totalDebtPaid, totalFee, surplus);
        }
    }

    function cancelAuction(uint256 auctionId) external override onlyLoanCore {
        Auction storage a = auctions[auctionId];
        if (a.status != AuctionStatus.Active) revert AuctionNotActive();
        a.status = AuctionStatus.Cancelled;
        emit AuctionCancelled(auctionId, a.loanId);
    }

    /**
     * @notice Protocol guardian or owner emergency action to cancel a stuck auction if oracle is frozen or stale.
     * Enforces that the feed is STALE_FEED or FROZEN_CORPORATE_ACTION and applies a per-loan cooldown.
     */
    function emergencyCancelAuction(uint256 auctionId) external {
        address guardian = ILoanCore(loanCore).guardian();
        if (msg.sender != owner() && msg.sender != guardian) revert UnauthorizedCaller();
        Auction storage a = auctions[auctionId];
        if (a.status != AuctionStatus.Active) revert AuctionNotActive();

        address router = ILoanCore(loanCore).oracleRouter();
        (, , IOracleRouter.OracleState oState) = IOracleRouter(router).getPrice(a.collateralToken);
        if (
            oState != IOracleRouter.OracleState.STALE_FEED &&
            oState != IOracleRouter.OracleState.FROZEN_CORPORATE_ACTION
        ) {
            revert OracleNotStaleOrFrozen();
        }

        if (block.timestamp < lastEmergencyCancelTime[a.loanId] + EMERGENCY_CANCEL_COOLDOWN) {
            revert EmergencyCancelCooldownActive();
        }
        lastEmergencyCancelTime[a.loanId] = block.timestamp;

        a.status = AuctionStatus.Cancelled;
        ILoanCore(loanCore).onAuctionCancelled(a.loanId);
        emit AuctionCancelled(auctionId, a.loanId);
    }

    function restartOrCancelAuction(uint256 auctionId) external override nonReentrant {
        Auction storage a = auctions[auctionId];
        if (a.status != AuctionStatus.Active) revert AuctionNotActive();
        if (block.timestamp < a.startTime + a.duration) revert AuctionNotActive();
        if (a.collateralRemaining == 0) revert InvalidAuctionAmount();

        address router = ILoanCore(loanCore).oracleRouter();
        (uint256 currentPrice, , IOracleRouter.OracleState oState) = IOracleRouter(router).getPrice(a.collateralToken);
        if (
            oState != IOracleRouter.OracleState.VALID_OPEN &&
            oState != IOracleRouter.OracleState.VALID_CLOSED &&
            oState != IOracleRouter.OracleState.STALE_FEED
        ) {
            return; // Maintain status if oracle is invalid or corporate action frozen
        }
        if (currentPrice == 0) return;

        ILoanCore.Loan memory l = ILoanCore(loanCore).getLoan(a.loanId);
        (uint256 grossVal, , ) = IOracleRouter(router).getValue(a.collateralToken, l.collateralRaw);
        uint128 debtPrincipal = l.principal - l.principalRepaid;
        uint128 debtInterest = ILoanCore(loanCore).getDueInterest(a.loanId);
        uint256 totalDebt = debtPrincipal + debtInterest;
        uint256 currentLtvBps = grossVal > 0 ? (totalDebt * 10000) / grossVal : 10000;

        if (currentLtvBps < l.liqLtvBps && !a.isDefaultAuction) {
            // Stock price recovered! Position is healthy. Cancel auction!
            a.status = AuctionStatus.Cancelled;
            ILoanCore(loanCore).onAuctionCancelled(a.loanId);
            emit AuctionCancelled(auctionId, a.loanId);
        } else {
            // Still liquidatable; restart auction at fresh oracle price
            IAssetRegistry.AssetConfig memory cfg = IAssetRegistry(ILoanCore(loanCore).assetRegistry()).getAssetConfig(a.collateralToken);
            a.startPrice = (currentPrice * 99) / 100;
            a.floorPrice = (currentPrice * (10000 - cfg.maxDiscountBps)) / 10000;
            a.startTime = uint64(block.timestamp);
            emit AuctionRestarted(auctionId, a.startPrice, a.floorPrice);
        }
    }

    function getAuction(uint256 auctionId) external view override returns (Auction memory) {
        return auctions[auctionId];
    }

    uint256[49] private __gap;
}
