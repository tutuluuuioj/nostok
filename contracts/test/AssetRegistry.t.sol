// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {MockSequencer} from "./mocks/MockSequencer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract AssetRegistryTest is Test {
    AssetRegistry public registry;

    address public owner = address(0x1111);
    address public guardian = address(0x2222);
    address public feed = address(0x3333);
    address public token = address(0x4444);

    function setUp() public {
        AssetRegistry impl = new AssetRegistry();
        bytes memory data = abi.encodeCall(AssetRegistry.initialize, (owner, guardian));
        registry = AssetRegistry(address(new ERC1967Proxy(address(impl), data)));
    }

    function test_SetAssetConfig_Success() public {
        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry.AssetConfig({
            feed: feed,
            feedDecimals: 8,
            tier: uint8(IAssetRegistry.AssetTier.TierA),
            maxInitLtvBps: 6000,
            marginCallLtvBps: 7000,
            liqLtvBps: 7800,
            badDebtLtvBps: 9000,
            maxDiscountBps: 600,
            closedMarketHaircutBps: 500,
            perLoanCap: 10_000e6,
            assetCap: 250_000e6,
            maxStaleOpenSecs: 86400,
            status: uint8(IAssetRegistry.AssetStatus.Active),
            restricted: false
        });

        vm.prank(owner);
        registry.setAssetConfig(token, cfg);

        assertTrue(registry.isAssetSupported(token));
        assertEq(uint8(registry.getAssetStatus(token)), uint8(IAssetRegistry.AssetStatus.Active));
    }

    function test_InvalidLtvHierarchy_Reverts() public {
        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry.AssetConfig({
            feed: feed,
            feedDecimals: 8,
            tier: 0,
            maxInitLtvBps: 8000, // Invalid: maxInit > marginCall
            marginCallLtvBps: 7000,
            liqLtvBps: 7800,
            badDebtLtvBps: 9000,
            maxDiscountBps: 600,
            closedMarketHaircutBps: 500,
            perLoanCap: 10_000e6,
            assetCap: 250_000e6,
            maxStaleOpenSecs: 86400,
            status: uint8(IAssetRegistry.AssetStatus.Active),
            restricted: false
        });

        vm.prank(owner);
        vm.expectRevert(AssetRegistry.InvalidLtvParameters.selector);
        registry.setAssetConfig(token, cfg);
    }

    function test_GuardianTighteningPermissions() public {
        test_SetAssetConfig_Success();

        // Guardian can tighten to ReduceOnly
        vm.prank(guardian);
        registry.setAssetStatus(token, IAssetRegistry.AssetStatus.ReduceOnly);
        assertEq(uint8(registry.getAssetStatus(token)), uint8(IAssetRegistry.AssetStatus.ReduceOnly));

        // Guardian can tighten to Frozen
        vm.prank(guardian);
        registry.setAssetStatus(token, IAssetRegistry.AssetStatus.Frozen);
        assertEq(uint8(registry.getAssetStatus(token)), uint8(IAssetRegistry.AssetStatus.Frozen));

        // Guardian CANNOT loosen back to Active
        vm.prank(guardian);
        vm.expectRevert(AssetRegistry.GuardianCanOnlyTighten.selector);
        registry.setAssetStatus(token, IAssetRegistry.AssetStatus.Active);

        // Owner CAN loosen back to Active
        vm.prank(owner);
        registry.setAssetStatus(token, IAssetRegistry.AssetStatus.Active);
        assertEq(uint8(registry.getAssetStatus(token)), uint8(IAssetRegistry.AssetStatus.Active));
    }

    function test_InvalidDiscountParameters_Reverts() public {
        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry.AssetConfig({
            feed: feed,
            feedDecimals: 8,
            tier: 0,
            maxInitLtvBps: 6000,
            marginCallLtvBps: 7000,
            liqLtvBps: 7800,
            badDebtLtvBps: 9000,
            maxDiscountBps: 99, // Below 100 bps bricks auction floor calculation!
            closedMarketHaircutBps: 500,
            perLoanCap: 10_000e6,
            assetCap: 250_000e6,
            maxStaleOpenSecs: 86400,
            status: uint8(IAssetRegistry.AssetStatus.Active),
            restricted: false
        });

        // Reverts when < 100 bps
        vm.prank(owner);
        vm.expectRevert(AssetRegistry.InvalidDiscountParameters.selector);
        registry.setAssetConfig(token, cfg);

        // Reverts when > 3000 bps (30%)
        cfg.maxDiscountBps = 3500;
        vm.prank(owner);
        vm.expectRevert(AssetRegistry.InvalidDiscountParameters.selector);
        registry.setAssetConfig(token, cfg);
    }

    function test_RegistryToRouterSync_SetOracleRouterThenSetAssetConfig() public {
        MockSequencer sequencer = new MockSequencer(0);
        OracleRouter routerImpl = new OracleRouter();
        bytes memory routerData = abi.encodeCall(
            OracleRouter.initialize,
            (owner, address(registry), address(sequencer))
        );
        OracleRouter router = OracleRouter(address(new ERC1967Proxy(address(routerImpl), routerData)));

        // 1. Wire setOracleRouter on AssetRegistry
        vm.prank(owner);
        registry.setOracleRouter(address(router));
        assertEq(registry.oracleRouter(), address(router));

        // 2. Deploy B20 token with non-zero multiplier (e.g. NVDAc = 1.0005e18)
        MockERC20 b20 = new MockERC20("NVIDIA Corp", "NVDAc", 6);
        b20.setUiMultiplier(1000537939576369481);

        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry.AssetConfig({
            feed: feed,
            feedDecimals: 8,
            tier: uint8(IAssetRegistry.AssetTier.TierA),
            maxInitLtvBps: 6000,
            marginCallLtvBps: 7000,
            liqLtvBps: 7800,
            badDebtLtvBps: 9000,
            maxDiscountBps: 600,
            closedMarketHaircutBps: 500,
            perLoanCap: 10_000e6,
            assetCap: 250_000e6,
            maxStaleOpenSecs: 3600,
            status: uint8(IAssetRegistry.AssetStatus.Active),
            restricted: false
        });

        // 3. setAssetConfig automatically syncs the multiplier to OracleRouter
        vm.prank(owner);
        registry.setAssetConfig(address(b20), cfg);

        assertEq(router.recordedMultiplier(address(b20)), 1000537939576369481);

        // 4. Pending split does NOT revert setAssetConfig
        b20.setUiMultiplier(2e18); // 100% split jump
        vm.prank(owner);
        registry.setAssetConfig(address(b20), cfg); // Must succeed without reverting!
    }
}
