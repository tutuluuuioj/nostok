// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OrderSettlement} from "../src/OrderSettlement.sol";
import {LoanCore} from "../src/LoanCore.sol";
import {CollateralEscrow} from "../src/CollateralEscrow.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {EligibilityGate} from "../src/EligibilityGate.sol";
import {LiquidationAuction} from "../src/LiquidationAuction.sol";
import {IOrderSettlement} from "../src/interfaces/IOrderSettlement.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockSequencer} from "./mocks/MockSequencer.sol";

contract OrderSettlementTest is Test {
    OrderSettlement public settlement;
    LoanCore public core;
    CollateralEscrow public escrow;
    PositionNFT public nft;
    AssetRegistry public registry;
    OracleRouter public router;
    FeeCollector public feeCollector;
    LiquidationAuction public auction;
    EligibilityGate public gate;

    MockERC20 public usdc;
    MockERC20 public stockToken;
    MockAggregator public feed;
    MockSequencer public sequencer;

    address public owner = address(0x1111);
    address public guardian = address(0x2222);
    address public treasury = address(0x3333);
    address public reserve = address(0x4444);

    uint256 public borrowerPrivateKey = 0xA11CE;
    address public borrower;

    uint256 public lenderPrivateKey = 0xB0B;
    address public lender;

    function setUp() public {
        borrower = vm.addr(borrowerPrivateKey);
        lender = vm.addr(lenderPrivateKey);

        vm.warp(1700000000);

        vm.startPrank(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        stockToken = new MockERC20("NVIDIA Corp", "NVDAc", 6);

        feed = new MockAggregator(8, 200e8); // $200.00
        sequencer = new MockSequencer(0); // UP

        gate = new EligibilityGate(owner, address(0), true);
        escrow = new CollateralEscrow(owner);
        nft = new PositionNFT(owner, address(gate));

        AssetRegistry regImpl = new AssetRegistry();
        bytes memory regData = abi.encodeCall(AssetRegistry.initialize, (owner, guardian));
        registry = AssetRegistry(address(new ERC1967Proxy(address(regImpl), regData)));

        OracleRouter routerImpl = new OracleRouter();
        bytes memory routerData = abi.encodeCall(
            OracleRouter.initialize,
            (owner, address(registry), address(sequencer))
        );
        router = OracleRouter(address(new ERC1967Proxy(address(routerImpl), routerData)));
        router.setMarketSession(true, true);

        FeeCollector feeImpl = new FeeCollector();
        bytes memory feeData = abi.encodeCall(FeeCollector.initialize, (owner, treasury, reserve));
        feeCollector = FeeCollector(address(new ERC1967Proxy(address(feeImpl), feeData)));

        LoanCore coreImpl = new LoanCore();
        core = LoanCore(address(new ERC1967Proxy(address(coreImpl), "")));

        LiquidationAuction auctionImpl = new LiquidationAuction();
        auction = LiquidationAuction(address(new ERC1967Proxy(address(auctionImpl), "")));

        core.initialize(
            owner,
            guardian,
            address(escrow),
            address(nft),
            address(registry),
            address(router),
            address(feeCollector),
            address(auction),
            address(usdc)
        );

        OrderSettlement settlementImpl = new OrderSettlement();
        bytes memory settData = abi.encodeCall(
            OrderSettlement.initialize,
            (owner, address(core), address(gate))
        );
        settlement = OrderSettlement(address(new ERC1967Proxy(address(settlementImpl), settData)));

        core.setOrderSettlement(address(settlement));

        auction.initialize(
            owner,
            address(escrow),
            address(core),
            address(feeCollector),
            address(usdc)
        );

        escrow.setAuthorizedCore(address(core), true);
        escrow.setAuthorizedCore(address(auction), true);
        nft.setAuthorizedCore(address(core), true);

        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry.AssetConfig({
            feed: address(feed),
            feedDecimals: 8,
            tier: 0,
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
        registry.setAssetConfig(address(stockToken), cfg);
        vm.stopPrank();

        stockToken.mint(borrower, 100e6);
        usdc.mint(lender, 50_000e6);

        vm.prank(borrower);
        stockToken.approve(address(escrow), type(uint256).max);

        vm.prank(lender);
        usdc.approve(address(core), type(uint256).max);
    }

    function test_FillBorrowOrder_EIP712() public {
        IOrderSettlement.BorrowOrder memory order = IOrderSettlement.BorrowOrder({
            borrower: borrower,
            collateralToken: address(stockToken),
            collateralAmount: 50e6, // 50 NVDAc ($10,000)
            minUsdc: 5000e6, // $5,000 USDC (50% LTV)
            maxRateBps: 800, // 8.00% APR
            termDays: 30,
            maxLtvBps: 6000,
            minFill: 500e6,
            expiry: uint64(block.timestamp + 7 days),
            nonce: 0,
            yieldMode: 0,
            allowInKindSettlement: false
        });

        bytes32 digest = settlement.hashBorrowOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Lender fills the order
        vm.prank(lender);
        uint256 loanId = settlement.fillBorrowOrder(order, sig, 5000e6);

        assertEq(loanId, 1);
        assertEq(nft.ownerOf(loanId), lender);
        assertEq(escrow.getBalance(address(stockToken)), 50e6);
    }

    function test_PartialFillBorrowOrder() public {
        IOrderSettlement.BorrowOrder memory order = IOrderSettlement.BorrowOrder({
            borrower: borrower,
            collateralToken: address(stockToken),
            collateralAmount: 50e6,
            minUsdc: 5000e6,
            maxRateBps: 800,
            termDays: 30,
            maxLtvBps: 6000,
            minFill: 1000e6,
            expiry: uint64(block.timestamp + 7 days),
            nonce: 0,
            yieldMode: 0,
            allowInKindSettlement: false
        });

        bytes32 digest = settlement.hashBorrowOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // First partial fill: $2,500
        vm.prank(lender);
        uint256 loanId1 = settlement.fillBorrowOrder(order, sig, 2500e6);
        assertEq(loanId1, 1);
        assertEq(settlement.getOrderFilledAmount(digest), 2500e6);

        // Second partial fill: $2,500
        vm.prank(lender);
        uint256 loanId2 = settlement.fillBorrowOrder(order, sig, 2500e6);
        assertEq(loanId2, 2);
        assertEq(settlement.getOrderFilledAmount(digest), 5000e6);

        // Third fill attempt exceeds order
        vm.prank(lender);
        vm.expectRevert(OrderSettlement.OrderExceeded.selector);
        settlement.fillBorrowOrder(order, sig, 1000e6);
    }

    function test_OrderCancellation() public {
        IOrderSettlement.BorrowOrder memory order = IOrderSettlement.BorrowOrder({
            borrower: borrower,
            collateralToken: address(stockToken),
            collateralAmount: 50e6,
            minUsdc: 5000e6,
            maxRateBps: 800,
            termDays: 30,
            maxLtvBps: 6000,
            minFill: 500e6,
            expiry: uint64(block.timestamp + 7 days),
            nonce: 0,
            yieldMode: 0,
            allowInKindSettlement: false
        });

        bytes32 digest = settlement.hashBorrowOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Third party attempt to cancel reverts
        address attacker = address(0x9999);
        vm.prank(attacker);
        vm.expectRevert(OrderSettlement.Unauthorized.selector);
        settlement.cancelBorrowOrder(order);

        // Borrower cancels their order
        vm.prank(borrower);
        settlement.cancelBorrowOrder(order);
        assertTrue(settlement.isOrderCancelled(digest));

        // Fill attempt reverts
        vm.prank(lender);
        vm.expectRevert(OrderSettlement.OrderCancelledAlready.selector);
        settlement.fillBorrowOrder(order, sig, 5000e6);
    }

    function test_NonceBump() public {
        IOrderSettlement.BorrowOrder memory order = IOrderSettlement.BorrowOrder({
            borrower: borrower,
            collateralToken: address(stockToken),
            collateralAmount: 50e6,
            minUsdc: 5000e6,
            maxRateBps: 800,
            termDays: 30,
            maxLtvBps: 6000,
            minFill: 500e6,
            expiry: uint64(block.timestamp + 7 days),
            nonce: 0,
            yieldMode: 0,
            allowInKindSettlement: false
        });

        bytes32 digest = settlement.hashBorrowOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Borrower bumps nonce
        vm.prank(borrower);
        settlement.bumpNonce();
        assertEq(settlement.getMakerNonce(borrower), 1);

        // Fill attempt with old nonce reverts
        vm.prank(lender);
        vm.expectRevert(OrderSettlement.InvalidNonce.selector);
        settlement.fillBorrowOrder(order, sig, 5000e6);
    }

    function test_FillBorrowOrder_WithAttestations() public {
        uint256 kycPrivateKey = 0x8888;
        address kycSigner = vm.addr(kycPrivateKey);

        // Put gate into permissioned mode with attestation signer
        vm.startPrank(owner);
        gate.setPermissionlessMode(false);
        gate.setAttestationSigner(kycSigner);
        vm.stopPrank();

        IOrderSettlement.BorrowOrder memory order = IOrderSettlement.BorrowOrder({
            borrower: borrower,
            collateralToken: address(stockToken),
            collateralAmount: 50e6,
            minUsdc: 5000e6,
            maxRateBps: 800,
            termDays: 30,
            maxLtvBps: 6000,
            minFill: 500e6,
            expiry: uint64(block.timestamp + 7 days),
            nonce: 0,
            yieldMode: 0,
            allowInKindSettlement: false
        });

        bytes32 digest = settlement.hashBorrowOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Calling fillBorrowOrder without attestations reverts IneligibleCounterparty
        vm.prank(lender);
        vm.expectRevert(OrderSettlement.IneligibleCounterparty.selector);
        settlement.fillBorrowOrder(order, sig, 5000e6);

        // Sign KYC attestations for borrower and lender
        uint256 expiry = block.timestamp + 1 days;
        bytes32 bDigest = gate.getAttestationDigest(borrower, 0, expiry);
        (uint8 bv, bytes32 br, bytes32 bs) = vm.sign(kycPrivateKey, bDigest);
        bytes memory bAttestation = abi.encode(expiry, abi.encodePacked(br, bs, bv));

        bytes32 lDigest = gate.getAttestationDigest(lender, 0, expiry);
        (uint8 lv, bytes32 lr, bytes32 ls) = vm.sign(kycPrivateKey, lDigest);
        bytes memory lAttestation = abi.encode(expiry, abi.encodePacked(lr, ls, lv));

        // Attempting with expired borrower attestation fails
        bytes memory expiredB = abi.encode(block.timestamp - 1, abi.encodePacked(br, bs, bv));
        vm.prank(lender);
        vm.expectRevert(OrderSettlement.IneligibleCounterparty.selector);
        settlement.fillBorrowOrderWithAttestations(order, sig, 5000e6, expiredB, lAttestation);

        // Filling with both valid attestations succeeds!
        vm.prank(lender);
        uint256 loanId = settlement.fillBorrowOrderWithAttestations(
            order,
            sig,
            5000e6,
            bAttestation,
            lAttestation
        );

        assertEq(loanId, 1);
        assertEq(core.totalOutstandingPrincipal(), 5000e6);
    }

    function test_FillLendOffer_WithAttestations() public {
        uint256 kycPrivateKey = 0x8888;
        address kycSigner = vm.addr(kycPrivateKey);

        vm.startPrank(owner);
        gate.setPermissionlessMode(false);
        gate.setAttestationSigner(kycSigner);
        vm.stopPrank();

        IOrderSettlement.LendOffer memory offer = IOrderSettlement.LendOffer({
            lender: lender,
            usdcAmount: 5000e6,
            minRateBps: 800,
            termDays: 30,
            allowedCollateral: address(stockToken),
            maxLtvBps: 6000,
            minFill: 500e6,
            expiry: uint64(block.timestamp + 7 days),
            nonce: 0,
            yieldMode: 0
        });

        bytes32 digest = settlement.hashLendOffer(offer);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lenderPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Sign KYC attestations
        uint256 expiry = block.timestamp + 1 days;
        bytes32 bDigest = gate.getAttestationDigest(borrower, 0, expiry);
        (uint8 bv, bytes32 br, bytes32 bs) = vm.sign(kycPrivateKey, bDigest);
        bytes memory bAttestation = abi.encode(expiry, abi.encodePacked(br, bs, bv));

        bytes32 lDigest = gate.getAttestationDigest(lender, 0, expiry);
        (uint8 lv, bytes32 lr, bytes32 ls) = vm.sign(kycPrivateKey, lDigest);
        bytes memory lAttestation = abi.encode(expiry, abi.encodePacked(lr, ls, lv));

        // Taker (borrower) fills lend offer passing borrowerAttestation then lenderAttestation
        vm.prank(borrower);
        uint256 loanId = settlement.fillLendOfferWithAttestations(
            offer,
            sig,
            address(stockToken),
            50e6,
            5000e6,
            bAttestation,
            lAttestation
        );

        assertEq(loanId, 1);
        assertEq(core.totalOutstandingPrincipal(), 5000e6);
    }
}
