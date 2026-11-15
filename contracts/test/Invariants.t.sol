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
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockSequencer} from "./mocks/MockSequencer.sol";

contract InvariantsTest is Test {
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
    address public settlement = address(0x5555);

    address public borrower = address(0xAAAA);
    address public lender = address(0xBBBB);

    function setUp() public {
        vm.warp(1700000000);

        vm.startPrank(owner);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        stockToken = new MockERC20("NVIDIA Corp", "NVDAc", 6);

        feed = new MockAggregator(8, 200e8);
        sequencer = new MockSequencer(0);

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

        core.setOrderSettlement(settlement);

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

        stockToken.mint(borrower, 1000e6);
        usdc.mint(lender, 100_000e6);

        vm.prank(borrower);
        stockToken.approve(address(escrow), type(uint256).max);

        vm.prank(lender);
        usdc.approve(address(core), type(uint256).max);
    }

    /**
     * @notice Invariant 1: Escrow Collateral Solvency
     * Escrow balance must always equal or exceed active loans' collateral.
     */
    function test_Invariant_EscrowSolvency() public {
        vm.prank(settlement);
        uint256 loan1 = core.openLoan(borrower, lender, address(stockToken), 50e6, 5000e6, 800, 30, 6000, 3, 0);

        vm.prank(settlement);
        uint256 loan2 = core.openLoan(borrower, lender, address(stockToken), 40e6, 4000e6, 800, 30, 6000, 3, 0);

        uint256 expectedEscrow = 90e6;
        assertEq(escrow.getBalance(address(stockToken)), expectedEscrow);
        assertEq(stockToken.balanceOf(address(escrow)), expectedEscrow);

        // Repaying loan 1 releases exactly its collateral
        usdc.mint(borrower, 10_000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);

        vm.prank(borrower);
        core.repay(loan1);

        assertEq(escrow.getBalance(address(stockToken)), 40e6);
        assertEq(stockToken.balanceOf(address(escrow)), 40e6);

        // Repaying loan 2 brings escrow cleanly back to 0
        vm.prank(borrower);
        core.repay(loan2);

        assertEq(escrow.getBalance(address(stockToken)), 0);
        assertEq(stockToken.balanceOf(address(escrow)), 0);
    }

    /**
     * @notice Invariant 3: Unstoppable Liquidity
     * Repay and TopUp can NEVER be blocked when protocol is paused or oracle is frozen.
     */
    function test_Invariant_UnstoppableLiquidityWhenPausedOrFrozen() public {
        vm.prank(settlement);
        uint256 loanId = core.openLoan(borrower, lender, address(stockToken), 50e6, 5000e6, 800, 30, 6000, 3, 0);

        // Guardian pauses protocol
        vm.prank(guardian);
        core.setPaused(true);
        assertTrue(core.paused());

        // Guardian freezes the asset
        vm.prank(guardian);
        registry.setAssetStatus(address(stockToken), IAssetRegistry.AssetStatus.Frozen);

        // New loans are blocked
        vm.prank(settlement);
        vm.expectRevert(LoanCore.ProtocolPaused.selector);
        core.openLoan(borrower, lender, address(stockToken), 50e6, 5000e6, 800, 30, 6000, 3, 0);

        // BUT TopUp succeeds!
        vm.prank(borrower);
        core.topUp(loanId, 10e6);
        assertEq(escrow.getBalance(address(stockToken)), 60e6);

        // AND Repay succeeds!
        usdc.mint(borrower, 10_000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);

        vm.prank(borrower);
        core.repay(loanId);

        // Collateral released cleanly even while protocol is paused and asset is frozen!
        assertEq(escrow.getBalance(address(stockToken)), 0);
    }

    /**
     * @notice Invariant 5: Credit Conservation
     * Total claimable USDC created matches received debt payments.
     */
    function test_Invariant_CreditConservation() public {
        vm.prank(settlement);
        uint256 loanId = core.openLoan(borrower, lender, address(stockToken), 50e6, 5000e6, 800, 30, 6000, 3, 0);

        usdc.mint(borrower, 6000e6);
        vm.prank(borrower);
        usdc.approve(address(core), type(uint256).max);

        vm.prank(borrower);
        core.repay(loanId);

        uint128 claimableBalance = core.getClaimable(lender);
        assertGt(claimableBalance, 5000e6); // Principal + net interest

        // Lender can pull claim in full
        vm.prank(lender);
        uint128 claimed = core.claim(lender);
        assertEq(claimed, claimableBalance);
        assertEq(core.getClaimable(lender), 0);
    }
}
