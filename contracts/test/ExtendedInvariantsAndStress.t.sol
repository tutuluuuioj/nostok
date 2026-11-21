// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {LoanCore} from "../src/LoanCore.sol";
import {OrderSettlement} from "../src/OrderSettlement.sol";
import {CollateralEscrow} from "../src/CollateralEscrow.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {EligibilityGate} from "../src/EligibilityGate.sol";
import {LiquidationAuction} from "../src/LiquidationAuction.sol";
import {ILoanCore} from "../src/interfaces/ILoanCore.sol";
import {IOrderSettlement} from "../src/interfaces/IOrderSettlement.sol";
import {IAssetRegistry} from "../src/interfaces/IAssetRegistry.sol";
import {ILiquidationAuction} from "../src/interfaces/ILiquidationAuction.sol";
import {IOracleRouter} from "../src/interfaces/IOracleRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockSequencer} from "./mocks/MockSequencer.sol";
import {EchidnaHarness} from "./echidna/EchidnaHarness.sol";

/**
 * @notice Adversarial ERC-20 callback token used to verify nonReentrant protections on
 *         CollateralEscrow, LoanCore, and LiquidationAuction during flash/reentrancy drills.
 */
contract ReentrantMockERC20 is ERC20 {
    uint8 private _dec;
    uint256 public uiMultiplier;
    address public reenterTarget;
    bytes public reenterCalldata;
    bool public armed;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(string memory n, string memory s, uint8 dec) ERC20(n, s) {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function setUiMultiplier(uint256 mult) external {
        uiMultiplier = mult;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function armReentry(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterCalldata = data;
        armed = true;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from != address(0) && to != address(0)) {
            armed = false;
            reentryAttempted = true;
            (bool ok, ) = reenterTarget.call(reenterCalldata);
            reentrySucceeded = ok;
        }
    }
}

/**
 * @title ExtendedProtocolHandler
 * @notice Multi-asset (8-dec + 18-dec), multi-actor stateful fuzz handler driving the complete
 *         OrderSettlement -> EligibilityGate -> LoanCore -> CollateralEscrow -> LiquidationAuction -> FeeCollector -> OracleRouter stack.
 */
contract ExtendedProtocolHandler is CommonBase, StdCheats, StdUtils {
    LoanCore public core;
    OrderSettlement public settlement;
    CollateralEscrow public escrow;
    PositionNFT public nft;
    LiquidationAuction public auction;
    AssetRegistry public registry;
    OracleRouter public router;
    FeeCollector public feeCollector;
    EligibilityGate public gate;

    MockERC20 public stock8;
    MockERC20 public stock18;
    MockERC20 public usdc;
    MockAggregator public feed8;
    MockAggregator public feed18;
    MockSequencer public sequencer;

    address public owner;
    address public guardian;
    address public treasury;
    address public safetyReserve;

    uint256 public borrower1Pk;
    address public borrower1;
    uint256 public borrower2Pk;
    address public borrower2;
    uint256 public lender1Pk;
    address public lender1;
    uint256 public lender2Pk;
    address public lender2;
    uint256 public attSignerPk;
    address public keeper;
    address public liquidator;

    uint256[] public loanIds;
    mapping(address => uint256) public ghostEscrowByToken;
    uint256 public ghostFeesDistributed;
    uint256 public ghostGateNonceFloor;
    uint256 public ghostOrderNonceFloor;
    bool public handlerViolation;

    bytes32 private constant BORROW_ORDER_TYPEHASH = keccak256(
        "BorrowOrder(address borrower,address collateralToken,uint128 collateralAmount,uint128 minUsdc,uint32 maxRateBps,uint16 termDays,uint16 maxLtvBps,uint128 minFill,uint64 expiry,uint256 nonce,uint8 yieldMode,bool allowInKindSettlement)"
    );
    bytes32 private constant EXTEND_ORDER_TYPEHASH = keccak256(
        "ExtendOrder(uint256 loanId,uint64 newMaturity,uint32 newRateBps,uint256 nonce,uint64 deadline)"
    );

    constructor(
        LoanCore _core,
        OrderSettlement _settlement,
        CollateralEscrow _escrow,
        PositionNFT _nft,
        LiquidationAuction _auction,
        AssetRegistry _registry,
        OracleRouter _router,
        FeeCollector _feeCollector,
        EligibilityGate _gate,
        MockERC20 _stock8,
        MockERC20 _stock18,
        MockERC20 _usdc,
        MockAggregator _feed8,
        MockAggregator _feed18,
        MockSequencer _sequencer,
        address _owner,
        address _guardian,
        address _treasury,
        address _safetyReserve,
        uint256 _borrower1Pk,
        uint256 _borrower2Pk,
        uint256 _lender1Pk,
        uint256 _lender2Pk,
        uint256 _attSignerPk,
        address _keeper,
        address _liquidator
    ) {
        core = _core;
        settlement = _settlement;
        escrow = _escrow;
        nft = _nft;
        auction = _auction;
        registry = _registry;
        router = _router;
        feeCollector = _feeCollector;
        gate = _gate;
        stock8 = _stock8;
        stock18 = _stock18;
        usdc = _usdc;
        feed8 = _feed8;
        feed18 = _feed18;
        sequencer = _sequencer;
        owner = _owner;
        guardian = _guardian;
        treasury = _treasury;
        safetyReserve = _safetyReserve;
        borrower1Pk = _borrower1Pk;
        borrower1 = vm.addr(_borrower1Pk);
        borrower2Pk = _borrower2Pk;
        borrower2 = vm.addr(_borrower2Pk);
        lender1Pk = _lender1Pk;
        lender1 = vm.addr(_lender1Pk);
        lender2Pk = _lender2Pk;
        lender2 = vm.addr(_lender2Pk);
        attSignerPk = _attSignerPk;
        keeper = _keeper;
        liquidator = _liquidator;
    }

    function _attestation(address account, uint256 expiry) internal view returns (bytes memory) {
        uint256 n = gate.userNonce(account);
        bytes32 digest = gate.getAttestationDigest(account, n, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attSignerPk, digest);
        return abi.encode(expiry, abi.encodePacked(r, s, v));
    }

    function _signSettlementOrder(uint256 pk, IOrderSettlement.BorrowOrder memory o) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("NOSTOK Order Settlement")),
                keccak256(bytes("1")),
                block.chainid,
                address(settlement)
            )
        );
        bytes32 sh = keccak256(
            abi.encode(
                BORROW_ORDER_TYPEHASH,
                o.borrower,
                o.collateralToken,
                o.collateralAmount,
                o.minUsdc,
                o.maxRateBps,
                o.termDays,
                o.maxLtvBps,
                o.minFill,
                o.expiry,
                o.nonce,
                o.yieldMode,
                o.allowInKindSettlement
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signLoanExtend(
        uint256 pk,
        uint256 loanId,
        uint64 newMaturity,
        uint32 newRateBps,
        uint256 nonce,
        uint64 deadline
    ) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("NOSTOK Loan Core")),
                keccak256(bytes("1")),
                block.chainid,
                address(core)
            )
        );
        bytes32 sh = keccak256(
            abi.encode(EXTEND_ORDER_TYPEHASH, loanId, newMaturity, newRateBps, nonce, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function openLoanViaSettlement(
        uint256 colSeed,
        uint256 prinSeed,
        bool useAsset18,
        bool useBorrower2,
        bool useLender2
    ) external {
        if (loanIds.length >= 12) return;
        if (core.paused()) return;

        MockERC20 tok = useAsset18 ? stock18 : stock8;
        MockAggregator feed = useAsset18 ? feed18 : feed8;
        uint256 bPk = useBorrower2 ? borrower2Pk : borrower1Pk;
        address b = useBorrower2 ? borrower2 : borrower1;
        address lnd = useLender2 ? lender2 : lender1;

        feed.setUpdatedAt(block.timestamp);
        if (!sequencerValidAndOpen(address(tok))) return;

        uint128 colAmt = useAsset18
            ? uint128(bound(colSeed, 10e18, 40e18))
            : uint128(bound(colSeed, 10e8, 40e8));

        (, uint256 effVal, ) = router.getValue(address(tok), colAmt);
        uint128 maxPrin = uint128((effVal * 6000) / 10000);
        if (maxPrin < 500e6) return;
        if (maxPrin > 50_000e6) maxPrin = 50_000e6;
        uint128 principal = uint128(bound(prinSeed, 500e6, maxPrin));

        if (core.assetOutstandingPrincipal(address(tok)) + principal > registry.getAssetConfig(address(tok)).assetCap) return;
        if (core.totalOutstandingPrincipal() + principal > core.globalUsdcCap()) return;

        uint64 expiry = uint64(block.timestamp + 1 days);
        IOrderSettlement.BorrowOrder memory order = IOrderSettlement.BorrowOrder({
            borrower: b,
            collateralToken: address(tok),
            collateralAmount: colAmt,
            minUsdc: principal,
            maxRateBps: 900,
            termDays: 30,
            maxLtvBps: 6000,
            minFill: 500e6,
            expiry: expiry,
            nonce: settlement.getMakerNonce(b),
            yieldMode: 0,
            allowInKindSettlement: false
        });

        bytes memory orderSig = _signSettlementOrder(bPk, order);
        bytes memory bAtt = _attestation(b, expiry);
        bytes memory lAtt = _attestation(lnd, expiry);

        tok.mint(b, colAmt);
        vm.prank(b);
        tok.approve(address(escrow), colAmt);
        usdc.mint(lnd, principal);
        vm.prank(lnd);
        usdc.approve(address(core), principal);

        uint128 origFee = feeCollector.calculateOriginationFee(principal);
        vm.prank(lnd);
        uint256 loanId = settlement.fillBorrowOrderWithAttestations(order, orderSig, principal, bAtt, lAtt);
        loanIds.push(loanId);
        ghostEscrowByToken[address(tok)] += colAmt;
        ghostFeesDistributed += origFee;
    }

    function sequencerValidAndOpen(address tok) internal view returns (bool) {
        if (registry.getAssetConfig(tok).status != uint8(IAssetRegistry.AssetStatus.Active)) return false;
        (, , IOracleRouter.OracleState st) = router.getPrice(tok);
        return st == IOracleRouter.OracleState.VALID_OPEN || st == IOracleRouter.OracleState.VALID_CLOSED;
    }

    function topUp(uint256 idxSeed, uint256 extraSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active) && l.status != uint8(ILoanCore.LoanStatus.Grace)) return;

        uint128 extra = l.collateralToken == address(stock18)
            ? uint128(bound(extraSeed, 1, 5e18))
            : uint128(bound(extraSeed, 1, 5e8));
        MockERC20(l.collateralToken).mint(l.borrower, extra);
        vm.prank(l.borrower);
        MockERC20(l.collateralToken).approve(address(escrow), extra);
        vm.prank(l.borrower);
        core.topUp(loanId, extra);
        ghostEscrowByToken[l.collateralToken] += extra;
    }

    function partialRepay(uint256 idxSeed, uint256 amtSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active)) return;
        uint128 rem = l.principal - l.principalRepaid;
        if (rem <= 200e6) return;

        uint128 repayPrin = uint128(bound(amtSeed, 50e6, rem / 2));
        uint128 colBefore = l.collateralRaw;
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);

        usdc.mint(l.borrower, repayPrin * 2);
        vm.prank(l.borrower);
        usdc.approve(address(core), repayPrin * 2);
        vm.prank(l.borrower);
        core.partialRepay(loanId, repayPrin);

        uint128 colAfter = core.getLoan(loanId).collateralRaw;
        ghostEscrowByToken[l.collateralToken] -= (colBefore - colAfter);
        ghostFeesDistributed += (usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore;
    }

    function extendLoan(uint256 idxSeed, uint256 extraDaysSeed, uint256 newRateSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active) || block.timestamp > l.maturity) return;

        uint64 maxMat = l.startTime + 90 days;
        if (l.maturity + 1 days > maxMat) return;
        uint64 newMat = uint64(bound(extraDaysSeed, l.maturity + 1 days, maxMat));
        uint32 newRate = uint32(bound(newRateSeed, 100, 4000));
        uint64 deadline = uint64(block.timestamp + 1 hours);
        address holder = nft.ownerOf(loanId);
        uint256 holderPk = holder == lender2 ? lender2Pk : lender1Pk;
        if (vm.addr(holderPk) != holder) return;

        bytes memory sig = _signLoanExtend(holderPk, loanId, newMat, newRate, core.loanExtensionNonce(loanId), deadline);
        vm.prank(l.borrower);
        core.extend(loanId, newMat, newRate, deadline, sig);
    }

    function repay(uint256 idxSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status > uint8(ILoanCore.LoanStatus.Auction)) return;

        uint128 rem = l.principal - l.principalRepaid;
        uint128 due = core.getDueInterest(loanId);
        uint128 need = rem + due;
        uint128 colBefore = l.collateralRaw;
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);

        usdc.mint(l.borrower, need);
        vm.prank(l.borrower);
        usdc.approve(address(core), need);
        vm.prank(l.borrower);
        core.repay(loanId);

        ghostEscrowByToken[l.collateralToken] -= colBefore;
        ghostFeesDistributed += (usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore;
    }

    function advanceTime(uint256 secsSeed) external {
        uint256 step = bound(secsSeed, 60, 4 days);
        vm.warp(block.timestamp + step);
        feed8.setUpdatedAt(block.timestamp);
        feed18.setUpdatedAt(block.timestamp);
    }

    function changePrices(uint256 p8Seed, uint256 p18Seed) external {
        feed8.setPrice(int256(bound(p8Seed, 50e8, 300e8)));
        feed18.setPrice(int256(bound(p18Seed, 120e8, 700e8)));
    }

    function startLiquidation(uint256 idxSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active) && l.status != uint8(ILoanCore.LoanStatus.Grace)) return;

        MockAggregator feed = l.collateralToken == address(stock18) ? feed18 : feed8;
        feed.setUpdatedAt(block.timestamp);
        (, , IOracleRouter.OracleState st) = router.getPrice(l.collateralToken);
        if (st != IOracleRouter.OracleState.VALID_OPEN) return;

        (uint256 gross, , ) = router.getValue(l.collateralToken, l.collateralRaw);
        uint256 debt = uint256(l.principal - l.principalRepaid) + core.getDueInterest(loanId);
        if (gross == 0 || (debt * 10000) / gross < l.liqLtvBps) return;

        vm.prank(keeper);
        core.startLiquidation(loanId);
    }

    function startDefaultAuction(uint256 idxSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status != uint8(ILoanCore.LoanStatus.Active) && l.status != uint8(ILoanCore.LoanStatus.Grace)) return;
        if (block.timestamp <= l.maturity + core.GRACE_PERIOD_SECONDS()) return;

        MockAggregator feed = l.collateralToken == address(stock18) ? feed18 : feed8;
        feed.setUpdatedAt(block.timestamp);
        (, , IOracleRouter.OracleState st) = router.getPrice(l.collateralToken);
        if (st != IOracleRouter.OracleState.VALID_OPEN) return;

        vm.prank(keeper);
        core.startDefaultAuction(loanId);
    }

    function buyAuction(uint256 idxSeed, uint256 fracBpsSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        uint256 aucId = core.loanActiveAuction(loanId);
        if (aucId == 0) return;

        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);
        if (a.status != ILiquidationAuction.AuctionStatus.Active || a.collateralRemaining == 0) return;
        if (block.timestamp > a.startTime + a.duration && router.isMarketOpen()) return;

        uint256 bps = bound(fracBpsSeed, 2500, 10000);
        uint128 colAmt = uint128((uint256(a.collateralRemaining) * bps) / 10000);
        if (colAmt == 0) colAmt = a.collateralRemaining;

        uint256 price = auction.getCurrentPrice(aucId);
        uint8 dec = MockERC20(a.collateralToken).decimals();
        uint256 num = uint256(colAmt) * price * 1e6;
        uint256 den = (10 ** dec) * 1e8;
        uint256 needed = (num + den - 1) / den;
        if (needed < auction.MIN_BUY_USDC() && colAmt != a.collateralRemaining) {
            colAmt = a.collateralRemaining;
            num = uint256(colAmt) * price * 1e6;
            needed = (num + den - 1) / den;
        }

        uint128 colBefore = core.getLoan(loanId).collateralRaw;
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);

        usdc.mint(liquidator, needed);
        vm.prank(liquidator);
        usdc.approve(address(auction), needed);
        vm.prank(liquidator);
        auction.buy(aucId, colAmt, uint128(needed));

        uint128 colAfter = core.getLoan(loanId).collateralRaw;
        ghostEscrowByToken[a.collateralToken] -= (colBefore - colAfter);
        ghostFeesDistributed += (usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore;
    }

    function restartOrCancelAuction(uint256 idxSeed) external {
        if (loanIds.length == 0) return;
        uint256 loanId = loanIds[idxSeed % loanIds.length];
        uint256 aucId = core.loanActiveAuction(loanId);
        if (aucId == 0) return;
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);
        if (a.status != ILiquidationAuction.AuctionStatus.Active) return;
        if (block.timestamp < a.startTime + a.duration) return;

        MockAggregator feed = a.collateralToken == address(stock18) ? feed18 : feed8;
        feed.setUpdatedAt(block.timestamp);
        auction.restartOrCancelAuction(aucId);
    }

    function claimPayout(bool useLender2) external {
        address lnd = useLender2 ? lender2 : lender1;
        if (core.getClaimable(lnd) == 0) return;
        vm.prank(lnd);
        core.claim(lnd);
    }

    function togglePauseAndNonces(bool pauseNext) external {
        vm.prank(guardian);
        core.setPaused(pauseNext);

        vm.prank(borrower1);
        uint256 nextG = gate.userNonce(borrower1);
        if (nextG < ghostGateNonceFloor) handlerViolation = true;
        vm.prank(borrower1);
        gate.bumpMyNonce();
        ghostGateNonceFloor = gate.userNonce(borrower1);

        vm.prank(borrower1);
        uint256 nextO = settlement.bumpNonce();
        if (nextO <= ghostOrderNonceFloor && ghostOrderNonceFloor > 0) handlerViolation = true;
        ghostOrderNonceFloor = nextO;
    }

    function loanCount() external view returns (uint256) {
        return loanIds.length;
    }
}

/**
 * @title ExtendedInvariantsTest
 * @notice WS4.2 8-invariant multi-asset stateful fuzz test suite.
 */
contract ExtendedInvariantsTest is Test {
    ExtendedProtocolHandler public handler;
    LoanCore public core;
    OrderSettlement public settlement;
    CollateralEscrow public escrow;
    PositionNFT public nft;
    LiquidationAuction public auction;
    AssetRegistry public registry;
    OracleRouter public router;
    FeeCollector public feeCollector;
    EligibilityGate public gate;

    MockERC20 public stock8;
    MockERC20 public stock18;
    MockERC20 public usdc;
    MockAggregator public feed8;
    MockAggregator public feed18;
    MockSequencer public sequencer;

    address public owner = address(0x1111);
    address public guardian = address(0x2222);
    address public treasury = address(0x3333);
    address public safetyReserve = address(0x4444);

    uint256 internal constant B1_PK = 0xB1;
    uint256 internal constant B2_PK = 0xB2;
    uint256 internal constant L1_PK = 0xD1;
    uint256 internal constant L2_PK = 0xD2;
    uint256 internal constant ATT_PK = 0xA77;
    address public keeper = address(0xEEE1);
    address public liquidator = address(0xEEE2);

    function setUp() public {
        vm.warp(1_795_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        stock8 = new MockERC20("NVIDIA B20", "NVDAc", 8);
        stock18 = new MockERC20("META B20", "METAc", 18);
        stock8.setUiMultiplier(1e18);
        stock18.setUiMultiplier(1e18);

        feed8 = new MockAggregator(8, 200e8);
        feed18 = new MockAggregator(8, 500e8);
        sequencer = new MockSequencer(0);

        vm.startPrank(owner);
        gate = new EligibilityGate(owner, vm.addr(ATT_PK), false);
        escrow = new CollateralEscrow(owner);
        nft = new PositionNFT(owner, address(gate));

        registry = AssetRegistry(address(new ERC1967Proxy(address(new AssetRegistry()), "")));
        registry.initialize(owner, guardian);

        router = OracleRouter(address(new ERC1967Proxy(address(new OracleRouter()), "")));
        router.initialize(owner, address(registry), address(sequencer));
        router.setMarketSession(true, true);
        registry.setOracleRouter(address(router));

        feeCollector = FeeCollector(address(new ERC1967Proxy(address(new FeeCollector()), "")));
        feeCollector.initialize(owner, treasury, safetyReserve);

        core = LoanCore(address(new ERC1967Proxy(address(new LoanCore()), "")));
        auction = LiquidationAuction(address(new ERC1967Proxy(address(new LiquidationAuction()), "")));
        settlement = OrderSettlement(address(new ERC1967Proxy(address(new OrderSettlement()), "")));

        core.initialize(owner, guardian, address(escrow), address(nft), address(registry), address(router), address(feeCollector), address(auction), address(usdc));
        core.setOrderSettlement(address(settlement));
        auction.initialize(owner, address(escrow), address(core), address(feeCollector), address(usdc));
        settlement.initialize(owner, address(core), address(gate));

        escrow.setAuthorizedCore(address(core), true);
        escrow.setAuthorizedCore(address(auction), true);
        nft.setAuthorizedCore(address(core), true);

        registry.setAssetConfig(
            address(stock8),
            IAssetRegistry.AssetConfig({
                feed: address(feed8),
                feedDecimals: 8,
                tier: 0,
                maxInitLtvBps: 6000,
                marginCallLtvBps: 7000,
                liqLtvBps: 7800,
                badDebtLtvBps: 9000,
                maxDiscountBps: 600,
                closedMarketHaircutBps: 500,
                perLoanCap: 50_000e6,
                assetCap: 100_000e6,
                maxStaleOpenSecs: 86400,
                status: uint8(IAssetRegistry.AssetStatus.Active),
                restricted: false
            })
        );
        registry.setAssetConfig(
            address(stock18),
            IAssetRegistry.AssetConfig({
                feed: address(feed18),
                feedDecimals: 8,
                tier: 0,
                maxInitLtvBps: 6000,
                marginCallLtvBps: 7000,
                liqLtvBps: 7800,
                badDebtLtvBps: 9000,
                maxDiscountBps: 600,
                closedMarketHaircutBps: 500,
                perLoanCap: 50_000e6,
                assetCap: 100_000e6,
                maxStaleOpenSecs: 86400,
                status: uint8(IAssetRegistry.AssetStatus.Active),
                restricted: false
            })
        );
        vm.stopPrank();

        handler = new ExtendedProtocolHandler(
            core,
            settlement,
            escrow,
            nft,
            auction,
            registry,
            router,
            feeCollector,
            gate,
            stock8,
            stock18,
            usdc,
            feed8,
            feed18,
            sequencer,
            owner,
            guardian,
            treasury,
            safetyReserve,
            B1_PK,
            B2_PK,
            L1_PK,
            L2_PK,
            ATT_PK,
            keeper,
            liquidator
        );
        targetContract(address(handler));
    }

    function invariant_1_MultiAssetEscrowSolvency() public view {
        assertEq(escrow.getBalance(address(stock8)), handler.ghostEscrowByToken(address(stock8)));
        assertEq(stock8.balanceOf(address(escrow)), handler.ghostEscrowByToken(address(stock8)));
        assertEq(escrow.getBalance(address(stock18)), handler.ghostEscrowByToken(address(stock18)));
        assertEq(stock18.balanceOf(address(escrow)), handler.ghostEscrowByToken(address(stock18)));

        uint256 sum8;
        uint256 sum18;
        uint256 count = handler.loanCount();
        for (uint256 i = 0; i < count; i++) {
            ILoanCore.Loan memory l = core.getLoan(handler.loanIds(i));
            if (l.collateralToken == address(stock8)) sum8 += l.collateralRaw;
            else if (l.collateralToken == address(stock18)) sum18 += l.collateralRaw;
        }
        assertEq(sum8, handler.ghostEscrowByToken(address(stock8)));
        assertEq(sum18, handler.ghostEscrowByToken(address(stock18)));
    }

    function invariant_2_GlobalPrincipalAccountingAndCap() public view {
        uint256 openPrincipal;
        uint256 count = handler.loanCount();
        for (uint256 i = 0; i < count; i++) {
            ILoanCore.Loan memory l = core.getLoan(handler.loanIds(i));
            if (l.status <= uint8(ILoanCore.LoanStatus.Auction)) {
                openPrincipal += (l.principal - l.principalRepaid);
            }
        }
        assertEq(core.totalOutstandingPrincipal(), openPrincipal);
        assertLe(core.totalOutstandingPrincipal(), core.globalUsdcCap());
    }

    function invariant_3_PerAssetPrincipalAccountingAndCaps() public view {
        uint256 p8;
        uint256 p18;
        uint256 count = handler.loanCount();
        for (uint256 i = 0; i < count; i++) {
            ILoanCore.Loan memory l = core.getLoan(handler.loanIds(i));
            if (l.status <= uint8(ILoanCore.LoanStatus.Auction)) {
                if (l.collateralToken == address(stock8)) p8 += (l.principal - l.principalRepaid);
                else if (l.collateralToken == address(stock18)) p18 += (l.principal - l.principalRepaid);
            }
        }
        assertEq(core.assetOutstandingPrincipal(address(stock8)), p8);
        assertEq(core.assetOutstandingPrincipal(address(stock18)), p18);
        assertEq(p8 + p18, core.totalOutstandingPrincipal());
        assertLe(p8, registry.getAssetConfig(address(stock8)).assetCap);
        assertLe(p18, registry.getAssetConfig(address(stock18)).assetCap);
    }

    function invariant_4_CoreAndAuctionUsdcSolvency() public view {
        uint256 claimSum =
            core.getClaimable(handler.borrower1()) +
            core.getClaimable(handler.borrower2()) +
            core.getClaimable(handler.lender1()) +
            core.getClaimable(handler.lender2()) +
            core.getClaimable(keeper) +
            core.getClaimable(liquidator);
        assertGe(usdc.balanceOf(address(core)), claimSum);
        assertEq(usdc.balanceOf(address(auction)), 0);
    }

    function invariant_5_PositionNftAndAuctionLockParity() public view {
        uint256 count = handler.loanCount();
        for (uint256 i = 0; i < count; i++) {
            uint256 id = handler.loanIds(i);
            ILoanCore.Loan memory l = core.getLoan(id);
            if (l.status <= uint8(ILoanCore.LoanStatus.Auction)) {
                assertTrue(nft.ownerOf(id) != address(0));
                bool inAuc = l.status == uint8(ILoanCore.LoanStatus.Auction);
                assertEq(nft.isAuctionLocked(id), inAuc);
                assertEq(core.loanActiveAuction(id) != 0, inAuc);
            } else {
                assertEq(l.collateralRaw, 0);
                assertEq(core.loanActiveAuction(id), 0);
                assertFalse(nft.isAuctionLocked(id));
            }
        }
    }

    function invariant_6_FeeCollectorCapsAndConservation() public view {
        assertLe(feeCollector.originationFeeBps(), feeCollector.MAX_ORIGINATION_BPS());
        assertLe(feeCollector.interestCutBps(), feeCollector.MAX_INTEREST_CUT_BPS());
        assertLe(feeCollector.liquidationFeeBps(), feeCollector.MAX_LIQUIDATION_BPS());
        assertEq(usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve), handler.ghostFeesDistributed());
    }

    function invariant_7_EligibilityAndOrderNonceMonotonicity() public view {
        assertFalse(handler.handlerViolation());
        assertFalse(gate.permissionlessMode());
        assertGe(gate.userNonce(handler.borrower1()), handler.ghostGateNonceFloor());
        assertGe(settlement.getMakerNonce(handler.borrower1()), handler.ghostOrderNonceFloor());
    }

    function invariant_8_OracleMultipliersPreserved() public view {
        assertGt(router.recordedMultiplier(address(stock8)), 0);
        assertGt(router.recordedMultiplier(address(stock18)), 0);
    }
}

/**
 * @title SecurityBoundaryStressTest
 * @notice WS4.2 stress suite verifying 1-wei rounding, dust auto-close, exact timestamp/grace/cooldown
 *         boundaries, flash-loan/reentrancy safety, exact sequencer downtime grace resumption,
 *         and direct EchidnaHarness property assertions inside `forge test`.
 */
contract SecurityBoundaryStressTest is Test {
    LoanCore public core;
    CollateralEscrow public escrow;
    PositionNFT public nft;
    LiquidationAuction public auction;
    AssetRegistry public registry;
    OracleRouter public router;
    FeeCollector public feeCollector;
    EligibilityGate public gate;

    ReentrantMockERC20 public stock;
    MockERC20 public usdc;
    MockAggregator public feed;
    MockSequencer public sequencer;

    address public owner = address(0x1111);
    address public guardian = address(0x2222);
    address public treasury = address(0x3333);
    address public reserve = address(0x4444);
    address public settlement = address(0x5555);
    address public borrower = address(0xBEE1);
    address public lender = address(0xFEE1);
    address public keeper = address(0xCAFE);
    address public liquidator = address(0xDEAD);

    function setUp() public {
        // Tuesday, 15:00 UTC (regular US equity market open)
        vm.warp(1_795_100_400);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        stock = new ReentrantMockERC20("NVIDIA B20", "NVDAc", 8);
        stock.setUiMultiplier(1e18);
        feed = new MockAggregator(8, 200e8);
        sequencer = new MockSequencer(0);

        vm.startPrank(owner);
        gate = new EligibilityGate(owner, owner, true);
        escrow = new CollateralEscrow(owner);
        nft = new PositionNFT(owner, address(gate));
        registry = AssetRegistry(address(new ERC1967Proxy(address(new AssetRegistry()), "")));
        registry.initialize(owner, guardian);
        router = OracleRouter(address(new ERC1967Proxy(address(new OracleRouter()), "")));
        router.initialize(owner, address(registry), address(sequencer));
        router.setMarketSession(true, true);
        registry.setOracleRouter(address(router));
        feeCollector = FeeCollector(address(new ERC1967Proxy(address(new FeeCollector()), "")));
        feeCollector.initialize(owner, treasury, reserve);

        core = LoanCore(address(new ERC1967Proxy(address(new LoanCore()), "")));
        auction = LiquidationAuction(address(new ERC1967Proxy(address(new LiquidationAuction()), "")));
        core.initialize(owner, guardian, address(escrow), address(nft), address(registry), address(router), address(feeCollector), address(auction), address(usdc));
        core.setOrderSettlement(settlement);
        auction.initialize(owner, address(escrow), address(core), address(feeCollector), address(usdc));

        escrow.setAuthorizedCore(address(core), true);
        escrow.setAuthorizedCore(address(auction), true);
        nft.setAuthorizedCore(address(core), true);

        registry.setAssetConfig(
            address(stock),
            IAssetRegistry.AssetConfig({
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
                maxStaleOpenSecs: 21600,
                status: uint8(IAssetRegistry.AssetStatus.Active),
                restricted: false
            })
        );
        vm.stopPrank();
    }

    function _openSimpleLoan(uint128 colAmt, uint128 principal, uint16 termDays) internal returns (uint256 loanId) {
        feed.setUpdatedAt(block.timestamp);
        stock.mint(borrower, colAmt);
        vm.prank(borrower);
        stock.approve(address(escrow), colAmt);
        usdc.mint(lender, principal);
        vm.prank(lender);
        usdc.approve(address(core), principal);
        vm.prank(settlement);
        loanId = core.openLoan(borrower, lender, address(stock), colAmt, principal, 800, termDays, 6000, 3, 0);
    }

    /// @notice WS4.2: 1-wei topUp, odd-wei partialRepay remainder precision, MIN_BUY_USDC boundary, and dust auto-close.
    function test_WS42_OneWeiRoundingAndDustBoundaries() public {
        // Odd collateral 10_00000001 (8 dec) against 1,000 USDC principal
        uint256 loanId = _openSimpleLoan(10_00000001, 1_000e6, 30);

        // 1-wei topUp succeeds cleanly and leaves exact sum in escrow
        stock.mint(borrower, 1);
        vm.prank(borrower);
        stock.approve(address(escrow), 1);
        vm.prank(borrower);
        core.topUp(loanId, 1);
        assertEq(core.getLoan(loanId).collateralRaw, 10_00000002);
        assertEq(escrow.getBalance(address(stock)), 10_00000002);

        // Partial repay 1_000000 wei (1 USDC) of 1,000e6: truncates collateral released without losing 1 wei
        uint128 dueBefore = core.getDueInterest(loanId);
        usdc.mint(borrower, 1e6 + dueBefore);
        vm.prank(borrower);
        usdc.approve(address(core), 1e6 + dueBefore);
        uint256 bBalBefore = stock.balanceOf(borrower);
        vm.prank(borrower);
        core.partialRepay(loanId, 1e6);
        uint256 bReleased = stock.balanceOf(borrower) - bBalBefore;
        assertEq(core.getLoan(loanId).collateralRaw + bReleased, 10_00000002);
        assertEq(escrow.getBalance(address(stock)), core.getLoan(loanId).collateralRaw);

        // Drop price to $120 -> partial liquidation (50% of 10.00000002 = ~4.95e8 -> ~$594 @ $120)
        feed.setPrice(120e8);
        vm.prank(keeper);
        uint256 aucId = core.startLiquidation(loanId);
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);

        // Buy just under MIN_BUY_USDC ($10) on partial slice reverts BuyAmountTooSmall
        uint128 smallCol = 8_000000; // ~0.08 NVDAc * ~$118.80 = ~$9.50 < $10
        usdc.mint(liquidator, 20e6);
        vm.prank(liquidator);
        usdc.approve(address(auction), 20e6);
        vm.prank(liquidator);
        vm.expectRevert(LiquidationAuction.BuyAmountTooSmall.selector);
        auction.buy(aucId, smallCol, 20e6);

        // Buying such that < $10 remains auto-closes the auction and returns exact dust to borrower!
        uint128 buyNearAll = a.collateralRemaining - 5_000000; // leaves 0.05 shares (~$5.94 < $10)
        uint256 bDustBefore = stock.balanceOf(borrower);
        usdc.mint(liquidator, 1_000e6);
        vm.prank(liquidator);
        usdc.approve(address(auction), 1_000e6);
        vm.prank(liquidator);
        auction.buy(aucId, buyNearAll, 1_000e6);

        assertEq(uint8(auction.getAuction(aucId).status), uint8(ILiquidationAuction.AuctionStatus.Settled));
        assertEq(auction.getAuction(aucId).collateralRemaining, 0);
        assertEq(stock.balanceOf(borrower) - bDustBefore, 5_000000);
        assertEq(escrow.getBalance(address(stock)), core.getLoan(loanId).collateralRaw);
    }

    /// @notice WS4.2: Exact boundary transitions across maturity, 24h grace, default trigger,
    ///         auction duration expiry, emergencyCancelAuction 1h cooldown, and stale restart limit.
    function test_WS42_TimestampGraceAndCooldownBoundaries() public {
        // Use valid 1800s (30m) open staleness threshold so STALE_FEED can also occur inside the 1h cooldown window
        vm.prank(owner);
        registry.setAssetConfig(
            address(stock),
            IAssetRegistry.AssetConfig({
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
                maxStaleOpenSecs: 1800,
                status: uint8(IAssetRegistry.AssetStatus.Active),
                restricted: false
            })
        );

        uint256 loanId = _openSimpleLoan(10e8, 1_000e6, 7);
        ILoanCore.Loan memory l = core.getLoan(loanId);
        uint256 mat = l.maturity;

        // At exact maturity: stays Active; at maturity + 1: transitions to Grace
        vm.warp(mat);
        assertEq(uint8(core.syncStatus(loanId)), uint8(ILoanCore.LoanStatus.Active));
        vm.warp(mat + 1);
        assertEq(uint8(core.syncStatus(loanId)), uint8(ILoanCore.LoanStatus.Grace));

        // At exact maturity + 24h: startDefaultAuction still reverts LoanNotInGrace (`<=`); +1s succeeds!
        vm.warp(mat + 24 hours);
        feed.setUpdatedAt(mat + 24 hours);
        vm.prank(keeper);
        vm.expectRevert(LoanCore.LoanNotInGrace.selector);
        core.startDefaultAuction(loanId);

        uint256 tDef = mat + 24 hours + 1;
        vm.warp(tDef);
        feed.setUpdatedAt(tDef);
        vm.prank(keeper);
        uint256 auc1 = core.startDefaultAuction(loanId);
        ILiquidationAuction.Auction memory a = auction.getAuction(auc1);

        // Auction reverts AuctionExpired at startTime + duration + 1 during valid open market
        uint256 tExp = uint256(a.startTime) + a.duration + 1;
        vm.warp(tExp);
        feed.setUpdatedAt(tExp);
        usdc.mint(liquidator, 1_000e6);
        vm.prank(liquidator);
        usdc.approve(address(auction), 1_000e6);
        vm.prank(liquidator);
        vm.expectRevert(LiquidationAuction.AuctionExpired.selector);
        auction.buy(auc1, 1e8, 1_000e6);

        // Healthy oracle cannot emergencyCancelAuction; stale oracle (1801s > 1800s) unlocks it + starts 1h cooldown
        vm.prank(guardian);
        vm.expectRevert(LiquidationAuction.OracleNotStaleOrFrozen.selector);
        auction.emergencyCancelAuction(auc1);

        uint256 cancelAt = tExp + 1801;
        vm.warp(cancelAt);
        vm.prank(guardian);
        auction.emergencyCancelAuction(auc1);

        // Re-start default auction with fresh feed, advance inside 1h cooldown (1801..3599) so feed is STALE_FEED AND cooldown reverts!
        feed.setUpdatedAt(cancelAt);
        vm.prank(keeper);
        uint256 auc2 = core.startDefaultAuction(loanId);

        uint256 tCooldownEndMinus1 = cancelAt + 3599; // 3599 > 1800 (STALE_FEED) and < 3600 (cooldown active)
        vm.warp(tCooldownEndMinus1);
        vm.prank(guardian);
        vm.expectRevert(LiquidationAuction.EmergencyCancelCooldownActive.selector);
        auction.emergencyCancelAuction(auc2);

        uint256 tCooldownEnd = cancelAt + 3600;
        vm.warp(tCooldownEnd);
        vm.prank(guardian);
        auction.emergencyCancelAuction(auc2);

        // Stale restart cap check: maxFeedAge = 2 * 1800 = 3600s; at updatedAt + 3601 restartOrCancelAuction must no-op!
        feed.setUpdatedAt(tCooldownEnd);
        vm.prank(keeper);
        uint256 auc3 = core.startDefaultAuction(loanId);
        uint64 s3 = auction.getAuction(auc3).startTime;
        vm.warp(tCooldownEnd + 3601);
        auction.restartOrCancelAuction(auc3);
        assertEq(auction.getAuction(auc3).startTime, s3, "Past maxFeedAge must not restart");
    }

    /// @notice WS4.2: Flash-loan single-block lifecycle + malicious ERC-20 transfer callback reentrancy blocked.
    function test_WS42_FlashLoanAtomicCycleAndCallbackReentrancy() public {
        // Attempt ERC-20 callback reentry into LoanCore.repay while Escrow releases collateral
        uint256 loanId = _openSimpleLoan(10e8, 1_000e6, 30);
        uint128 due = core.getDueInterest(loanId);
        uint128 need = 1_000e6 + due;

        usdc.mint(borrower, need * 2);
        vm.prank(borrower);
        usdc.approve(address(core), need * 2);

        stock.armReentry(address(core), abi.encodeCall(LoanCore.repay, (loanId)));
        vm.prank(borrower);
        core.repay(loanId);

        assertTrue(stock.reentryAttempted(), "Callback reentrancy attempt must have fired");
        assertFalse(stock.reentrySucceeded(), "ReentrancyGuard on Escrow/LoanCore must block reentry");
        assertEq(escrow.getBalance(address(stock)), 0);

        // Claim single-block flash payout
        vm.prank(lender);
        uint128 claimed = core.claim(lender);
        assertEq(core.getClaimable(lender), 0);
        assertGt(claimed, 1_000e6);
    }

    /// @notice WS4.2: Sequencer downtime blocks openLoan & startLiquidation, allows repay/topUp,
    ///         and resumes cleanly once elapsed == sequencerGracePeriod (3600s).
    function test_WS42_SequencerDowntimeAndExactGraceResumption() public {
        uint256 tRec = 1_795_100_400;
        uint256 loanId = _openSimpleLoan(10e8, 1_000e6, 30);
        feed.setPrice(100e8); // 11 * $100 = $1,100 => ~91% LTV after 1e8 topUp (>= 78% liq threshold)

        // Sequencer goes DOWN
        sequencer.setStatus(1, tRec);
        (, , IOracleRouter.OracleState sDown) = router.getPrice(address(stock));
        assertEq(uint8(sDown), uint8(IOracleRouter.OracleState.INVALID_SEQUENCER));

        // openLoan and startLiquidation revert OracleInvalidForAction
        stock.mint(borrower, 10e8);
        vm.prank(borrower);
        stock.approve(address(escrow), 10e8);
        usdc.mint(lender, 1_000e6);
        vm.prank(lender);
        usdc.approve(address(core), 1_000e6);
        vm.prank(settlement);
        vm.expectRevert(LoanCore.OracleInvalidForAction.selector);
        core.openLoan(borrower, lender, address(stock), 10e8, 1_000e6, 800, 30, 6000, 3, 0);

        vm.prank(keeper);
        vm.expectRevert(LoanCore.OracleInvalidForAction.selector);
        core.startLiquidation(loanId);

        // topUp still works during sequencer outage
        stock.mint(borrower, 1e8);
        vm.prank(borrower);
        stock.approve(address(escrow), 1e8);
        vm.prank(borrower);
        core.topUp(loanId, 1e8);
        assertEq(core.getLoan(loanId).collateralRaw, 11e8);

        // Sequencer recovers at tRec; at tRec + 3599 still INVALID_SEQUENCER; at tRec + 3600 resumes VALID_OPEN!
        sequencer.setStatus(0, tRec);
        vm.warp(tRec + 3599);
        feed.setUpdatedAt(tRec + 3599);
        (, , IOracleRouter.OracleState sGrace) = router.getPrice(address(stock));
        assertEq(uint8(sGrace), uint8(IOracleRouter.OracleState.INVALID_SEQUENCER));

        vm.warp(tRec + 3600);
        feed.setUpdatedAt(tRec + 3600);
        (, , IOracleRouter.OracleState sResumed) = router.getPrice(address(stock));
        assertEq(uint8(sResumed), uint8(IOracleRouter.OracleState.VALID_OPEN));

        vm.prank(keeper);
        uint256 aucId = core.startLiquidation(loanId);
        assertGt(aucId, 0);
    }

    /// @notice WS4.2: Drives EchidnaHarness directly under Foundry to guarantee all 8 echidna_* properties pass & compile.
    function test_WS42_EchidnaHarnessAll8PropertiesPass() public {
        EchidnaHarness eh = new EchidnaHarness();
        eh.actionOpenLoan(5e8, 2_000e6, false, false);
        eh.actionOpenLoan(4e18, 3_000e6, true, true);
        eh.actionTopUp(0, 1e8);
        eh.actionSetPriceAndLiquidate(0, 80e8);
        eh.actionBuyAuction(0, 5000);
        eh.actionBumpNonce();
        eh.actionClaimLender();

        assertTrue(eh.echidna_escrow_solvency(), "echidna_escrow_solvency failed");
        assertTrue(eh.echidna_global_principal_cap(), "echidna_global_principal_cap failed");
        assertTrue(eh.echidna_per_asset_caps(), "echidna_per_asset_caps failed");
        assertTrue(eh.echidna_usdc_solvency(), "echidna_usdc_solvency failed");
        assertTrue(eh.echidna_nft_and_lock_parity(), "echidna_nft_and_lock_parity failed");
        assertTrue(eh.echidna_fee_caps_and_conservation(), "echidna_fee_caps_and_conservation failed");
        assertTrue(eh.echidna_nonce_monotonicity(), "echidna_nonce_monotonicity failed");
        assertTrue(eh.echidna_oracle_baseline_preserved(), "echidna_oracle_baseline_preserved failed");
    }
}
