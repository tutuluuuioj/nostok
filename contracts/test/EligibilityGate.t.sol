// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EligibilityGate} from "../src/EligibilityGate.sol";

contract EligibilityGateTest is Test {
    EligibilityGate public gate;

    address public owner = address(0x1111);
    uint256 public kycSignerPrivateKey = 0x9999;
    address public kycSigner;

    address public operator = address(0x2222);
    address public user1 = address(0x3333);
    address public user2 = address(0x4444);
    address public user3 = address(0x5555);

    function setUp() public {
        kycSigner = vm.addr(kycSignerPrivateKey);
        vm.prank(owner);
        gate = new EligibilityGate(owner, kycSigner, false);
    }

    function test_Operator_BatchAllowlist() public {
        // Owner designates operator
        vm.prank(owner);
        gate.setOperator(operator, true);
        assertTrue(gate.isOperator(operator));

        // Unauthorized user cannot add allowlist
        address attacker = address(0x6666);
        vm.prank(attacker);
        vm.expectRevert(EligibilityGate.Unauthorized.selector);
        gate.setAllowlist(user1, true);

        // Operator adds batch of users instantly without 48h timelock
        address[] memory users = new address[](3);
        users[0] = user1;
        users[1] = user2;
        users[2] = user3;

        vm.prank(operator);
        gate.setAllowlistBatch(users, true);

        assertTrue(gate.isEligible(user1, ""));
        assertTrue(gate.isEligible(user2, ""));
        assertTrue(gate.isEligible(user3, ""));
    }

    function test_SignedAttestation_InstantEligibility() public {
        // User is not on allowlist
        assertFalse(gate.isEligible(user1, ""));

        // KYC provider issues offchain signed non-US attestation
        bytes32 messageHash = keccak256(
            abi.encodePacked("NOSTOK_ELIGIBLE_NON_US:", block.chainid, user1)
        );
        bytes32 ethHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(kycSignerPrivateKey, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);

        // User is immediately eligible via attestation without any onchain transactions!
        assertTrue(gate.isEligible(user1, sig));
    }
}
