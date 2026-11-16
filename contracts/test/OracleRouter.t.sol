// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {IOracleRouter} from "../src/interfaces/IOracleRouter.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockSequencer} from "./mocks/MockSequencer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract OracleRouterTest is Test {
    OracleRouter public router;
    AssetRegistry public registry;
    MockAggregator public feed;
    MockSequencer public sequencer;
    MockERC20 public stockToken;

    address public owner = address(0x1111);
    address public guardian = address(0x2222);

    function setUp() public {
        vm.warp(1700000000 + 7200);
        AssetRegistry regImpl = new AssetRegistry();
        bytes memory regData = abi.encodeCall(AssetRegistry.initialize, (owner, guardian));
        registry = AssetRegistry(address(new ERC1967Proxy(address(regImpl), regData)));

        // Feed: 8 decimals, initial price $180.00 (18000000000)
        feed = new MockAggregator(8, 180e8);
        // Sequencer: UP (0)
        sequencer = new MockSequencer(0);

        stockToken = new MockERC20("NVIDIA Corp", "NVDAc", 6);

        OracleRouter routerImpl = new OracleRouter();
        bytes memory routerData = abi.encodeCall(
            OracleRouter.initialize,
            (owner, address(registry), address(sequencer))
        );
        router = OracleRouter(address(new ERC1967Proxy(address(routerImpl), routerData)));

        // Configure asset in registry
        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry.AssetConfig({
            feed: address(feed),
            feedDecimals: 8,
            tier: 0,
            maxInitLtvBps: 6000,
            marginCallLtvBps: 7000,
            liqLtvBps: 7800,
            badDebtLtvBps: 9000,
            maxDiscountBps: 600,
            closedMarketHaircutBps: 500, // 5% haircut when closed
            perLoanCap: 10_000e6,
            assetCap: 250_000e6,
            maxStaleOpenSecs: 3600,
            status: uint8(IAssetRegistry.AssetStatus.Active),
            restricted: false
        });

        vm.prank(owner);
        registry.setAssetConfig(address(stockToken), cfg);

        // Default: set manual market session to OPEN for unit testing
        vm.prank(owner);
        router.setMarketSession(true, true);
    }

    function test_ValidOpen_PriceAndValuation() public {
        // Warp block timestamp past sequencer grace period (1 hour)
        vm.warp(block.timestamp + 7200);
        feed.setUpdatedAt(block.timestamp);

        (uint256 price, uint8 decimals, IOracleRouter.OracleState state) = router.getPrice(address(stockToken));
        assertEq(price, 180e8);
        assertEq(decimals, 8);
        assertEq(uint8(state), uint8(IOracleRouter.OracleState.VALID_OPEN));

        // 10 shares of stock (10e6 raw units) at $180 = $1800 USDC (1800e6)
        (uint256 grossVal, uint256 effVal, IOracleRouter.OracleState valState) = router.getValue(
            address(stockToken),
            10e6
        );
        assertEq(grossVal, 1800e6);
        assertEq(effVal, 1800e6); // No haircut during market open
        assertEq(uint8(valState), uint8(IOracleRouter.OracleState.VALID_OPEN));
    }

    function test_ValidClosed_Haircut() public {
        vm.warp(block.timestamp + 7200);
        feed.setUpdatedAt(block.timestamp);

        // Switch to closed market
        vm.prank(owner);
        router.setMarketSession(false, true);

        (, , IOracleRouter.OracleState state) = router.getPrice(address(stockToken));
        assertEq(uint8(state), uint8(IOracleRouter.OracleState.VALID_CLOSED));

        // $1800 gross with 5% (500 bps) haircut = $1710 effective
        (uint256 grossVal, uint256 effVal, ) = router.getValue(address(stockToken), 10e6);
        assertEq(grossVal, 1800e6);
        assertEq(effVal, 1710e6);
    }

    function test_SequencerDown_ReturnsInvalid() public {
        vm.warp(block.timestamp + 7200);
        // Set sequencer to DOWN (1)
        sequencer.setStatus(1, block.timestamp);

        (, , IOracleRouter.OracleState state) = router.getPrice(address(stockToken));
        assertEq(uint8(state), uint8(IOracleRouter.OracleState.INVALID_SEQUENCER));
    }

    function test_SequencerGracePeriod_ReturnsInvalid() public {
        vm.warp(block.timestamp + 7200);
        // Sequencer came back UP 10 minutes ago (< 3600s grace period)
        sequencer.setStatus(0, block.timestamp - 600);

        (, , IOracleRouter.OracleState state) = router.getPrice(address(stockToken));
        assertEq(uint8(state), uint8(IOracleRouter.OracleState.INVALID_SEQUENCER));
    }

    function test_AssetFrozen_ReturnsCorporateAction() public {
        vm.warp(block.timestamp + 7200);
        vm.prank(guardian);
        registry.setAssetStatus(address(stockToken), IAssetRegistry.AssetStatus.Frozen);

        (, , IOracleRouter.OracleState state) = router.getPrice(address(stockToken));
        assertEq(uint8(state), uint8(IOracleRouter.OracleState.FROZEN_CORPORATE_ACTION));
    }

    function test_StaleFeed_DuringOpenHours() public {
        vm.warp(block.timestamp + 7200);
        // Heartbeat is 3600s; set updated 5000s ago
        feed.setUpdatedAt(block.timestamp - 5000);

        (, , IOracleRouter.OracleState state) = router.getPrice(address(stockToken));
        assertEq(uint8(state), uint8(IOracleRouter.OracleState.STALE_FEED));
    }

    function test_MarketHours_DST() public {
        // Disable manual market session override so real calendar and DST calculations run
        vm.prank(owner);
        router.setMarketSession(false, false);

        // 1. Summer EDT (July 15, 2024 - Monday): Market opens 13:30 UTC, closes 20:00 UTC
        // 2024-07-15 12:00:00 UTC = 1721044800 (Pre-market)
        vm.warp(1721044800);
        assertTrue(router.isUSDaylightSaving(block.timestamp));
        assertFalse(router.isMarketOpen());

        // 2024-07-15 14:00:00 UTC = 1721052000 (Open)
        vm.warp(1721052000);
        assertTrue(router.isMarketOpen());

        // 2024-07-15 20:30:00 UTC = 1721075400 (After-hours)
        vm.warp(1721075400);
        assertFalse(router.isMarketOpen());

        // 2. Winter EST (January 16, 2024 - Tuesday): Market opens 14:30 UTC, closes 21:00 UTC
        // 2024-01-16 13:45:00 UTC = 1705412700 (Pre-market in winter!)
        vm.warp(1705412700);
        assertFalse(router.isUSDaylightSaving(block.timestamp));
        assertFalse(router.isMarketOpen());

        // 2024-01-16 15:00:00 UTC = 1705417200 (Open in winter)
        vm.warp(1705417200);
        assertTrue(router.isMarketOpen());

        // 2024-01-16 20:30:00 UTC = 1705437000 (Still open in winter until 21:00 UTC)
        vm.warp(1705437000);
        assertTrue(router.isMarketOpen());

        // 2024-01-16 21:30:00 UTC = 1705440600 (Closed in winter after 21:00 UTC)
        vm.warp(1705440600);
        assertFalse(router.isMarketOpen());
    }

    function test_MarketHours_HolidaysAndHalfDays() public {
        vm.prank(owner);
        router.setMarketSession(false, false);

        // July 15, 2024 14:00:00 UTC (normally open)
        uint256 testTime = 1721052000;
        vm.warp(testTime);
        assertTrue(router.isMarketOpen());

        // Admin declares holiday for this epoch day
        uint256 epochDay = testTime / 86400;
        vm.prank(owner);
        router.setHoliday(epochDay, true);
        assertFalse(router.isMarketOpen());

        // Clear holiday
        vm.prank(owner);
        router.setHoliday(epochDay, false);
        assertTrue(router.isMarketOpen());

        // Set half day: closes 3h early at 17:00 UTC (61200s) instead of 20:00 UTC (72000s)
        vm.prank(owner);
        router.setHalfDay(epochDay, true);

        // At 14:00 UTC (50400s), still open
        vm.warp(1721052000);
        assertTrue(router.isMarketOpen());

        // At 17:30 UTC (63000s), closed early!
        vm.warp(testTime + 12600);
        assertFalse(router.isMarketOpen());
    }

    function test_MultiplierChange_AutoFreezesAsset() public {
        vm.warp(block.timestamp + 7200);
        feed.setUpdatedAt(block.timestamp);

        // Real on-chain B20 token (NVDAc = 1.000537939576369481e18) does NOT freeze at launch!
        stockToken.setUiMultiplier(1000537939576369481);
        // Baseline synced at listing
        router.syncMultiplier(address(stockToken));

        (uint256 pNvidia, , IOracleRouter.OracleState stateNvidia) = router.getPrice(address(stockToken));
        assertEq(uint8(stateNvidia), uint8(IOracleRouter.OracleState.VALID_OPEN));
        assertEq(pNvidia, 180e8); // Not double-multiplied!

        // Normal dividend drift (+15 bps) does NOT freeze
        stockToken.setUiMultiplier(1002000000000000000);
        (, , IOracleRouter.OracleState stateDiv) = router.getPrice(address(stockToken));
        assertEq(uint8(stateDiv), uint8(IOracleRouter.OracleState.VALID_OPEN));

        // Token splits 2-for-1 -> new multiplier 2e18 (> 5% jump) without governance sync
        stockToken.setUiMultiplier(2e18);

        // OracleRouter detects split mismatch and automatically freezes!
        (, , IOracleRouter.OracleState frozenState) = router.getPrice(address(stockToken));
        assertEq(uint8(frozenState), uint8(IOracleRouter.OracleState.FROZEN_CORPORATE_ACTION));

        // When governance reviews and syncs the new multiplier, it unfreezes without inflating price
        vm.prank(owner);
        router.syncMultiplier(address(stockToken));
        (uint256 unfreezeP, , IOracleRouter.OracleState recoveredState) = router.getPrice(address(stockToken));
        assertEq(uint8(recoveredState), uint8(IOracleRouter.OracleState.VALID_OPEN));
        // Chainlink feed prices the token directly, no double-counting
        assertEq(unfreezeP, 180e8);
    }

    function test_StaleFeed_DuringClosedHours() public {
        vm.warp(1700000000 + 7200);

        // Market is closed
        vm.prank(owner);
        router.setMarketSession(false, true);

        // Feed updated 42 hours ago (typical Sunday on NVDA feed <= 100h / 360000s) -> VALID_CLOSED
        feed.setUpdatedAt(block.timestamp - (42 * 3600));
        (, , IOracleRouter.OracleState state1) = router.getPrice(address(stockToken));
        assertEq(uint8(state1), uint8(IOracleRouter.OracleState.VALID_CLOSED));

        // Feed updated 65 hours ago (Monday pre-market <= 100h) -> VALID_CLOSED
        feed.setUpdatedAt(block.timestamp - (65 * 3600));
        (, , IOracleRouter.OracleState state2) = router.getPrice(address(stockToken));
        assertEq(uint8(state2), uint8(IOracleRouter.OracleState.VALID_CLOSED));

        // Feed updated 101 hours ago (> 100h maxStaleClosedSecs) -> STALE_FEED
        feed.setUpdatedAt(block.timestamp - (101 * 3600));
        (, , IOracleRouter.OracleState state3) = router.getPrice(address(stockToken));
        assertEq(uint8(state3), uint8(IOracleRouter.OracleState.STALE_FEED));
    }

    function test_PMc_LikeMultiplier_NotFrozenAtLaunch() public {
        feed.setUpdatedAt(block.timestamp);
        // PMc real multiplier ~ 1.5588e18
        stockToken.setUiMultiplier(1558800000000000000);

        // Baseline synced at listing / deploy
        router.syncMultiplier(address(stockToken));

        (uint256 p, , IOracleRouter.OracleState state) = router.getPrice(address(stockToken));
        assertEq(uint8(state), uint8(IOracleRouter.OracleState.VALID_OPEN));
        assertEq(p, 180e8);
    }

    function test_SplitBeforeFirstSync_Freezes() public {
        feed.setUpdatedAt(block.timestamp);
        // Token has split to 10e18 before ever being synced (recMult == 0)
        stockToken.setUiMultiplier(10e18);

        // Unsynced token freezes upon split
        (, , IOracleRouter.OracleState state) = router.getPrice(address(stockToken));
        assertEq(uint8(state), uint8(IOracleRouter.OracleState.FROZEN_CORPORATE_ACTION));
    }

    function test_DividendDrift_RepeatedRatchet_NotFrozen() public {
        feed.setUpdatedAt(block.timestamp);
        uint256 mult = 1e18;
        stockToken.setUiMultiplier(mult);

        // Sync initial baseline
        router.syncMultiplier(address(stockToken));

        // +4% repeated 5 times with syncMultiplier ratcheting baseline
        for (uint256 i = 0; i < 5; i++) {
            mult = (mult * 104) / 100;
            stockToken.setUiMultiplier(mult);

            // Permissionless caller ratchets baseline since diff is 4% (< 5%)
            address keeper = address(0x9999);
            vm.prank(keeper);
            router.syncMultiplier(address(stockToken));

            (, , IOracleRouter.OracleState state) = router.getPrice(address(stockToken));
            assertEq(uint8(state), uint8(IOracleRouter.OracleState.VALID_OPEN));
        }
    }

    function test_TenToOneSplit_Freezes_ThenSynced() public {
        feed.setUpdatedAt(block.timestamp);
        uint256 baseMult = 1e18;
        stockToken.setUiMultiplier(baseMult);
        router.syncMultiplier(address(stockToken));

        // 10:1 split occurs! Multiplier becomes 10e18 (1000% jump)
        stockToken.setUiMultiplier(10e18);

        // OracleRouter auto-freezes!
        (, , IOracleRouter.OracleState frozenState) = router.getPrice(address(stockToken));
        assertEq(uint8(frozenState), uint8(IOracleRouter.OracleState.FROZEN_CORPORATE_ACTION));

        // Permissionless caller cannot unfreeze a corporate action split
        address keeper = address(0x9999);
        vm.prank(keeper);
        vm.expectRevert(OracleRouter.CorporateActionSplitPending.selector);
        router.syncMultiplier(address(stockToken));

        // Governance / owner reviews corporate action and syncs multiplier
        vm.prank(owner);
        router.syncMultiplier(address(stockToken));

        // Asset is unfrozen and operational
        (, , IOracleRouter.OracleState unfreezeState) = router.getPrice(address(stockToken));
        assertEq(uint8(unfreezeState), uint8(IOracleRouter.OracleState.VALID_OPEN));
    }

    function test_Holidays_2027_2028_LoadedByDefault() public view {
        // 2027 New Year's Day (day 20819)
        assertTrue(router.isHoliday(20819));
        // 2027 Thanksgiving (day 21147)
        assertTrue(router.isHoliday(21147));
        // 2027 Black Friday half-day (day 21148)
        assertTrue(router.isHalfDay(21148));

        // 2028 MLK Day (day 21200)
        assertTrue(router.isHoliday(21200));
        // 2028 Christmas (day 21543)
        assertTrue(router.isHoliday(21543));
        // 2028 July 3 half-day (day 21368)
        assertTrue(router.isHalfDay(21368));
    }

    function test_Holidays_2029_2030_LoadedByDefault() public view {
        // 2029 New Year's Day (day 21550)
        assertTrue(router.isHoliday(21550));
        // 2029 Thanksgiving (day 21875)
        assertTrue(router.isHoliday(21875));
        // 2029 Black Friday half-day (day 21876)
        assertTrue(router.isHalfDay(21876));

        // 2030 Juneteenth (day 22084)
        assertTrue(router.isHoliday(22084));
        // 2030 Christmas (day 22273)
        assertTrue(router.isHoliday(22273));
        // 2030 Christmas Eve half-day (day 22272)
        assertTrue(router.isHalfDay(22272));
    }

    function test_Thanksgiving_IsLoadedByDefault() public {
        // Disable manual session override
        vm.prank(owner);
        router.setMarketSession(false, false);

        // Thanksgiving 2024: Nov 28, 2024 15:00:00 UTC (normally trading hours on Thursday)
        uint256 thanksgiving2024 = 1732806000;
        vm.warp(thanksgiving2024);

        // Verified preloaded holiday: market is CLOSED!
        uint256 epochDay = thanksgiving2024 / 86400;
        assertTrue(router.isHoliday(epochDay));
        assertFalse(router.isMarketOpen());
    }
}
