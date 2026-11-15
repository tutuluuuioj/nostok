// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CollateralEscrow} from "../src/CollateralEscrow.sol";
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
}
