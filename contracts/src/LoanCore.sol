// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {ILoanCore} from "./interfaces/ILoanCore.sol";
import {ICollateralEscrow} from "./interfaces/ICollateralEscrow.sol";
import {IPositionNFT} from "./interfaces/IPositionNFT.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {IFeeCollector} from "./interfaces/IFeeCollector.sol";
import {ILiquidationAuction} from "./interfaces/ILiquidationAuction.sol";

/**
 * @title LoanCore
 * @notice Central loan state machine, bullet interest math, top-ups, and settlement.
 */
contract LoanCore is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    ILoanCore
{
    using SafeERC20 for IERC20;

    uint8 public constant CORE_VERSION = 1;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint64 public constant GRACE_PERIOD_SECONDS = 24 hours;

    address public escrow;
    address public positionNft;
    address public orderSettlement;
    address public assetRegistry;
    address public oracleRouter;
    address public feeCollector;
    address public liquidationAuction;
    address public usdc;
    address public guardian;

    bool public paused; // Pause new loan fills only; repay/topup/claim CANNOT be paused
    uint128 public globalUsdcCap; // Guarded launch TVL cap
    uint128 public totalOutstandingPrincipal;

    uint256 public nextLoanId;
    mapping(uint256 => Loan) public loans;
    mapping(address => uint128) public assetOutstandingPrincipal;
    mapping(address => uint128) public claimable;

    error UnauthorizedCaller();
    error ZeroAddress();
    error ProtocolPaused();
    error GlobalCapExceeded();
    error PerLoanCapExceeded();
    error AssetCapExceeded();
    error AssetNotActive();
    error OracleInvalidForAction();
    error LtvExceeded();
    error InvalidLoanTerms();
    error LoanNotActive();
    error LoanNotInGrace();
    error LoanNotLiquidatable();
    error InsufficientPayment();

    event ProtocolPausedStateChanged(bool isPaused);
    event GlobalCapUpdated(uint128 newCap);
    event GuardianUpdated(address indexed newGuardian);

    modifier onlyOrderSettlement() {
        if (msg.sender != orderSettlement) revert UnauthorizedCaller();
        _;
    }

    modifier onlyAuction() {
        if (msg.sender != liquidationAuction) revert UnauthorizedCaller();
        _;
    }

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) revert UnauthorizedCaller();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        address initialGuardian,
        address initialEscrow,
        address initialPositionNft,
        address initialAssetRegistry,
        address initialOracleRouter,
        address initialFeeCollector,
        address initialAuction,
        address initialUsdc
    ) external initializer {
        if (
            initialOwner == address(0) ||
            initialEscrow == address(0) ||
            initialPositionNft == address(0) ||
            initialAssetRegistry == address(0) ||
            initialOracleRouter == address(0) ||
            initialFeeCollector == address(0) ||
            initialAuction == address(0) ||
            initialUsdc == address(0)
        ) {
            revert ZeroAddress();
        }
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        guardian = initialGuardian;
        escrow = initialEscrow;
        positionNft = initialPositionNft;
        assetRegistry = initialAssetRegistry;
        oracleRouter = initialOracleRouter;
        feeCollector = initialFeeCollector;
        liquidationAuction = initialAuction;
        usdc = initialUsdc;

        nextLoanId = 1;
        globalUsdcCap = 250_000 * 1e6; // $250k initial guarded cap
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setOrderSettlement(address newSettlement) external onlyOwner {
        if (newSettlement == address(0)) revert ZeroAddress();
        orderSettlement = newSettlement;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    function setGlobalCap(uint128 newCap) external onlyOwner {
        globalUsdcCap = newCap;
        emit GlobalCapUpdated(newCap);
    }

    /**
     * @notice Guardian or Owner can pause new originations.
     * Repayments, top-ups, claims, and liquidations remain permanently functional.
     */
    function setPaused(bool isPaused) external onlyGuardianOrOwner {
        paused = isPaused;
        emit ProtocolPausedStateChanged(isPaused);
    }

    /**
     * @notice Opens a loan, escrowing collateral, disbursing USDC, and minting Position NFT.
     */
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
    ) external override onlyOrderSettlement nonReentrant returns (uint256 loanId) {
        if (paused) revert ProtocolPaused();
        if (borrower == address(0) || lender == address(0) || collateralToken == address(0)) {
            revert ZeroAddress();
        }
        if (principal < 500 * 1e6 || termDays < 7 || termDays > 90 || rateBps > 4000) {
            revert InvalidLoanTerms();
        }

        // Check Caps
        if (totalOutstandingPrincipal + principal > globalUsdcCap) revert GlobalCapExceeded();

        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry(assetRegistry).getAssetConfig(collateralToken);
        if (cfg.status != uint8(IAssetRegistry.AssetStatus.Active)) revert AssetNotActive();
        if (cfg.perLoanCap > 0 && principal > cfg.perLoanCap) revert PerLoanCapExceeded();
        if (cfg.assetCap > 0 && assetOutstandingPrincipal[collateralToken] + principal > cfg.assetCap) {
            revert AssetCapExceeded();
        }

        // Valuation and LTV Check
        (, uint256 effectiveVal, IOracleRouter.OracleState oState) = IOracleRouter(oracleRouter).getValue(
            collateralToken,
            collateralAmount
        );

        if (oState != IOracleRouter.OracleState.VALID_OPEN && oState != IOracleRouter.OracleState.VALID_CLOSED) {
            revert OracleInvalidForAction();
        }

        uint16 allowedLtv = maxLtvBps < cfg.maxInitLtvBps ? maxLtvBps : cfg.maxInitLtvBps;
        if ((uint256(principal) * 10000) > (effectiveVal * allowedLtv)) revert LtvExceeded();

        loanId = nextLoanId++;

        uint64 startTime = uint64(block.timestamp);
        uint64 maturity = startTime + (uint64(termDays) * 1 days);

        loans[loanId] = Loan({
            borrower: borrower,
            collateralToken: collateralToken,
            collateralRaw: collateralAmount,
            principal: principal,
            startTime: startTime,
            maturity: maturity,
            rateBps: rateBps,
            penaltySpreadBps: 500, // 5% penalty APR in grace
            initLtvBps: allowedLtv,
            marginCallLtvBps: cfg.marginCallLtvBps,
            liqLtvBps: cfg.liqLtvBps,
            minInterestDays: minInterestDays > 0 ? minInterestDays : 3,
            status: uint8(LoanStatus.Active),
            yieldMode: yieldMode,
            coreVersion: CORE_VERSION,
            interestPaid: 0,
            principalRepaid: 0
        });

        totalOutstandingPrincipal += principal;
        assetOutstandingPrincipal[collateralToken] += principal;

        // Pull collateral into immutable escrow
        ICollateralEscrow(escrow).depositCollateral(collateralToken, borrower, collateralAmount);

        // Deduct origination fee (0.10%)
        uint128 fee = IFeeCollector(feeCollector).calculateOriginationFee(principal);
        uint128 proceeds = principal - fee;

        // Pull USDC from lender and distribute
        IERC20(usdc).safeTransferFrom(lender, borrower, proceeds);
        if (fee > 0) {
            IERC20(usdc).safeTransferFrom(lender, address(this), fee);
            IERC20(usdc).forceApprove(feeCollector, fee);
            IFeeCollector(feeCollector).distributeFees(usdc, fee);
        }

        // Mint Position NFT to lender (tokenId == loanId)
        IPositionNFT(positionNft).mint(lender, loanId);

        emit LoanOpened(
            loanId,
            borrower,
            lender,
            collateralToken,
            collateralAmount,
            principal,
            rateBps,
            maturity
        );
    }

    /**
     * @notice Computes due interest following Simple Interest Actual/365, minInterest, and grace penalties.
     */
    function getDueInterest(uint256 loanId) public view override returns (uint128) {
        Loan storage l = loans[loanId];
        if (l.status == uint8(LoanStatus.Repaid) || l.status >= uint8(LoanStatus.SettledDefault)) {
            return 0;
        }

        uint256 activePrincipal = uint256(l.principal - l.principalRepaid);
        if (activePrincipal == 0) return 0;

        uint256 fullTermSecs = l.maturity - l.startTime;
        uint256 maxFullInterest = (activePrincipal * l.rateBps * fullTermSecs + (10000 * SECONDS_PER_YEAR - 1)) /
            (10000 * SECONDS_PER_YEAR);

        if (block.timestamp <= l.maturity) {
            // Early or on-time repayment
            uint256 elapsed = block.timestamp - l.startTime;
            uint256 minSecs = uint256(l.minInterestDays) * 1 days;
            uint256 interestElapsed = elapsed < minSecs ? minSecs : elapsed;

            uint256 calculated = (activePrincipal * l.rateBps * interestElapsed + (10000 * SECONDS_PER_YEAR - 1)) /
                (10000 * SECONDS_PER_YEAR);

            return uint128(calculated > maxFullInterest ? maxFullInterest : calculated);
        } else {
            // Grace period: full term interest + penalty interest
            uint256 graceElapsed = block.timestamp - l.maturity;
            uint256 penaltyRate = l.rateBps + l.penaltySpreadBps;

            uint256 penaltyInterest = (activePrincipal * penaltyRate * graceElapsed + (10000 * SECONDS_PER_YEAR - 1)) /
                (10000 * SECONDS_PER_YEAR);

            return uint128(maxFullInterest + penaltyInterest);
        }
    }

    /**
     * @notice Repays a loan in full, releasing collateral to borrower and crediting NFT holder.
     */
    function repay(uint256 loanId) external override nonReentrant returns (uint128 totalPaid) {
        Loan storage l = loans[loanId];
        if (l.status != uint8(LoanStatus.Active) && l.status != uint8(LoanStatus.Grace)) {
            revert LoanNotActive();
        }

        uint128 remainingPrincipal = l.principal - l.principalRepaid;
        uint128 interestDue = getDueInterest(loanId);
        totalPaid = remainingPrincipal + interestDue;

        // Pull payment from payer
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), totalPaid);

        // Deduct protocol interest cut (10%)
        uint128 interestCut = IFeeCollector(feeCollector).calculateInterestCut(interestDue);
        uint128 netInterest = interestDue - interestCut;

        if (interestCut > 0) {
            IERC20(usdc).forceApprove(feeCollector, interestCut);
            IFeeCollector(feeCollector).distributeFees(usdc, interestCut);
        }

        // Credit NFT holder (claimant) with principal + netInterest
        address holder = IPositionNFT(positionNft).ownerOf(loanId);
        claimable[holder] += (remainingPrincipal + netInterest);

        // Update state
        l.principalRepaid = l.principal;
        l.interestPaid += interestDue;
        l.status = uint8(LoanStatus.Repaid);

        totalOutstandingPrincipal -= remainingPrincipal;
        assetOutstandingPrincipal[l.collateralToken] -= remainingPrincipal;

        // Release entire collateral back to borrower
        ICollateralEscrow(escrow).releaseCollateral(l.collateralToken, l.borrower, l.collateralRaw);

        // Burn NFT claim
        IPositionNFT(positionNft).burn(loanId);

        emit Repaid(loanId, msg.sender, remainingPrincipal, interestDue);
    }

    /**
     * @notice Repays a portion of the principal and releases proportional collateral.
     */
    function partialRepay(
        uint256 loanId,
        uint128 principalRepayAmount
    ) external override nonReentrant returns (uint128 totalPaid) {
        Loan storage l = loans[loanId];
        if (l.status != uint8(LoanStatus.Active)) revert LoanNotActive();

        uint128 remainingPrincipal = l.principal - l.principalRepaid;
        if (principalRepayAmount == 0 || principalRepayAmount >= remainingPrincipal) {
            revert InvalidLoanTerms();
        }

        // Proportionate collateral release
        uint128 collateralToRelease = uint128(
            (uint256(l.collateralRaw) * principalRepayAmount) / remainingPrincipal
        );

        totalPaid = principalRepayAmount;
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), totalPaid);

        address holder = IPositionNFT(positionNft).ownerOf(loanId);
        claimable[holder] += principalRepayAmount;

        l.principalRepaid += principalRepayAmount;
        l.collateralRaw -= collateralToRelease;

        totalOutstandingPrincipal -= principalRepayAmount;
        assetOutstandingPrincipal[l.collateralToken] -= principalRepayAmount;

        ICollateralEscrow(escrow).releaseCollateral(l.collateralToken, l.borrower, collateralToRelease);

        emit PartialRepaid(loanId, msg.sender, principalRepayAmount, 0, collateralToRelease);
    }

    /**
     * @notice Tops up collateral to reduce position risk. Allowed in all states.
     */
    function topUp(uint256 loanId, uint128 additionalCollateral) external override nonReentrant {
        Loan storage l = loans[loanId];
        if (l.status != uint8(LoanStatus.Active) && l.status != uint8(LoanStatus.Grace)) {
            revert LoanNotActive();
        }
        if (additionalCollateral == 0) revert InvalidLoanTerms();

        l.collateralRaw += additionalCollateral;
        ICollateralEscrow(escrow).depositCollateral(l.collateralToken, msg.sender, additionalCollateral);

        emit ToppedUp(loanId, msg.sender, additionalCollateral);
    }

    /**
     * @notice Extends a loan term agreed upon by the current NFT claim holder.
     */
    function extend(
        uint256 loanId,
        uint64 newMaturity,
        uint32 newRateBps,
        bytes calldata /* lenderSig */
    ) external override nonReentrant {
        Loan storage l = loans[loanId];
        if (l.status != uint8(LoanStatus.Active)) revert LoanNotActive();
        if (newMaturity <= l.maturity) revert InvalidLoanTerms();

        address holder = IPositionNFT(positionNft).ownerOf(loanId);
        if (msg.sender != holder && msg.sender != l.borrower) revert UnauthorizedCaller();

        l.maturity = newMaturity;
        l.rateBps = newRateBps;

        emit Extended(loanId, newMaturity, newRateBps);
    }

    /**
     * @notice Starts Dutch liquidation auction if position has breached liquidation LTV during VALID_OPEN.
     */
    function startLiquidation(uint256 loanId) external override nonReentrant returns (uint256 auctionId) {
        Loan storage l = loans[loanId];
        if (l.status != uint8(LoanStatus.Active) && l.status != uint8(LoanStatus.Grace)) {
            revert LoanNotActive();
        }

        (uint256 price, , IOracleRouter.OracleState oState) = IOracleRouter(oracleRouter).getPrice(l.collateralToken);
        if (oState != IOracleRouter.OracleState.VALID_OPEN) revert OracleInvalidForAction();

        (uint256 grossVal, , ) = IOracleRouter(oracleRouter).getValue(l.collateralToken, l.collateralRaw);
        uint128 debtPrincipal = l.principal - l.principalRepaid;
        uint128 debtInterest = getDueInterest(loanId);
        uint256 currentDebt = debtPrincipal + debtInterest;

        // Current LTV in BPS
        uint256 currentLtvBps = (currentDebt * 10000) / grossVal;
        if (currentLtvBps < l.liqLtvBps) revert LoanNotLiquidatable();

        l.status = uint8(LoanStatus.Auction);
        IPositionNFT(positionNft).setAuctionLock(loanId, true);

        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry(assetRegistry).getAssetConfig(l.collateralToken);
        bool isFull = currentLtvBps >= cfg.badDebtLtvBps;

        // Partial liquidation sells up to 50% of collateral; full liquidation sells 100%
        uint128 collateralToAuction = isFull ? l.collateralRaw : (l.collateralRaw / 2);

        auctionId = ILiquidationAuction(liquidationAuction).startAuction(
            loanId,
            l.borrower,
            l.collateralToken,
            collateralToAuction,
            debtPrincipal,
            debtInterest,
            price,
            cfg.maxDiscountBps,
            msg.sender, // Keeper address
            isFull
        );
    }

    /**
     * @notice Starts default auction if loan passed 24h grace period without repayment.
     */
    function startDefaultAuction(uint256 loanId) external override nonReentrant returns (uint256 auctionId) {
        Loan storage l = loans[loanId];
        if (block.timestamp <= l.maturity + GRACE_PERIOD_SECONDS) revert LoanNotInGrace();
        if (l.status != uint8(LoanStatus.Active) && l.status != uint8(LoanStatus.Grace)) {
            revert LoanNotActive();
        }

        (uint256 price, , IOracleRouter.OracleState oState) = IOracleRouter(oracleRouter).getPrice(l.collateralToken);
        if (oState != IOracleRouter.OracleState.VALID_OPEN) revert OracleInvalidForAction();

        l.status = uint8(LoanStatus.Auction);
        IPositionNFT(positionNft).setAuctionLock(loanId, true);

        uint128 debtPrincipal = l.principal - l.principalRepaid;
        uint128 debtInterest = getDueInterest(loanId);

        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry(assetRegistry).getAssetConfig(l.collateralToken);

        auctionId = ILiquidationAuction(liquidationAuction).startAuction(
            loanId,
            l.borrower,
            l.collateralToken,
            l.collateralRaw,
            debtPrincipal,
            debtInterest,
            price,
            cfg.maxDiscountBps,
            msg.sender,
            true // Default is always full liquidation
        );
    }

    /**
     * @notice Settlement callback from LiquidationAuction.
     */
    function onAuctionSettlement(
        uint256 loanId,
        uint128 usdcCollected,
        uint128 collateralSold,
        bool isFullLiquidation
    ) external override onlyAuction {
        Loan storage l = loans[loanId];
        IERC20(usdc).safeTransferFrom(liquidationAuction, address(this), usdcCollected);

        address holder = IPositionNFT(positionNft).ownerOf(loanId);
        claimable[holder] += usdcCollected;

        l.collateralRaw -= collateralSold;

        uint128 remainingPrincipal = l.principal - l.principalRepaid;
        totalOutstandingPrincipal -= remainingPrincipal;
        assetOutstandingPrincipal[l.collateralToken] -= remainingPrincipal;

        if (isFullLiquidation || l.collateralRaw == 0) {
            l.status = uint8(LoanStatus.SettledLiquidated);
            IPositionNFT(positionNft).burn(loanId);
        } else {
            l.status = uint8(LoanStatus.Active);
            IPositionNFT(positionNft).setAuctionLock(loanId, false);
        }
    }

    /**
     * @notice Pull payment pattern: lenders or borrowers claim their USDC balances.
     */
    function claim(address to) external override nonReentrant returns (uint128 claimedAmount) {
        if (to == address(0)) revert ZeroAddress();
        claimedAmount = claimable[msg.sender];
        if (claimedAmount == 0) revert InsufficientPayment();

        claimable[msg.sender] = 0;
        IERC20(usdc).safeTransfer(to, claimedAmount);

        emit Claimed(msg.sender, claimedAmount);
    }

    function getLoan(uint256 loanId) external view override returns (Loan memory) {
        return loans[loanId];
    }

    function getClaimable(address account) external view override returns (uint128) {
        return claimable[account];
    }
}
