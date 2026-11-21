// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

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
 * @title FormalPropertiesTest
 * @notice WS4.3 Halmos-compatible `check_*` symbolic & high-run Foundry property proofs
 *         verifying:
 *         1. Actual/365 simple interest ceiling rounding & 1-wei checkpoint additivity
 *         2. 24h grace penalty spread (+500 bps) & cumulative 90d / 40% extend caps
 *         3. minInterestDays lifetime floor without double-counting
 *         4. Liquidation close factors (50% vs 100%), linear Dutch price bounds, and 0-wei waterfall USDC conservation
 *         5. CollateralEscrow multi-token / multi-deposit isolation
 */
contract FormalPropertiesTest is Test {
    uint256 internal constant BASE_TIME = 1_795_100_400; // Tuesday 15:00 UTC (market open)
    uint256 internal constant SECONDS_PER_YEAR = 365 days;
    bytes32 internal constant EXTEND_ORDER_TYPEHASH = keccak256(
        "ExtendOrder(uint256 loanId,uint64 newMaturity,uint32 newRateBps,uint256 nonce,uint64 deadline)"
    );

    struct Stack {
        LoanCore core;
        CollateralEscrow escrow;
        PositionNFT nft;
        LiquidationAuction auction;
        AssetRegistry registry;
        OracleRouter router;
        FeeCollector feeCollector;
        EligibilityGate gate;
        MockERC20 usdc;
        MockERC20 col;
        MockAggregator feed;
        MockSequencer seq;
        address owner;
        address guardian;
        address treasury;
        address reserve;
        address settlement;
        address borrower;
        address lender;
        uint256 lenderPk;
        address keeper;
        address liquidator;
    }

    function _ceilDiv(uint256 num, uint256 den) internal pure returns (uint256) {
        return num == 0 ? 0 : (num + den - 1) / den;
    }

    function _deployStack(uint8 colDecimals, int256 initPrice) internal returns (Stack memory s) {
        vm.warp(BASE_TIME);
        s.owner = address(0x1111);
        s.guardian = address(0x2222);
        s.treasury = address(0x3333);
        s.reserve = address(0x4444);
        s.settlement = address(0x5555);
        s.borrower = address(0xB0B0);
        s.lenderPk = 0x7777;
        s.lender = vm.addr(s.lenderPk);
        s.keeper = address(0xCAFE);
        s.liquidator = address(0xDEAD);

        s.usdc = new MockERC20("USD Coin", "USDC", 6);
        s.col = new MockERC20("Collateral", "COL", colDecimals);
        s.col.setUiMultiplier(1e18);
        s.feed = new MockAggregator(8, initPrice);
        s.seq = new MockSequencer(0);

        vm.startPrank(s.owner);
        s.gate = new EligibilityGate(s.owner, s.owner, true);
        s.escrow = new CollateralEscrow(s.owner);
        s.nft = new PositionNFT(s.owner, address(s.gate));
        s.registry = AssetRegistry(address(new ERC1967Proxy(address(new AssetRegistry()), "")));
        s.registry.initialize(s.owner, s.guardian);
        s.router = OracleRouter(address(new ERC1967Proxy(address(new OracleRouter()), "")));
        s.router.initialize(s.owner, address(s.registry), address(s.seq));
        s.router.setMarketSession(true, true);
        s.registry.setOracleRouter(address(s.router));
        s.feeCollector = FeeCollector(address(new ERC1967Proxy(address(new FeeCollector()), "")));
        s.feeCollector.initialize(s.owner, s.treasury, s.reserve);

        s.core = LoanCore(address(new ERC1967Proxy(address(new LoanCore()), "")));
        s.auction = LiquidationAuction(address(new ERC1967Proxy(address(new LiquidationAuction()), "")));
        s.core.initialize(s.owner, s.guardian, address(s.escrow), address(s.nft), address(s.registry), address(s.router), address(s.feeCollector), address(s.auction), address(s.usdc));
        s.core.setOrderSettlement(s.settlement);
        s.core.setGlobalCap(10_000_000e6);
        s.auction.initialize(s.owner, address(s.escrow), address(s.core), address(s.feeCollector), address(s.usdc));
        s.escrow.setAuthorizedCore(address(s.core), true);
        s.escrow.setAuthorizedCore(address(s.auction), true);
        s.nft.setAuthorizedCore(address(s.core), true);

        s.registry.setAssetConfig(
            address(s.col),
            IAssetRegistry.AssetConfig({
                feed: address(s.feed),
                feedDecimals: 8,
                tier: 0,
                maxInitLtvBps: 6000,
                marginCallLtvBps: 7000,
                liqLtvBps: 7800,
                badDebtLtvBps: 9000,
                maxDiscountBps: 600,
                closedMarketHaircutBps: 500,
                perLoanCap: 10_000_000e6,
                assetCap: 10_000_000e6,
                maxStaleOpenSecs: 86400,
                status: uint8(IAssetRegistry.AssetStatus.Active),
                restricted: false
            })
        );
        vm.stopPrank();
    }

    function _signExtend(Stack memory s, uint256 loanId, uint64 newMat, uint32 newRate, uint256 nonce, uint64 deadline) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("NOSTOK Loan Core")),
                keccak256(bytes("1")),
                block.chainid,
                address(s.core)
            )
        );
        bytes32 sh = keccak256(abi.encode(EXTEND_ORDER_TYPEHASH, loanId, newMat, newRate, nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(s.lenderPk, keccak256(abi.encodePacked("\x19\x01", domain, sh)));
        return abi.encodePacked(r, s_, v);
    }

    /// @notice Foundry wrapper executing Halmos-compatible property 1 with 512 fuzz runs.
    /// forge-config: default.fuzz.runs = 512
    function test_check_SimpleInterestEquivalenceAndCeiling(
        uint64 principalSeed,
        uint16 rateSeed,
        uint16 termDaysSeed,
        uint32 elapsed1Seed,
        uint32 elapsed2Seed
    ) public {
        check_SimpleInterestEquivalenceAndCeiling(principalSeed, rateSeed, termDaysSeed, elapsed1Seed, elapsed2Seed);
    }

    /// @notice WS4.3 Property 1: Simple Interest Actual/365 ceiling formula, monotonicity, and checkpoint additivity.
    /// forge-config: default.fuzz.runs = 512
    function check_SimpleInterestEquivalenceAndCeiling(
        uint64 principalSeed,
        uint16 rateSeed,
        uint16 termDaysSeed,
        uint32 elapsed1Seed,
        uint32 elapsed2Seed
    ) public {
        Stack memory s = _deployStack(8, 200e8);
        uint128 principal = uint128(bound(principalSeed, 500e6, 500_000e6));
        uint32 rateBps = uint32(bound(rateSeed, 100, 4000));
        uint16 termDays = uint16(bound(termDaysSeed, 7, 60));

        // Ensure elapsed1 + elapsed2 stays inside [minDays..termDays] and post-minInterest floor
        uint256 totalTerm = uint256(termDays) * 1 days;
        uint256 e1 = bound(elapsed1Seed, 3 days, totalTerm - 1 days);
        uint256 e2 = bound(elapsed2Seed, 0, totalTerm - e1);
        uint256 colNeeded = _ceilDiv((uint256(principal) * 10000) / 6000, 200e6) * 1e8 + 10e8;

        s.col.mint(s.borrower, colNeeded);
        vm.prank(s.borrower);
        s.col.approve(address(s.escrow), colNeeded);
        s.usdc.mint(s.lender, principal);
        vm.prank(s.lender);
        s.usdc.approve(address(s.core), principal);
        vm.prank(s.settlement);
        uint256 loanId = s.core.openLoan(s.borrower, s.lender, address(s.col), uint128(colNeeded), principal, rateBps, termDays, 6000, 1, 0);

        // Snapshot single-interval accrual at BASE_TIME + e1 and BASE_TIME + e1 + e2 (explicit monotonic timestamps for --via-ir safety)
        uint256 t1 = BASE_TIME + e1;
        vm.warp(t1);
        uint128 due1 = s.core.getDueInterest(loanId);
        uint256 expected1 = _ceilDiv(uint256(principal) * rateBps * e1, 10000 * SECONDS_PER_YEAR);
        assertEq(due1, expected1, "Pre-maturity getDueInterest mismatch vs exact Actual/365 ceil equation");

        uint256 t2 = BASE_TIME + e1 + e2;
        vm.warp(t2);
        uint128 dueCombined = s.core.getDueInterest(loanId);
        uint256 expectedCombined = _ceilDiv(uint256(principal) * rateBps * (e1 + e2), 10000 * SECONDS_PER_YEAR);
        assertEq(dueCombined, expectedCombined, "Combined Actual/365 ceil equation mismatch");
        assertGe(dueCombined, due1, "Interest must be monotonically non-decreasing");

        // Checkpoint via zero-rate extension at BASE_TIME + e1 preserves old accrual and continues at same rate
        if (e2 > 0 && BASE_TIME + totalTerm + 1 days <= BASE_TIME + 90 days) {
            // Deploy fresh mirror loan and checkpoint via extend(rate=rateBps) at BASE_TIME + e1
            Stack memory s2 = _deployStack(8, 200e8);
            s2.col.mint(s2.borrower, colNeeded);
            vm.prank(s2.borrower);
            s2.col.approve(address(s2.escrow), colNeeded);
            s2.usdc.mint(s2.lender, principal);
            vm.prank(s2.lender);
            s2.usdc.approve(address(s2.core), principal);
            vm.prank(s2.settlement);
            uint256 id2 = s2.core.openLoan(s2.borrower, s2.lender, address(s2.col), uint128(colNeeded), principal, rateBps, termDays, 6000, 1, 0);

            vm.warp(t1);
            ILoanCore.Loan memory l2 = s2.core.getLoan(id2);
            uint64 newMat = l2.maturity + 1 days;
            uint64 dl = uint64(t1 + 1 hours);
            bytes memory sig = _signExtend(s2, id2, newMat, rateBps, 0, dl);
            vm.prank(s2.borrower);
            s2.core.extend(id2, newMat, rateBps, dl, sig);

            vm.warp(t2);
            uint128 checkpointTotal = s2.core.getDueInterest(id2);
            assertGe(checkpointTotal, dueCombined);
            assertLe(checkpointTotal, dueCombined + 1, "Split ceil accrual can differ by at most +1 wei");
        }
    }

    /// @notice Foundry wrapper executing Halmos-compatible property 2 with 512 fuzz runs.
    /// forge-config: default.fuzz.runs = 512
    function test_check_GracePenaltySpreadAndExtendCap(
        uint64 principalSeed,
        uint16 rateSeed,
        uint32 graceSecsSeed,
        uint32 badRateSeed,
        uint16 excessDaysSeed
    ) public {
        check_GracePenaltySpreadAndExtendCap(principalSeed, rateSeed, graceSecsSeed, badRateSeed, excessDaysSeed);
    }

    /// @notice WS4.3 Property 2: Grace penalty (+500 bps post-maturity) & extend limits (40% max APR, 90d cumulative).
    /// forge-config: default.fuzz.runs = 512
    function check_GracePenaltySpreadAndExtendCap(
        uint64 principalSeed,
        uint16 rateSeed,
        uint32 graceSecsSeed,
        uint32 badRateSeed,
        uint16 excessDaysSeed
    ) public {
        Stack memory s = _deployStack(8, 200e8);
        uint128 principal = uint128(bound(principalSeed, 500e6, 200_000e6));
        uint32 rateBps = uint32(bound(rateSeed, 200, 3500));
        uint256 colNeeded = _ceilDiv((uint256(principal) * 10000) / 6000, 200e6) * 1e8 + 10e8;

        s.col.mint(s.borrower, colNeeded);
        vm.prank(s.borrower);
        s.col.approve(address(s.escrow), colNeeded);
        s.usdc.mint(s.lender, principal);
        vm.prank(s.lender);
        s.usdc.approve(address(s.core), principal);
        vm.prank(s.settlement);
        uint256 loanId = s.core.openLoan(s.borrower, s.lender, address(s.col), uint128(colNeeded), principal, rateBps, 10, 6000, 3, 0);

        ILoanCore.Loan memory l = s.core.getLoan(loanId);
        uint256 graceElapsed = bound(graceSecsSeed, 1, 24 hours);
        vm.warp(l.maturity + graceElapsed);

        uint256 expectedReg = _ceilDiv(uint256(principal) * rateBps * 10 days, 10000 * SECONDS_PER_YEAR);
        uint256 expectedPen = _ceilDiv(uint256(principal) * (rateBps + 500) * graceElapsed, 10000 * SECONDS_PER_YEAR);
        assertEq(s.core.getDueInterest(loanId), expectedReg + expectedPen, "Grace interest equation mismatch");

        // Enforce extend rate > 4000 bps and maturity > startTime + 90 days always revert on a pre-maturity loan
        Stack memory s2 = _deployStack(8, 200e8);
        s2.col.mint(s2.borrower, colNeeded);
        vm.prank(s2.borrower);
        s2.col.approve(address(s2.escrow), colNeeded);
        s2.usdc.mint(s2.lender, principal);
        vm.prank(s2.lender);
        s2.usdc.approve(address(s2.core), principal);
        vm.prank(s2.settlement);
        uint256 id2 = s2.core.openLoan(s2.borrower, s2.lender, address(s2.col), uint128(colNeeded), principal, rateBps, 10, 6000, 3, 0);
        ILoanCore.Loan memory l2 = s2.core.getLoan(id2);

        uint32 invalidRate = uint32(bound(badRateSeed, 4001, 50_000));
        vm.prank(s2.borrower);
        vm.expectRevert(LoanCore.InvalidLoanTerms.selector);
        s2.core.extend(id2, l2.maturity + 1 days, invalidRate, uint64(block.timestamp + 1 hours), "");

        uint64 overMaxMat = l2.startTime + 90 days + uint64(bound(excessDaysSeed, 1, 30) * 1 days);
        vm.prank(s2.borrower);
        vm.expectRevert(LoanCore.InvalidLoanTerms.selector);
        s2.core.extend(id2, overMaxMat, rateBps, uint64(block.timestamp + 1 hours), "");
    }

    /// @notice Foundry wrapper executing Halmos-compatible property 3 with 512 fuzz runs.
    /// forge-config: default.fuzz.runs = 512
    function test_check_MinInterestFloorNoDoubleCount(
        uint64 principalSeed,
        uint16 rateSeed,
        uint8 minDaysSeed,
        uint32 elapsedSeed
    ) public {
        check_MinInterestFloorNoDoubleCount(principalSeed, rateSeed, minDaysSeed, elapsedSeed);
    }

    /// @notice WS4.3 Property 3: minInterestDays acts strictly as a lifetime floor without double counting.
    /// forge-config: default.fuzz.runs = 512
    function check_MinInterestFloorNoDoubleCount(
        uint64 principalSeed,
        uint16 rateSeed,
        uint8 minDaysSeed,
        uint32 elapsedSeed
    ) public {
        Stack memory s = _deployStack(8, 200e8);
        uint128 principal = uint128(bound(principalSeed, 500e6, 200_000e6));
        uint32 rateBps = uint32(bound(rateSeed, 200, 4000));
        uint16 minDays = uint16(bound(minDaysSeed, 1, 14));
        uint256 colNeeded = _ceilDiv((uint256(principal) * 10000) / 6000, 200e6) * 1e8 + 10e8;

        s.col.mint(s.borrower, colNeeded);
        vm.prank(s.borrower);
        s.col.approve(address(s.escrow), colNeeded);
        s.usdc.mint(s.lender, principal);
        vm.prank(s.lender);
        s.usdc.approve(address(s.core), principal);
        vm.prank(s.settlement);
        uint256 loanId = s.core.openLoan(s.borrower, s.lender, address(s.col), uint128(colNeeded), principal, rateBps, 30, 6000, minDays, 0);

        uint256 elapsed = bound(elapsedSeed, 0, 29 days);
        uint256 tTarget = BASE_TIME + elapsed;
        vm.warp(tTarget);

        uint256 floorExpected = _ceilDiv(uint256(principal) * rateBps * (uint256(minDays) * 1 days), 10000 * SECONDS_PER_YEAR);
        uint256 realExpected = elapsed == 0 ? 0 : _ceilDiv(uint256(principal) * rateBps * elapsed, 10000 * SECONDS_PER_YEAR);
        uint256 expectedDue = realExpected > floorExpected ? realExpected : floorExpected;

        uint128 due = s.core.getDueInterest(loanId);
        assertEq(due, expectedDue, "Exact max(realAccrued, minFloor) equality failed");
        assertGe(due, floorExpected);

        // Extending early and repaying immediately must NEVER charge floor twice
        ILoanCore.Loan memory l = s.core.getLoan(loanId);
        uint64 dl = uint64(tTarget + 1 hours);
        bytes memory sig = _signExtend(s, loanId, l.maturity + 1 days, 4000, 0, dl);
        vm.prank(s.borrower);
        s.core.extend(loanId, l.maturity + 1 days, 4000, dl, sig);
        assertEq(s.core.getDueInterest(loanId), expectedDue, "Extend mutated accrued/floored due interest");
    }

    /// @notice Foundry wrapper executing Halmos-compatible property 4 with 512 fuzz runs.
    /// forge-config: default.fuzz.runs = 512
    function test_check_CloseFactorAndAuctionWaterfallConservation(
        uint8 decIdx,
        uint64 principalSeed,
        uint16 crashPriceUsdSeed,
        uint16 buyElapsedSeed,
        uint16 buyFracBpsSeed
    ) public {
        check_CloseFactorAndAuctionWaterfallConservation(decIdx, principalSeed, crashPriceUsdSeed, buyElapsedSeed, buyFracBpsSeed);
    }

    /// @notice WS4.3 Property 4: Liquidation close factor (50% vs 100%), linear price decay bounds,
    ///         and 0-wei global USDC conservation across 6, 8, and 18 collateral decimals.
    /// forge-config: default.fuzz.runs = 512
    function check_CloseFactorAndAuctionWaterfallConservation(
        uint8 decIdx,
        uint64 principalSeed,
        uint16 crashPriceUsdSeed,
        uint16 buyElapsedSeed,
        uint16 buyFracBpsSeed
    ) public {
        uint8 colDec = decIdx % 3 == 0 ? 6 : (decIdx % 3 == 1 ? 8 : 18);
        uint256 colUnit = 10 ** colDec;
        Stack memory s = _deployStack(colDec, 200e8);

        uint128 principal = uint128(bound(principalSeed, 1_000e6, 50_000e6));
        // Target initial LTV ~50% at $200 => collateral value = 2 * principal => whole shares to simplify rounding bounds
        uint256 shares = _ceilDiv(uint256(principal) * 2, 200e6);
        uint128 colAmt = uint128(shares * colUnit);

        s.col.mint(s.borrower, colAmt);
        vm.prank(s.borrower);
        s.col.approve(address(s.escrow), colAmt);
        s.usdc.mint(s.lender, principal);
        vm.prank(s.lender);
        s.usdc.approve(address(s.core), principal);
        vm.prank(s.settlement);
        uint256 loanId = s.core.openLoan(s.borrower, s.lender, address(s.col), colAmt, principal, 800, 30, 6000, 3, 0);

        // Crash oracle price into liquidatable range [$60 .. $125]
        uint256 crashPrice8 = bound(crashPriceUsdSeed, 60, 125) * 1e8;
        s.feed.setPrice(int256(crashPrice8));
        (uint256 grossVal, , ) = s.router.getValue(address(s.col), colAmt);
        uint256 debt = uint256(principal) + s.core.getDueInterest(loanId);
        uint256 ltvBps = (debt * 10000) / grossVal;
        vm.assume(ltvBps >= 7800);

        vm.prank(s.keeper);
        uint256 aucId = s.core.startLiquidation(loanId);
        ILiquidationAuction.Auction memory a = s.auction.getAuction(aucId);

        // Verify close-factor law: < badDebtLtvBps (9000) => 50%, >= badDebtLtvBps => 100%
        if (ltvBps >= 9000) {
            assertEq(a.collateralTotal, colAmt, ">= badDebtLtvBps must trigger 100% close factor");
        } else {
            assertEq(a.collateralTotal, colAmt / 2, "< badDebtLtvBps must trigger 50% partial close factor");
        }

        // Advance inside auction duration and verify linear Dutch price invariant: floor <= cur <= start
        uint256 elapsed = bound(buyElapsedSeed, 0, a.duration);
        uint256 tBuy = BASE_TIME + elapsed;
        vm.warp(tBuy);
        s.feed.setUpdatedAt(tBuy);
        uint256 curPrice = s.auction.getCurrentPrice(aucId);
        assertGe(curPrice, a.floorPrice);
        assertLe(curPrice, a.startPrice);
        assertEq(curPrice, a.startPrice - (((a.startPrice - a.floorPrice) * elapsed) / a.duration));

        // Buy partial/full slice above MIN_BUY_USDC and prove 0-wei waterfall conservation!
        uint128 colBuy = uint128((uint256(a.collateralRemaining) * bound(buyFracBpsSeed, 4000, 10000)) / 10000);
        if (colBuy == 0) colBuy = a.collateralRemaining;
        uint256 den = colUnit * 1e8;
        uint128 expectedPaid = uint128(_ceilDiv(uint256(colBuy) * curPrice * 1e6, den));
        if (expectedPaid < s.auction.MIN_BUY_USDC()) {
            colBuy = a.collateralRemaining;
            expectedPaid = uint128(_ceilDiv(uint256(colBuy) * curPrice * 1e6, den));
        }

        uint256 keepBefore = s.usdc.balanceOf(s.keeper);
        uint256 feeBefore = s.usdc.balanceOf(s.treasury) + s.usdc.balanceOf(s.reserve);
        uint256 bBefore = s.usdc.balanceOf(s.borrower);
        uint256 coreBefore = s.usdc.balanceOf(address(s.core));
        uint256 lClaimBefore = s.core.getClaimable(s.lender);

        s.usdc.mint(s.liquidator, expectedPaid);
        vm.prank(s.liquidator);
        s.usdc.approve(address(s.auction), expectedPaid);
        vm.prank(s.liquidator);
        uint128 paid = s.auction.buy(aucId, colBuy, expectedPaid);
        assertEq(paid, expectedPaid);

        uint256 keeperDelta = s.usdc.balanceOf(s.keeper) - keepBefore;
        uint256 feeDelta = (s.usdc.balanceOf(s.treasury) + s.usdc.balanceOf(s.reserve)) - feeBefore;
        uint256 borrowerDelta = s.usdc.balanceOf(s.borrower) - bBefore;
        uint256 claimDelta = s.core.getClaimable(s.lender) - lClaimBefore;
        uint256 coreDelta = s.usdc.balanceOf(address(s.core)) - coreBefore;

        assertEq(keeperDelta + feeDelta + borrowerDelta + claimDelta, paid, "0-wei waterfall USDC conservation violated");
        assertEq(coreDelta, claimDelta, "LoanCore USDC delta must match lender claimable increase");
        assertEq(s.usdc.balanceOf(address(s.auction)), 0, "Auction must never retain stranded USDC");
    }

    /// @notice Foundry wrapper executing Halmos-compatible property 5 with 512 fuzz runs.
    /// forge-config: default.fuzz.runs = 512
    function test_check_CollateralEscrowIsolation(uint64 amtA1, uint64 amtA2, uint64 amtB, uint64 releaseA) public {
        check_CollateralEscrowIsolation(amtA1, amtA2, amtB, releaseA);
    }

    /// @notice WS4.3 Property 5: CollateralEscrow isolates independent tokens & balances and reverts on over-release.
    /// forge-config: default.fuzz.runs = 512
    function check_CollateralEscrowIsolation(uint64 amtA1, uint64 amtA2, uint64 amtB, uint64 releaseA) public {
        address coreAuth = address(0x9001);
        address userA = address(0xA001);
        address userB = address(0xB001);

        CollateralEscrow escrow = new CollateralEscrow(address(this));
        escrow.setAuthorizedCore(coreAuth, true);
        MockERC20 tokA = new MockERC20("Token A", "TOKA", 8);
        MockERC20 tokB = new MockERC20("Token B", "TOKB", 18);

        uint256 a1 = bound(amtA1, 1, 1_000_000e8);
        uint256 a2 = bound(amtA2, 1, 1_000_000e8);
        uint256 b1 = bound(amtB, 1, 1_000_000e18);

        tokA.mint(userA, a1);
        tokA.mint(userB, a2);
        tokB.mint(userB, b1);

        vm.prank(userA);
        tokA.approve(address(escrow), a1);
        vm.prank(userB);
        tokA.approve(address(escrow), a2);
        vm.prank(userB);
        tokB.approve(address(escrow), b1);

        vm.startPrank(coreAuth);
        escrow.depositCollateral(address(tokA), userA, a1);
        escrow.depositCollateral(address(tokA), userB, a2);
        escrow.depositCollateral(address(tokB), userB, b1);
        vm.stopPrank();

        assertEq(escrow.getBalance(address(tokA)), a1 + a2);
        assertEq(escrow.getBalance(address(tokB)), b1);

        uint256 rel = bound(releaseA, 0, a1);
        vm.prank(coreAuth);
        escrow.releaseCollateral(address(tokA), userA, rel);

        // Releasing tokA never mutates tokB
        assertEq(escrow.getBalance(address(tokA)), (a1 + a2) - rel);
        assertEq(tokA.balanceOf(address(escrow)), (a1 + a2) - rel);
        assertEq(escrow.getBalance(address(tokB)), b1);
        assertEq(tokB.balanceOf(address(escrow)), b1);

        // Over-releasing tokA reverts cleanly with InsufficientBalance and leaves balances untouched
        uint256 tooMuch = ((a1 + a2) - rel) + 1;
        vm.prank(coreAuth);
        vm.expectRevert(CollateralEscrow.InsufficientBalance.selector);
        escrow.releaseCollateral(address(tokA), userA, tooMuch);

        assertEq(escrow.getBalance(address(tokB)), b1);
    }
}
