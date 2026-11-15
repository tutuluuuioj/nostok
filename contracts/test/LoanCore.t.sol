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
import {ILoanCore} from "../src/interfaces/ILoanCore.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockSequencer} from "./mocks/MockSequencer.sol";

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
        "ExtendOrder(uint256 loanId,uint64 newMaturity,uint32 newRateBps,uint256 nonce)"
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

        // 1. Reverts if rate exceeds 40% cap (4000 bps)
        vm.prank(borrower);
        vm.expectRevert(LoanCore.InvalidLoanTerms.selector);
        core.extend(1, newMaturity, 4500, "");

        // 2. Reverts if extension term > 90 days from now
        vm.prank(borrower);
        vm.expectRevert(LoanCore.InvalidLoanTerms.selector);
        core.extend(1, uint64(block.timestamp + 95 days), newRateBps, "");

        // 3. Reverts if unauthorized third party calls
        address attacker = address(0x9999);
        vm.prank(attacker);
        vm.expectRevert(LoanCore.UnauthorizedCaller.selector);
        core.extend(1, newMaturity, newRateBps, "");

        // 4. Lender signs EIP-712 approval for extension
        bytes32 structHash = keccak256(
            abi.encode(EXTEND_ORDER_TYPEHASH, 1, newMaturity, newRateBps, 0)
        );
        bytes32 digest = _hashTypedData(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lenderPrivateKey, digest);
        bytes memory lenderSig = abi.encodePacked(r, s, v);

        // 5. Borrower submits with wrong signature reverts
        (uint8 badV, bytes32 badR, bytes32 badS) = vm.sign(borrowerPrivateKey, digest);
        bytes memory badSig = abi.encodePacked(badR, badS, badV);
        vm.prank(borrower);
        vm.expectRevert(LoanCore.InvalidSignature.selector);
        core.extend(1, newMaturity, newRateBps, badSig);

        // 6. Borrower submits with valid lender signature -> extends successfully!
        vm.prank(borrower);
        core.extend(1, newMaturity, newRateBps, lenderSig);

        ILoanCore.Loan memory updatedLoan = core.getLoan(1);
        assertEq(updatedLoan.maturity, newMaturity);
        assertEq(updatedLoan.rateBps, newRateBps);
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
}
