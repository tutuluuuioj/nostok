// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract FeeCollectorTest is Test {
    FeeCollector public collector;
    MockERC20 public usdc;

    address public owner = address(0x1111);
    address public treasury = address(0x2222);
    address public reserve = address(0x3333);

    function setUp() public {
        FeeCollector impl = new FeeCollector();
        bytes memory data = abi.encodeCall(FeeCollector.initialize, (owner, treasury, reserve));
        collector = FeeCollector(address(new ERC1967Proxy(address(impl), data)));

        usdc = new MockERC20("USD Coin", "USDC", 6);
    }

    function test_DefaultFeeCalculations() public view {
        // Origination fee: 0.10% (10 bps) of $10,000 (10,000e6) = $10.00 (10e6)
        uint128 origFee = collector.calculateOriginationFee(10_000e6);
        assertEq(origFee, 10e6);

        // Interest cut: 10% (1000 bps) of $100 (100e6) = $10.00 (10e6)
        uint128 cut = collector.calculateInterestCut(100e6);
        assertEq(cut, 10e6);

        // Liquidation fee: 1.00% (100 bps) of $5,000 (5000e6) = $50.00 (50e6)
        // Keeper gets 30% ($15.00), protocol gets 70% ($35.00)
        (uint128 protoFee, uint128 keeperReward) = collector.calculateLiquidationFee(5000e6);
        assertEq(protoFee + keeperReward, 50e6);
        assertEq(keeperReward, 15e6);
        assertEq(protoFee, 35e6);
    }

    function test_HardCapsEnforced() public {
        // Max origination is 100 bps (1.0%)
        vm.prank(owner);
        vm.expectRevert(FeeCollector.FeeCapExceeded.selector);
        collector.setFeeRates(101, 1000, 100, 2000);

        // Max interest cut is 2000 bps (20%)
        vm.prank(owner);
        vm.expectRevert(FeeCollector.FeeCapExceeded.selector);
        collector.setFeeRates(10, 2001, 100, 2000);

        // Max liquidation is 300 bps (3%)
        vm.prank(owner);
        vm.expectRevert(FeeCollector.FeeCapExceeded.selector);
        collector.setFeeRates(10, 1000, 301, 2000);
    }

    function test_FeeDistribution() public {
        usdc.mint(address(this), 100e6);
        usdc.approve(address(collector), 100e6);

        // 20% to safety reserve ($20), 80% to treasury ($80)
        collector.distributeFees(address(usdc), 100e6);

        assertEq(usdc.balanceOf(reserve), 20e6);
        assertEq(usdc.balanceOf(treasury), 80e6);
    }
}
