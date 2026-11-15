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
}
