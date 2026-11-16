// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {LoanCore} from "../src/LoanCore.sol";
import {CollateralEscrow} from "../src/CollateralEscrow.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {EligibilityGate} from "../src/EligibilityGate.sol";
import {LiquidationAuction} from "../src/LiquidationAuction.sol";
import {ILiquidationAuction} from "../src/interfaces/ILiquidationAuction.sol";
import {ILoanCore} from "../src/interfaces/ILoanCore.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockSequencer} from "./mocks/MockSequencer.sol";
import {MockSmartWallet} from "./mocks/MockSmartWallet.sol";

contract LoanCoreTest is Test {
    LoanCore public core;
    CollateralEscrow public escrow;
    PositionNFT public nft;
    AssetRegistry public registry;
    OracleRouter public router;
    FeeCollector public feeCollector;
    EligibilityGate public gate;
    LiquidationAuction public auction;

    MockERC20 public usdc;
    MockERC20 public stockToken;
    MockAggregator public feed;
    MockSequencer public sequencer;

    address public owner = address(0x1111);
    address public guardian = address(0x2222);
    address public treasury = address(0x3333);
    address public reserve = address(0x4444);
    address public mockOrderSettlement = address(0x5555);

    uint256 public borrowerPrivateKey = 0xA11CE;
    address public borrower;
    uint256 public lenderPrivateKey = 0xB0B;
    address public lender;

    bytes32 public constant EXTEND_ORDER_TYPEHASH = keccak256(
        "ExtendOrder(uint256 loanId,uint64 newMaturity,uint32 newRateBps,uint256 nonce,uint64 deadline)"
    );

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("NOSTOK Loan Core")),
                keccak256(bytes("1")),
                block.chainid,
                address(core)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function setUp() public {
        borrower = vm.addr(borrowerPrivateKey);
        lender = vm.addr(lenderPrivateKey);
        vm.warp(1700000000); // Set baseline timestamp

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
        router.setMarketSession(true, true); // Open session

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

        auction.initialize(
            owner,
            address(escrow),
            address(core),
            address(feeCollector),
            address(usdc)
        );

        core.setOrderSettlement(mockOrderSettlement);

        // Authorize LoanCore & Auction on Escrow and NFT
        escrow.setAuthorizedCore(address(core), true);
        escrow.setAuthorizedCore(address(auction), true);
        nft.setAuthorizedCore(address(core), true);

        // Register Stock Token: 60% maxInitLTV, 78% liqLTV
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

        // Mint balances and approvals
        stockToken.mint(borrower, 100e6); // 100 NVDAc @ $200 = $20,000 collateral
        usdc.mint(lender, 20_000e6);

        vm.prank(borrower);
        stockToken.approve(address(escrow), type(uint256).max);

        vm.prank(lender);
        usdc.approve(address(core), type(uint256).max);
    }

    function test_OpenLoan_Success() public {
        // Borrow $5,000 USDC against 50 NVDAc ($10,000 value, 50% LTV)
        vm.prank(mockOrderSettlement);
        uint256 loanId = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6, // 50 NVDAc
            5000e6, // $5,000 USDC
            800, // 8.00% APR
            30, // 30 days
            6000, // 60% max LTV
            3, // 3 minInterestDays
            0 // yieldMode None
        );

        assertEq(loanId, 1);
        assertEq(escrow.getBalance(address(stockToken)), 50e6);
        assertEq(nft.ownerOf(loanId), lender);

        // Origination fee = 0.10% of $5,000 = $5.00
        // Borrower received $4,995
        assertEq(usdc.balanceOf(borrower), 4995e6);
    }

    function test_OpenLoan_LtvExceeded_Reverts() public {
        // Try borrowing $7,000 against 50 NVDAc ($10,000 value = 70% LTV > 60% cap)
        vm.prank(mockOrderSettlement);
        vm.expectRevert(LoanCore.LtvExceeded.selector);
        core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            7000e6,
            800,
            30,
            6000,
            3,
            0
        );
    }

    function test_Repay_AtMaturity() public {
        test_OpenLoan_Success();

        // Warp time to maturity (30 days)
        vm.warp(block.timestamp + 30 days);

        // 30 days interest on $5,000 at 8% APR = $32.88 (3287672)
        uint128 interestDue = core.getDueInterest(1);
        assertGt(interestDue, 0);

        // Fund borrower with USDC to repay principal + interest
        usdc.mint(borrower, 6000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);

        vm.prank(borrower);
        uint128 totalPaid = core.repay(1);

        assertEq(totalPaid, 5000e6 + interestDue);
        // Collateral returned to borrower
        assertEq(stockToken.balanceOf(borrower), 100e6);
        assertEq(escrow.getBalance(address(stockToken)), 0);

        // Lender claimable has principal + net interest (minus 10% interest cut)
        uint128 cut = feeCollector.calculateInterestCut(interestDue);
        assertEq(core.getClaimable(lender), 5000e6 + (interestDue - cut));

        // Lender claims payout
        vm.prank(lender);
        core.claim(lender);
        assertEq(usdc.balanceOf(lender), 20000e6 - 5000e6 + (5000e6 + interestDue - cut));
    }

    function test_EarlyRepay_MinInterestPenalty() public {
        test_OpenLoan_Success();

        // Repay after only 1 day (should be charged minInterestDays = 3 days)
        vm.warp(block.timestamp + 1 days);

        uint128 interestDue = core.getDueInterest(1);
        // 3 days interest on $5,000 at 8% = ~$3.29 (328768)
        assertGt(interestDue, 3e6);

        usdc.mint(borrower, 6000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);

        vm.prank(borrower);
        core.repay(1);

        assertEq(stockToken.balanceOf(borrower), 100e6);
    }

    function test_TopUp_Collateral() public {
        test_OpenLoan_Success();

        // Top up 10 NVDAc
        vm.prank(borrower);
        core.topUp(1, 10e6);

        ILoanCore.Loan memory l = core.getLoan(1);
        assertEq(l.collateralRaw, 60e6);
        assertEq(escrow.getBalance(address(stockToken)), 60e6);
    }

    function test_PartialRepay() public {
        test_OpenLoan_Success();

        usdc.mint(borrower, 3000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);

        // Repay $2,500 (50% of principal)
        vm.prank(borrower);
        core.partialRepay(1, 2500e6);

        ILoanCore.Loan memory l = core.getLoan(1);
        assertEq(l.principalRepaid, 2500e6);
        // Half collateral released (25 NVDAc)
        assertEq(l.collateralRaw, 25e6);
        assertEq(stockToken.balanceOf(borrower), 75e6);
    }

    function test_Extend_RequiresCounterpartyEIP712Sig_And_CapsRate() public {
        test_OpenLoan_Success();
        ILoanCore.Loan memory l = core.getLoan(1);

        uint64 newMaturity = l.maturity + 15 days;
        uint32 newRateBps = 1200; // 12%
        uint64 deadline = uint64(block.timestamp + 1 days);

        // 1. Reverts if rate exceeds 40% cap (4000 bps)
        vm.prank(borrower);
        vm.expectRevert(LoanCore.InvalidLoanTerms.selector);
        core.extend(1, newMaturity, 4500, deadline, "");

        // 2. Reverts if extension term > 90 days from now
        vm.prank(borrower);
        vm.expectRevert(LoanCore.InvalidLoanTerms.selector);
        core.extend(1, uint64(block.timestamp + 95 days), newRateBps, deadline, "");

        // 3. Reverts if unauthorized third party calls
        address attacker = address(0x9999);
        vm.prank(attacker);
        vm.expectRevert(LoanCore.UnauthorizedCaller.selector);
        core.extend(1, newMaturity, newRateBps, deadline, "");

        // 4. Lender signs EIP-712 approval for extension
        bytes32 structHash = keccak256(
            abi.encode(EXTEND_ORDER_TYPEHASH, 1, newMaturity, newRateBps, 0, deadline)
        );
        bytes32 digest = _hashTypedData(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lenderPrivateKey, digest);
        bytes memory lenderSig = abi.encodePacked(r, s, v);

        // 5. Borrower submits with wrong signature reverts
        (uint8 badV, bytes32 badR, bytes32 badS) = vm.sign(borrowerPrivateKey, digest);
        bytes memory badSig = abi.encodePacked(badR, badS, badV);
        vm.prank(borrower);
        vm.expectRevert(LoanCore.InvalidSignature.selector);
        core.extend(1, newMaturity, newRateBps, deadline, badSig);

        // 6. Borrower submits with valid lender signature -> extends successfully!
        vm.prank(borrower);
        core.extend(1, newMaturity, newRateBps, deadline, lenderSig);

        ILoanCore.Loan memory updatedLoan = core.getLoan(1);
        assertEq(updatedLoan.maturity, newMaturity);
        assertEq(updatedLoan.rateBps, newRateBps);
    }

    function test_Extend_ExpiredSignature_Reverts() public {
        test_OpenLoan_Success();
        ILoanCore.Loan memory l = core.getLoan(1);

        uint64 newMaturity = l.maturity + 15 days;
        uint32 newRateBps = 1200;
        uint64 deadline = uint64(block.timestamp + 1 hours);

        bytes32 structHash = keccak256(
            abi.encode(EXTEND_ORDER_TYPEHASH, 1, newMaturity, newRateBps, 0, deadline)
        );
        bytes32 digest = _hashTypedData(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lenderPrivateKey, digest);
        bytes memory lenderSig = abi.encodePacked(r, s, v);

        // Warp past deadline
        vm.warp(block.timestamp + 2 hours);

        vm.prank(borrower);
        vm.expectRevert(LoanCore.OrderExpired.selector);
        core.extend(1, newMaturity, newRateBps, deadline, lenderSig);
    }

    function test_RepayDuringAuction_CancelsAuctionAndSavesCollateral() public {
        test_OpenLoan_Success();

        // Trigger liquidation auction (50 shares * $125 = $6,250; debt $5,000 = 80% LTV > 78% threshold)
        feed.setPrice(125e8);
        address keeper = address(0xDDDD);
        vm.prank(keeper);
        uint256 auctionId = core.startLiquidation(1);
        assertEq(auctionId, 1);
        assertTrue(nft.isAuctionLocked(1));

        // Borrower repays full debt during the active auction
        usdc.mint(borrower, 6000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);

        vm.prank(borrower);
        core.repay(1);

        // Auction was cancelled!
        ILiquidationAuction.Auction memory a = auction.getAuction(auctionId);
        assertEq(uint8(a.status), uint8(ILiquidationAuction.AuctionStatus.Cancelled));

        // Borrower received 100% of their collateral back!
        assertEq(stockToken.balanceOf(borrower), 100e6);
        assertEq(escrow.getBalance(address(stockToken)), 0);

        // Loan status is Repaid, NFT burned
        ILoanCore.Loan memory l = core.getLoan(1);
        assertEq(uint8(l.status), uint8(ILoanCore.LoanStatus.Repaid));
        vm.expectRevert();
        nft.ownerOf(1);
    }

    function test_PartialRepay_AccruesAndChargesInterest() public {
        test_OpenLoan_Success();

        // Warp 10 days
        vm.warp(block.timestamp + 10 days);

        uint128 initialLenderClaimable = core.getClaimable(lender);

        usdc.mint(borrower, 3000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);

        // Repay $2,500 (50% of principal)
        vm.prank(borrower);
        uint128 totalPaid = core.partialRepay(1, 2500e6);

        // Total paid MUST exceed principal repayment because it accrued interest on the repaid part!
        assertGt(totalPaid, 2500e6);
        uint128 interestCharged = totalPaid - 2500e6;
        assertGt(interestCharged, 0);

        // Fee collector received protocol cut of the interest
        uint128 cut = feeCollector.calculateInterestCut(interestCharged);
        assertGt(cut, 0);

        // Lender claimable increased by principal + net interest
        assertEq(core.getClaimable(lender), initialLenderClaimable + 2500e6 + (interestCharged - cut));

        ILoanCore.Loan memory l = core.getLoan(1);
        assertEq(l.principalRepaid, 2500e6);
        assertEq(l.interestPaid, interestCharged);
    }

    function test_SyncStatus_GracePeriod() public {
        test_OpenLoan_Success();

        // Warp to maturity (30 days) + 12 hours (within 24h grace window)
        vm.warp(block.timestamp + 30 days + 12 hours);

        ILoanCore.LoanStatus status = core.syncStatus(1);
        assertEq(uint8(status), uint8(ILoanCore.LoanStatus.Grace));

        // Penalty interest is calculated and active
        uint128 interestDue = core.getDueInterest(1);
        // Standard full 30d interest is ~$32.88. In grace, penalty interest spread is added.
        assertGt(interestDue, 33e6);
    }

    function test_MinInterestDays_Dynamic() public {
        // Open loan with custom minInterestDays = 14
        vm.prank(mockOrderSettlement);
        uint256 loanId = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            5000e6,
            800,
            30,
            6000,
            14, // 14 minInterestDays
            0
        );

        ILoanCore.Loan memory l = core.getLoan(loanId);
        assertEq(l.minInterestDays, 14);

        // Warp only 2 days
        vm.warp(block.timestamp + 2 days);

        // Interest charged must reflect minimum 14 days!
        uint128 interestDue = core.getDueInterest(loanId);
        // 14 days on $5,000 at 8% = ~$15.34 (1534246)
        assertGt(interestDue, 15e6);
    }

    function test_PartialAuctionBuy_NoDoubleChargeInterest() public {
        test_OpenLoan_Success();
        // Loan 1: $5,000 principal at 8% APR for 30 days
        // Warp 15 days (halfway)
        vm.warp(block.timestamp + 15 days);
        uint128 interestDueAtAuction = core.getDueInterest(1);
        assertGt(interestDueAtAuction, 0);

        // Price drops to trigger liquidation
        feed.setPrice(125e8);
        address keeper = address(0xDDDD);
        vm.prank(keeper);
        uint256 auctionId = core.startLiquidation(1);

        // Liquidator buys 15 shares (partial buy: 15 shares out of 25 in auction)
        address liquidator = address(0xCCCC);
        usdc.mint(liquidator, 50_000e6);
        vm.prank(liquidator);
        usdc.approve(address(auction), type(uint256).max);

        vm.prank(liquidator);
        auction.buy(auctionId, 15e6, 20_000e6);

        // All accrued interest up to now was paid by the auction!
        ILoanCore.Loan memory l1 = core.getLoan(1);
        assertEq(l1.interestPaid, interestDueAtAuction);

        // Immediate check right after auction buy: due interest MUST BE 0!
        // Previous bug charged remaining principal all the way from startTime again!
        uint128 immediateDue = core.getDueInterest(1);
        assertEq(immediateDue, 0);

        // Warp another 10 days
        vm.warp(block.timestamp + 10 days);
        uint128 laterDue = core.getDueInterest(1);
        uint128 remainingPrincipal = l1.principal - l1.principalRepaid;
        // Interest must ONLY be for the 10 elapsed days on the remaining principal!
        uint128 expected10DaysInterest = uint128(
            (uint256(remainingPrincipal) * l1.rateBps * 10 days + (10000 * 365 days - 1)) / (10000 * 365 days)
        );
        assertEq(laterDue, expected10DaysInterest);
    }

    function test_Extend_ChainedPast90Days_Reverts() public {
        test_OpenLoan_Success();
        ILoanCore.Loan memory l = core.getLoan(1);
        uint64 start = l.startTime;

        // 1. Extend from 30 days to 60 days from startTime
        uint64 maturity60 = start + 60 days;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 structHash1 = keccak256(
            abi.encode(EXTEND_ORDER_TYPEHASH, 1, maturity60, 1000, 0, deadline)
        );
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(lenderPrivateKey, _hashTypedData(structHash1));
        vm.prank(borrower);
        core.extend(1, maturity60, 1000, deadline, abi.encodePacked(r1, s1, v1));

        // Warp 20 days forward
        vm.warp(block.timestamp + 20 days);

        // 2. Chained extend attempt: trying to extend past 90 days from startTime (e.g. 95 days)
        uint64 maturity95 = start + 95 days;
        bytes32 structHash2 = keccak256(
            abi.encode(EXTEND_ORDER_TYPEHASH, 1, maturity95, 1000, 1, deadline + 20 days)
        );
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(lenderPrivateKey, _hashTypedData(structHash2));

        // Must revert InvalidLoanTerms because newMaturity > l.startTime + 90 days!
        vm.prank(borrower);
        vm.expectRevert(LoanCore.InvalidLoanTerms.selector);
        core.extend(1, maturity95, 1000, deadline + 20 days, abi.encodePacked(r2, s2, v2));

        // Extending to exactly 90 days from startTime succeeds
        uint64 maturity90 = start + 90 days;
        bytes32 structHash3 = keccak256(
            abi.encode(EXTEND_ORDER_TYPEHASH, 1, maturity90, 1000, 1, deadline + 20 days)
        );
        (uint8 v3, bytes32 r3, bytes32 s3) = vm.sign(lenderPrivateKey, _hashTypedData(structHash3));
        vm.prank(borrower);
        core.extend(1, maturity90, 1000, deadline + 20 days, abi.encodePacked(r3, s3, v3));
    }

    function test_Extend_NewRateNotRetroactive() public {
        test_OpenLoan_Success();
        ILoanCore.Loan memory l0 = core.getLoan(1);

        // Warp 15 days at original 8% APR
        uint256 t1 = block.timestamp + 15 days;
        vm.warp(t1);
        uint128 interestPeriod1 = core.getDueInterest(1);
        assertGt(interestPeriod1, 0);

        // Extend to 45 days and raise rate to 20% APR (2000 bps)
        uint64 newMaturity = l0.startTime + 45 days;
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 structHash = keccak256(
            abi.encode(EXTEND_ORDER_TYPEHASH, 1, newMaturity, 2000, 0, deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lenderPrivateKey, _hashTypedData(structHash));
        vm.prank(borrower);
        core.extend(1, newMaturity, 2000, deadline, abi.encodePacked(r, s, v));

        // Immediately after extend: interest due must equal interest from period 1
        assertEq(core.getDueInterest(1), interestPeriod1);

        // Warp to 30 days from startTime (15 days under new 20% APR)
        uint256 t2 = l0.startTime + 30 days;
        vm.warp(t2);
        uint128 totalDue = core.getDueInterest(1);

        uint128 expectedPeriod2Interest = uint128(
            (uint256(5000e6) * 2000 * 15 days + (10000 * 365 days - 1)) / (10000 * 365 days)
        );
        // Total interest must be period 1 (at 8%) + period 2 (at 20%), NOT 30 days at 20%!
        assertEq(totalDue, interestPeriod1 + expectedPeriod2Interest);

        uint128 retroactive30DaysAt20 = uint128(
            (uint256(5000e6) * 2000 * 30 days + (10000 * 365 days - 1)) / (10000 * 365 days)
        );
        // It is strictly less than retroactive rate would have been!
        assertLt(totalDue, retroactive30DaysAt20);
    }

    function test_Extend_ERC1271_SmartWalletSignature() public {
        test_OpenLoan_Success();

        // Deploy ERC-1271 mock smart wallet owned by lender
        MockSmartWallet wallet = new MockSmartWallet(lender);

        // Transfer Position NFT #1 from lender to the smart wallet
        vm.prank(lender);
        nft.transferFrom(lender, address(wallet), 1);
        assertEq(nft.ownerOf(1), address(wallet));

        ILoanCore.Loan memory l = core.getLoan(1);
        uint64 newMaturity = l.maturity + 15 days;
        uint64 deadline = uint64(block.timestamp + 1 days);

        bytes32 structHash = keccak256(
            abi.encode(EXTEND_ORDER_TYPEHASH, 1, newMaturity, 1200, 0, deadline)
        );
        bytes32 digest = _hashTypedData(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lenderPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Borrower submits extension with smart wallet's signature via ERC-1271 -> succeeds!
        vm.prank(borrower);
        core.extend(1, newMaturity, 1200, deadline, sig);

        ILoanCore.Loan memory updated = core.getLoan(1);
        assertEq(updated.maturity, newMaturity);
        assertEq(updated.rateBps, 1200);
    }
}
