// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {EligibilityGate} from "../src/EligibilityGate.sol";

contract PositionNFTTest is Test {
    PositionNFT public nft;
    EligibilityGate public gate;

    address public owner = address(0x1111);
    address public core = address(0x2222);
    address public lender1 = address(0x3333);
    address public lender2 = address(0x4444);

    function setUp() public {
        vm.startPrank(owner);
        gate = new EligibilityGate(owner, address(0), true); // permissionless for test
        nft = new PositionNFT(owner, address(gate));
        nft.setAuthorizedCore(core, true);
        vm.stopPrank();
    }

    function test_MintAndBurn() public {
        vm.prank(core);
        nft.mint(lender1, 101);

        assertEq(nft.ownerOf(101), lender1);
        assertEq(nft.balanceOf(lender1), 1);

        vm.prank(core);
        nft.burn(101);

        assertEq(nft.balanceOf(lender1), 0);
    }

    function test_AuctionTransferLock() public {
        vm.prank(core);
        nft.mint(lender1, 102);

        // Standard transfer works
        vm.prank(lender1);
        nft.transferFrom(lender1, lender2, 102);
        assertEq(nft.ownerOf(102), lender2);

        // Lock for auction
        vm.prank(core);
        nft.setAuctionLock(102, true);
        assertTrue(nft.isAuctionLocked(102));

        // Transfer during auction fails
        vm.prank(lender2);
        vm.expectRevert(PositionNFT.AuctionTransferLocked.selector);
        nft.transferFrom(lender2, lender1, 102);

        // Unlock auction
        vm.prank(core);
        nft.setAuctionLock(102, false);

        vm.prank(lender2);
        nft.transferFrom(lender2, lender1, 102);
        assertEq(nft.ownerOf(102), lender1);
    }

    function test_MetadataURI() public {
        vm.prank(core);
        nft.mint(lender1, 103);

        string memory uri = nft.tokenURI(103);
        assertTrue(bytes(uri).length > 0);
    }

    function test_TransferWithAttestation() public {
        uint256 kycPrivateKey = 0x8888;
        address kycSigner = vm.addr(kycPrivateKey);

        // Configure gate: permissioned mode with kycSigner
        vm.startPrank(owner);
        gate.setPermissionlessMode(false);
        gate.setAttestationSigner(kycSigner);
        vm.stopPrank();

        vm.prank(core);
        nft.mint(lender1, 104);

        address recipient = address(0x7777);
        // Direct transfer without attestation fails because recipient is not allowlisted
        vm.prank(lender1);
        vm.expectRevert(PositionNFT.IneligibleRecipient.selector);
        nft.transferFrom(lender1, recipient, 104);

        // Recipient obtains signed attestation
        uint256 expiry = block.timestamp + 1 days;
        bytes32 digest = gate.getAttestationDigest(recipient, 0, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(kycPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes memory context = abi.encode(expiry, sig);

        // Transfer with valid attestation succeeds!
        vm.prank(lender1);
        nft.transferWithAttestation(lender1, recipient, 104, context);
        assertEq(nft.ownerOf(104), recipient);

        // Another transfer to unauthorized recipient with expired attestation fails
        address recipient2 = address(0x6666);
        bytes32 digest2 = gate.getAttestationDigest(recipient2, 0, expiry);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(kycPrivateKey, digest2);
        bytes memory expiredContext = abi.encode(block.timestamp - 1, abi.encodePacked(r2, s2, v2));

        vm.prank(recipient);
        vm.expectRevert(PositionNFT.IneligibleRecipient.selector);
        nft.transferWithAttestation(recipient, recipient2, 104, expiredContext);
    }
}
