// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {LoanCore} from "../src/LoanCore.sol";
import {CollateralEscrow} from "../src/CollateralEscrow.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {EligibilityGate} from "../src/EligibilityGate.sol";
import {LiquidationAuction} from "../src/LiquidationAuction.sol";
import {ILoanCore} from "../src/interfaces/ILoanCore.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {ILiquidationAuction} from "../src/interfaces/ILiquidationAuction.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockSequencer} from "./mocks/MockSequencer.sol";

/**
 * @notice Minimal ERC-1271 + ERC-721 receiver wallet so LoanCore.extend() and PositionNFT._safeMint()
 *         work identically under Foundry and Halmos symbolic execution without vm.sign / ecrecover.
 */
contract HalmosLenderWallet is IERC721Receiver {
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/**
 * @title FormalPropertiesTest
 * @notice WS4.3 Halmos-compatible `check_*` symbolic properties (using ONLY Halmos-supported
 *         cheatcodes: vm.warp, vm.prank, vm.startPrank, vm.stopPrank, vm.assume; native Solidity
 *         `assert(...)` and `try/catch` instead of vm.assertEq/vm.expectRevert/vm.sign; concrete
 *         setUp deployment with `dynamic_test_linking = false` so no vm.deployCode is emitted),
 *         paired with 512-run Foundry fuzz wrappers (`test_check_*`).
 *
 *         Properties verified:
 *         1. Actual/365 simple interest ceiling rounding, monotonicity & 1-wei checkpoint additivity
 *         2. 24h grace penalty spread (+500 bps) & cumulative 90d / 40% extend caps
 *         3. minInterestDays lifetime floor without double-counting
 *         4. Liquidation close factors (50% vs 100%), linear Dutch price bounds & 0-wei waterfall conservation (6/8/18 dec)
 *         5. CollateralEscrow multi-token isolation, over-release revert & unauthorized caller rejection
 */
contract FormalPropertiesTest is TestBase, StdUtils {
    bool public IS_TEST = true;

    uint256 internal constant BASE_TIME = 1_795_100_400; // Tuesday 15:00 UTC (regular US market open)
    uint256 internal constant SECONDS_PER_YEAR = 365 days;
    uint128 internal constant FIXED_COL_8 = 5_000e8; // $1,000,000 at $200 => <= 50% LTV for all principals <= $500k

    address internal constant OWNER = address(0x1111);
    address internal constant GUARDIAN = address(0x2222);
    address internal constant TREASURY = address(0x3333);
    address internal constant RESERVE = address(0x4444);
    address internal constant SETTLEMENT = address(0x5555);
    address internal constant BORROWER = address(0xB0B0);
    address internal constant KEEPER = address(0xCAFE);
    address internal constant LIQUIDATOR = address(0xDEAD);
    address internal constant ISO_AUTH = address(0x9001);
    address internal constant ISO_USER_A = address(0xA001);
    address internal constant ISO_USER_B = address(0xB001);

    LoanCore internal core;
    CollateralEscrow internal escrow;
    PositionNFT internal nft;
    LiquidationAuction internal auction;
    AssetRegistry internal registry;
    OracleRouter internal router;
    FeeCollector internal feeCollector;
    EligibilityGate internal gate;
    HalmosLenderWallet internal lenderWallet;

    MockERC20 internal usdc;
    MockERC20 internal col6;
    MockERC20 internal col8;
    MockERC20 internal col18;
    MockAggregator internal feed6;
    MockAggregator internal feed8;
    MockAggregator internal feed18;
    MockSequencer internal seq;

    CollateralEscrow internal isoEscrow;
    MockERC20 internal isoTokA;
    MockERC20 internal isoTokB;

    function _ceilDiv(uint256 num, uint256 den) internal pure returns (uint256) {
        return num == 0 ? 0 : (num + den - 1) / den;
    }

    function _assetCfg(address feed) internal pure returns (IAssetRegistry.AssetConfig memory) {
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
            perLoanCap: 10_000_000e6,
            assetCap: 50_000_000e6,
            maxStaleOpenSecs: 86400,
            status: uint8(IAssetRegistry.AssetStatus.Active),
            restricted: false
        });
    }

    function setUp() public {
        vm.warp(BASE_TIME);

        lenderWallet = new HalmosLenderWallet();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        col6 = new MockERC20("Collateral 6", "COL6", 6);
        col8 = new MockERC20("Collateral 8", "COL8", 8);
        col18 = new MockERC20("Collateral 18", "COL18", 18);
        col6.setUiMultiplier(1e18);
        col8.setUiMultiplier(1e18);
        col18.setUiMultiplier(1e18);

        feed6 = new MockAggregator(8, 200e8);
        feed8 = new MockAggregator(8, 200e8);
        feed18 = new MockAggregator(8, 200e8);
        seq = new MockSequencer(0);

        vm.startPrank(OWNER);
        gate = new EligibilityGate(OWNER, OWNER, true);
        escrow = new CollateralEscrow(OWNER);
        nft = new PositionNFT(OWNER, address(gate));
        registry = AssetRegistry(address(new ERC1967Proxy(address(new AssetRegistry()), "")));
        registry.initialize(OWNER, GUARDIAN);
        router = OracleRouter(address(new ERC1967Proxy(address(new OracleRouter()), "")));
        router.initialize(OWNER, address(registry), address(seq));
        router.setMarketSession(true, true);
        registry.setOracleRouter(address(router));
        feeCollector = FeeCollector(address(new ERC1967Proxy(address(new FeeCollector()), "")));
        feeCollector.initialize(OWNER, TREASURY, RESERVE);

        core = LoanCore(address(new ERC1967Proxy(address(new LoanCore()), "")));
        auction = LiquidationAuction(address(new ERC1967Proxy(address(new LiquidationAuction()), "")));
        core.initialize(
            OWNER,
            GUARDIAN,
            address(escrow),
            address(nft),
            address(registry),
            address(router),
            address(feeCollector),
            address(auction),
            address(usdc)
        );
        core.setOrderSettlement(SETTLEMENT);
        core.setGlobalCap(100_000_000e6);
        auction.initialize(OWNER, address(escrow), address(core), address(feeCollector), address(usdc));
        escrow.setAuthorizedCore(address(core), true);
        escrow.setAuthorizedCore(address(auction), true);
        nft.setAuthorizedCore(address(core), true);

        registry.setAssetConfig(address(col6), _assetCfg(address(feed6)));
        registry.setAssetConfig(address(col8), _assetCfg(address(feed8)));
        registry.setAssetConfig(address(col18), _assetCfg(address(feed18)));
        router.syncMultiplier(address(col6));
        router.syncMultiplier(address(col8));
        router.syncMultiplier(address(col18));
        vm.stopPrank();

        // Standalone CollateralEscrow stack for Property 5
        isoEscrow = new CollateralEscrow(address(this));
        isoEscrow.setAuthorizedCore(ISO_AUTH, true);
        isoTokA = new MockERC20("Token A", "TOKA", 8);
        isoTokB = new MockERC20("Token B", "TOKB", 18);
    }

    function _openLoan(
        MockERC20 tok,
        uint128 colAmt,
        uint128 principal,
        uint32 rateBps,
        uint16 termDays,
        uint16 minDays
    ) internal returns (uint256 loanId) {
        tok.mint(BORROWER, colAmt);
        vm.prank(BORROWER);
        tok.approve(address(escrow), colAmt);
        usdc.mint(address(lenderWallet), principal);
        vm.prank(address(lenderWallet));
        usdc.approve(address(core), principal);
        vm.prank(SETTLEMENT);
        loanId = core.openLoan(BORROWER, address(lenderWallet), address(tok), colAmt, principal, rateBps, termDays, 6000, minDays, 0);
    }

    // ---------------- Property 1: Simple Interest Actual/365, Monotonicity & Checkpoint Additivity ----------------

    /// forge-config: default.fuzz.runs = 512
    function test_check_SimpleInterestEquivalenceAndCeiling(
        uint64 principalSeed,
        uint16 rateSeed,
        uint16 termDaysSeed,
        uint32 elapsed1Seed,
        uint32 elapsed2Seed
    ) public {
        uint64 principal = uint64(bound(principalSeed, 500e6, 500_000e6));
        uint16 rateBps = uint16(bound(rateSeed, 100, 4000));
        uint16 termDays = uint16(bound(termDaysSeed, 7, 60));
        uint32 totalTerm = uint32(uint256(termDays) * 1 days);
        uint32 e1 = uint32(bound(elapsed1Seed, 3 days, totalTerm - 1 days));
        uint32 e2 = uint32(bound(elapsed2Seed, 0, totalTerm - e1));
        check_SimpleInterestEquivalenceAndCeiling(principal, rateBps, termDays, e1, e2);
    }

    /// @notice WS4.3 Property 1 (Halmos-compatible): Actual/365 ceiling formula, monotonicity & 1-wei checkpoint additivity.
    function check_SimpleInterestEquivalenceAndCeiling(
        uint64 principal,
        uint16 rateBps,
        uint16 termDays,
        uint32 e1,
        uint32 e2
    ) public {
        vm.assume(principal >= 500e6 && principal <= 500_000e6);
        vm.assume(rateBps >= 100 && rateBps <= 4000);
        vm.assume(termDays >= 7 && termDays <= 60);
        uint256 totalTerm = uint256(termDays) * 1 days;
        vm.assume(e1 >= 3 days && e1 <= totalTerm - 1 days);
        vm.assume(e2 <= totalTerm - e1);

        // Open two identical loans at BASE_TIME: loan1 accrues continuously, loan2 checkpoints via extend() at t1
        uint256 loan1 = _openLoan(col8, FIXED_COL_8, principal, rateBps, termDays, 1);
        uint256 loan2 = _openLoan(col8, FIXED_COL_8, principal, rateBps, termDays, 1);

        uint256 t1 = BASE_TIME + e1;
        vm.warp(t1);
        uint128 due1 = core.getDueInterest(loan1);
        uint256 expected1 = _ceilDiv(uint256(principal) * rateBps * e1, 10000 * SECONDS_PER_YEAR);
        assert(due1 == expected1);

        // Checkpoint loan2 at t1 using ERC-1271 lender wallet (no vm.sign / ecrecover)
        if (e2 > 0) {
            ILoanCore.Loan memory l2 = core.getLoan(loan2);
            vm.prank(BORROWER);
            core.extend(loan2, l2.maturity + 1 days, rateBps, uint64(t1 + 1 hours), "");
        }

        uint256 t2 = BASE_TIME + e1 + e2;
        vm.warp(t2);
        uint128 dueCombined = core.getDueInterest(loan1);
        uint256 expectedCombined = _ceilDiv(uint256(principal) * rateBps * (uint256(e1) + e2), 10000 * SECONDS_PER_YEAR);
        assert(dueCombined == expectedCombined);
        assert(dueCombined >= due1);

        if (e2 > 0) {
            uint128 checkpointTotal = core.getDueInterest(loan2);
            assert(checkpointTotal >= dueCombined);
            assert(checkpointTotal <= dueCombined + 1);
        }
    }

    // ---------------- Property 2: Grace Penalty (+500 bps) & Extend Caps (40% APR / 90d) ----------------

    /// forge-config: default.fuzz.runs = 512
    function test_check_GracePenaltySpreadAndExtendCap(
        uint64 principalSeed,
        uint16 rateSeed,
        uint32 graceSecsSeed,
        uint32 badRateSeed,
        uint16 excessDaysSeed
    ) public {
        uint64 principal = uint64(bound(principalSeed, 500e6, 200_000e6));
        uint16 rateBps = uint16(bound(rateSeed, 200, 3500));
        uint32 graceElapsed = uint32(bound(graceSecsSeed, 1, 24 hours));
        uint32 invalidRate = uint32(bound(badRateSeed, 4001, 50_000));
        uint16 excessDays = uint16(bound(excessDaysSeed, 1, 30));
        check_GracePenaltySpreadAndExtendCap(principal, rateBps, graceElapsed, invalidRate, excessDays);
    }

    /// @notice WS4.3 Property 2 (Halmos-compatible): +500 bps grace penalty spread & extend rate/term cap enforcement.
    function check_GracePenaltySpreadAndExtendCap(
        uint64 principal,
        uint16 rateBps,
        uint32 graceElapsed,
        uint32 invalidRate,
        uint16 excessDays
    ) public {
        vm.assume(principal >= 500e6 && principal <= 200_000e6);
        vm.assume(rateBps >= 200 && rateBps <= 3500);
        vm.assume(graceElapsed >= 1 && graceElapsed <= 24 hours);
        vm.assume(invalidRate >= 4001 && invalidRate <= 50_000);
        vm.assume(excessDays >= 1 && excessDays <= 30);

        uint256 loanId = _openLoan(col8, FIXED_COL_8, principal, rateBps, 10, 3);
        ILoanCore.Loan memory l = core.getLoan(loanId);

        // Pre-maturity: extend rate > 4000 bps MUST revert InvalidLoanTerms
        vm.prank(BORROWER);
        try core.extend(loanId, l.maturity + 1 days, invalidRate, uint64(BASE_TIME + 1 hours), "") {
            assert(false);
        } catch (bytes memory err) {
            assert(err.length >= 4 && bytes4(err) == LoanCore.InvalidLoanTerms.selector);
        }

        // Pre-maturity: extend maturity > startTime + 90 days MUST revert InvalidLoanTerms
        uint64 overMaxMat = l.startTime + 90 days + uint64(excessDays) * 1 days;
        vm.prank(BORROWER);
        try core.extend(loanId, overMaxMat, rateBps, uint64(BASE_TIME + 1 hours), "") {
            assert(false);
        } catch (bytes memory err) {
            assert(err.length >= 4 && bytes4(err) == LoanCore.InvalidLoanTerms.selector);
        }

        // Post-maturity grace penalty: regular 10d accrual + (rateBps + 500) penalty over graceElapsed
        vm.warp(uint256(l.maturity) + graceElapsed);
        uint256 expectedReg = _ceilDiv(uint256(principal) * rateBps * 10 days, 10000 * SECONDS_PER_YEAR);
        uint256 expectedPen = _ceilDiv(uint256(principal) * (uint256(rateBps) + 500) * graceElapsed, 10000 * SECONDS_PER_YEAR);
        assert(core.getDueInterest(loanId) == expectedReg + expectedPen);
    }

    // ---------------- Property 3: minInterestDays Lifetime Floor (No Double Counting) ----------------

    /// forge-config: default.fuzz.runs = 512
    function test_check_MinInterestFloorNoDoubleCount(
        uint64 principalSeed,
        uint16 rateSeed,
        uint8 minDaysSeed,
        uint32 elapsedSeed
    ) public {
        uint64 principal = uint64(bound(principalSeed, 500e6, 200_000e6));
        uint16 rateBps = uint16(bound(rateSeed, 200, 4000));
        uint8 minDays = uint8(bound(minDaysSeed, 1, 14));
        uint32 elapsed = uint32(bound(elapsedSeed, 0, 29 days));
        check_MinInterestFloorNoDoubleCount(principal, rateBps, minDays, elapsed);
    }

    /// @notice WS4.3 Property 3 (Halmos-compatible): minInterestDays acts strictly as lifetime floor with zero double-counting on extend.
    function check_MinInterestFloorNoDoubleCount(
        uint64 principal,
        uint16 rateBps,
        uint8 minDays,
        uint32 elapsed
    ) public {
        vm.assume(principal >= 500e6 && principal <= 200_000e6);
        vm.assume(rateBps >= 200 && rateBps <= 4000);
        vm.assume(minDays >= 1 && minDays <= 14);
        vm.assume(elapsed <= 29 days);

        uint256 loanId = _openLoan(col8, FIXED_COL_8, principal, rateBps, 30, minDays);
        uint256 tTarget = BASE_TIME + elapsed;
        vm.warp(tTarget);

        uint256 floorExpected = _ceilDiv(uint256(principal) * rateBps * (uint256(minDays) * 1 days), 10000 * SECONDS_PER_YEAR);
        uint256 realExpected = elapsed == 0 ? 0 : _ceilDiv(uint256(principal) * rateBps * elapsed, 10000 * SECONDS_PER_YEAR);
        uint256 expectedDue = realExpected > floorExpected ? realExpected : floorExpected;

        uint128 due = core.getDueInterest(loanId);
        assert(due == expectedDue);
        assert(due >= floorExpected);

        // Extending early at 40% APR must NEVER mutate accrued/floored due interest at tTarget
        ILoanCore.Loan memory l = core.getLoan(loanId);
        vm.prank(BORROWER);
        core.extend(loanId, l.maturity + 1 days, 4000, uint64(tTarget + 1 hours), "");
        assert(core.getDueInterest(loanId) == expectedDue);
    }

    // ---------------- Property 4: Close Factor, Linear Dutch Price & 0-Wei Waterfall Conservation ----------------

    /// forge-config: default.fuzz.runs = 512
    function test_check_CloseFactorAndAuctionWaterfallConservation(
        uint8 decIdxSeed,
        uint64 principalSeed,
        uint16 crashPriceUsdSeed,
        uint16 buyElapsedSeed,
        uint16 buyFracBpsSeed
    ) public {
        uint8 decIdx = uint8(bound(decIdxSeed, 0, 2));
        uint64 principal = uint64(bound(principalSeed, 1_000e6, 1_200e6));
        uint16 crashPriceUsd = uint16(bound(crashPriceUsdSeed, 60, 125));
        uint16 buyElapsed = uint16(bound(buyElapsedSeed, 0, 1800));
        uint16 buyFracBps = uint16(bound(buyFracBpsSeed, 4000, 10000));
        check_CloseFactorAndAuctionWaterfallConservation(decIdx, principal, crashPriceUsd, buyElapsed, buyFracBps);
    }

    /// @notice WS4.3 Property 4 (Halmos-compatible): Close factor (50% vs 100%), linear Dutch bounds & 0-wei waterfall conservation across 6/8/18 dec.
    function check_CloseFactorAndAuctionWaterfallConservation(
        uint8 decIdx,
        uint64 principal,
        uint16 crashPriceUsd,
        uint16 buyElapsed,
        uint16 buyFracBps
    ) public {
        vm.assume(decIdx <= 2);
        vm.assume(principal >= 1_000e6 && principal <= 1_200e6);
        vm.assume(crashPriceUsd >= 60 && crashPriceUsd <= 125);
        vm.assume(buyElapsed <= 1800);
        vm.assume(buyFracBps >= 4000 && buyFracBps <= 10000);

        MockERC20 tok;
        MockAggregator feed;
        uint256 colUnit;
        if (decIdx == 0) {
            tok = col6;
            feed = feed6;
            colUnit = 1e6;
        } else if (decIdx == 1) {
            tok = col8;
            feed = feed8;
            colUnit = 1e8;
        } else {
            tok = col18;
            feed = feed18;
            colUnit = 1e18;
        }

        // 10 shares @ $200 = $2,000 => 50%..60% init LTV for principal in [$1,000 .. $1,200]
        uint128 colAmt = uint128(10 * colUnit);
        uint256 loanId = _openLoan(tok, colAmt, principal, 800, 30, 3);

        uint256 crashPrice8 = uint256(crashPriceUsd) * 1e8;
        feed.setPrice(int256(crashPrice8));
        (uint256 grossVal, , ) = router.getValue(address(tok), colAmt);
        uint256 debt = uint256(principal) + core.getDueInterest(loanId);
        uint256 ltvBps = (debt * 10000) / grossVal;
        vm.assume(ltvBps >= 7800);

        vm.prank(KEEPER);
        uint256 aucId = core.startLiquidation(loanId);
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);

        if (ltvBps >= 9000) {
            assert(a.collateralTotal == colAmt);
        } else {
            assert(a.collateralTotal == colAmt / 2);
        }

        uint256 tBuy = BASE_TIME + buyElapsed;
        vm.warp(tBuy);
        feed.setUpdatedAt(tBuy);
        uint256 curPrice = auction.getCurrentPrice(aucId);
        assert(curPrice >= a.floorPrice);
        assert(curPrice <= a.startPrice);
        assert(curPrice == a.startPrice - (((a.startPrice - a.floorPrice) * buyElapsed) / a.duration));

        uint128 colBuy = uint128((uint256(a.collateralRemaining) * buyFracBps) / 10000);
        if (colBuy == 0) colBuy = a.collateralRemaining;
        uint256 den = colUnit * 1e8;
        uint128 expectedPaid = uint128(_ceilDiv(uint256(colBuy) * curPrice * 1e6, den));
        if (expectedPaid < auction.MIN_BUY_USDC()) {
            colBuy = a.collateralRemaining;
            expectedPaid = uint128(_ceilDiv(uint256(colBuy) * curPrice * 1e6, den));
        }

        uint256 keepBefore = usdc.balanceOf(KEEPER);
        uint256 feeBefore = usdc.balanceOf(TREASURY) + usdc.balanceOf(RESERVE);
        uint256 bBefore = usdc.balanceOf(BORROWER);
        uint256 coreBefore = usdc.balanceOf(address(core));
        uint256 lClaimBefore = core.getClaimable(address(lenderWallet));

        usdc.mint(LIQUIDATOR, expectedPaid);
        vm.prank(LIQUIDATOR);
        usdc.approve(address(auction), expectedPaid);
        vm.prank(LIQUIDATOR);
        uint128 paid = auction.buy(aucId, colBuy, expectedPaid);
        assert(paid == expectedPaid);

        uint256 keeperDelta = usdc.balanceOf(KEEPER) - keepBefore;
        uint256 feeDelta = (usdc.balanceOf(TREASURY) + usdc.balanceOf(RESERVE)) - feeBefore;
        uint256 borrowerDelta = usdc.balanceOf(BORROWER) - bBefore;
        uint256 claimDelta = core.getClaimable(address(lenderWallet)) - lClaimBefore;
        uint256 coreDelta = usdc.balanceOf(address(core)) - coreBefore;

        assert(keeperDelta + feeDelta + borrowerDelta + claimDelta == paid);
        assert(coreDelta == claimDelta);
        assert(usdc.balanceOf(address(auction)) == 0);
    }

    // ---------------- Property 5: CollateralEscrow Multi-Token Isolation & Access Control ----------------

    /// forge-config: default.fuzz.runs = 512
    function test_check_CollateralEscrowIsolation(uint64 amtA1, uint64 amtA2, uint64 amtB, uint64 releaseA) public {
        uint64 a1 = uint64(bound(amtA1, 1, 1_000_000e8));
        uint64 a2 = uint64(bound(amtA2, 1, 1_000_000e8));
        uint64 b1 = uint64(bound(amtB, 1, 1_000_000e18));
        uint64 rel = uint64(bound(releaseA, 0, a1));
        check_CollateralEscrowIsolation(a1, a2, b1, rel);
    }

    /// @notice WS4.3 Property 5 (Halmos-compatible): Multi-token isolation, over-release rejection & unauthorized withdrawal rejection.
    function check_CollateralEscrowIsolation(uint64 a1, uint64 a2, uint64 b1, uint64 rel) public {
        vm.assume(a1 >= 1 && a1 <= 1_000_000e8);
        vm.assume(a2 >= 1 && a2 <= 1_000_000e8);
        vm.assume(b1 >= 1 && b1 <= 1_000_000e18);
        vm.assume(rel <= a1);

        isoTokA.mint(ISO_USER_A, a1);
        isoTokA.mint(ISO_USER_B, a2);
        isoTokB.mint(ISO_USER_B, b1);

        vm.prank(ISO_USER_A);
        isoTokA.approve(address(isoEscrow), a1);
        vm.prank(ISO_USER_B);
        isoTokA.approve(address(isoEscrow), a2);
        vm.prank(ISO_USER_B);
        isoTokB.approve(address(isoEscrow), b1);

        vm.startPrank(ISO_AUTH);
        isoEscrow.depositCollateral(address(isoTokA), ISO_USER_A, a1);
        isoEscrow.depositCollateral(address(isoTokA), ISO_USER_B, a2);
        isoEscrow.depositCollateral(address(isoTokB), ISO_USER_B, b1);
        vm.stopPrank();

        assert(isoEscrow.getBalance(address(isoTokA)) == uint256(a1) + a2);
        assert(isoEscrow.getBalance(address(isoTokB)) == b1);

        // Unauthorized direct withdrawal MUST revert UnauthorizedCaller
        vm.prank(ISO_USER_A);
        try isoEscrow.releaseCollateral(address(isoTokA), ISO_USER_A, 1) {
            assert(false);
        } catch (bytes memory err) {
            assert(err.length >= 4 && bytes4(err) == CollateralEscrow.UnauthorizedCaller.selector);
        }

        vm.prank(ISO_AUTH);
        isoEscrow.releaseCollateral(address(isoTokA), ISO_USER_A, rel);

        uint256 expectedRemA = (uint256(a1) + a2) - rel;
        assert(isoEscrow.getBalance(address(isoTokA)) == expectedRemA);
        assert(isoTokA.balanceOf(address(isoEscrow)) == expectedRemA);
        assert(isoEscrow.getBalance(address(isoTokB)) == b1);
        assert(isoTokB.balanceOf(address(isoEscrow)) == b1);

        // Over-releasing tokA MUST revert InsufficientBalance and leave tokB untouched
        vm.prank(ISO_AUTH);
        try isoEscrow.releaseCollateral(address(isoTokA), ISO_USER_A, expectedRemA + 1) {
            assert(false);
        } catch (bytes memory err) {
            assert(err.length >= 4 && bytes4(err) == CollateralEscrow.InsufficientBalance.selector);
        }
        assert(isoEscrow.getBalance(address(isoTokB)) == b1);
    }
}
