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
}
