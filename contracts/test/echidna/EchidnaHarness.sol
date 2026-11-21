// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CollateralEscrow} from "../../src/CollateralEscrow.sol";
import {PositionNFT} from "../../src/PositionNFT.sol";
import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {OracleRouter} from "../../src/OracleRouter.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {EligibilityGate} from "../../src/EligibilityGate.sol";
import {LiquidationAuction} from "../../src/LiquidationAuction.sol";
import {LoanCore} from "../../src/LoanCore.sol";
import {ILoanCore} from "../../src/interfaces/ILoanCore.sol";
import {IAssetRegistry} from "../../src/interfaces/IAssetRegistry.sol";
import {ILiquidationAuction} from "../../src/interfaces/ILiquidationAuction.sol";
import {IOracleRouter} from "../../src/interfaces/IOracleRouter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockSequencer} from "../mocks/MockSequencer.sol";

/**
 * @notice Minimal contract actor enabling multi-party harness actions without VM cheatcodes
 *         so Echidna (`crytic-compile`) and Foundry can both execute all 8 protocol invariants.
 */
contract EchidnaActor {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function callTarget(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

/**
 * @title EchidnaHarness
 * @notice WS4.2 8-invariant Echidna & Foundry dual-compatible protocol fuzz harness
 *         covering multi-asset (8-dec + 18-dec) collateral, caps, solvency, auction locks,
 *         fees, nonces, and pause/oracle safety guarantees.
 */
contract EchidnaHarness {
    CollateralEscrow public escrow;
    PositionNFT public nft;
    AssetRegistry public registry;
    OracleRouter public router;
    FeeCollector public feeCollector;
    EligibilityGate public gate;
    LoanCore public core;
    LiquidationAuction public auction;

    MockERC20 public usdc;
    MockERC20 public stock8;
    MockERC20 public stock18;
    MockAggregator public feed8;
    MockAggregator public feed18;
    MockSequencer public sequencer;

    EchidnaActor public borrowerA;
    EchidnaActor public borrowerB;
    EchidnaActor public lender;
    EchidnaActor public keeper;
    EchidnaActor public liquidator;

    address public settlement;
    address public guardian;
    address public treasury;
    address public safetyReserve;

    uint256[] public loanIds;
    mapping(address => uint256) public ghostEscrow;
    uint256 public ghostFeesDistributed;
    uint256 public ghostLastUserNonce;
    bool private _nonceRegressionSeen;

    constructor() {
        settlement = address(this);
        guardian = address(new EchidnaActor());
        treasury = address(0xAAA1);
        safetyReserve = address(0xAAA2);

        borrowerA = new EchidnaActor();
        borrowerB = new EchidnaActor();
        lender = new EchidnaActor();
        keeper = new EchidnaActor();
        liquidator = new EchidnaActor();

        usdc = new MockERC20("USD Coin", "USDC", 6);
        stock8 = new MockERC20("NVIDIA B20", "NVDAc", 8);
        stock18 = new MockERC20("META B20", "METAc", 18);
        stock8.setUiMultiplier(1e18);
        stock18.setUiMultiplier(1e18);

        feed8 = new MockAggregator(8, 200e8);
        feed18 = new MockAggregator(8, 500e8);
        sequencer = new MockSequencer(0);

        gate = new EligibilityGate(address(this), address(this), true);
        escrow = new CollateralEscrow(address(this));
        nft = new PositionNFT(address(this), address(gate));

        registry = AssetRegistry(address(new ERC1967Proxy(address(new AssetRegistry()), "")));
        registry.initialize(address(this), guardian);

        router = OracleRouter(address(new ERC1967Proxy(address(new OracleRouter()), "")));
        router.initialize(address(this), address(registry), address(sequencer));
        router.setMarketSession(true, true);
        registry.setOracleRouter(address(router));

        feeCollector = FeeCollector(address(new ERC1967Proxy(address(new FeeCollector()), "")));
        feeCollector.initialize(address(this), treasury, safetyReserve);

        core = LoanCore(address(new ERC1967Proxy(address(new LoanCore()), "")));
        LiquidationAuction auctionImpl = new LiquidationAuction();
        auction = LiquidationAuction(address(new ERC1967Proxy(address(auctionImpl), "")));

        core.initialize(
            address(this),
            guardian,
            address(escrow),
            address(nft),
            address(registry),
            address(router),
            address(feeCollector),
            address(auction),
            address(usdc)
        );
        core.setOrderSettlement(settlement);
        auction.initialize(address(this), address(escrow), address(core), address(feeCollector), address(usdc));

        escrow.setAuthorizedCore(address(core), true);
        escrow.setAuthorizedCore(address(auction), true);
        nft.setAuthorizedCore(address(core), true);

        registry.setAssetConfig(address(stock8), _defaultCfg(address(feed8), 100_000e6));
        registry.setAssetConfig(address(stock18), _defaultCfg(address(feed18), 100_000e6));
        router.syncMultiplier(address(stock8));
        router.syncMultiplier(address(stock18));
    }

    function _defaultCfg(address feed, uint128 assetCap) internal pure returns (IAssetRegistry.AssetConfig memory) {
        return IAssetRegistry.AssetConfig({
            feed: feed,
            feedDecimals: 8,
            tier: 0,
            maxInitLtvBps: 6000,
            marginCallLtvBps: 7000,
            liqLtvBps: 7800,
            badDebtLtvBps: 9000,
            maxDiscountBps: 600,
            closedMarketHaircutBps: 500,
            perLoanCap: 50_000e6,
            assetCap: assetCap,
            maxStaleOpenSecs: 86400,
            status: uint8(IAssetRegistry.AssetStatus.Active),
            restricted: false
        });
    }

    function actionOpenLoan(uint256 colSeed, uint256 prinSeed, bool useAsset18, bool useBorrowerB) external {
        if (loanIds.length >= 16) return;
        MockERC20 tok = useAsset18 ? stock18 : stock8;
        EchidnaActor b = useBorrowerB ? borrowerB : borrowerA;
        MockAggregator feed = useAsset18 ? feed18 : feed8;

        feed.setUpdatedAt(block.timestamp);
        uint128 colAmt = useAsset18
            ? uint128(10e18 + (colSeed % 40e18))
            : uint128(10e8 + (colSeed % 40e8));

        (, uint256 effVal, IOracleRouter.OracleState st) = router.getValue(address(tok), colAmt);
        if (st != IOracleRouter.OracleState.VALID_OPEN && st != IOracleRouter.OracleState.VALID_CLOSED) return;
        uint256 maxPrin = (effVal * 6000) / 10000;
        if (maxPrin < 500e6) return;

        uint128 principal = uint128(500e6 + (prinSeed % (maxPrin - 500e6 + 1)));
        if (principal > 50_000e6) principal = 50_000e6;
        if (core.assetOutstandingPrincipal(address(tok)) + principal > 100_000e6) return;
        if (core.totalOutstandingPrincipal() + principal > core.globalUsdcCap()) return;

        tok.mint(address(b), colAmt);
        b.approveToken(address(tok), address(escrow), colAmt);
        usdc.mint(address(lender), principal);
        lender.approveToken(address(usdc), address(core), principal);

        // ERC-20 lender transfer inside core.openLoan pulls directly from lender EOA/actor
        // Delegate openLoan through settlement (`address(this)`) with lender pre-approved
        uint128 origFee = feeCollector.calculateOriginationFee(principal);
        try core.openLoan(
            address(b),
            address(lender),
            address(tok),
            colAmt,
            principal,
            800,
            30,
            6000,
            3,
            0
        ) returns (uint256 loanId) {
            loanIds.push(loanId);
            ghostEscrow[address(tok)] += colAmt;
            ghostFeesDistributed += origFee;
        } catch {}
    }

    function actionTopUp(uint256 idxSeed, uint256 addSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active) && l.status != uint8(ILoanCore.LoanStatus.Grace)) return;

        MockERC20 tok = MockERC20(l.collateralToken);
        uint128 extra = l.collateralToken == address(stock18)
            ? uint128(1 + (addSeed % 5e18))
            : uint128(1 + (addSeed % 5e8));
        EchidnaActor actor = l.borrower == address(borrowerB) ? borrowerB : borrowerA;
        tok.mint(address(actor), extra);
        actor.approveToken(address(tok), address(escrow), extra);

        try actor.callTarget(address(core), abi.encodeCall(LoanCore.topUp, (loanId, extra))) {
            ghostEscrow[address(tok)] += extra;
        } catch {}
    }

    function actionRepay(uint256 idxSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status > uint8(ILoanCore.LoanStatus.Auction)) return;

        uint128 rem = l.principal - l.principalRepaid;
        uint128 due = core.getDueInterest(loanId);
        uint128 need = rem + due;
        uint128 cut = feeCollector.calculateInterestCut(due);
        EchidnaActor actor = l.borrower == address(borrowerB) ? borrowerB : borrowerA;
        usdc.mint(address(actor), need);
        actor.approveToken(address(usdc), address(core), need);

        uint128 colBefore = l.collateralRaw;
        try actor.callTarget(address(core), abi.encodeCall(LoanCore.repay, (loanId))) {
            ghostEscrow[l.collateralToken] -= colBefore;
            ghostFeesDistributed += cut;
        } catch {}
    }

    function actionSetPriceAndLiquidate(uint256 idxSeed, uint256 priceSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active) && l.status != uint8(ILoanCore.LoanStatus.Grace)) return;

        MockAggregator feed = l.collateralToken == address(stock18) ? feed18 : feed8;
        int256 basePrice = l.collateralToken == address(stock18) ? int256(500e8) : int256(200e8);
        int256 nextPrice = int256(uint256(50e8 + (priceSeed % uint256(basePrice))));
        feed.setPrice(nextPrice);

        try keeper.callTarget(address(core), abi.encodeCall(LoanCore.startLiquidation, (loanId))) {} catch {}
    }

    function actionBuyAuction(uint256 idxSeed, uint256 fracBpsSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        uint256 aucId = core.loanActiveAuction(loanId);
        if (aucId == 0) return;

        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);
        if (a.status != ILiquidationAuction.AuctionStatus.Active || a.collateralRemaining == 0) return;

        uint256 bps = 2000 + (fracBpsSeed % 8001);
        uint128 colToBuy = uint128((uint256(a.collateralRemaining) * bps) / 10000);
        if (colToBuy == 0) colToBuy = a.collateralRemaining;

        uint256 colBefore = core.getLoan(loanId).collateralRaw;
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);

        usdc.mint(address(liquidator), 1_000_000e6);
        liquidator.approveToken(address(usdc), address(auction), 1_000_000e6);
        try liquidator.callTarget(address(auction), abi.encodeCall(LiquidationAuction.buy, (aucId, colToBuy, 1_000_000e6))) {
            uint256 colAfter = core.getLoan(loanId).collateralRaw;
            ghostEscrow[a.collateralToken] -= (colBefore - colAfter);
            uint256 feeAfter = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);
            if (feeAfter > feeBefore) {
                ghostFeesDistributed += (feeAfter - feeBefore);
            }
        } catch {}
    }

    function actionClaimLender() external {
        if (core.getClaimable(address(lender)) == 0) return;
        try lender.callTarget(address(core), abi.encodeCall(LoanCore.claim, (address(lender)))) {} catch {}
    }

    function actionBumpNonce() external {
        try borrowerA.callTarget(address(gate), abi.encodeCall(EligibilityGate.bumpMyNonce, ())) {
            uint256 cur = gate.userNonce(address(borrowerA));
            if (cur < ghostLastUserNonce) _nonceRegressionSeen = true;
            ghostLastUserNonce = cur;
        } catch {}
    }

    // ---------------- Echidna / WS4.2 8 Core Protocol Invariants ----------------

    /// @notice Invariant 1: Multi-asset Escrow ledger and physical ERC-20 balances match per-loan sums.
    function echidna_escrow_solvency() public view returns (bool) {
        if (escrow.getBalance(address(stock8)) != ghostEscrow[address(stock8)]) return false;
        if (stock8.balanceOf(address(escrow)) != ghostEscrow[address(stock8)]) return false;
        if (escrow.getBalance(address(stock18)) != ghostEscrow[address(stock18)]) return false;
        if (stock18.balanceOf(address(escrow)) != ghostEscrow[address(stock18)]) return false;

        uint256 sum8;
        uint256 sum18;
        for (uint256 i = 0; i < loanIds.length; i++) {
            ILoanCore.Loan memory l = core.getLoan(loanIds[i]);
            if (l.collateralToken == address(stock8)) sum8 += l.collateralRaw;
            else if (l.collateralToken == address(stock18)) sum18 += l.collateralRaw;
        }
        return sum8 == ghostEscrow[address(stock8)] && sum18 == ghostEscrow[address(stock18)];
    }

    /// @notice Invariant 2: Global principal accounting matches open loans and respects global cap.
    function echidna_global_principal_cap() public view returns (bool) {
        uint256 openPrincipal;
        for (uint256 i = 0; i < loanIds.length; i++) {
            ILoanCore.Loan memory l = core.getLoan(loanIds[i]);
            if (l.status <= uint8(ILoanCore.LoanStatus.Auction)) {
                openPrincipal += (l.principal - l.principalRepaid);
            }
        }
        return core.totalOutstandingPrincipal() == openPrincipal && openPrincipal <= core.globalUsdcCap();
    }

    /// @notice Invariant 3: Per-asset principal sums equal global outstanding principal and respect assetCap.
    function echidna_per_asset_caps() public view returns (bool) {
        uint256 p8 = core.assetOutstandingPrincipal(address(stock8));
        uint256 p18 = core.assetOutstandingPrincipal(address(stock18));
        if (p8 + p18 != core.totalOutstandingPrincipal()) return false;
        if (p8 > registry.getAssetConfig(address(stock8)).assetCap) return false;
        if (p18 > registry.getAssetConfig(address(stock18)).assetCap) return false;
        return true;
    }

    /// @notice Invariant 4: LoanCore USDC solvency & zero stranded USDC in LiquidationAuction.
    function echidna_usdc_solvency() public view returns (bool) {
        uint256 totalClaimable =
            core.getClaimable(address(borrowerA)) +
            core.getClaimable(address(borrowerB)) +
            core.getClaimable(address(lender)) +
            core.getClaimable(address(keeper)) +
            core.getClaimable(address(liquidator));
        if (usdc.balanceOf(address(core)) < totalClaimable) return false;
        if (usdc.balanceOf(address(auction)) != 0) return false;
        return true;
    }

    /// @notice Invariant 5: PositionNFT existence and auction lock match loan status cleanly.
    function echidna_nft_and_lock_parity() public view returns (bool) {
        for (uint256 i = 0; i < loanIds.length; i++) {
            uint256 id = loanIds[i];
            ILoanCore.Loan memory l = core.getLoan(id);
            bool open = l.status <= uint8(ILoanCore.LoanStatus.Auction);
            if (open) {
                try nft.ownerOf(id) returns (address owner_) {
                    if (owner_ == address(0)) return false;
                } catch {
                    return false;
                }
                bool isAuc = l.status == uint8(ILoanCore.LoanStatus.Auction);
                if (nft.isAuctionLocked(id) != isAuc) return false;
                if ((core.loanActiveAuction(id) != 0) != isAuc) return false;
            } else {
                if (l.collateralRaw != 0) return false;
                if (core.loanActiveAuction(id) != 0) return false;
                if (nft.isAuctionLocked(id)) return false;
            }
        }
        return true;
    }

    /// @notice Invariant 6: FeeCollector stays within hardcoded caps and conserves distributed fees.
    function echidna_fee_caps_and_conservation() public view returns (bool) {
        if (feeCollector.originationFeeBps() > feeCollector.MAX_ORIGINATION_BPS()) return false;
        if (feeCollector.interestCutBps() > feeCollector.MAX_INTEREST_CUT_BPS()) return false;
        if (feeCollector.liquidationFeeBps() > feeCollector.MAX_LIQUIDATION_BPS()) return false;
        return usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve) == ghostFeesDistributed;
    }

    /// @notice Invariant 7: User nonces remain monotonic with zero recorded gate violation.
    function echidna_nonce_monotonicity() public view returns (bool) {
        return !_nonceRegressionSeen && gate.userNonce(address(borrowerA)) >= ghostLastUserNonce;
    }

    /// @notice Invariant 8: OracleRouter baseline multipliers remain non-zero once initialized.
    function echidna_oracle_baseline_preserved() public view returns (bool) {
        return router.recordedMultiplier(address(stock8)) > 0 && router.recordedMultiplier(address(stock18)) > 0;
    }
}
