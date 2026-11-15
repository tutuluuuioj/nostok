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
}
