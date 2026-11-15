// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ILoanCore} from "./interfaces/ILoanCore.sol";
import {ICollateralEscrow} from "./interfaces/ICollateralEscrow.sol";
import {IPositionNFT} from "./interfaces/IPositionNFT.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {IFeeCollector} from "./interfaces/IFeeCollector.sol";
import {ILiquidationAuction} from "./interfaces/ILiquidationAuction.sol";

/**
 * @title LoanCore
 * @notice Central loan state machine, bullet interest math, top-ups, extensions, and settlement.
 */
contract LoanCore is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable,
    ILoanCore
{
    using SafeERC20 for IERC20;

    uint8 public constant CORE_VERSION = 1;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint64 public constant GRACE_PERIOD_SECONDS = 24 hours;

    bytes32 public constant EXTEND_ORDER_TYPEHASH = keccak256(
        "ExtendOrder(uint256 loanId,uint64 newMaturity,uint32 newRateBps,uint256 nonce)"
    );

    address public escrow;
    address public positionNft;
    address public orderSettlement;
    address public assetRegistry;
    address public oracleRouter;
    address public feeCollector;
    address public liquidationAuction;
    address public usdc;
    address public guardian;

    bool public paused;
    uint128 public globalUsdcCap;
    uint128 public totalOutstandingPrincipal;

    uint256 public nextLoanId;
    mapping(uint256 => Loan) public loans;
    mapping(address => uint128) public assetOutstandingPrincipal;
    mapping(address => uint128) public claimable;
    mapping(uint256 => uint256) public loanExtensionNonce;

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
    error InvalidSignature();

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
            initialUsdc == address(0)
        ) {
            revert ZeroAddress();
        }
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __EIP712_init("NOSTOK Loan Core", "1");

        guardian = initialGuardian;
        escrow = initialEscrow;
        positionNft = initialPositionNft;
        assetRegistry = initialAssetRegistry;
        oracleRouter = initialOracleRouter;
        feeCollector = initialFeeCollector;
        liquidationAuction = initialAuction;
        usdc = initialUsdc;

        nextLoanId = 1;
        globalUsdcCap = 250_000 * 1e6;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setLiquidationAuction(address newAuction) external onlyOwner {
        if (newAuction == address(0)) revert ZeroAddress();
        liquidationAuction = newAuction;
    }

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

    function setPaused(bool isPaused) external onlyGuardianOrOwner {
        paused = isPaused;
        emit ProtocolPausedStateChanged(isPaused);
    }

    /**
     * @notice Updates loan status from Active to Grace if maturity has passed.
     */
    function syncStatus(uint256 loanId) public override returns (LoanStatus) {
        Loan storage l = loans[loanId];
        if (l.status == uint8(LoanStatus.Active)) {
            if (block.timestamp > l.maturity) {
                if (block.timestamp <= l.maturity + GRACE_PERIOD_SECONDS) {
                    l.status = uint8(LoanStatus.Grace);
                    emit StatusSynced(loanId, LoanStatus.Grace);
                }
            }
        }
        return LoanStatus(l.status);
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
        // Enforce minInterestDays range between 1 and 30 days
        if (minInterestDays < 1 || minInterestDays > 30) {
            revert InvalidLoanTerms();
        }

        if (totalOutstandingPrincipal + principal > globalUsdcCap) revert GlobalCapExceeded();

        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry(assetRegistry).getAssetConfig(collateralToken);
        if (cfg.status != uint8(IAssetRegistry.AssetStatus.Active)) revert AssetNotActive();
        if (cfg.perLoanCap > 0 && principal > cfg.perLoanCap) revert PerLoanCapExceeded();
        if (cfg.assetCap > 0 && assetOutstandingPrincipal[collateralToken] + principal > cfg.assetCap) {
            revert AssetCapExceeded();
        }

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
            minInterestDays: minInterestDays,
            status: uint8(LoanStatus.Active),
            yieldMode: yieldMode,
            coreVersion: CORE_VERSION,
            interestPaid: 0,
            principalRepaid: 0
        });

        totalOutstandingPrincipal += principal;
        assetOutstandingPrincipal[collateralToken] += principal;

        ICollateralEscrow(escrow).depositCollateral(collateralToken, borrower, collateralAmount);

        uint128 fee = IFeeCollector(feeCollector).calculateOriginationFee(principal);
        uint128 proceeds = principal - fee;

        IERC20(usdc).safeTransferFrom(lender, borrower, proceeds);
        if (fee > 0) {
            IERC20(usdc).safeTransferFrom(lender, address(this), fee);
            IERC20(usdc).forceApprove(feeCollector, fee);
            IFeeCollector(feeCollector).distributeFees(usdc, fee);
        }

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
            uint256 elapsed = block.timestamp - l.startTime;
            uint256 minSecs = uint256(l.minInterestDays) * 1 days;
            uint256 interestElapsed = elapsed < minSecs ? minSecs : elapsed;

            uint256 calculated = (activePrincipal * l.rateBps * interestElapsed + (10000 * SECONDS_PER_YEAR - 1)) /
                (10000 * SECONDS_PER_YEAR);

            return uint128(calculated > maxFullInterest ? maxFullInterest : calculated);
        } else {
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
        syncStatus(loanId);
        Loan storage l = loans[loanId];
        if (l.status != uint8(LoanStatus.Active) && l.status != uint8(LoanStatus.Grace)) {
            revert LoanNotActive();
        }

        uint128 remainingPrincipal = l.principal - l.principalRepaid;
        uint128 interestDue = getDueInterest(loanId);
        totalPaid = remainingPrincipal + interestDue;

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), totalPaid);

        uint128 interestCut = IFeeCollector(feeCollector).calculateInterestCut(interestDue);
        uint128 netInterest = interestDue - interestCut;

        if (interestCut > 0) {
            IERC20(usdc).forceApprove(feeCollector, interestCut);
            IFeeCollector(feeCollector).distributeFees(usdc, interestCut);
        }

        address holder = IPositionNFT(positionNft).ownerOf(loanId);
        claimable[holder] += (remainingPrincipal + netInterest);

        l.principalRepaid = l.principal;
        l.interestPaid += interestDue;
        l.status = uint8(LoanStatus.Repaid);

        totalOutstandingPrincipal -= remainingPrincipal;
        assetOutstandingPrincipal[l.collateralToken] -= remainingPrincipal;

        ICollateralEscrow(escrow).releaseCollateral(l.collateralToken, l.borrower, l.collateralRaw);
        IPositionNFT(positionNft).burn(loanId);

        emit Repaid(loanId, msg.sender, remainingPrincipal, interestDue);
    }

    /**
     * @notice Repays a portion of principal, accrues interest on the repaid part, and releases collateral pro rata.
     */
    function partialRepay(
        uint256 loanId,
        uint128 principalRepayAmount
    ) external override nonReentrant returns (uint128 totalPaid) {
        syncStatus(loanId);
        Loan storage l = loans[loanId];
        if (l.status != uint8(LoanStatus.Active)) revert LoanNotActive();

        uint128 remainingPrincipal = l.principal - l.principalRepaid;
        if (principalRepayAmount == 0 || principalRepayAmount >= remainingPrincipal) {
            revert InvalidLoanTerms();
        }

        // Accrue and charge interest on the portion of principal being repaid
        uint256 elapsed = block.timestamp - l.startTime;
        uint256 minSecs = uint256(l.minInterestDays) * 1 days;
        uint256 interestElapsed = elapsed < minSecs ? minSecs : elapsed;
        uint128 interestOnRepaid = uint128(
            (uint256(principalRepayAmount) * l.rateBps * interestElapsed + (10000 * SECONDS_PER_YEAR - 1)) /
                (10000 * SECONDS_PER_YEAR)
        );

        uint128 interestCut = IFeeCollector(feeCollector).calculateInterestCut(interestOnRepaid);
        uint128 netInterest = interestOnRepaid - interestCut;

        totalPaid = principalRepayAmount + interestOnRepaid;
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), totalPaid);

        if (interestCut > 0) {
            IERC20(usdc).forceApprove(feeCollector, interestCut);
            IFeeCollector(feeCollector).distributeFees(usdc, interestCut);
        }

        address holder = IPositionNFT(positionNft).ownerOf(loanId);
        claimable[holder] += (principalRepayAmount + netInterest);

        uint128 collateralToRelease = uint128(
            (uint256(l.collateralRaw) * principalRepayAmount) / remainingPrincipal
        );

        l.principalRepaid += principalRepayAmount;
        l.interestPaid += interestOnRepaid;
        l.collateralRaw -= collateralToRelease;

        totalOutstandingPrincipal -= principalRepayAmount;
        assetOutstandingPrincipal[l.collateralToken] -= principalRepayAmount;

        ICollateralEscrow(escrow).releaseCollateral(l.collateralToken, l.borrower, collateralToRelease);

        emit PartialRepaid(loanId, msg.sender, principalRepayAmount, interestOnRepaid, collateralToRelease);
    }

    /**
     * @notice Tops up collateral to reduce position risk. Allowed in all states.
     */
    function topUp(uint256 loanId, uint128 additionalCollateral) external override nonReentrant {
        syncStatus(loanId);
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
     * @notice Extends a loan term. Requires signed consent from counterparty via EIP-712.
     * Enforces a 40% rate cap and 90-day max term.
     */
    function extend(
        uint256 loanId,
        uint64 newMaturity,
        uint32 newRateBps,
        bytes calldata counterpartySig
    ) external override nonReentrant {
        syncStatus(loanId);
        Loan storage l = loans[loanId];
        if (l.status != uint8(LoanStatus.Active)) revert LoanNotActive();

        // Enforce rate cap (max 40% APR) and term boundaries
        if (newRateBps > 4000) revert InvalidLoanTerms();
        if (newMaturity <= l.maturity || newMaturity > block.timestamp + 90 days) {
            revert InvalidLoanTerms();
        }

        address holder = IPositionNFT(positionNft).ownerOf(loanId);
        if (msg.sender != l.borrower && msg.sender != holder) {
            revert UnauthorizedCaller();
        }

        uint256 nonce = loanExtensionNonce[loanId]++;

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(EXTEND_ORDER_TYPEHASH, loanId, newMaturity, newRateBps, nonce))
        );
        address signer = ECDSA.recover(digest, counterpartySig);

        if (msg.sender == l.borrower) {
            // Borrower calling -> counterparty must be current NFT holder
            if (signer != holder) revert InvalidSignature();
        } else {
            // Holder calling -> counterparty must be borrower
            if (signer != l.borrower) revert InvalidSignature();
        }

        l.maturity = newMaturity;
        l.rateBps = newRateBps;

        emit Extended(loanId, newMaturity, newRateBps);
    }

    /**
     * @notice Starts Dutch liquidation auction if position has breached liquidation LTV during VALID_OPEN.
     */
    function startLiquidation(uint256 loanId) external override nonReentrant returns (uint256 auctionId) {
        syncStatus(loanId);
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

        uint256 currentLtvBps = (currentDebt * 10000) / grossVal;
        if (currentLtvBps < l.liqLtvBps) revert LoanNotLiquidatable();

        l.status = uint8(LoanStatus.Auction);
        IPositionNFT(positionNft).setAuctionLock(loanId, true);

        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry(assetRegistry).getAssetConfig(l.collateralToken);
        bool isFull = currentLtvBps >= cfg.badDebtLtvBps;
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
            msg.sender,
            false // Not a default auction
        );
    }

    /**
     * @notice Starts default auction if loan passed 24h grace period without repayment.
     */
    function startDefaultAuction(uint256 loanId) external override nonReentrant returns (uint256 auctionId) {
        syncStatus(loanId);
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
            true // Is default auction
        );
    }

    /**
     * @notice Settlement callback from LiquidationAuction.
     * Updates remaining debt accurately per buy, and burns NFT only when auction settles.
     */
    function onAuctionSettlement(
        uint256 loanId,
        uint128 principalPaid,
        uint128 interestPaid,
        uint128 collateralSold,
        bool isSettled,
        bool isDefault
    ) external override onlyAuction {
        Loan storage l = loans[loanId];
        uint128 totalDebtReceived = principalPaid + interestPaid;

        if (totalDebtReceived > 0) {
            IERC20(usdc).safeTransferFrom(liquidationAuction, address(this), totalDebtReceived);
            address holder = IPositionNFT(positionNft).ownerOf(loanId);

            uint128 interestCut = 0;
            if (interestPaid > 0) {
                interestCut = IFeeCollector(feeCollector).calculateInterestCut(interestPaid);
                IERC20(usdc).forceApprove(feeCollector, interestCut);
                IFeeCollector(feeCollector).distributeFees(usdc, interestCut);
            }

            claimable[holder] += (principalPaid + (interestPaid - interestCut));
        }

        l.collateralRaw -= collateralSold;
        l.principalRepaid += principalPaid;
        l.interestPaid += interestPaid;

        totalOutstandingPrincipal -= principalPaid;
        assetOutstandingPrincipal[l.collateralToken] -= principalPaid;

        if (isSettled) {
            if (isDefault) {
                l.status = uint8(LoanStatus.SettledDefault);
            } else {
                l.status = uint8(LoanStatus.SettledLiquidated);
            }
            IPositionNFT(positionNft).burn(loanId);
        } else {
            // Partial buy: auction is still in progress
            l.status = uint8(LoanStatus.Auction);
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
