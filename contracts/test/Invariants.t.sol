// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
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

/**
 * @title ProtocolHandler
 * @notice State machine handler for Foundry invariant fuzzing.
 */
contract ProtocolHandler is CommonBase, StdCheats, StdUtils {
    LoanCore public core;
    CollateralEscrow public escrow;
    PositionNFT public nft;
    LiquidationAuction public auction;
    MockAggregator public feed;
    MockERC20 public stockToken;
    MockERC20 public usdc;

    address public settlement;
    address public borrower1;
    address public borrower2;
    address public lender;
    address public keeper;
    address public liquidator;

    uint256[] public activeLoanIds;
    uint256 public ghost_totalEscrowedCollateral;
    uint256 public ghost_totalOutstandingPrincipal;

    constructor(
        LoanCore _core,
        CollateralEscrow _escrow,
        PositionNFT _nft,
        LiquidationAuction _auction,
        MockAggregator _feed,
        MockERC20 _stockToken,
        MockERC20 _usdc,
        address _settlement,
        address _borrower1,
        address _borrower2,
        address _lender,
        address _keeper,
        address _liquidator
    ) {
        core = _core;
        escrow = _escrow;
        nft = _nft;
        auction = _auction;
        feed = _feed;
        stockToken = _stockToken;
        usdc = _usdc;
        settlement = _settlement;
        borrower1 = _borrower1;
        borrower2 = _borrower2;
        lender = _lender;
        keeper = _keeper;
        liquidator = _liquidator;
    }

    function openLoan(uint256 collateralSeed, uint256 principalSeed, bool useBorrower2) external {
        // Limit active loans to 10 concurrently
        if (activeLoanIds.length >= 10) return;

        address activeBorrower = useBorrower2 ? borrower2 : borrower1;
        // Bounded collateral between 10 NVDAc and 50 NVDAc ($2,000 to $10,000 at $200/share)
        uint128 collateralAmount = uint128(bound(collateralSeed, 10e6, 50e6));
        // Safe max borrow at 50% LTV: collateral * 100
        uint128 maxPrincipal = uint128((uint256(collateralAmount) * 100));
        uint128 principal = uint128(bound(principalSeed, 500e6, maxPrincipal));

        stockToken.mint(activeBorrower, collateralAmount);
        vm.prank(activeBorrower);
        stockToken.approve(address(escrow), collateralAmount);

        usdc.mint(lender, principal);
        vm.prank(lender);
        usdc.approve(address(core), principal);

        vm.prank(settlement);
        uint256 loanId = core.openLoan(
            activeBorrower,
            lender,
            address(stockToken),
            collateralAmount,
            principal,
            800,
            30,
            6000,
            3,
            0
        );

        activeLoanIds.push(loanId);
        ghost_totalEscrowedCollateral += collateralAmount;
        ghost_totalOutstandingPrincipal += principal;
    }

    function topUp(uint256 loanIndexSeed, uint256 additionalCollateralSeed) external {
        if (activeLoanIds.length == 0) return;

        uint256 idx = loanIndexSeed % activeLoanIds.length;
        uint256 loanId = activeLoanIds[idx];

        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active) && l.status != uint8(ILoanCore.LoanStatus.Grace)) return;

        uint128 additional = uint128(bound(additionalCollateralSeed, 1e6, 10e6));

        stockToken.mint(l.borrower, additional);
        vm.prank(l.borrower);
        stockToken.approve(address(escrow), additional);

        vm.prank(l.borrower);
        core.topUp(loanId, additional);

        ghost_totalEscrowedCollateral += additional;
    }

    function partialRepay(uint256 loanIndexSeed, uint256 repayAmountSeed) external {
        if (activeLoanIds.length == 0) return;

        uint256 idx = loanIndexSeed % activeLoanIds.length;
        uint256 loanId = activeLoanIds[idx];

        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active)) return;
        uint128 remaining = l.principal - l.principalRepaid;
        if (remaining <= 200e6) return;

        uint128 repayAmount = uint128(bound(repayAmountSeed, 50e6, remaining / 2));
        uint128 collateralToRelease = uint128(
            (uint256(l.collateralRaw) * repayAmount) / remaining
        );

        usdc.mint(l.borrower, repayAmount * 2);
        vm.prank(l.borrower);
        usdc.approve(address(core), repayAmount * 2);

        vm.prank(l.borrower);
        core.partialRepay(loanId, repayAmount);

        ghost_totalEscrowedCollateral -= collateralToRelease;
        ghost_totalOutstandingPrincipal -= repayAmount;
    }

    function repay(uint256 loanIndexSeed) external {
        if (activeLoanIds.length == 0) return;

        uint256 idx = loanIndexSeed % activeLoanIds.length;
        uint256 loanId = activeLoanIds[idx];

        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (
            l.status != uint8(ILoanCore.LoanStatus.Active) &&
            l.status != uint8(ILoanCore.LoanStatus.Grace) &&
            l.status != uint8(ILoanCore.LoanStatus.Auction)
        ) return;

        uint128 remaining = l.principal - l.principalRepaid;
        uint128 interest = core.getDueInterest(loanId);
        uint128 totalDue = remaining + interest;

        usdc.mint(l.borrower, totalDue);
        vm.prank(l.borrower);
        usdc.approve(address(core), totalDue);

        vm.prank(l.borrower);
        core.repay(loanId);

        ghost_totalEscrowedCollateral -= l.collateralRaw;
        ghost_totalOutstandingPrincipal -= remaining;

        activeLoanIds[idx] = activeLoanIds[activeLoanIds.length - 1];
        activeLoanIds.pop();
    }

    function startLiquidationAuction(uint256 loanIndexSeed) external {
        if (activeLoanIds.length == 0) return;

        uint256 idx = loanIndexSeed % activeLoanIds.length;
        uint256 loanId = activeLoanIds[idx];

        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active) && l.status != uint8(ILoanCore.LoanStatus.Grace)) return;

        // Drop price so position breaches liquidation LTV
        feed.setPrice(120e8);
        feed.setUpdatedAt(block.timestamp);

        vm.prank(keeper);
        core.startLiquidation(loanId);
    }

    function buyAuction(uint256 loanIndexSeed, uint256 buyAmountSeed, bool buyFull) external {
        if (activeLoanIds.length == 0) return;

        uint256 idx = loanIndexSeed % activeLoanIds.length;
        uint256 loanId = activeLoanIds[idx];

        uint256 auctionId = core.loanActiveAuction(loanId);
        if (auctionId == 0) return;

        ILiquidationAuction.Auction memory a = auction.getAuction(auctionId);
        if (a.status != ILiquidationAuction.AuctionStatus.Active || a.collateralRemaining == 0) return;

        // If auction expired (> 30 mins), restart it
        if (block.timestamp > a.startTime + a.duration) {
            feed.setUpdatedAt(block.timestamp);
            auction.restartOrCancelAuction(auctionId);
            a = auction.getAuction(auctionId);
            if (a.status != ILiquidationAuction.AuctionStatus.Active || a.collateralRemaining == 0) return;
        }

        uint128 collateralToBuy;
        if (buyFull) {
            collateralToBuy = a.collateralRemaining;
        } else {
            if (a.collateralRemaining <= 10e6) {
                collateralToBuy = a.collateralRemaining;
            } else {
                collateralToBuy = uint128(bound(buyAmountSeed, 10e6, a.collateralRemaining));
            }
        }

        ILoanCore.Loan memory l_before = core.getLoan(loanId);

        usdc.mint(liquidator, 50_000e6);
        vm.prank(liquidator);
        usdc.approve(address(auction), type(uint256).max);

        vm.prank(liquidator);
        auction.buy(auctionId, collateralToBuy, type(uint128).max);

        ILoanCore.Loan memory l_after = core.getLoan(loanId);

        uint128 principalPaid = l_after.principalRepaid - l_before.principalRepaid;
        uint128 collateralSold = l_before.collateralRaw - l_after.collateralRaw;

        if (l_after.status >= uint8(ILoanCore.LoanStatus.SettledDefault)) {
            // Loan completely settled (either fully repaid or bad debt)
            uint128 shortfall = l_after.principal - l_after.principalRepaid;
            ghost_totalOutstandingPrincipal -= (principalPaid + shortfall);
            ghost_totalEscrowedCollateral -= l_before.collateralRaw;

            activeLoanIds[idx] = activeLoanIds[activeLoanIds.length - 1];
            activeLoanIds.pop();
        } else {
            // Multi-buy or partial liquidation return to active
            ghost_totalEscrowedCollateral -= collateralSold;
            ghost_totalOutstandingPrincipal -= principalPaid;
        }
    }

    function activeLoansCount() external view returns (uint256) {
        return activeLoanIds.length;
    }
}

/**
 * @title InvariantsTest
 * @notice Foundry stateful invariant testing verifying mathematical guarantees under fuzzed call trees.
 */
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

    ProtocolHandler public handler;

    address public owner = address(0x1111);
    address public guardian = address(0x2222);
    address public treasury = address(0x3333);
    address public reserve = address(0x4444);
    address public settlement = address(0x5555);

    address public borrower = address(0xAAAA);
    address public borrower2 = address(0xCCCC);
    address public lender = address(0xBBBB);
    address public keeper = address(0xDDDD);
    address public liquidator = address(0xEEEE);

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
            perLoanCap: 250_000e6,
            assetCap: 250_000e6,
            maxStaleOpenSecs: 86400,
            status: uint8(IAssetRegistry.AssetStatus.Active),
            restricted: false
        });
        registry.setAssetConfig(address(stockToken), cfg);
        vm.stopPrank();

        // Instantiate handler
        handler = new ProtocolHandler(
            core,
            escrow,
            nft,
            auction,
            feed,
            stockToken,
            usdc,
            settlement,
            borrower,
            borrower2,
            lender,
            keeper,
            liquidator
        );

        // Target handler for stateful fuzzing
        targetContract(address(handler));
    }

    /**
     * @notice Invariant 1: Escrow Solvency
     * Physical collateral in escrow must ALWAYS exactly match ghost tracked active collateral.
     */
    function invariant_EscrowSolvency() public view {
        assertEq(
            escrow.getBalance(address(stockToken)),
            handler.ghost_totalEscrowedCollateral(),
            "Escrow tracked balance mismatch"
        );
        assertEq(
            stockToken.balanceOf(address(escrow)),
            handler.ghost_totalEscrowedCollateral(),
            "Physical token balance mismatch"
        );
    }

    /**
     * @notice Invariant 2: Total Outstanding Principal
     * LoanCore totalOutstandingPrincipal must ALWAYS exactly match ghost tracked outstanding principal.
     */
    function invariant_OutstandingPrincipal() public view {
        assertEq(
            core.totalOutstandingPrincipal(),
            handler.ghost_totalOutstandingPrincipal(),
            "Total outstanding principal mismatch"
        );
    }

    /**
     * @notice Invariant 3: Per-asset Outstanding Principal
     * Asset outstanding principal must match total outstanding principal when single asset.
     */
    function invariant_AssetOutstandingPrincipal() public view {
        assertEq(
            core.assetOutstandingPrincipal(address(stockToken)),
            handler.ghost_totalOutstandingPrincipal(),
            "Asset outstanding principal mismatch"
        );
    }
}
