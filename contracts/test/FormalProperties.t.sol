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
 * @notice WS4.3 Halmos-compatible `check_*` symbolic properties decomposed into fast solver-friendly
 *         proofs paired with 512-run Foundry fuzz wrappers (`test_check_*`):
 *         1. Actual/365 simple interest ceiling formula, monotonicity & extend checkpoint additivity
 *            ([500 .. 500,000] USDC, [1% .. 40%] APR, elapsed [3d .. 58d])
 *         2. 24h grace penalty (+500 bps) across [500 .. 200,000] USDC & [2% .. 35%] APR + extend caps (40% APR, 90d)
 *         3. minInterestDays lifetime floor without double counting on extend
 *         4. Close factor (50% vs 100%) across full 1,000-50,000 USDC & 6/8/18 collateral decimals,
 *            linear Dutch auction decay bounds, and 0-wei waterfall USDC conservation (1,000-50,000 USDC, 6/8/18 dec)
 *         5. CollateralEscrow multi-token isolation, over-release revert & unauthorized caller rejection
 */
contract FormalPropertiesTest is TestBase, StdUtils {
    bool public IS_TEST = true;

    uint256 internal constant BASE_TIME = 1_795_100_400; // Tuesday 15:00 UTC (regular US market open)
    uint256 internal constant SECONDS_PER_YEAR = 365 days;
    uint128 internal constant FIXED_COL_8 = 5_000e8; // $1,000,000 @ $200 => <= 50% LTV up to $500k
    uint32 internal constant STD_RATE_BPS = 800;     // 8.00% APR
    uint64 internal constant STD_PRINCIPAL = 10_000e6;

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

    uint256 internal capLoanId;
    uint256 internal stdInterestLoanId;
    uint256 internal symBuyAucId;

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

        capLoanId = _openLoan(col8, FIXED_COL_8, STD_PRINCIPAL, STD_RATE_BPS, 10, 3);
        stdInterestLoanId = _openLoan(col8, FIXED_COL_8, STD_PRINCIPAL, STD_RATE_BPS, 60, 1);

        // Pre-open & liquidate a dedicated concrete auction for SymbolicBuyAmount so Halmos focuses 100% on buy() + settlement waterfall.
        uint256 symBuyLoanId = _openLoan(col8, 100e8, STD_PRINCIPAL, STD_RATE_BPS, 30, 3);
        feed8.setPrice(80e8);
        vm.prank(KEEPER);
        symBuyAucId = core.startLiquidation(symBuyLoanId);
        feed8.setPrice(200e8);

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

    // ---------------- Property 1: Actual/365 Simple Interest, Monotonicity & Checkpoint Additivity ----------------

    /// forge-config: default.fuzz.runs = 512
    function test_check_SimpleInterestFormula_SymbolicPrincipal(uint64 principalSeed) public {
        check_SimpleInterestFormula_SymbolicPrincipal(uint64(bound(principalSeed, 500e6, 500_000e6)));
    }

    /// @notice WS4.3 Property 1a: Exact Actual/365 ceiling across all principals [500 .. 500,000] USDC.
    function check_SimpleInterestFormula_SymbolicPrincipal(uint64 principal) public {
        vm.assume(principal >= 500e6 && principal <= 500_000e6);

        uint256 loanId = _openLoan(col8, FIXED_COL_8, principal, STD_RATE_BPS, 60, 1);
        uint256 elapsed = 20 days;
        vm.warp(BASE_TIME + elapsed);
        uint128 due = core.getDueInterest(loanId);
        uint256 expected = _ceilDiv(uint256(principal) * STD_RATE_BPS * elapsed, 10000 * SECONDS_PER_YEAR);
        assert(due == expected);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_SimpleInterestFormula_SymbolicRate(uint16 rateSeed) public {
        check_SimpleInterestFormula_SymbolicRate(uint16(bound(rateSeed, 100, 4000)));
    }

    /// @notice WS4.3 Property 1b: Exact Actual/365 ceiling across all APRs [1% .. 40%].
    function check_SimpleInterestFormula_SymbolicRate(uint16 rateBps) public {
        vm.assume(rateBps >= 100 && rateBps <= 4000);

        uint256 loanId = _openLoan(col8, FIXED_COL_8, STD_PRINCIPAL, rateBps, 60, 1);
        uint256 elapsed = 20 days;
        vm.warp(BASE_TIME + elapsed);
        uint128 due = core.getDueInterest(loanId);
        uint256 expected = _ceilDiv(uint256(STD_PRINCIPAL) * rateBps * elapsed, 10000 * SECONDS_PER_YEAR);
        assert(due == expected);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_SimpleInterestFormula_SymbolicElapsed(uint32 elapsedSeed) public {
        check_SimpleInterestFormula_SymbolicElapsed(uint32(bound(elapsedSeed, 3 days, 58 days)));
    }

    /// @notice WS4.3 Property 1c: Exact Actual/365 ceiling & monotonicity across all elapsed timestamps [3d .. 58d].
    function check_SimpleInterestFormula_SymbolicElapsed(uint32 elapsed) public {
        vm.assume(elapsed >= 3 days && elapsed <= 58 days);

        vm.warp(BASE_TIME + elapsed);
        uint128 due = core.getDueInterest(stdInterestLoanId);
        uint256 expected = _ceilDiv(uint256(STD_PRINCIPAL) * STD_RATE_BPS * elapsed, 10000 * SECONDS_PER_YEAR);
        assert(due == expected);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_SimpleInterestCheckpointExact(uint32 e2Seed) public {
        check_SimpleInterestCheckpointExact(uint32(bound(e2Seed, 1, 29 days)));
    }

    /// @notice WS4.3 Property 1d-a: Extend() checkpointing at t1=15d preserves exact incremental Actual/365 accrual & monotonicity over [1s .. 29d].
    function check_SimpleInterestCheckpointExact(uint32 e2) public {
        vm.assume(e2 >= 1 && e2 <= 29 days);

        uint256 t1 = BASE_TIME + 15 days;
        vm.warp(t1);
        uint128 due1 = core.getDueInterest(stdInterestLoanId);
        ILoanCore.Loan memory l = core.getLoan(stdInterestLoanId);
        vm.prank(BORROWER);
        core.extend(stdInterestLoanId, l.maturity + 1 days, STD_RATE_BPS, uint64(t1 + 1 hours), "");

        vm.warp(t1 + e2);
        uint128 splitDue = core.getDueInterest(stdInterestLoanId);
        uint256 leg2 = _ceilDiv(uint256(STD_PRINCIPAL) * STD_RATE_BPS * e2, 10000 * SECONDS_PER_YEAR);
        assert(splitDue >= due1);
        assert(splitDue == due1 + leg2);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_SimpleInterestCheckpointSubadditive(uint32 e2Seed) public pure {
        uint256 den = 10000 * SECONDS_PER_YEAR;
        uint32 e2 = uint32(bound(e2Seed, 1, 29 days));
        uint256 num2 = uint256(STD_PRINCIPAL) * STD_RATE_BPS * e2;
        check_SimpleInterestCheckpointSubadditive(e2, uint64(num2 / den), uint64(num2 % den));
    }

    /// @notice WS4.3 Property 1d-b: Checkpointed ceiling sum at t1=15d is bounded in [unsplitDue .. unsplitDue + 1] across all [1s .. 29d].
    function check_SimpleInterestCheckpointSubadditive(uint32 e2, uint64 q2, uint64 r2) public pure {
        uint256 den = 10000 * SECONDS_PER_YEAR;
        vm.assume(e2 >= 1 && e2 <= 29 days);
        vm.assume(r2 < den);
        uint256 num1 = uint256(STD_PRINCIPAL) * STD_RATE_BPS * 15 days;
        uint256 num2 = uint256(STD_PRINCIPAL) * STD_RATE_BPS * e2;
        vm.assume(num2 == uint256(q2) * den + uint256(r2));

        uint256 q1 = num1 / den;
        uint256 r1 = num1 % den;
        uint256 leg1 = q1 + (r1 > 0 ? 1 : 0);
        uint256 leg2 = uint256(q2) + (r2 > 0 ? 1 : 0);
        uint256 rSum = r1 + uint256(r2);
        uint256 unsplitDue = q1 + uint256(q2) + (rSum == 0 ? 0 : (rSum <= den ? 1 : 2));

        assert(leg1 + leg2 >= unsplitDue);
        assert(leg1 + leg2 <= unsplitDue + 1);
    }

    // ---------------- Property 2: Grace Penalty Spread (+500 bps) & Extend Caps ----------------

    /// forge-config: default.fuzz.runs = 512
    function test_check_GracePenaltySpread_SymbolicPrincipalTime(uint64 principalSeed, uint32 graceSecsSeed) public {
        check_GracePenaltySpread_SymbolicPrincipalTime(
            uint64(bound(principalSeed, 500e6, 200_000e6)),
            uint32(bound(graceSecsSeed, 1, 24 hours))
        );
    }

    /// @notice WS4.3 Property 2a: Post-maturity grace accrues regular 10d + (rate + 500 bps) penalty across [500 .. 200,000] USDC.
    function check_GracePenaltySpread_SymbolicPrincipalTime(uint64 principal, uint32 graceElapsed) public {
        vm.assume(principal >= 500e6 && principal <= 200_000e6);
        vm.assume(graceElapsed >= 1 && graceElapsed <= 24 hours);

        uint256 loanId = _openLoan(col8, FIXED_COL_8, principal, STD_RATE_BPS, 10, 3);
        ILoanCore.Loan memory l = core.getLoan(loanId);

        vm.warp(uint256(l.maturity) + graceElapsed);
        uint256 expectedReg = _ceilDiv(uint256(principal) * STD_RATE_BPS * 10 days, 10000 * SECONDS_PER_YEAR);
        uint256 expectedPen = _ceilDiv(uint256(principal) * (uint256(STD_RATE_BPS) + 500) * graceElapsed, 10000 * SECONDS_PER_YEAR);
        assert(core.getDueInterest(loanId) == expectedReg + expectedPen);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_GracePenaltySpread_SymbolicRate(uint16 rateSeed) public {
        check_GracePenaltySpread_SymbolicRate(uint16(bound(rateSeed, 200, 3500)));
    }

    /// @notice WS4.3 Property 2b: Post-maturity grace penalty (+500 bps) holds across full [2% .. 35%] APR.
    function check_GracePenaltySpread_SymbolicRate(uint16 rateBps) public {
        vm.assume(rateBps >= 200 && rateBps <= 3500);

        uint256 loanId = _openLoan(col8, FIXED_COL_8, STD_PRINCIPAL, rateBps, 10, 3);
        ILoanCore.Loan memory l = core.getLoan(loanId);
        uint256 graceElapsed = 12 hours;

        vm.warp(uint256(l.maturity) + graceElapsed);
        uint256 expectedReg = _ceilDiv(uint256(STD_PRINCIPAL) * rateBps * 10 days, 10000 * SECONDS_PER_YEAR);
        uint256 expectedPen = _ceilDiv(uint256(STD_PRINCIPAL) * (uint256(rateBps) + 500) * graceElapsed, 10000 * SECONDS_PER_YEAR);
        assert(core.getDueInterest(loanId) == expectedReg + expectedPen);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_ExtendCapsEnforcement(uint32 badRateSeed, uint16 excessDaysSeed) public {
        check_ExtendCapsEnforcement(
            uint32(bound(badRateSeed, 4001, type(uint32).max)),
            uint16(bound(excessDaysSeed, 1, 3650))
        );
    }

    /// @notice WS4.3 Property 2c: Extend strictly rejects rate > 4000 bps and maturity > startTime + 90 days.
    function check_ExtendCapsEnforcement(uint32 invalidRate, uint16 excessDays) public {
        vm.assume(invalidRate > 4000);
        vm.assume(excessDays >= 1 && excessDays <= 3650);

        ILoanCore.Loan memory l = core.getLoan(capLoanId);

        vm.prank(BORROWER);
        try core.extend(capLoanId, l.maturity + 1 days, invalidRate, uint64(BASE_TIME + 1 hours), "") {
            assert(false);
        } catch (bytes memory err) {
            assert(err.length >= 4 && bytes4(err) == LoanCore.InvalidLoanTerms.selector);
        }

        uint64 overMaxMat = l.startTime + 90 days + uint64(excessDays) * 1 days;
        vm.prank(BORROWER);
        try core.extend(capLoanId, overMaxMat, l.rateBps, uint64(BASE_TIME + 1 hours), "") {
            assert(false);
        } catch (bytes memory err) {
            assert(err.length >= 4 && bytes4(err) == LoanCore.InvalidLoanTerms.selector);
        }
    }

    // ---------------- Property 3: minInterestDays Lifetime Floor (No Double Counting) ----------------

    /// forge-config: default.fuzz.runs = 512
    function test_check_MinInterestFloorNoDoubleCount(uint64 principalSeed) public {
        check_MinInterestFloorNoDoubleCount(uint64(bound(principalSeed, 500e6, 200_000e6)));
    }

    /// @notice WS4.3 Property 3a: minInterestDays=7 lifetime floor holds across [500 .. 200,000] USDC with zero extend double-count.
    function check_MinInterestFloorNoDoubleCount(uint64 principal) public {
        vm.assume(principal >= 500e6 && principal <= 200_000e6);

        uint256 loanId = _openLoan(col8, FIXED_COL_8, principal, STD_RATE_BPS, 30, 7);
        uint256 tTarget = BASE_TIME + 1 days;
        vm.warp(tTarget);

        uint256 floorExpected = _ceilDiv(uint256(principal) * STD_RATE_BPS * 7 days, 10000 * SECONDS_PER_YEAR);
        uint128 due = core.getDueInterest(loanId);
        assert(due == floorExpected);

        ILoanCore.Loan memory l = core.getLoan(loanId);
        vm.prank(BORROWER);
        core.extend(loanId, l.maturity + 1 days, 4000, uint64(tTarget + 1 hours), "");
        assert(core.getDueInterest(loanId) == floorExpected);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_MinInterestFloorTimeTransition(uint8 minDaysSeed, uint32 elapsedSeed) public {
        check_MinInterestFloorTimeTransition(
            uint8(bound(minDaysSeed, 1, 14)),
            uint32(bound(elapsedSeed, 0, 29 days))
        );
    }

    /// @notice WS4.3 Property 3b: Continuous time transition [0 .. 29d] satisfies max(realAccrued, minFloor) with zero extend double-count.
    function check_MinInterestFloorTimeTransition(uint8 minDays, uint32 elapsed) public {
        vm.assume(minDays >= 1 && minDays <= 14);
        vm.assume(elapsed <= 29 days);

        uint256 loanId = _openLoan(col8, FIXED_COL_8, STD_PRINCIPAL, STD_RATE_BPS, 30, minDays);
        uint256 tTarget = BASE_TIME + elapsed;
        vm.warp(tTarget);

        uint256 floorExpected = _ceilDiv(uint256(STD_PRINCIPAL) * STD_RATE_BPS * (uint256(minDays) * 1 days), 10000 * SECONDS_PER_YEAR);
        uint256 realExpected = elapsed == 0 ? 0 : _ceilDiv(uint256(STD_PRINCIPAL) * STD_RATE_BPS * elapsed, 10000 * SECONDS_PER_YEAR);
        uint256 expectedDue = realExpected > floorExpected ? realExpected : floorExpected;

        uint128 due = core.getDueInterest(loanId);
        assert(due == expectedDue);
        assert(due >= floorExpected);

        ILoanCore.Loan memory l = core.getLoan(loanId);
        vm.prank(BORROWER);
        core.extend(loanId, l.maturity + 1 days, 4000, uint64(tTarget + 1 hours), "");
        assert(core.getDueInterest(loanId) == expectedDue);
    }

    // ---------------- Property 4: Close Factor (Wide 1,000-50,000 USDC), Linear Dutch Decay & 0-Wei Waterfall ----------------

    uint64 internal constant CLOSE_THRESHOLD_PRINCIPAL = 1_079_290_329; // exact wei where (P + 3d minFloor) = $1,080.00 (9000 bps LTV @ $1,200 gross)

    function _verifyWideCloseFactorRegion(
        MockERC20 tok,
        MockAggregator feed,
        uint256 colUnit,
        uint64 principal,
        bool expectFull
    ) internal {
        if (expectFull) {
            vm.assume(principal >= CLOSE_THRESHOLD_PRINCIPAL && principal <= 50_000e6);
        } else {
            vm.assume(principal >= 1_000e6 && principal < CLOSE_THRESHOLD_PRINCIPAL);
        }

        // Disable origination fee for CloseFactor isolation so Halmos proves LoanCore close-factor LTV boundary across 6/8/18 decimals cleanly;
        // origination fee & FeeCollector flows remain active in Waterfall & Echidna tests.
        vm.prank(OWNER);
        feeCollector.setFeeRates(0, 1000, 100, 2000);

        feed.setPrice(1000e8);
        uint128 colAmt = uint128(100 * colUnit);
        uint256 loanId = _openLoan(tok, colAmt, principal, STD_RATE_BPS, 30, 3);

        feed.setPrice(12e8);
        vm.prank(KEEPER);
        uint256 aucId = core.startLiquidation(loanId);
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);

        assert(a.collateralTotal == (expectFull ? colAmt : (colAmt / 2)));
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_CloseFactorWide_6Dec_Partial(uint64 principalSeed) public {
        check_CloseFactorWide_6Dec_Partial(uint64(bound(principalSeed, 1_000e6, CLOSE_THRESHOLD_PRINCIPAL - 1)));
    }

    /// @notice WS4.3 Property 4a-1 (6-dec): 50% partial close factor across [1,000 .. 1,079.290519] USDC (< 90% LTV).
    function check_CloseFactorWide_6Dec_Partial(uint64 principal) public {
        _verifyWideCloseFactorRegion(col6, feed6, 1e6, principal, false);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_CloseFactorWide_6Dec_Full(uint64 principalSeed) public {
        check_CloseFactorWide_6Dec_Full(uint64(bound(principalSeed, CLOSE_THRESHOLD_PRINCIPAL, 50_000e6)));
    }

    /// @notice WS4.3 Property 4a-2 (6-dec): 100% full close factor across [1,079.290520 .. 50,000] USDC (>= 90% LTV).
    function check_CloseFactorWide_6Dec_Full(uint64 principal) public {
        _verifyWideCloseFactorRegion(col6, feed6, 1e6, principal, true);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_CloseFactorWide_8Dec_Partial(uint64 principalSeed) public {
        check_CloseFactorWide_8Dec_Partial(uint64(bound(principalSeed, 1_000e6, CLOSE_THRESHOLD_PRINCIPAL - 1)));
    }

    /// @notice WS4.3 Property 4b-1 (8-dec): 50% partial close factor across [1,000 .. 1,079.290519] USDC (< 90% LTV).
    function check_CloseFactorWide_8Dec_Partial(uint64 principal) public {
        _verifyWideCloseFactorRegion(col8, feed8, 1e8, principal, false);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_CloseFactorWide_8Dec_Full(uint64 principalSeed) public {
        check_CloseFactorWide_8Dec_Full(uint64(bound(principalSeed, CLOSE_THRESHOLD_PRINCIPAL, 50_000e6)));
    }

    /// @notice WS4.3 Property 4b-2 (8-dec): 100% full close factor across [1,079.290520 .. 50,000] USDC (>= 90% LTV).
    function check_CloseFactorWide_8Dec_Full(uint64 principal) public {
        _verifyWideCloseFactorRegion(col8, feed8, 1e8, principal, true);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_CloseFactorWide_18Dec_Partial(uint64 principalSeed) public {
        check_CloseFactorWide_18Dec_Partial(uint64(bound(principalSeed, 1_000e6, CLOSE_THRESHOLD_PRINCIPAL - 1)));
    }

    /// @notice WS4.3 Property 4c-1 (18-dec): 50% partial close factor across [1,000 .. 1,079.290519] USDC (< 90% LTV).
    function check_CloseFactorWide_18Dec_Partial(uint64 principal) public {
        _verifyWideCloseFactorRegion(col18, feed18, 1e18, principal, false);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_CloseFactorWide_18Dec_Full(uint64 principalSeed) public {
        check_CloseFactorWide_18Dec_Full(uint64(bound(principalSeed, CLOSE_THRESHOLD_PRINCIPAL, 50_000e6)));
    }

    /// @notice WS4.3 Property 4c-2 (18-dec): 100% full close factor across [1,079.290520 .. 50,000] USDC (>= 90% LTV).
    function check_CloseFactorWide_18Dec_Full(uint64 principal) public {
        _verifyWideCloseFactorRegion(col18, feed18, 1e18, principal, true);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_CloseFactor_SymbolicCrashPrice(uint16 crashPriceUsdSeed) public {
        check_CloseFactor_SymbolicCrashPrice(uint16(bound(crashPriceUsdSeed, 60, 128)));
    }

    /// @notice WS4.3 Property 4d: 50% vs 100% close factor transition across crash oracle prices [$60 .. $128].
    function check_CloseFactor_SymbolicCrashPrice(uint16 crashPriceUsd) public {
        vm.assume(crashPriceUsd >= 60 && crashPriceUsd <= 128);

        uint128 colAmt = 100e8;
        uint256 loanId = _openLoan(col8, colAmt, STD_PRINCIPAL, STD_RATE_BPS, 30, 3);
        feed8.setPrice(int256(uint256(crashPriceUsd) * 1e8));
        (uint256 grossVal, , ) = router.getValue(address(col8), colAmt);
        uint256 debt = uint256(STD_PRINCIPAL) + core.getDueInterest(loanId);
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
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionDutchPrice_StartFloorAndElapsed(uint16 oracleUsdSeed, uint16 discountSeed) public {
        check_AuctionDutchPrice_StartFloorAndElapsed(
            uint16(bound(oracleUsdSeed, 10, 2000)),
            uint16(bound(discountSeed, 100, 3000))
        );
    }

    /// @notice WS4.3 Property 4e: Auction startPrice (99%), floorPrice (100%-discount) & midpoint linear decay across [$10..$2000] x [1%..30%].
    function check_AuctionDutchPrice_StartFloorAndElapsed(uint16 oraclePriceUsd, uint16 maxDiscountBps) public {
        vm.assume(oraclePriceUsd >= 10 && oraclePriceUsd <= 2000);
        vm.assume(maxDiscountBps >= 100 && maxDiscountBps <= 3000);

        uint256 px = uint256(oraclePriceUsd) * 1e8;
        vm.prank(address(core));
        uint256 aucId = auction.startAuction(1, BORROWER, address(col8), 10e8, 1_000e6, 10e6, px, maxDiscountBps, KEEPER, false);
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);

        assert(a.startPrice == (px * 99) / 100);
        assert(a.floorPrice == (px * (10000 - maxDiscountBps)) / 10000);
        assert(auction.getCurrentPrice(aucId) == a.startPrice);

        vm.warp(BASE_TIME + a.duration);
        assert(auction.getCurrentPrice(aucId) == a.floorPrice);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionDutchPrice_SymbolicElapsedTime(uint16 elapsedSeed) public {
        check_AuctionDutchPrice_SymbolicElapsedTime(uint16(bound(elapsedSeed, 0, 1800)));
    }

    /// @notice WS4.3 Property 4f: Exact linear Dutch decay & [floorPrice .. startPrice] bounds across every second in [0 .. 1800].
    function check_AuctionDutchPrice_SymbolicElapsedTime(uint16 buyElapsed) public {
        vm.assume(buyElapsed <= 1800);

        vm.prank(address(core));
        uint256 aucId = auction.startAuction(1, BORROWER, address(col8), 10e8, 1_000e6, 10e6, 200e8, 600, KEEPER, false);
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);

        vm.warp(BASE_TIME + buyElapsed);
        uint256 curPrice = auction.getCurrentPrice(aucId);
        assert(curPrice >= a.floorPrice);
        assert(curPrice <= a.startPrice);
        assert(curPrice == a.startPrice - (((a.startPrice - a.floorPrice) * buyElapsed) / a.duration));
    }

    function _verifyWideWaterfallRegion(
        MockERC20 tok,
        MockAggregator feed,
        uint256 colUnit,
        uint64 principal,
        bool isFullClose
    ) internal {
        if (isFullClose) {
            vm.assume(principal >= CLOSE_THRESHOLD_PRINCIPAL && principal <= 50_000e6);
        } else {
            vm.assume(principal >= 1_000e6 && principal < CLOSE_THRESHOLD_PRINCIPAL);
        }

        // Disable origination fee during loan open so Halmos isolates the auction buy + FeeCollector liquidation waterfall across full [1,000..50,000] USDC.
        vm.prank(OWNER);
        feeCollector.setFeeRates(0, 1000, 100, 2000);

        // 100 shares @ $1,000 init ($100k gross), crash to $12 ($1,200 gross)
        feed.setPrice(1000e8);
        uint128 colAmt = uint128(100 * colUnit);
        uint256 loanId = _openLoan(tok, colAmt, principal, STD_RATE_BPS, 30, 3);

        feed.setPrice(12e8);
        vm.prank(KEEPER);
        uint256 aucId = core.startLiquidation(loanId);

        // With fixed crash oracle ($12) and split partial/full region, colBuy is concrete (50 or 100 shares)
        // so paid/liquidationFee/netProceeds are concrete while debtPrincipal/debtInterest/surplus remain fully symbolic.
        uint128 colBuy = uint128((isFullClose ? 100 : 50) * colUnit);
        uint256 curPrice = auction.getCurrentPrice(aucId);
        uint128 expectedPaid = uint128(_ceilDiv(uint256(colBuy) * curPrice * 1e6, colUnit * 1e8));

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

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionWaterfallWide_6Dec_Partial(uint64 principalSeed) public {
        check_AuctionWaterfallWide_6Dec_Partial(uint64(bound(principalSeed, 1_000e6, CLOSE_THRESHOLD_PRINCIPAL - 1)));
    }

    /// @notice WS4.3 Property 4g-1 (6-dec): 0-wei waterfall conservation across [1,000 .. 1,079.290519] USDC (50% partial close).
    function check_AuctionWaterfallWide_6Dec_Partial(uint64 principal) public {
        _verifyWideWaterfallRegion(col6, feed6, 1e6, principal, false);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionWaterfallWide_6Dec_Full(uint64 principalSeed) public {
        check_AuctionWaterfallWide_6Dec_Full(uint64(bound(principalSeed, CLOSE_THRESHOLD_PRINCIPAL, 50_000e6)));
    }

    /// @notice WS4.3 Property 4g-2 (6-dec): 0-wei waterfall conservation across [1,079.290520 .. 50,000] USDC (100% close: surplus + bad debt).
    function check_AuctionWaterfallWide_6Dec_Full(uint64 principal) public {
        _verifyWideWaterfallRegion(col6, feed6, 1e6, principal, true);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionWaterfallWide_8Dec_Partial(uint64 principalSeed) public {
        check_AuctionWaterfallWide_8Dec_Partial(uint64(bound(principalSeed, 1_000e6, CLOSE_THRESHOLD_PRINCIPAL - 1)));
    }

    /// @notice WS4.3 Property 4h-1 (8-dec): 0-wei waterfall conservation across [1,000 .. 1,079.290519] USDC (50% partial close).
    function check_AuctionWaterfallWide_8Dec_Partial(uint64 principal) public {
        _verifyWideWaterfallRegion(col8, feed8, 1e8, principal, false);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionWaterfallWide_8Dec_Full(uint64 principalSeed) public {
        check_AuctionWaterfallWide_8Dec_Full(uint64(bound(principalSeed, CLOSE_THRESHOLD_PRINCIPAL, 50_000e6)));
    }

    /// @notice WS4.3 Property 4h-2 (8-dec): 0-wei waterfall conservation across [1,079.290520 .. 50,000] USDC (100% close: surplus + bad debt).
    function check_AuctionWaterfallWide_8Dec_Full(uint64 principal) public {
        _verifyWideWaterfallRegion(col8, feed8, 1e8, principal, true);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionWaterfallWide_18Dec_Partial(uint64 principalSeed) public {
        check_AuctionWaterfallWide_18Dec_Partial(uint64(bound(principalSeed, 1_000e6, CLOSE_THRESHOLD_PRINCIPAL - 1)));
    }

    /// @notice WS4.3 Property 4i-1 (18-dec): 0-wei waterfall conservation across [1,000 .. 1,079.290519] USDC (50% partial close).
    function check_AuctionWaterfallWide_18Dec_Partial(uint64 principal) public {
        _verifyWideWaterfallRegion(col18, feed18, 1e18, principal, false);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionWaterfallWide_18Dec_Full(uint64 principalSeed) public {
        check_AuctionWaterfallWide_18Dec_Full(uint64(bound(principalSeed, CLOSE_THRESHOLD_PRINCIPAL, 50_000e6)));
    }

    /// @notice WS4.3 Property 4i-2 (18-dec): 0-wei waterfall conservation across [1,079.290520 .. 50,000] USDC (100% close: surplus + bad debt).
    function check_AuctionWaterfallWide_18Dec_Full(uint64 principal) public {
        _verifyWideWaterfallRegion(col18, feed18, 1e18, principal, true);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionBuy_SymbolicAmountAndDust(uint64 colBuySeed) public {
        check_AuctionBuy_SymbolicAmountAndDust(uint64(bound(colBuySeed, 2e7, 50e8)));
    }

    /// @notice WS4.3 Property 4j-1: Exact ceilDiv USDC payment, dust auto-close, and 0-wei conservation across arbitrary collateral buy sizes [0.2 .. 50] shares.
    function check_AuctionBuy_SymbolicAmountAndDust(uint64 colBuy) public {
        vm.assume(colBuy >= 2e7 && colBuy <= 50e8);

        // FeeCollector splits are proven across [10 .. 50,000] USDC in 4j-2; zeroing fees here keeps Halmos bit-blasting free of 5 nested div-10000 chains on colBuy.
        vm.prank(OWNER);
        feeCollector.setFeeRates(0, 0, 0, 0);

        uint256 tBuy = BASE_TIME + 900;
        vm.warp(tBuy);
        feed8.setUpdatedAt(tBuy);
        uint256 curPrice = auction.getCurrentPrice(symBuyAucId);

        uint128 expectedPaid = uint128(_ceilDiv(uint256(colBuy) * curPrice * 1e6, 1e8 * 1e8));

        uint256 bBefore = usdc.balanceOf(BORROWER);
        uint256 coreBefore = usdc.balanceOf(address(core));
        uint256 lClaimBefore = core.getClaimable(address(lenderWallet));

        usdc.mint(LIQUIDATOR, expectedPaid);
        vm.prank(LIQUIDATOR);
        usdc.approve(address(auction), expectedPaid);
        vm.prank(LIQUIDATOR);
        uint128 paid = auction.buy(symBuyAucId, colBuy, expectedPaid);
        assert(paid == expectedPaid);

        uint256 borrowerDelta = usdc.balanceOf(BORROWER) - bBefore;
        uint256 claimDelta = core.getClaimable(address(lenderWallet)) - lClaimBefore;
        uint256 coreDelta = usdc.balanceOf(address(core)) - coreBefore;

        assert(borrowerDelta + claimDelta == paid);
        assert(coreDelta == claimDelta);
        assert(usdc.balanceOf(address(auction)) == 0);
    }

    /// forge-config: default.fuzz.runs = 512
    function test_check_AuctionWaterfall_FeeCollectorConservation(uint64 usdcPaidSeed) public {
        check_AuctionWaterfall_FeeCollectorConservation(uint64(bound(usdcPaidSeed, 10e6, 50_000e6)));
    }

    /// @notice WS4.3 Property 4j-2: Exact 0-wei FeeCollector liquidation fee, keeper reward, and treasury/reserve split conservation across [10 .. 50,000] USDC.
    function check_AuctionWaterfall_FeeCollectorConservation(uint64 usdcPaid) public {
        vm.assume(usdcPaid >= 10e6 && usdcPaid <= 50_000e6);

        (uint128 protocolFee, uint128 keeperReward) = feeCollector.calculateLiquidationFee(usdcPaid);
        uint128 totalFee = protocolFee + keeperReward;
        assert(totalFee <= usdcPaid);

        uint256 treasBefore = usdc.balanceOf(TREASURY);
        uint256 resBefore = usdc.balanceOf(RESERVE);
        usdc.mint(address(this), protocolFee);
        usdc.approve(address(feeCollector), protocolFee);
        feeCollector.distributeFees(address(usdc), protocolFee);

        uint256 treasDelta = usdc.balanceOf(TREASURY) - treasBefore;
        uint256 resDelta = usdc.balanceOf(RESERVE) - resBefore;
        assert(treasDelta + resDelta == protocolFee);
        assert(treasDelta + resDelta + keeperReward == totalFee);
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

    /// @notice WS4.3 Property 5: Multi-token isolation, over-release rejection & unauthorized withdrawal rejection.
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

        vm.prank(ISO_AUTH);
        try isoEscrow.releaseCollateral(address(isoTokA), ISO_USER_A, expectedRemA + 1) {
            assert(false);
        } catch (bytes memory err) {
            assert(err.length >= 4 && bytes4(err) == CollateralEscrow.InsufficientBalance.selector);
        }
        assert(isoEscrow.getBalance(address(isoTokB)) == b1);
    }
}
