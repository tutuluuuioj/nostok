// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
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

contract LiquidationAuctionTest is Test {
    LoanCore public core;
    CollateralEscrow public escrow;
    PositionNFT public nft;
    AssetRegistry public registry;
    OracleRouter public router;
    FeeCollector public feeCollector;
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

    address public borrower = address(0xAAAA);
    address public lender = address(0xBBBB);
    address public liquidator = address(0xCCCC);
    address public keeper = address(0xDDDD);

    function setUp() public {
        vm.warp(1700000000);

        vm.startPrank(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        stockToken = new MockERC20("NVIDIA Corp", "NVDAc", 6);

        feed = new MockAggregator(8, 200e8); // $200.00
        sequencer = new MockSequencer(0); // UP

        EligibilityGate gate = new EligibilityGate(owner, address(0), true);
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

        auction.initialize(
            owner,
            address(escrow),
            address(core),
            address(feeCollector),
            address(usdc)
        );

        core.setOrderSettlement(mockOrderSettlement);

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
            maxDiscountBps: 600, // 6% max discount
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
        usdc.mint(lender, 20_000e6);
        usdc.mint(liquidator, 50_000e6);

        vm.prank(borrower);
        stockToken.approve(address(escrow), type(uint256).max);

        vm.prank(lender);
        usdc.approve(address(core), type(uint256).max);

        vm.prank(liquidator);
        usdc.approve(address(auction), type(uint256).max);
    }

    function test_LiquidationTriggerAndDutchAuctionBuy() public {
        // Open loan: 50 NVDAc ($10,000 value), borrow $5,800 (58% LTV)
        vm.prank(mockOrderSettlement);
        uint256 loanId = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            5800e6,
            800,
            30,
            6000,
            3,
            0
        );

        // Price drops from $200 down to $145
        // Collateral value = 50 * $145 = $7,250.
        // Debt = $5,800 -> LTV = 5800 / 7250 = 80% (breaches 78% liq threshold!)
        feed.setPrice(145e8);

        // Keeper triggers liquidation
        vm.prank(keeper);
        uint256 auctionId = core.startLiquidation(loanId);
        assertEq(auctionId, 1);

        // Position NFT is transfer-locked during auction
        assertTrue(nft.isAuctionLocked(loanId));

        // Start price is oracle - 1% ($145 * 0.99 = $143.55)
        uint256 startP = auction.getCurrentPrice(auctionId);
        assertEq(startP, (145e8 * 99) / 100);

        // Warp 15 minutes (halfway through 30-min auction)
        vm.warp(block.timestamp + 900);
        uint256 midPrice = auction.getCurrentPrice(auctionId);
        assertLt(midPrice, startP);

        // Liquidator buys 25 shares
        ILiquidationAuction.Auction memory a = auction.getAuction(auctionId);
        uint128 toBuy = a.collateralRemaining;

        vm.prank(liquidator);
        uint128 usdcPaid = auction.buy(auctionId, toBuy, 50_000e6);

        assertGt(usdcPaid, 0);
        assertEq(stockToken.balanceOf(liquidator), toBuy);

        // Keeper received reward
        assertGt(usdc.balanceOf(keeper), 0);
    }

    function test_Auction_DustBuyRejected() public {
        vm.prank(mockOrderSettlement);
        uint256 loanId = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            5800e6,
            800,
            30,
            6000,
            3,
            0
        );

        feed.setPrice(145e8);
        vm.prank(keeper);
        uint256 auctionId = core.startLiquidation(loanId);

        // Attempt to buy 1 raw unit of collateral (< 10 USDC)
        vm.prank(liquidator);
        vm.expectRevert(LiquidationAuction.BuyAmountTooSmall.selector);
        auction.buy(auctionId, 1, 100e6);
    }

    function test_Auction_MultiBuyAndDebtReduction() public {
        // Open loan: 50 NVDAc, borrow $5,800
        vm.prank(mockOrderSettlement);
        uint256 loanId = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            5800e6,
            800,
            30,
            6000,
            3,
            0
        );

        feed.setPrice(145e8);
        vm.prank(keeper);
        uint256 auctionId = core.startLiquidation(loanId);

        // First buy: liquidator buys 15 shares (partial buy)
        uint128 firstBuyCollateral = 15e6;
        vm.prank(liquidator);
        uint128 paid1 = auction.buy(auctionId, firstBuyCollateral, 20_000e6);
        assertGt(paid1, 10e6); // Well above $10 min buy size

        // Verify partial buy state: loan is NOT settled yet, still in Auction
        ILoanCore.Loan memory l1 = core.getLoan(loanId);
        assertEq(uint8(l1.status), uint8(ILoanCore.LoanStatus.Auction));
        assertTrue(nft.isAuctionLocked(loanId));
        assertGt(l1.principalRepaid, 0);
        assertLt(l1.principalRepaid, l1.principal);

        ILiquidationAuction.Auction memory a1 = auction.getAuction(auctionId);
        assertEq(a1.collateralRemaining, 10e6); // 25e6 (50% partial auction) - 15e6 = 10e6
        assertEq(uint8(a1.status), uint8(ILiquidationAuction.AuctionStatus.Active));

        // Second buy: liquidator buys remaining 10 shares of the partial auction
        uint128 remainingCollateral = a1.collateralRemaining;
        vm.prank(liquidator);
        uint128 paid2 = auction.buy(auctionId, remainingCollateral, 30_000e6);
        assertGt(paid2, 0);

        // Auction itself is settled, but LOAN is NOT settled!
        // The remaining 25 shares are NOT stuck, and the remaining debt (~$2,250) is still owed!
        ILiquidationAuction.Auction memory a2 = auction.getAuction(auctionId);
        assertEq(uint8(a2.status), uint8(ILiquidationAuction.AuctionStatus.Settled));

        ILoanCore.Loan memory l2 = core.getLoan(loanId);
        assertEq(uint8(l2.status), uint8(ILoanCore.LoanStatus.Active));
        assertEq(l2.collateralRaw, 25e6); // Other half of stock is still in the loan!
        assertGt(l2.principal - l2.principalRepaid, 2000e6); // ~$2,250 debt remains
        assertEq(nft.ownerOf(loanId), lender); // Position NFT is NOT burned!
        assertFalse(nft.isAuctionLocked(loanId)); // Auction lock removed!

        // Borrower can now repay the remaining debt to reclaim their remaining 25 shares
        usdc.mint(borrower, 3000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);

        vm.prank(borrower);
        core.repay(loanId);

        // All collateral released cleanly, escrow empty, loan repaid, NFT burned!
        assertEq(stockToken.balanceOf(borrower), 75e6);
        assertEq(escrow.getBalance(address(stockToken)), 0);
        ILoanCore.Loan memory lFinal = core.getLoan(loanId);
        assertEq(uint8(lFinal.status), uint8(ILoanCore.LoanStatus.Repaid));
        vm.expectRevert();
        nft.ownerOf(loanId);
    }

    function test_BadDebt_ShortfallClearedFromCaps() public {
        vm.prank(mockOrderSettlement);
        uint256 loanId = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            5800e6,
            800,
            30,
            6000,
            3,
            0
        );

        // Severe crash into bad debt (> 90% LTV threshold): price drops to $60
        // Collateral value = 50 * $60 = $3,000. Debt = $5,800.
        feed.setPrice(60e8);

        // Triggers 100% full liquidation auction
        vm.prank(keeper);
        uint256 auctionId = core.startLiquidation(loanId);
        ILiquidationAuction.Auction memory a = auction.getAuction(auctionId);
        assertEq(a.collateralTotal, 50e6); // 100% of collateral auctioned!

        // Liquidator buys all 50 shares
        vm.prank(liquidator);
        auction.buy(auctionId, 50e6, 50_000e6);

        // Loan settles with bad debt
        ILoanCore.Loan memory l = core.getLoan(loanId);
        assertEq(uint8(l.status), uint8(ILoanCore.LoanStatus.SettledLiquidated));
        assertEq(l.collateralRaw, 0);
        assertGt(l.principal - l.principalRepaid, 0); // Shortfall exists

        // Crucial fix: Shortfall is cleared from totalOutstandingPrincipal and asset cap!
        assertEq(core.totalOutstandingPrincipal(), 0);
        assertEq(core.assetOutstandingPrincipal(address(stockToken)), 0);
    }

    function test_Auction_RestartOrCancel_PriceRecovered() public {
        vm.prank(mockOrderSettlement);
        uint256 loanId = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            5800e6,
            800,
            30,
            6000,
            3,
            0
        );

        feed.setPrice(145e8);
        vm.prank(keeper);
        uint256 auctionId = core.startLiquidation(loanId);

        // 30-minute auction expires with nobody buying
        vm.warp(block.timestamp + 1801);

        // Price recovers back to $200!
        feed.setPrice(200e8);
        feed.setUpdatedAt(block.timestamp);

        // Anyone calls restartOrCancelAuction -> detects price recovered and cancels!
        auction.restartOrCancelAuction(auctionId);

        ILiquidationAuction.Auction memory a = auction.getAuction(auctionId);
        assertEq(uint8(a.status), uint8(ILiquidationAuction.AuctionStatus.Cancelled));

        // Loan returns to Active status and NFT is unlocked!
        ILoanCore.Loan memory l = core.getLoan(loanId);
        assertEq(uint8(l.status), uint8(ILoanCore.LoanStatus.Active));
        assertFalse(nft.isAuctionLocked(loanId));
    }

    function test_Auction_DefaultSettlesWithSettledDefault() public {
        vm.prank(mockOrderSettlement);
        uint256 loanId = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            4000e6,
            800,
            30,
            6000,
            3,
            0
        );

        // Warp past maturity (30 days) + grace period (24 hours) + 1 second
        vm.warp(block.timestamp + 31 days + 1);
        feed.setUpdatedAt(block.timestamp);

        // Default auction triggered
        vm.prank(keeper);
        uint256 auctionId = core.startDefaultAuction(loanId);
        assertEq(auctionId, 1);

        ILiquidationAuction.Auction memory a = auction.getAuction(auctionId);
        assertTrue(a.isDefaultAuction);

        // Liquidator buys all collateral
        vm.prank(liquidator);
        auction.buy(auctionId, a.collateralRemaining, 50_000e6);

        // Status is SettledDefault!
        ILoanCore.Loan memory l = core.getLoan(loanId);
        assertEq(uint8(l.status), uint8(ILoanCore.LoanStatus.SettledDefault));
    }

    function test_Auction_TwoLoansSameToken_NoCollateralDrain() public {
        address borrower2 = address(0xEEEE);
        stockToken.mint(borrower2, 100e6);
        vm.prank(borrower2);
        stockToken.approve(address(escrow), type(uint256).max);

        // Loan 1: borrower deposits 50 NVDAc, borrows $5,800
        vm.prank(mockOrderSettlement);
        uint256 loan1 = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            5800e6,
            800,
            30,
            6000,
            3,
            0
        );

        // Loan 2: borrower2 deposits 50 NVDAc, borrows $4,000
        vm.prank(mockOrderSettlement);
        uint256 loan2 = core.openLoan(
            borrower2,
            lender,
            address(stockToken),
            50e6,
            4000e6,
            800,
            30,
            6000,
            3,
            0
        );

        // Escrow holds exactly 100 NVDAc
        assertEq(stockToken.balanceOf(address(escrow)), 100e6);
        assertEq(escrow.getBalance(address(stockToken)), 100e6);

        // Trigger liquidation on Loan 1
        feed.setPrice(145e8);
        vm.prank(keeper);
        uint256 auctionId = core.startLiquidation(loan1);

        // Liquidator buys 25 shares (which pays off all debt)
        ILiquidationAuction.Auction memory a = auction.getAuction(auctionId);
        vm.prank(liquidator);
        auction.buy(auctionId, a.collateralRemaining, 50_000e6);

        // Partial auction sold 25 shares to liquidator; loan 1 remaining 25 shares stay in escrow
        assertEq(stockToken.balanceOf(liquidator), 25e6);

        // CRITICAL CHECK: Escrow STILL has EXACTLY 75 NVDAc (25 remaining for Loan 1 + 50 for Loan 2)!
        // Loan 2's collateral was completely untouched and NOT drained!
        assertEq(stockToken.balanceOf(address(escrow)), 75e6);
        assertEq(escrow.getBalance(address(stockToken)), 75e6);

        // Borrower 1 repays remaining debt to reclaim their remaining 25 shares
        usdc.mint(borrower, 4000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);
        vm.prank(borrower);
        core.repay(loan1);

        assertEq(stockToken.balanceOf(borrower), 75e6);
        // Escrow now holds exactly Loan 2's 50 shares
        assertEq(stockToken.balanceOf(address(escrow)), 50e6);
        assertEq(escrow.getBalance(address(stockToken)), 50e6);

        // Loan 2 borrower can cleanly repay and get 100% of their 50 NVDAc collateral back without revert!
        usdc.mint(borrower2, 6000e6);
        vm.prank(borrower2);
        usdc.approve(address(core), type(uint256).max);
        vm.prank(borrower2);
        core.repay(loan2);

        assertEq(stockToken.balanceOf(borrower2), 100e6);
        assertEq(stockToken.balanceOf(address(escrow)), 0);
        assertEq(escrow.getBalance(address(stockToken)), 0);
    }

    function test_Auction_BuyPastDuration_RevertsAuctionExpired() public {
        vm.prank(mockOrderSettlement);
        uint256 loanId = core.openLoan(
            borrower,
            lender,
            address(stockToken),
            50e6,
            5800e6,
            800,
            30,
            6000,
            3,
            0
        );

        feed.setPrice(145e8);
        vm.prank(keeper);
        uint256 auctionId = core.startLiquidation(loanId);

        // Warp past the 30-minute auction duration (1800s)
        vm.warp(block.timestamp + 1801);

        // Buying after 30 minutes at stale floor price reverts!
        vm.prank(liquidator);
        vm.expectRevert(LiquidationAuction.AuctionExpired.selector);
        auction.buy(auctionId, 10e6, 20_000e6);

        // Fresh oracle price update
        feed.setPrice(130e8);
        feed.setUpdatedAt(block.timestamp);

        // Restart auction with fresh oracle
        auction.restartOrCancelAuction(auctionId);

        // Now buying at restarted fresh auction succeeds!
        vm.prank(liquidator);
        uint128 paid = auction.buy(auctionId, 10e6, 20_000e6);
        assertGt(paid, 0);
    }
}
