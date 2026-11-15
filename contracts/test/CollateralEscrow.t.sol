// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CollateralEscrow} from "../src/CollateralEscrow.sol";
import {NostokTimelock} from "../src/NostokTimelock.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract CollateralEscrowTest is Test {
    CollateralEscrow public escrow;
    MockERC20 public token;

    address public owner = address(0x1111);
    address public core = address(0x2222);
    address public user = address(0x3333);

    function setUp() public {
        vm.prank(owner);
        escrow = new CollateralEscrow(owner);

        token = new MockERC20("NVIDIA Tokenized", "NVDAc", 6);

        vm.prank(owner);
        escrow.setAuthorizedCore(core, true);
    }

    function test_Authorization() public {
        assertTrue(escrow.isAuthorizedCore(core));
        assertFalse(escrow.isAuthorizedCore(user));

        vm.prank(owner);
        escrow.setAuthorizedCore(core, false);
        assertFalse(escrow.isAuthorizedCore(core));
    }

    function test_DepositCollateral_Success() public {
        token.mint(user, 1000e6);

        vm.prank(user);
        token.approve(address(escrow), 500e6);

        vm.prank(core);
        escrow.depositCollateral(address(token), user, 500e6);

        assertEq(escrow.getBalance(address(token)), 500e6);
        assertEq(token.balanceOf(address(escrow)), 500e6);
        assertEq(token.balanceOf(user), 500e6);
    }

    function test_DepositCollateral_Unauthorized() public {
        vm.expectRevert(CollateralEscrow.UnauthorizedCaller.selector);
        escrow.depositCollateral(address(token), user, 100e6);
    }

    function test_ReleaseCollateral_Success() public {
        token.mint(address(escrow), 500e6);
        // Simulate tracked balance
        token.mint(user, 500e6);
        vm.prank(user);
        token.approve(address(escrow), 500e6);
        vm.prank(core);
        escrow.depositCollateral(address(token), user, 500e6);

        vm.prank(core);
        escrow.releaseCollateral(address(token), user, 200e6);

        assertEq(escrow.getBalance(address(token)), 300e6);
        assertEq(token.balanceOf(user), 200e6);
    }

    function test_ReleaseCollateral_InsufficientBalance() public {
        vm.prank(core);
        vm.expectRevert(CollateralEscrow.InsufficientBalance.selector);
        escrow.releaseCollateral(address(token), user, 100e6);
    }

    function test_TimelockGovernsEscrowAuthorization() public {
        address multisig = address(0x5555);
        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = multisig;

        NostokTimelock timelock = new NostokTimelock(proposers, executors, multisig);

        // Transfer escrow ownership to Timelock
        vm.prank(owner);
        escrow.transferOwnership(address(timelock));

        address newCore = address(0x8888);

        // 1. Direct call to setAuthorizedCore reverts (owner is now timelock)
        vm.prank(owner);
        vm.expectRevert();
        escrow.setAuthorizedCore(newCore, true);

        // 2. Schedule operation via Timelock
        bytes memory callData = abi.encodeCall(escrow.setAuthorizedCore, (newCore, true));
        bytes32 salt = bytes32(uint256(1));

        vm.prank(multisig);
        timelock.schedule(address(escrow), 0, callData, bytes32(0), salt, 48 hours);

        // 3. Executing before 48 hours reverts
        vm.prank(multisig);
        vm.expectRevert();
        timelock.execute(address(escrow), 0, callData, bytes32(0), salt);

        // 4. Warp 48 hours
        vm.warp(block.timestamp + 48 hours);

        // 5. Executing after 48 hours succeeds
        vm.prank(multisig);
        timelock.execute(address(escrow), 0, callData, bytes32(0), salt);

        // New core is now authorized!
        assertTrue(escrow.isAuthorizedCore(newCore));
    }
}
