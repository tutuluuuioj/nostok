// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EligibilityGate} from "../src/EligibilityGate.sol";
import {MockSmartWallet} from "./mocks/MockSmartWallet.sol";

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
        vm.warp(1700000000);
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

        // KYC provider issues offchain signed non-US attestation bound to chainId, gate, user, nonce, expiry
        uint256 expiry = block.timestamp + 1 days;
        bytes32 digest = gate.getAttestationDigest(user1, 0, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(kycSignerPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes memory context = abi.encode(expiry, sig);

        // User is immediately eligible via attestation without any onchain transactions!
        assertTrue(gate.isEligible(user1, context));

        // 1. User revocation rejects even with valid signature
        vm.prank(owner);
        gate.revokeUser(user1, true);
        assertFalse(gate.isEligible(user1, context));

        // Unrevoke restores eligibility
        vm.prank(owner);
        gate.revokeUser(user1, false);
        assertTrue(gate.isEligible(user1, context));

        // 2. User nonce bump invalidates old attestation
        vm.prank(user1);
        gate.bumpMyNonce();
        assertFalse(gate.isEligible(user1, context));

        // New attestation with bumped nonce succeeds
        bytes32 newDigest = gate.getAttestationDigest(user1, 1, expiry);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(kycSignerPrivateKey, newDigest);
        bytes memory newContext = abi.encode(expiry, abi.encodePacked(r2, s2, v2));
        assertTrue(gate.isEligible(user1, newContext));

        // 3. Expired attestation fails
        vm.warp(expiry + 1);
        assertFalse(gate.isEligible(user1, newContext));
    }

    function test_MalformedContext_ReturnsFalse() public view {
        // Short malformed context (< 96 bytes)
        assertFalse(gate.isEligible(user1, hex"deadbeef"));
        // Random 96-byte non-ABI payload
        bytes memory garbage = new bytes(96);
        for (uint256 i = 0; i < 96; i++) {
            garbage[i] = bytes1(uint8(i + 1));
        }
        // Must return false without reverting
        assertFalse(gate.isEligible(user1, garbage));
    }

    function test_Legacy65Byte_Rejected() public view {
        bytes memory raw65 = new bytes(65);
        assertFalse(gate.isEligible(user1, raw65));
    }

    function test_ERC1271_SmartWalletAttestationSigner() public {
        // Deploy smart contract wallet that implements ERC-1271
        uint256 walletSignerPk = 0x8888;
        address walletSigner = vm.addr(walletSignerPk);
        MockSmartWallet smartSigner = new MockSmartWallet(walletSigner);

        // Set EligibilityGate's attestationSigner to the smart wallet contract
        vm.prank(owner);
        gate.setAttestationSigner(address(smartSigner));
        assertEq(gate.attestationSigner(), address(smartSigner));

        // Generate attestation signed by the key behind the smart contract wallet
        uint256 expiry = block.timestamp + 1 days;
        bytes32 digest = gate.getAttestationDigest(user1, 0, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletSignerPk, digest);
        bytes memory context = abi.encode(expiry, abi.encodePacked(r, s, v));

        // EligibilityGate checks ERC-1271 on the contract wallet and approves eligibility
        assertTrue(gate.isEligible(user1, context));
    }
}
