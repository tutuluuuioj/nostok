// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {console2} from "forge-std/console2.sol";
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
 *         Enforces independent fee formulas, orthogonal over-cap revert probes, strict +1 nonce checks,
 *         NFT transfer claimant entitlement, borrower surplus, pause/freeze unstoppable liquidity,
 *         and high-frequency auction / liquidation / default / restart coverage.
 */
contract ExtendedProtocolHandler is CommonBase, StdCheats, StdUtils {
    // Orthogonal caps so PerLoanCapExceeded, AssetCapExceeded, and GlobalCapExceeded are independently isolated
    uint128 public constant PER_LOAN_CAP = 50_000e6;
    uint128 public constant ASSET_CAP = 60_000e6;
    uint128 public constant GLOBAL_CAP = 80_000e6;

    // Independent expected fee bps (never copied from FeeCollector calculation outputs)
    uint16 public constant EXPECTED_ORIG_BPS = 10;       // 0.10%
    uint16 public constant EXPECTED_INT_CUT_BPS = 1000;  // 10.00%
    uint16 public constant EXPECTED_LIQ_BPS = 100;       // 1.00%
    uint16 public constant EXPECTED_KEEPER_BPS = 3000;   // 30.00% of liquidation fee

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
    uint256[] public openLoanIds;
    mapping(address => uint256) public ghostEscrowByToken;
    uint256 public ghostExpectedFees;
    mapping(address => uint256) public ghostExpectedGateNonce;
    mapping(address => uint256) public ghostExpectedOrderNonce;

    // Explicit violation latches mapped to roadmap invariants & mutation checks
    bool public escrowIsolationViolated;
    bool public unstoppableViolated;
    bool public auctionConditionViolated;
    bool public surplusViolated;
    bool public capOrFeeViolated;
    bool public nonceViolated;
    bool public creditViolated;
    bool public entitlementViolated;

    // Per-action success counters
    uint256 public cntOpenLoan;
    uint256 public cntTopUp;
    uint256 public cntPartialRepay;
    uint256 public cntExtend;
    uint256 public cntRepay;
    uint256 public cntStartLiquidation;
    uint256 public cntStartDefaultAuction;
    uint256 public cntBuyAuction;
    uint256 public cntRestartAuction;
    uint256 public cntCancelRecoveredAuction;
    uint256 public cntClaim;
    uint256 public cntNftTransfer;
    uint256 public cntSurplusRefund;
    uint256 public cntOverCapPerLoanReverted;
    uint256 public cntOverCapAssetReverted;
    uint256 public cntOverCapGlobalReverted;
    uint256 public cntGateNonceBumped;
    uint256 public cntOrderNonceBumped;
    uint256 public cntEscrowIsolationProbed;
    uint256 public cntUnstoppableVerified;
    uint64 private _orderExpirySalt;

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

    // ---------------- Independent Fee & Helper Math ----------------

    function _expectedOrigFee(uint128 principal) internal pure returns (uint128) {
        if (principal == 0 || EXPECTED_ORIG_BPS == 0) return 0;
        return uint128((uint256(principal) * EXPECTED_ORIG_BPS + 9999) / 10000);
    }

    function _expectedIntCut(uint128 interest) internal pure returns (uint128) {
        if (interest == 0 || EXPECTED_INT_CUT_BPS == 0) return 0;
        return uint128((uint256(interest) * EXPECTED_INT_CUT_BPS + 9999) / 10000);
    }

    function _expectedLiqFee(uint128 usdcPaid) internal pure returns (uint128 protocolFee, uint128 keeperReward) {
        if (usdcPaid == 0 || EXPECTED_LIQ_BPS == 0) return (0, 0);
        uint128 total = uint128((uint256(usdcPaid) * EXPECTED_LIQ_BPS + 9999) / 10000);
        keeperReward = uint128((uint256(total) * EXPECTED_KEEPER_BPS) / 10000);
        protocolFee = total - keeperReward;
    }

    function _safeColForPrincipal(uint128 principal, uint256 price8, uint256 colUnit, uint256 extraSeed) internal pure returns (uint128) {
        uint256 minRaw = (uint256(principal) * 220 * colUnit) / price8 + colUnit;
        uint256 extra = (extraSeed % 12) * colUnit;
        return uint128(minRaw + extra);
    }

    function _removeOpenLoan(uint256 loanId) internal {
        uint256 len = openLoanIds.length;
        for (uint256 i = 0; i < len; i++) {
            if (openLoanIds[i] == loanId) {
                openLoanIds[i] = openLoanIds[len - 1];
                openLoanIds.pop();
                return;
            }
        }
    }

    function _findOpenLoan(uint256 idxSeed, bool wantAuction) internal view returns (bool found, uint256 loanId) {
        uint256 len = openLoanIds.length;
        if (len == 0) return (false, 0);
        uint256 start = idxSeed % len;
        for (uint256 i = 0; i < len; i++) {
            uint256 id = openLoanIds[(start + i) % len];
            uint8 st = core.getLoan(id).status;
            if (wantAuction) {
                if (st == uint8(ILoanCore.LoanStatus.Auction) && core.loanActiveAuction(id) != 0) {
                    return (true, id);
                }
            } else {
                if (st == uint8(ILoanCore.LoanStatus.Active) || st == uint8(ILoanCore.LoanStatus.Grace)) {
                    return (true, id);
                }
            }
        }
        return (false, 0);
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

    // ---------------- Fuzz Actions ----------------

    function openLoanViaSettlement(
        uint256 colSeed,
        uint256 prinSeed,
        bool useAsset18,
        bool useBorrower2,
        bool useLender2
    ) external {
        if (openLoanIds.length >= 12) return;
        if (core.paused()) return;

        MockERC20 tok = useAsset18 ? stock18 : stock8;
        MockAggregator feed = useAsset18 ? feed18 : feed8;
        uint256 colUnit = useAsset18 ? 1e18 : 1e8;
        uint256 bPk = useBorrower2 ? borrower2Pk : borrower1Pk;
        address b = useBorrower2 ? borrower2 : borrower1;
        address lnd = useLender2 ? lender2 : lender1;

        feed.setUpdatedAt(block.timestamp);
        (uint256 px, , IOracleRouter.OracleState st) = router.getPrice(address(tok));
        if (st != IOracleRouter.OracleState.VALID_OPEN && st != IOracleRouter.OracleState.VALID_CLOSED) return;
        if (px < 10e8) {
            px = useAsset18 ? 500e8 : 200e8;
            feed.setPrice(int256(px));
        }

        uint256 remGlobal = GLOBAL_CAP > core.totalOutstandingPrincipal()
            ? GLOBAL_CAP - core.totalOutstandingPrincipal()
            : 0;
        uint256 remAsset = ASSET_CAP > core.assetOutstandingPrincipal(address(tok))
            ? ASSET_CAP - core.assetOutstandingPrincipal(address(tok))
            : 0;
        uint256 maxAllowed = remGlobal < remAsset ? remGlobal : remAsset;
        if (maxAllowed > PER_LOAN_CAP) maxAllowed = PER_LOAN_CAP;
        if (maxAllowed < 500e6) return;

        uint128 principal = uint128(bound(prinSeed, 500e6, maxAllowed));
        uint128 colAmt = _safeColForPrincipal(principal, px, colUnit, colSeed);

        uint64 expiry = uint64(block.timestamp + 1 days + (++_orderExpirySalt));
        IOrderSettlement.BorrowOrder memory order = IOrderSettlement.BorrowOrder({
            borrower: b,
            collateralToken: address(tok),
            collateralAmount: colAmt,
            minUsdc: principal,
            maxRateBps: 900,
            termDays: 7,
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

        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);
        uint256 bUsdcBefore = usdc.balanceOf(b);
        uint128 expOrigFee = _expectedOrigFee(principal);

        vm.prank(lnd);
        uint256 loanId = settlement.fillBorrowOrderWithAttestations(order, orderSig, principal, bAtt, lAtt);
        loanIds.push(loanId);
        openLoanIds.push(loanId);
        ghostEscrowByToken[address(tok)] += colAmt;

        // Independent origination fee check (kills 2x fee mutation immediately)
        uint256 actualFee = (usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore;
        uint256 actualProceeds = usdc.balanceOf(b) - bUsdcBefore;
        if (actualFee != expOrigFee || actualProceeds != principal - expOrigFee) {
            capOrFeeViolated = true;
        }
        ghostExpectedFees += expOrigFee;
        cntOpenLoan++;
    }

    /// @notice Probes PerLoanCapExceeded, AssetCapExceeded, and GlobalCapExceeded independently via real OrderSettlement orders.
    function attemptOverCapLoans(bool useAsset18) external {
        if (core.paused()) return;
        MockERC20 tok = useAsset18 ? stock18 : stock8;
        MockAggregator feed = useAsset18 ? feed18 : feed8;
        uint256 colUnit = useAsset18 ? 1e18 : 1e8;

        feed.setUpdatedAt(block.timestamp);
        (uint256 px, , IOracleRouter.OracleState st) = router.getPrice(address(tok));
        if (st != IOracleRouter.OracleState.VALID_OPEN && st != IOracleRouter.OracleState.VALID_CLOSED) return;
        if (px < 10e8) return;

        uint256 totalOut = core.totalOutstandingPrincipal();
        uint256 assetOut = core.assetOutstandingPrincipal(address(tok));

        // 1. Pure PerLoanCapExceeded (exceeds PER_LOAN_CAP while <= ASSET_CAP and <= GLOBAL_CAP)
        uint128 overPerLoan = PER_LOAN_CAP + 500e6;
        if (totalOut + overPerLoan <= GLOBAL_CAP && assetOut + overPerLoan <= ASSET_CAP) {
            _probeOverCapOrder(tok, colUnit, px, overPerLoan, LoanCore.PerLoanCapExceeded.selector, 0);
        }

        // 2. Pure AssetCapExceeded (<= PER_LOAN_CAP and total+prin <= GLOBAL_CAP, ONLY exceeds ASSET_CAP)
        if (ASSET_CAP > assetOut) {
            uint256 candAsset = (ASSET_CAP - assetOut) + 500e6;
            if (candAsset <= PER_LOAN_CAP && totalOut + candAsset <= GLOBAL_CAP) {
                _probeOverCapOrder(tok, colUnit, px, uint128(candAsset), LoanCore.AssetCapExceeded.selector, 1);
            }
        }

        // 3. Pure GlobalCapExceeded (<= PER_LOAN_CAP and asset+prin <= ASSET_CAP, ONLY exceeds GLOBAL_CAP)
        if (GLOBAL_CAP > totalOut) {
            uint256 candGlobal = (GLOBAL_CAP - totalOut) + 500e6;
            if (candGlobal <= PER_LOAN_CAP && assetOut + candGlobal <= ASSET_CAP) {
                _probeOverCapOrder(tok, colUnit, px, uint128(candGlobal), LoanCore.GlobalCapExceeded.selector, 2);
            }
        }
    }

    function _probeOverCapOrder(
        MockERC20 tok,
        uint256 colUnit,
        uint256 px,
        uint128 principal,
        bytes4 expectedSel,
        uint8 capKind
    ) internal {
        uint128 colAmt = _safeColForPrincipal(principal, px, colUnit, 0);
        uint64 expiry = uint64(block.timestamp + 1 days + (++_orderExpirySalt));
        IOrderSettlement.BorrowOrder memory order = IOrderSettlement.BorrowOrder({
            borrower: borrower1,
            collateralToken: address(tok),
            collateralAmount: colAmt,
            minUsdc: principal,
            maxRateBps: 900,
            termDays: 7,
            maxLtvBps: 6000,
            minFill: 500e6,
            expiry: expiry,
            nonce: settlement.getMakerNonce(borrower1),
            yieldMode: 0,
            allowInKindSettlement: false
        });
        bytes memory sig = _signSettlementOrder(borrower1Pk, order);
        bytes memory bAtt = _attestation(borrower1, expiry);
        bytes memory lAtt = _attestation(lender1, expiry);

        tok.mint(borrower1, colAmt);
        vm.prank(borrower1);
        tok.approve(address(escrow), colAmt);
        usdc.mint(lender1, principal);
        vm.prank(lender1);
        usdc.approve(address(core), principal);

        vm.prank(lender1);
        try settlement.fillBorrowOrderWithAttestations(order, sig, principal, bAtt, lAtt) {
            capOrFeeViolated = true;
        } catch (bytes memory err) {
            if (err.length < 4 || bytes4(err) != expectedSel) {
                capOrFeeViolated = true;
            } else if (capKind == 0) {
                cntOverCapPerLoanReverted++;
            } else if (capKind == 1) {
                cntOverCapAssetReverted++;
            } else {
                cntOverCapGlobalReverted++;
            }
        }
    }

    function topUp(uint256 idxSeed, uint256 extraSeed) external {
        (bool found, uint256 loanId) = _findOpenLoan(idxSeed, false);
        if (!found) return;
        ILoanCore.Loan memory l = core.getLoan(loanId);

        uint128 extra = l.collateralToken == address(stock18)
            ? uint128(bound(extraSeed, 1, 5e18))
            : uint128(bound(extraSeed, 1, 5e8));
        MockERC20(l.collateralToken).mint(l.borrower, extra);
        vm.prank(l.borrower);
        MockERC20(l.collateralToken).approve(address(escrow), extra);
        vm.prank(l.borrower);
        core.topUp(loanId, extra);
        ghostEscrowByToken[l.collateralToken] += extra;
        cntTopUp++;
    }

    function partialRepay(uint256 idxSeed, uint256 amtSeed) external {
        uint256 len = openLoanIds.length;
        if (len == 0) return;
        uint256 start = idxSeed % len;
        uint256 loanId = 0;
        for (uint256 i = 0; i < len; i++) {
            uint256 id = openLoanIds[(start + i) % len];
            ILoanCore.Loan memory cand = core.getLoan(id);
            if (
                cand.status == uint8(ILoanCore.LoanStatus.Active) &&
                block.timestamp <= cand.maturity &&
                (cand.principal - cand.principalRepaid) > 200e6
            ) {
                loanId = id;
                break;
            }
        }
        if (loanId == 0) return;

        ILoanCore.Loan memory l = core.getLoan(loanId);
        uint128 rem = l.principal - l.principalRepaid;
        uint128 repayPrin = uint128(bound(amtSeed, 50e6, rem / 2));

        address holder = nft.ownerOf(loanId);
        address otherLender = holder == lender2 ? lender1 : lender2;
        uint256 holderClaimBefore = core.getClaimable(holder);
        uint256 otherClaimBefore = core.getClaimable(otherLender);
        uint128 colBefore = l.collateralRaw;
        uint128 intPaidBefore = l.interestPaid;
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);

        usdc.mint(l.borrower, repayPrin * 2);
        vm.prank(l.borrower);
        usdc.approve(address(core), repayPrin * 2);
        vm.prank(l.borrower);
        core.partialRepay(loanId, repayPrin);

        ILoanCore.Loan memory lAfter = core.getLoan(loanId);
        uint128 intPaidDelta = lAfter.interestPaid - intPaidBefore;
        uint128 expCut = _expectedIntCut(intPaidDelta);

        if ((usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore != expCut) {
            capOrFeeViolated = true;
        }
        if (core.getClaimable(holder) - holderClaimBefore != uint256(repayPrin) + (intPaidDelta - expCut)) {
            entitlementViolated = true;
        }
        if (core.getClaimable(otherLender) != otherClaimBefore) entitlementViolated = true;

        ghostEscrowByToken[l.collateralToken] -= (colBefore - lAfter.collateralRaw);
        ghostExpectedFees += expCut;
        cntPartialRepay++;
    }

    function extendLoan(uint256 idxSeed, uint256 extraDaysSeed, uint256 newRateSeed) external {
        uint256 len = openLoanIds.length;
        if (len == 0) return;
        uint256 start = idxSeed % len;
        uint256 loanId = 0;
        for (uint256 i = 0; i < len; i++) {
            uint256 id = openLoanIds[(start + i) % len];
            ILoanCore.Loan memory cand = core.getLoan(id);
            if (
                cand.status == uint8(ILoanCore.LoanStatus.Active) &&
                block.timestamp <= cand.maturity &&
                cand.maturity + 1 days <= cand.startTime + 90 days
            ) {
                loanId = id;
                break;
            }
        }
        if (loanId == 0) return;

        ILoanCore.Loan memory l = core.getLoan(loanId);
        uint64 maxMat = l.startTime + 90 days;
        uint64 newMat = uint64(bound(extraDaysSeed, l.maturity + 1 days, maxMat));
        uint32 newRate = uint32(bound(newRateSeed, 100, 4000));
        uint64 deadline = uint64(block.timestamp + 1 hours);
        address holder = nft.ownerOf(loanId);
        uint256 holderPk = holder == lender2 ? lender2Pk : lender1Pk;
        if (vm.addr(holderPk) != holder) return;

        bytes memory sig = _signLoanExtend(holderPk, loanId, newMat, newRate, core.loanExtensionNonce(loanId), deadline);
        vm.prank(l.borrower);
        core.extend(loanId, newMat, newRate, deadline, sig);
        cntExtend++;
    }

    function transferNft(uint256 idxSeed) external {
        if (openLoanIds.length == 0) return;
        uint256 loanId = openLoanIds[idxSeed % openLoanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        address holder = nft.ownerOf(loanId);
        address dest = holder == lender2 ? lender1 : lender2;
        bytes memory destAtt = _attestation(dest, block.timestamp + 1 days);

        if (l.status == uint8(ILoanCore.LoanStatus.Auction)) {
            vm.prank(holder);
            try nft.transferWithAttestation(holder, dest, loanId, destAtt) {
                entitlementViolated = true;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != PositionNFT.AuctionTransferLocked.selector) {
                    entitlementViolated = true;
                }
            }
            return;
        }

        vm.prank(holder);
        nft.transferWithAttestation(holder, dest, loanId, destAtt);
        if (nft.ownerOf(loanId) != dest) entitlementViolated = true;
        cntNftTransfer++;
    }

    function repay(uint256 idxSeed) external {
        if (openLoanIds.length == 0) return;
        uint256 loanId = openLoanIds[idxSeed % openLoanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status > uint8(ILoanCore.LoanStatus.Auction)) return;

        address holder = nft.ownerOf(loanId);
        address otherLender = holder == lender2 ? lender1 : lender2;
        uint256 holderClaimBefore = core.getClaimable(holder);
        uint256 otherClaimBefore = core.getClaimable(otherLender);
        uint256 bColBefore = MockERC20(l.collateralToken).balanceOf(l.borrower);
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);

        uint128 rem = l.principal - l.principalRepaid;
        uint128 due = core.getDueInterest(loanId);
        uint128 need = rem + due;
        uint128 expCut = _expectedIntCut(due);
        uint128 colBefore = l.collateralRaw;

        usdc.mint(l.borrower, need);
        vm.prank(l.borrower);
        usdc.approve(address(core), need);
        vm.prank(l.borrower);
        core.repay(loanId);

        _removeOpenLoan(loanId);
        ghostEscrowByToken[l.collateralToken] -= colBefore;

        if ((usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore != expCut) {
            capOrFeeViolated = true;
        }
        ghostExpectedFees += expCut;

        if (core.getClaimable(holder) - holderClaimBefore != uint256(rem) + (due - expCut)) {
            entitlementViolated = true;
        }
        if (core.getClaimable(otherLender) != otherClaimBefore) entitlementViolated = true;
        if (MockERC20(l.collateralToken).balanceOf(l.borrower) - bColBefore != colBefore) {
            surplusViolated = true;
        }
        cntRepay++;
    }

    /// @notice Targets liquidatable LTV (83% partial or 92% full/surplus) after verifying healthy negative revert.
    function startLiquidation(uint256 idxSeed, bool wantFullClose) external {
        (bool found, uint256 loanId) = _findOpenLoan(idxSeed, false);
        if (!found) return;
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.collateralRaw < 2 && !wantFullClose) return;

        MockAggregator feed = l.collateralToken == address(stock18) ? feed18 : feed8;
        uint256 colUnit = l.collateralToken == address(stock18) ? 1e18 : 1e8;
        feed.setUpdatedAt(block.timestamp);
        uint256 debt = uint256(l.principal - l.principalRepaid) + core.getDueInterest(loanId);

        // Roadmap #4 negative check: healthy loan must revert LoanNotLiquidatable
        (uint256 grossBefore, , IOracleRouter.OracleState stBefore) = router.getValue(l.collateralToken, l.collateralRaw);
        if (stBefore == IOracleRouter.OracleState.VALID_OPEN && grossBefore > 0 && (debt * 10000) / grossBefore < l.liqLtvBps) {
            vm.prank(keeper);
            try core.startLiquidation(loanId) {
                auctionConditionViolated = true;
                return;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != LoanCore.LoanNotLiquidatable.selector) {
                    auctionConditionViolated = true;
                }
            }
        }

        uint256 targetLtv = wantFullClose ? 9200 : 8300;
        uint256 targetPrice8 = (debt * 10000 * colUnit * 100) / (uint256(l.collateralRaw) * targetLtv);
        if (targetPrice8 < 2e8) return;
        feed.setPrice(int256(targetPrice8));

        (uint256 grossAfter, , ) = router.getValue(l.collateralToken, l.collateralRaw);
        if (grossAfter == 0) return;
        if ((debt * 10000) / grossAfter < l.liqLtvBps) {
            targetPrice8 = (targetPrice8 * 97) / 100;
            if (targetPrice8 < 1e8) return;
            feed.setPrice(int256(targetPrice8));
        }

        vm.prank(keeper);
        core.startLiquidation(loanId);
        cntStartLiquidation++;
    }

    /// @notice Warps past maturity + 24h grace (after checking negative LoanNotInGrace) and launches default auction.
    function startDefaultAuction(uint256 idxSeed) external {
        (bool found, uint256 loanId) = _findOpenLoan(idxSeed, false);
        if (!found) return;
        ILoanCore.Loan memory l = core.getLoan(loanId);

        if (block.timestamp <= l.maturity + core.GRACE_PERIOD_SECONDS()) {
            vm.prank(keeper);
            try core.startDefaultAuction(loanId) {
                auctionConditionViolated = true;
                return;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != LoanCore.LoanNotInGrace.selector) {
                    auctionConditionViolated = true;
                }
            }
            vm.warp(uint256(l.maturity) + core.GRACE_PERIOD_SECONDS() + 1);
        }

        feed8.setUpdatedAt(block.timestamp);
        feed18.setUpdatedAt(block.timestamp);
        vm.prank(keeper);
        core.startDefaultAuction(loanId);
        cntStartDefaultAuction++;
    }

    /// @notice Buys active auction collateral (restarting if expired) and verifies independent fees, surplus & claimant entitlement.
    function buyAuction(uint256 idxSeed, uint256 fracBpsSeed) external {
        (bool found, uint256 loanId) = _findOpenLoan(idxSeed, true);
        if (!found) return;
        uint256 aucId = core.loanActiveAuction(loanId);
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);
        if (a.status != ILiquidationAuction.AuctionStatus.Active || a.collateralRemaining == 0) return;

        if (block.timestamp > a.startTime + a.duration && router.isMarketOpen()) {
            MockAggregator feed = a.collateralToken == address(stock18) ? feed18 : feed8;
            feed.setUpdatedAt(block.timestamp);
            uint64 prevStart = a.startTime;
            auction.restartOrCancelAuction(aucId);
            a = auction.getAuction(aucId);
            if (a.status == ILiquidationAuction.AuctionStatus.Cancelled) {
                cntCancelRecoveredAuction++;
                return;
            }
            if (a.startTime != prevStart) cntRestartAuction++;
            if (a.status != ILiquidationAuction.AuctionStatus.Active || a.collateralRemaining == 0) return;
        }

        uint256 bps = (fracBpsSeed % 2 == 0) ? 10000 : bound(fracBpsSeed, 3000, 10000);
        uint128 colAmt = uint128((uint256(a.collateralRemaining) * bps) / 10000);
        if (colAmt == 0) colAmt = a.collateralRemaining;

        uint256 price = auction.getCurrentPrice(aucId);
        uint256 colUnit = a.collateralToken == address(stock18) ? 1e18 : 1e8;
        uint256 den = colUnit * 1e8;
        uint256 num = uint256(colAmt) * price * 1e6;
        uint128 needed = uint128((num + den - 1) / den);
        if (needed < auction.MIN_BUY_USDC() && colAmt != a.collateralRemaining) {
            colAmt = a.collateralRemaining;
            num = uint256(colAmt) * price * 1e6;
            needed = uint128((num + den - 1) / den);
        }
        if (needed == 0) return;

        address holder = nft.ownerOf(loanId);
        address otherLender = holder == lender2 ? lender1 : lender2;
        uint256 holderClaimBefore = core.getClaimable(holder);
        uint256 otherClaimBefore = core.getClaimable(otherLender);
        uint256 bUsdcBefore = usdc.balanceOf(a.borrower);
        uint256 bColBefore = MockERC20(a.collateralToken).balanceOf(a.borrower);
        uint256 kUsdcBefore = usdc.balanceOf(a.keeper);
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);
        uint128 colBefore = core.getLoan(loanId).collateralRaw;
        uint128 dueIntBefore = core.getDueInterest(loanId);

        usdc.mint(liquidator, needed);
        vm.prank(liquidator);
        usdc.approve(address(auction), needed);
        vm.prank(liquidator);
        uint128 paid = auction.buy(aucId, colAmt, needed);

        (uint128 expLiqProt, uint128 expKeeper) = _expectedLiqFee(paid);
        uint128 netProceeds = paid - (expLiqProt + expKeeper);
        uint128 expIntPaid = netProceeds > dueIntBefore ? dueIntBefore : netProceeds;
        uint128 prinAvail = netProceeds - expIntPaid;
        uint128 expPrinPaid = prinAvail > a.debtPrincipalRemaining ? a.debtPrincipalRemaining : prinAvail;
        uint128 expSurplus = prinAvail - expPrinPaid;
        uint128 expIntCut = _expectedIntCut(expIntPaid);

        if (usdc.balanceOf(a.borrower) - bUsdcBefore != expSurplus) surplusViolated = true;
        if (expSurplus > 0) cntSurplusRefund++;

        if (usdc.balanceOf(a.keeper) - kUsdcBefore != expKeeper) capOrFeeViolated = true;
        if ((usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore != uint256(expLiqProt) + expIntCut) {
            capOrFeeViolated = true;
        }
        ghostExpectedFees += uint256(expLiqProt) + expIntCut;

        if (core.getClaimable(holder) - holderClaimBefore != uint256(expPrinPaid) + (expIntPaid - expIntCut)) {
            entitlementViolated = true;
        }
        if (core.getClaimable(otherLender) != otherClaimBefore) entitlementViolated = true;

        ILoanCore.Loan memory lAfter = core.getLoan(loanId);
        ghostEscrowByToken[a.collateralToken] -= (colBefore - lAfter.collateralRaw);
        if (lAfter.status > uint8(ILoanCore.LoanStatus.Auction)) {
            _removeOpenLoan(loanId);
            if (lAfter.principalRepaid >= lAfter.principal) {
                if (
                    lAfter.collateralRaw != 0 ||
                    MockERC20(a.collateralToken).balanceOf(a.borrower) - bColBefore != colBefore - colAmt
                ) {
                    surplusViolated = true;
                }
            }
        }
        cntBuyAuction++;
    }

    /// @notice Advances past 30m auction duration and exercises both restart and healthy-recovery cancel paths.
    function restartOrCancelAuction(uint256 idxSeed, bool recoverPrice) external {
        (bool found, uint256 loanId) = _findOpenLoan(idxSeed, true);
        if (!found) return;
        uint256 aucId = core.loanActiveAuction(loanId);
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);
        if (a.status != ILiquidationAuction.AuctionStatus.Active) return;

        if (block.timestamp < a.startTime + a.duration) {
            vm.warp(uint256(a.startTime) + a.duration + 1);
        }
        MockAggregator feed = a.collateralToken == address(stock18) ? feed18 : feed8;
        if (recoverPrice && !a.isDefaultAuction) {
            feed.setPrice(a.collateralToken == address(stock18) ? int256(600e8) : int256(260e8));
        }
        feed8.setUpdatedAt(block.timestamp);
        feed18.setUpdatedAt(block.timestamp);

        uint64 prevStart = a.startTime;
        auction.restartOrCancelAuction(aucId);
        ILiquidationAuction.Auction memory aAfter = auction.getAuction(aucId);
        if (aAfter.status == ILiquidationAuction.AuctionStatus.Cancelled) {
            cntCancelRecoveredAuction++;
        } else if (aAfter.startTime != prevStart) {
            cntRestartAuction++;
        }
    }

    function claimPayout(bool useLender2) external {
        address lnd = useLender2 ? lender2 : lender1;
        if (core.getClaimable(lnd) == 0) {
            lnd = useLender2 ? lender1 : lender2;
        }
        uint256 amt = core.getClaimable(lnd);
        if (amt == 0) return;
        uint256 beforeBal = usdc.balanceOf(lnd);
        vm.prank(lnd);
        core.claim(lnd);
        if (usdc.balanceOf(lnd) - beforeBal != amt || core.getClaimable(lnd) != 0) {
            creditViolated = true;
        }
        cntClaim++;
    }

    /// @notice Roadmap #2: Probes unauthorized CollateralEscrow withdrawals by NFT holder, borrower, and liquidator.
    function probeEscrowIsolation(uint256 idxSeed) external {
        address tok = (idxSeed % 2 == 0) ? address(stock8) : address(stock18);
        address[4] memory intruders = [lender1, lender2, borrower1, liquidator];
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(intruders[i]);
            try escrow.releaseCollateral(tok, intruders[i], 1) {
                escrowIsolationViolated = true;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != CollateralEscrow.UnauthorizedCaller.selector) {
                    escrowIsolationViolated = true;
                }
            }
        }
        cntEscrowIsolationProbed++;
    }

    /// @notice Roadmap #3: Verifies topUp, repay, and claim NEVER revert while LoanCore is paused or asset/oracle is frozen.
    function testPauseAndFreezeUnstoppable(uint256 idxSeed, uint8 modeSeed) external {
        (bool found, uint256 loanId) = _findOpenLoan(idxSeed, false);
        if (!found) return;
        ILoanCore.Loan memory l = core.getLoan(loanId);
        MockERC20 tok = MockERC20(l.collateralToken);
        address holder = nft.ownerOf(loanId);
        uint8 mode = modeSeed % 3;

        if (mode == 0) {
            vm.prank(guardian);
            core.setPaused(true);
        } else if (mode == 1) {
            vm.prank(guardian);
            registry.setAssetStatus(address(tok), IAssetRegistry.AssetStatus.Frozen);
        } else {
            tok.setUiMultiplier(2e18);
        }

        // Positive 1: topUp succeeds
        tok.mint(l.borrower, 1);
        vm.prank(l.borrower);
        tok.approve(address(escrow), 1);
        vm.prank(l.borrower);
        try core.topUp(loanId, 1) {
            ghostEscrowByToken[address(tok)] += 1;
            cntTopUp++;
        } catch {
            unstoppableViolated = true;
        }

        // Positive 2: repay succeeds
        ILoanCore.Loan memory lMid = core.getLoan(loanId);
        uint128 rem = lMid.principal - lMid.principalRepaid;
        uint128 due = core.getDueInterest(loanId);
        uint128 need = rem + due;
        uint128 expCut = _expectedIntCut(due);
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);
        uint256 holderClaimBefore = core.getClaimable(holder);
        usdc.mint(l.borrower, need);
        vm.prank(l.borrower);
        usdc.approve(address(core), need);
        vm.prank(l.borrower);
        try core.repay(loanId) {
            _removeOpenLoan(loanId);
            ghostEscrowByToken[address(tok)] -= lMid.collateralRaw;
            if ((usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore != expCut) {
                capOrFeeViolated = true;
            }
            ghostExpectedFees += expCut;
            if (core.getClaimable(holder) - holderClaimBefore != uint256(rem) + (due - expCut)) {
                entitlementViolated = true;
            }
            cntRepay++;
        } catch {
            unstoppableViolated = true;
        }

        // Positive 3: claim succeeds
        uint256 claimNow = core.getClaimable(holder);
        if (claimNow > 0) {
            uint256 balBefore = usdc.balanceOf(holder);
            vm.prank(holder);
            try core.claim(holder) {
                if (usdc.balanceOf(holder) - balBefore != claimNow || core.getClaimable(holder) != 0) {
                    creditViolated = true;
                }
                cntClaim++;
            } catch {
                unstoppableViolated = true;
            }
        }

        // Restore cleanly
        if (mode == 0) {
            vm.prank(guardian);
            core.setPaused(false);
        } else if (mode == 1) {
            vm.prank(owner);
            registry.setAssetStatus(address(tok), IAssetRegistry.AssetStatus.Active);
        } else {
            tok.setUiMultiplier(1e18);
        }
        cntUnstoppableVerified++;
    }

    /// @notice Strictly verifies gate.bumpMyNonce() and settlement.bumpNonce() increment by +1 and invalidate old proofs.
    function bumpNoncesStrict(bool useBorrower2) external {
        address b = useBorrower2 ? borrower2 : borrower1;
        uint256 bPk = useBorrower2 ? borrower2Pk : borrower1Pk;
        uint64 expiry = uint64(block.timestamp + 1 days);

        // 1. EligibilityGate strict +1 increment & immediate replay invalidation
        uint256 gBefore = gate.userNonce(b);
        bytes memory oldAtt = _attestation(b, expiry);
        if (!gate.isEligible(b, oldAtt)) nonceViolated = true;

        vm.prank(b);
        gate.bumpMyNonce();
        if (gate.userNonce(b) != gBefore + 1) nonceViolated = true;
        if (gate.isEligible(b, oldAtt)) nonceViolated = true;
        ghostExpectedGateNonce[b] += 1;
        cntGateNonceBumped++;

        // 2. OrderSettlement strict +1 increment & immediate old-nonce InvalidNonce revert
        uint256 oBefore = settlement.getMakerNonce(b);
        IOrderSettlement.BorrowOrder memory oldOrder = IOrderSettlement.BorrowOrder({
            borrower: b,
            collateralToken: address(stock8),
            collateralAmount: 10e8,
            minUsdc: 500e6,
            maxRateBps: 900,
            termDays: 7,
            maxLtvBps: 6000,
            minFill: 500e6,
            expiry: expiry,
            nonce: oBefore,
            yieldMode: 0,
            allowInKindSettlement: false
        });
        bytes memory oldOrderSig = _signSettlementOrder(bPk, oldOrder);

        vm.prank(b);
        uint256 retNonce = settlement.bumpNonce();
        if (retNonce != oBefore + 1 || settlement.getMakerNonce(b) != oBefore + 1) {
            nonceViolated = true;
        }
        ghostExpectedOrderNonce[b] += 1;

        bytes memory freshBAtt = _attestation(b, expiry);
        bytes memory freshLAtt = _attestation(lender1, expiry);
        vm.prank(lender1);
        try settlement.fillBorrowOrderWithAttestations(oldOrder, oldOrderSig, 500e6, freshBAtt, freshLAtt) {
            nonceViolated = true;
        } catch (bytes memory err) {
            if (err.length < 4 || bytes4(err) != OrderSettlement.InvalidNonce.selector) {
                nonceViolated = true;
            }
        }
        cntOrderNonceBumped++;
    }

    function loanCount() external view returns (uint256) {
        return loanIds.length;
    }

    function openLoanCount() external view returns (uint256) {
        return openLoanIds.length;
    }
}

/**
 * @title ExtendedInvariantsTest
 * @notice WS4.2 8-invariant multi-asset stateful fuzz test suite mapped directly onto the
 *         8 NOSTOK Production Roadmap invariants (lines 76-84) + caps, independent fees & strict nonces.
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
        vm.warp(1_795_100_400);
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
        core.setGlobalCap(80_000e6);
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
                assetCap: 60_000e6,
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
                assetCap: 60_000e6,
                maxStaleOpenSecs: 86400,
                status: uint8(IAssetRegistry.AssetStatus.Active),
                restricted: false
            })
        );
        router.syncMultiplier(address(stock8));
        router.syncMultiplier(address(stock18));
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

        // Seed 2 initial positions (28k stock8 + 12k stock18 = 40k total) so PerLoan, Asset, and Global cap probes & auctions hit immediately
        handler.openLoanViaSettlement(0, 28_000e6, false, false, false);
        handler.openLoanViaSettlement(0, 12_000e6, true, true, true);

        bytes4[] memory selectors = new bytes4[](15);
        selectors[0] = ExtendedProtocolHandler.openLoanViaSettlement.selector;
        selectors[1] = ExtendedProtocolHandler.attemptOverCapLoans.selector;
        selectors[2] = ExtendedProtocolHandler.topUp.selector;
        selectors[3] = ExtendedProtocolHandler.partialRepay.selector;
        selectors[4] = ExtendedProtocolHandler.extendLoan.selector;
        selectors[5] = ExtendedProtocolHandler.transferNft.selector;
        selectors[6] = ExtendedProtocolHandler.repay.selector;
        selectors[7] = ExtendedProtocolHandler.startLiquidation.selector;
        selectors[8] = ExtendedProtocolHandler.startDefaultAuction.selector;
        selectors[9] = ExtendedProtocolHandler.buyAuction.selector;
        selectors[10] = ExtendedProtocolHandler.restartOrCancelAuction.selector;
        selectors[11] = ExtendedProtocolHandler.claimPayout.selector;
        selectors[12] = ExtendedProtocolHandler.probeEscrowIsolation.selector;
        selectors[13] = ExtendedProtocolHandler.testPauseAndFreezeUnstoppable.selector;
        selectors[14] = ExtendedProtocolHandler.bumpNoncesStrict.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Roadmap Invariant 1 — Collateral Solvency
    function invariant_1_CollateralSolvency() public view {
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

    /// @notice Roadmap Invariant 2 — Strict Escrow Isolation
    function invariant_2_StrictEscrowIsolation() public view {
        assertFalse(handler.escrowIsolationViolated());
        assertTrue(escrow.isAuthorizedCore(address(core)));
        assertTrue(escrow.isAuthorizedCore(address(auction)));
        assertFalse(escrow.isAuthorizedCore(handler.lender1()));
        assertFalse(escrow.isAuthorizedCore(handler.lender2()));
        assertFalse(escrow.isAuthorizedCore(handler.borrower1()));
        assertFalse(escrow.isAuthorizedCore(handler.borrower2()));
        assertFalse(escrow.isAuthorizedCore(liquidator));
    }

    /// @notice Roadmap Invariant 3 — Unstoppable Protocol Liquidity
    function invariant_3_UnstoppableProtocolLiquidity() public view {
        assertFalse(handler.unstoppableViolated());
    }

    /// @notice Roadmap Invariant 4 — Valid Auction Condition & Lock Parity
    function invariant_4_ValidAuctionConditionAndLockParity() public view {
        assertFalse(handler.auctionConditionViolated());
        uint256 count = handler.loanCount();
        for (uint256 i = 0; i < count; i++) {
            uint256 id = handler.loanIds(i);
            ILoanCore.Loan memory l = core.getLoan(id);
            if (l.status <= uint8(ILoanCore.LoanStatus.Auction)) {
                bool inAuc = l.status == uint8(ILoanCore.LoanStatus.Auction);
                assertEq(nft.isAuctionLocked(id), inAuc);
                assertEq(core.loanActiveAuction(id) != 0, inAuc);
                if (inAuc) {
                    ILiquidationAuction.Auction memory a = auction.getAuction(core.loanActiveAuction(id));
                    assertEq(uint8(a.status), uint8(ILiquidationAuction.AuctionStatus.Active));
                    assertGt(a.floorPrice, 0);
                    assertGe(a.startPrice, a.floorPrice);
                }
            } else {
                assertEq(l.collateralRaw, 0);
                assertEq(core.loanActiveAuction(id), 0);
                // Closed loans must have their PositionNFT burned. Note: LoanCore.repay clears isAuctionLocked
                // before burning, whereas LoanCore.onAuctionSettlement burns directly without clearing the dead slot.
                try nft.ownerOf(id) {
                    assertTrue(false, "Closed loan PositionNFT must be burned");
                } catch {}
                if (l.status == uint8(ILoanCore.LoanStatus.Repaid)) {
                    assertFalse(nft.isAuctionLocked(id));
                }
            }
        }
    }

    /// @notice Roadmap Invariant 5 — Borrower Surplus Protection
    function invariant_5_BorrowerSurplusProtection() public view {
        assertFalse(handler.surplusViolated());
    }

    /// @notice Roadmap Invariant 6 — Debt Payoff Invariance, Caps, Independent Fees & Strict Nonces
    function invariant_6_DebtPayoffCapsFeesAndNonces() public view {
        assertFalse(handler.capOrFeeViolated());
        assertFalse(handler.nonceViolated());
        assertFalse(gate.permissionlessMode());

        uint256 openPrincipal;
        uint256 p8;
        uint256 p18;
        uint256 count = handler.loanCount();
        for (uint256 i = 0; i < count; i++) {
            ILoanCore.Loan memory l = core.getLoan(handler.loanIds(i));
            assertLe(l.principalRepaid, l.principal);
            if (l.status <= uint8(ILoanCore.LoanStatus.Auction)) {
                uint256 rem = l.principal - l.principalRepaid;
                openPrincipal += rem;
                if (l.collateralToken == address(stock8)) p8 += rem;
                else if (l.collateralToken == address(stock18)) p18 += rem;
            }
        }
        assertEq(core.totalOutstandingPrincipal(), openPrincipal);
        assertLe(openPrincipal, core.globalUsdcCap());
        assertEq(core.assetOutstandingPrincipal(address(stock8)), p8);
        assertEq(core.assetOutstandingPrincipal(address(stock18)), p18);
        assertLe(p8, registry.getAssetConfig(address(stock8)).assetCap);
        assertLe(p18, registry.getAssetConfig(address(stock18)).assetCap);

        assertLe(feeCollector.originationFeeBps(), feeCollector.MAX_ORIGINATION_BPS());
        assertLe(feeCollector.interestCutBps(), feeCollector.MAX_INTEREST_CUT_BPS());
        assertLe(feeCollector.liquidationFeeBps(), feeCollector.MAX_LIQUIDATION_BPS());
        assertEq(usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve), handler.ghostExpectedFees());

        assertEq(gate.userNonce(handler.borrower1()), handler.ghostExpectedGateNonce(handler.borrower1()));
        assertEq(gate.userNonce(handler.borrower2()), handler.ghostExpectedGateNonce(handler.borrower2()));
        assertEq(settlement.getMakerNonce(handler.borrower1()), handler.ghostExpectedOrderNonce(handler.borrower1()));
        assertEq(settlement.getMakerNonce(handler.borrower2()), handler.ghostExpectedOrderNonce(handler.borrower2()));
    }

    /// @notice Roadmap Invariant 7 — Credit Conservation
    function invariant_7_CreditConservation() public view {
        assertFalse(handler.creditViolated());
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

    /// @notice Roadmap Invariant 8 — Claimant Entitlement & Oracle Baseline
    function invariant_8_ClaimantEntitlement() public view {
        assertFalse(handler.entitlementViolated());
        uint256 count = handler.loanCount();
        for (uint256 i = 0; i < count; i++) {
            uint256 id = handler.loanIds(i);
            ILoanCore.Loan memory l = core.getLoan(id);
            if (l.status <= uint8(ILoanCore.LoanStatus.Auction)) {
                assertTrue(nft.ownerOf(id) != address(0));
            }
        }
        assertGt(router.recordedMultiplier(address(stock8)), 0);
        assertGt(router.recordedMultiplier(address(stock18)), 0);
    }

    function afterInvariant() public view {
        console2.log("RUN_COUNTS open/liq/def:", handler.cntOpenLoan(), handler.cntStartLiquidation(), handler.cntStartDefaultAuction());
        console2.log("RUN_COUNTS buy/restart/cancel:", handler.cntBuyAuction(), handler.cntRestartAuction(), handler.cntCancelRecoveredAuction());
        console2.log("RUN_COUNTS repay/surplus/nftXfer:", handler.cntRepay(), handler.cntSurplusRefund(), handler.cntNftTransfer());
        console2.log("RUN_COUNTS capPL/capA/capG:", handler.cntOverCapPerLoanReverted(), handler.cntOverCapAssetReverted(), handler.cntOverCapGlobalReverted());
        console2.log("RUN_COUNTS noncesG/O/unstop:", handler.cntGateNonceBumped(), handler.cntOrderNonceBumped(), handler.cntUnstoppableVerified());
    }
}

/**
 * @title SecurityBoundaryStressTest
 * @notice WS4.2 stress & mutation-guard suite verifying 1-wei rounding, dust auto-close, exact
 *         timestamp/grace/cooldown boundaries, flash-loan/reentrancy safety, exact sequencer downtime
 *         grace resumption, orthogonal cap/fee/nonce mutation guards, ExtendedProtocolHandler action
 *         liveness/counts, and full non-vacuous EchidnaHarness execution.
 */
contract SecurityBoundaryStressTest is Test {
    LoanCore public core;
    OrderSettlement public settlement;
    CollateralEscrow public escrow;
    PositionNFT public nft;
    LiquidationAuction public auction;
    AssetRegistry public registry;
    OracleRouter public router;
    FeeCollector public feeCollector;
    EligibilityGate public gate;

    ReentrantMockERC20 public stock;
    MockERC20 public stock2;
    MockERC20 public usdc;
    MockAggregator public feed;
    MockAggregator public feed2;
    MockSequencer public sequencer;

    address public owner = address(0x1111);
    address public guardian = address(0x2222);
    address public treasury = address(0x3333);
    address public reserve = address(0x4444);
    address public settlementAddr = address(0x5555);
    address public borrower = address(0xBEE1);
    address public lender = address(0xFEE1);
    address public keeper = address(0xCAFE);
    address public liquidator = address(0xDEAD);

    function setUp() public {
        // Tuesday, 15:00 UTC (regular US equity market open)
        vm.warp(1_795_100_400);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        stock = new ReentrantMockERC20("NVIDIA B20", "NVDAc", 8);
        stock2 = new MockERC20("META B20", "METAc", 18);
        stock.setUiMultiplier(1e18);
        stock2.setUiMultiplier(1e18);
        feed = new MockAggregator(8, 200e8);
        feed2 = new MockAggregator(8, 500e8);
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
        settlement = OrderSettlement(address(new ERC1967Proxy(address(new OrderSettlement()), "")));
        core.initialize(owner, guardian, address(escrow), address(nft), address(registry), address(router), address(feeCollector), address(auction), address(usdc));
        core.setOrderSettlement(settlementAddr);
        auction.initialize(owner, address(escrow), address(core), address(feeCollector), address(usdc));
        settlement.initialize(owner, address(core), address(gate));

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
        registry.setAssetConfig(
            address(stock2),
            IAssetRegistry.AssetConfig({
                feed: address(feed2),
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
        router.syncMultiplier(address(stock));
        router.syncMultiplier(address(stock2));
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
        vm.prank(settlementAddr);
        loanId = core.openLoan(borrower, lender, address(stock), colAmt, principal, 800, termDays, 6000, 3, 0);
    }

    /// @notice WS4.2: 1-wei topUp, odd-wei partialRepay remainder precision, MIN_BUY_USDC boundary, and dust auto-close.
    function test_WS42_OneWeiRoundingAndDustBoundaries() public {
        uint256 loanId = _openSimpleLoan(10_00000001, 1_000e6, 30);

        stock.mint(borrower, 1);
        vm.prank(borrower);
        stock.approve(address(escrow), 1);
        vm.prank(borrower);
        core.topUp(loanId, 1);
        assertEq(core.getLoan(loanId).collateralRaw, 10_00000002);
        assertEq(escrow.getBalance(address(stock)), 10_00000002);

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

        feed.setPrice(120e8);
        vm.prank(keeper);
        uint256 aucId = core.startLiquidation(loanId);
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);

        uint128 smallCol = 8_000000;
        usdc.mint(liquidator, 20e6);
        vm.prank(liquidator);
        usdc.approve(address(auction), 20e6);
        vm.prank(liquidator);
        vm.expectRevert(LiquidationAuction.BuyAmountTooSmall.selector);
        auction.buy(aucId, smallCol, 20e6);

        uint128 buyNearAll = a.collateralRemaining - 5_000000;
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

        vm.warp(mat);
        assertEq(uint8(core.syncStatus(loanId)), uint8(ILoanCore.LoanStatus.Active));
        vm.warp(mat + 1);
        assertEq(uint8(core.syncStatus(loanId)), uint8(ILoanCore.LoanStatus.Grace));

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

        uint256 tExp = uint256(a.startTime) + a.duration + 1;
        vm.warp(tExp);
        feed.setUpdatedAt(tExp);
        usdc.mint(liquidator, 1_000e6);
        vm.prank(liquidator);
        usdc.approve(address(auction), 1_000e6);
        vm.prank(liquidator);
        vm.expectRevert(LiquidationAuction.AuctionExpired.selector);
        auction.buy(auc1, 1e8, 1_000e6);

        vm.prank(guardian);
        vm.expectRevert(LiquidationAuction.OracleNotStaleOrFrozen.selector);
        auction.emergencyCancelAuction(auc1);

        uint256 cancelAt = tExp + 1801;
        vm.warp(cancelAt);
        vm.prank(guardian);
        auction.emergencyCancelAuction(auc1);

        feed.setUpdatedAt(cancelAt);
        vm.prank(keeper);
        uint256 auc2 = core.startDefaultAuction(loanId);

        uint256 tCooldownEndMinus1 = cancelAt + 3599;
        vm.warp(tCooldownEndMinus1);
        vm.prank(guardian);
        vm.expectRevert(LiquidationAuction.EmergencyCancelCooldownActive.selector);
        auction.emergencyCancelAuction(auc2);

        uint256 tCooldownEnd = cancelAt + 3600;
        vm.warp(tCooldownEnd);
        vm.prank(guardian);
        auction.emergencyCancelAuction(auc2);

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

        vm.prank(lender);
        uint128 claimed = core.claim(lender);
        assertEq(core.getClaimable(lender), 0);
        assertGt(claimed, 1_000e6);
    }

    /// @notice WS4.2: Sequencer downtime blocks openLoan & startLiquidation, allows topUp,
    ///         and resumes cleanly once elapsed == sequencerGracePeriod (3600s).
    function test_WS42_SequencerDowntimeAndExactGraceResumption() public {
        uint256 tRec = 1_795_100_400;
        uint256 loanId = _openSimpleLoan(10e8, 1_000e6, 30);
        feed.setPrice(100e8);

        sequencer.setStatus(1, tRec);
        (, , IOracleRouter.OracleState sDown) = router.getPrice(address(stock));
        assertEq(uint8(sDown), uint8(IOracleRouter.OracleState.INVALID_SEQUENCER));

        stock.mint(borrower, 10e8);
        vm.prank(borrower);
        stock.approve(address(escrow), 10e8);
        usdc.mint(lender, 1_000e6);
        vm.prank(lender);
        usdc.approve(address(core), 1_000e6);
        vm.prank(settlementAddr);
        vm.expectRevert(LoanCore.OracleInvalidForAction.selector);
        core.openLoan(borrower, lender, address(stock), 10e8, 1_000e6, 800, 30, 6000, 3, 0);

        vm.prank(keeper);
        vm.expectRevert(LoanCore.OracleInvalidForAction.selector);
        core.startLiquidation(loanId);

        stock.mint(borrower, 1e8);
        vm.prank(borrower);
        stock.approve(address(escrow), 1e8);
        vm.prank(borrower);
        core.topUp(loanId, 1e8);
        assertEq(core.getLoan(loanId).collateralRaw, 11e8);

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

    /// @notice WS4.2 Mutation Guards: Kills removed global cap, removed asset cap, removed per-loan cap,
    ///         2x origination fee / wrong interest or liquidation fees, and un-incremented gate/order nonces.
    function test_WS42_CapsFeesAndNoncesMutationGuards() public {
        // Configure orthogonal caps: perLoanCap = 40k, assetCap = 50k, globalCap = 60k
        vm.startPrank(owner);
        core.setGlobalCap(60_000e6);
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
                perLoanCap: 40_000e6,
                assetCap: 50_000e6,
                maxStaleOpenSecs: 21600,
                status: uint8(IAssetRegistry.AssetStatus.Active),
                restricted: false
            })
        );
        registry.setAssetConfig(
            address(stock2),
            IAssetRegistry.AssetConfig({
                feed: address(feed2),
                feedDecimals: 8,
                tier: 0,
                maxInitLtvBps: 6000,
                marginCallLtvBps: 7000,
                liqLtvBps: 7800,
                badDebtLtvBps: 9000,
                maxDiscountBps: 600,
                closedMarketHaircutBps: 500,
                perLoanCap: 40_000e6,
                assetCap: 50_000e6,
                maxStaleOpenSecs: 21600,
                status: uint8(IAssetRegistry.AssetStatus.Active),
                restricted: false
            })
        );
        vm.stopPrank();

        // 1. Pure PerLoanCapExceeded: 40,001 USDC (> 40k perLoanCap, <= 50k assetCap, <= 60k globalCap)
        stock.mint(borrower, 500e8);
        vm.prank(borrower);
        stock.approve(address(escrow), 500e8);
        usdc.mint(lender, 40_001e6);
        vm.prank(lender);
        usdc.approve(address(core), 40_001e6);
        vm.prank(settlementAddr);
        vm.expectRevert(LoanCore.PerLoanCapExceeded.selector);
        core.openLoan(borrower, lender, address(stock), 500e8, 40_001e6, 800, 30, 6000, 3, 0);

        // 2. Open valid 30,000 USDC loan on stock and check INDEPENDENT origination fee (0.10% = 30 USDC, NOT 2x = 60 USDC)
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(reserve);
        uint256 bUsdcBefore = usdc.balanceOf(borrower);
        uint256 loan1 = _openSimpleLoan(400e8, 30_000e6, 30);
        uint256 expectedOrigFee = (uint256(30_000e6) * 10 + 9999) / 10000; // 30e6 independent formula
        assertEq((usdc.balanceOf(treasury) + usdc.balanceOf(reserve)) - feeBefore, expectedOrigFee, "Origination fee mismatch");
        assertEq(usdc.balanceOf(borrower) - bUsdcBefore, 30_000e6 - expectedOrigFee, "Borrower net proceeds mismatch");
        assertGt(loan1, 0);

        // 3. Pure AssetCapExceeded: +20,001 USDC on stock (<= 40k perLoanCap, total 50,001 <= 60k globalCap, ONLY exceeds 50k assetCap)
        stock.mint(borrower, 300e8);
        vm.prank(borrower);
        stock.approve(address(escrow), 300e8);
        usdc.mint(lender, 20_001e6);
        vm.prank(lender);
        usdc.approve(address(core), 20_001e6);
        vm.prank(settlementAddr);
        vm.expectRevert(LoanCore.AssetCapExceeded.selector);
        core.openLoan(borrower, lender, address(stock), 300e8, 20_001e6, 800, 30, 6000, 3, 0);

        // 4. Pure GlobalCapExceeded: +30,001 USDC on stock2 (<= 40k perLoanCap, <= 50k stock2 assetCap, ONLY exceeds 60k globalCap)
        stock2.mint(borrower, 200e18);
        vm.prank(borrower);
        stock2.approve(address(escrow), 200e18);
        usdc.mint(lender, 30_001e6);
        vm.prank(lender);
        usdc.approve(address(core), 30_001e6);
        vm.prank(settlementAddr);
        vm.expectRevert(LoanCore.GlobalCapExceeded.selector);
        core.openLoan(borrower, lender, address(stock2), 200e18, 30_001e6, 800, 30, 6000, 3, 0);

        // Exact boundary 30,000 USDC on stock2 hits 60,000 USDC globalCap cleanly
        usdc.mint(lender, 30_000e6);
        vm.prank(lender);
        usdc.approve(address(core), 30_000e6);
        vm.prank(settlementAddr);
        core.openLoan(borrower, lender, address(stock2), 200e18, 30_000e6, 800, 30, 6000, 3, 0);
        assertEq(core.totalOutstandingPrincipal(), 60_000e6);

        // 5. Strict EligibilityGate nonce +1 & immediate old-attestation invalidation
        uint256 signerPk = 0x516;
        uint256 userPk = 0x05E2;
        address user = vm.addr(userPk);
        vm.startPrank(owner);
        gate.setPermissionlessMode(false);
        gate.setAttestationSigner(vm.addr(signerPk));
        vm.stopPrank();

        uint256 g0 = gate.userNonce(user);
        uint256 exp = block.timestamp + 1 days;
        bytes32 d0 = gate.getAttestationDigest(user, g0, exp);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(signerPk, d0);
        bytes memory oldAtt = abi.encode(exp, abi.encodePacked(r0, s0, v0));
        assertTrue(gate.isEligible(user, oldAtt));

        vm.prank(user);
        gate.bumpMyNonce();
        assertEq(gate.userNonce(user), g0 + 1, "Gate bumpMyNonce must strictly increment by +1");
        assertFalse(gate.isEligible(user, oldAtt), "Old attestation must be invalidated after bumpMyNonce");

        vm.prank(owner);
        gate.bumpUserNonce(user);
        assertEq(gate.userNonce(user), g0 + 2, "Gate bumpUserNonce must strictly increment by +1");

        // 6. Strict OrderSettlement nonce +1 & immediate old-nonce InvalidNonce revert
        uint256 o0 = settlement.getMakerNonce(user);
        vm.prank(user);
        uint256 o1 = settlement.bumpNonce();
        assertEq(o1, o0 + 1, "OrderSettlement bumpNonce return value must strictly increment by +1");
        assertEq(settlement.getMakerNonce(user), o0 + 1, "OrderSettlement getMakerNonce must strictly increment by +1");

        IOrderSettlement.BorrowOrder memory staleOrder = IOrderSettlement.BorrowOrder({
            borrower: user,
            collateralToken: address(stock),
            collateralAmount: 10e8,
            minUsdc: 500e6,
            maxRateBps: 900,
            termDays: 7,
            maxLtvBps: 6000,
            minFill: 500e6,
            expiry: uint64(exp),
            nonce: o0,
            yieldMode: 0,
            allowInKindSettlement: false
        });
        vm.prank(lender);
        vm.expectRevert(OrderSettlement.InvalidNonce.selector);
        settlement.fillBorrowOrderWithAttestations(staleOrder, "", 500e6, "", "");
    }

    /// @notice WS4.2: Drives EchidnaHarness past sequencer grace and strictly asserts every lifecycle
    ///         path actually executes (> 0 counts) and all 8 roadmap properties + liveness pass.
    function test_WS42_EchidnaHarnessAll8PropertiesPass() public {
        // Explicitly warp past 1h sequencer grace period before deploying EchidnaHarness
        vm.warp(1_795_100_400);
        EchidnaHarness eh = new EchidnaHarness();
        assertTrue(eh.router().isSequencerValid(), "Sequencer must be valid past grace period");

        // 1. Probe pure PerLoanCapExceeded before opening loans
        eh.actionAttemptOverCapLoans(false);
        assertGe(eh.overCapPerLoanRevertsCount(), 1, "PerLoanCapExceeded probe must fire");

        // 2. Open 8-dec loan (35k) & probe pure AssetCapExceeded (stock8) and pure GlobalCapExceeded (stock18)
        eh.actionOpenLoan(0, 34_500e6, false, false, false);
        eh.actionAttemptOverCapLoans(false); // stock8 assetCap (60k) probe
        eh.actionAttemptOverCapLoans(true);  // stock18 globalCap (80k) probe

        // 3. Open 3 more loans across both 8-dec and 18-dec tokens and both borrowers/lenders
        eh.actionOpenLoan(2, 2_000e6, false, true, false);
        eh.actionOpenLoan(3, 3_000e6, true, false, true);
        eh.actionOpenLoan(1, 2_500e6, true, true, false);
        assertGe(eh.openedLoansCount(), 4, "EchidnaHarness must actually open loans");

        // 4. TopUp, NFT transfer (Roadmap #8), Escrow isolation probe (Roadmap #2), strict nonce bump
        eh.actionTopUp(0, 1e8);
        eh.actionTransferNft(1);
        eh.actionProbeEscrowIsolation(0);
        eh.actionProbeEscrowIsolation(1);
        eh.actionBumpNonce();

        // 5. Partial liquidation (50% close) + buy on loan 0, and Full liquidation (100% close -> borrower surplus!) + buy on loan 1
        eh.actionSetPriceAndLiquidate(0, false);
        eh.actionBuyAuction(0, 5000);
        eh.actionSetPriceAndLiquidate(1, true);
        eh.actionBuyAuction(1, 0); // 100% buy -> triggers borrower USDC surplus!

        // 6. Pause / Asset Freeze / B20 Multiplier Split unstoppable liquidity tests (Roadmap #3)
        eh.actionOpenLoan(0, 1_500e6, false, false, false);
        eh.actionOpenLoan(0, 1_500e6, true, true, true);
        eh.actionOpenLoan(0, 1_500e6, false, false, true);
        eh.actionTestPauseAndFreezeUnstoppable(0, 0); // LoanCore paused
        eh.actionTestPauseAndFreezeUnstoppable(0, 1); // Asset Frozen
        eh.actionTestPauseAndFreezeUnstoppable(0, 2); // B20 multiplier jump >= 5%

        // 7. Warp past 7d maturity + 24h grace -> Default auction + full buy (borrower surplus + residual collateral!)
        eh.actionOpenLoan(0, 1_000e6, false, false, false);
        vm.warp(block.timestamp + 8 days + 1);
        eh.actionStartDefaultAuction(0);
        eh.actionBuyAuction(0, 0);

        // 8. Repay remaining open loan & claim lender payouts
        eh.actionOpenLoan(0, 1_000e6, true, false, false);
        eh.actionTransferNft(0);
        eh.actionRepay(0);
        eh.actionClaimLender(false);
        eh.actionClaimLender(true);

        // Strict non-vacuity assertions
        assertGe(eh.openedLoansCount(), 6, "Expected >= 6 opened loans");
        assertGe(eh.topUpsCount(), 4, "Expected >= 4 topUps");
        assertGe(eh.liquidationsStartedCount(), 2, "Expected >= 2 liquidations");
        assertGe(eh.defaultAuctionsStartedCount(), 1, "Expected >= 1 default auction");
        assertGe(eh.auctionBuysCount(), 3, "Expected >= 3 auction buys");
        assertGe(eh.surplusRefundsCount(), 1, "Expected >= 1 borrower surplus refund");
        assertGe(eh.repaidLoansCount(), 4, "Expected >= 4 repaid loans");
        assertGe(eh.claimsCount(), 2, "Expected >= 2 lender claims");
        assertGe(eh.nftTransfersCount(), 2, "Expected >= 2 PositionNFT transfers");
        assertGe(eh.overCapPerLoanRevertsCount(), 1, "Expected >= 1 PerLoanCapExceeded revert");
        assertGe(eh.overCapAssetRevertsCount(), 1, "Expected >= 1 AssetCapExceeded revert");
        assertGe(eh.overCapGlobalRevertsCount(), 1, "Expected >= 1 GlobalCapExceeded revert");
        assertGe(eh.escrowIsolationProbesCount(), 2, "Expected >= 2 escrow isolation probes");
        assertGe(eh.unstoppableChecksCount(), 3, "Expected >= 3 pause/freeze unstoppable checks");
        assertGe(eh.nonceBumpsCount(), 1, "Expected >= 1 strict nonce bump");

        // All 8 roadmap-mapped properties + liveness check
        assertTrue(eh.echidna_1_collateral_solvency(), "echidna_1_collateral_solvency failed");
        assertTrue(eh.echidna_2_strict_escrow_isolation(), "echidna_2_strict_escrow_isolation failed");
        assertTrue(eh.echidna_3_unstoppable_liquidity(), "echidna_3_unstoppable_liquidity failed");
        assertTrue(eh.echidna_4_valid_auction_condition(), "echidna_4_valid_auction_condition failed");
        assertTrue(eh.echidna_5_borrower_surplus_protection(), "echidna_5_borrower_surplus_protection failed");
        assertTrue(eh.echidna_6_debt_payoff_caps_and_fees(), "echidna_6_debt_payoff_caps_and_fees failed");
        assertTrue(eh.echidna_7_credit_conservation(), "echidna_7_credit_conservation failed");
        assertTrue(eh.echidna_8_claimant_entitlement(), "echidna_8_claimant_entitlement failed");
        assertTrue(eh.echidna_9_liveness_no_silent_reverts(), "echidna_9_liveness_no_silent_reverts failed");
    }

    /// @notice WS4.2: Drives ExtendedInvariantsTest's exact ExtendedProtocolHandler across all auction,
    ///         default, restart, recovery-cancel, over-cap, fee, nonce, pause/freeze & NFT transfer paths,
    ///         logging and strictly asserting per-action success counts.
    function test_WS42_ExtendedHandlerActionLivenessAndCoverage() public {
        ExtendedInvariantsTest suite = new ExtendedInvariantsTest();
        suite.setUp();
        ExtendedProtocolHandler h = suite.handler();

        // Exercise all over-cap probes (assetCap + globalCap on seeded loans, then perLoanCap after repay)
        h.attemptOverCapLoans(false);
        h.attemptOverCapLoans(true);
        h.openLoanViaSettlement(1, 5_000e6, false, false, false);
        h.openLoanViaSettlement(2, 5_000e6, true, true, true);
        h.topUp(0, 1e8);
        h.partialRepay(0, 1_000e6);
        h.extendLoan(0, 10 days, 1200);
        h.transferNft(0);
        h.probeEscrowIsolation(0);
        h.bumpNoncesStrict(false);
        h.bumpNoncesStrict(true);

        // Liquidation -> restart -> recovery-cancel -> re-liquidate -> full buy with surplus
        h.startLiquidation(0, false);
        h.restartOrCancelAuction(0, false); // Restart
        h.restartOrCancelAuction(0, true);  // Recovery cancel
        h.startLiquidation(0, true);        // 100% close -> surplus
        h.buyAuction(0, 0);                 // Full buy

        // Default auction -> restart -> buy
        h.startDefaultAuction(0);
        h.restartOrCancelAuction(0, false);
        h.buyAuction(0, 0);

        // Pause / Freeze / B20 split unstoppable liquidity
        h.openLoanViaSettlement(0, 2_000e6, false, false, false);
        h.openLoanViaSettlement(0, 2_000e6, true, true, true);
        h.openLoanViaSettlement(0, 2_000e6, false, false, true);
        h.testPauseAndFreezeUnstoppable(0, 0);
        h.testPauseAndFreezeUnstoppable(0, 1);
        h.testPauseAndFreezeUnstoppable(0, 2);

        // Repay remaining loans so totalOut == 0, then probe pure PerLoanCapExceeded
        while (h.openLoanCount() > 0) {
            h.repay(0);
        }
        h.attemptOverCapLoans(false);
        h.claimPayout(false);
        h.claimPayout(true);

        console2.log("cntOpenLoan:", h.cntOpenLoan());
        console2.log("cntStartLiquidation:", h.cntStartLiquidation());
        console2.log("cntStartDefaultAuction:", h.cntStartDefaultAuction());
        console2.log("cntBuyAuction:", h.cntBuyAuction());
        console2.log("cntRestartAuction:", h.cntRestartAuction());
        console2.log("cntCancelRecoveredAuction:", h.cntCancelRecoveredAuction());
        console2.log("cntSurplusRefund:", h.cntSurplusRefund());
        console2.log("cntOverCapPerLoanReverted:", h.cntOverCapPerLoanReverted());
        console2.log("cntOverCapAssetReverted:", h.cntOverCapAssetReverted());
        console2.log("cntOverCapGlobalReverted:", h.cntOverCapGlobalReverted());
        console2.log("cntGateNonceBumped:", h.cntGateNonceBumped());
        console2.log("cntOrderNonceBumped:", h.cntOrderNonceBumped());

        assertGe(h.cntOpenLoan(), 7);
        assertGe(h.cntTopUp(), 4);
        assertGe(h.cntPartialRepay(), 1);
        assertGe(h.cntExtend(), 1);
        assertGe(h.cntNftTransfer(), 1);
        assertGe(h.cntStartLiquidation(), 2);
        assertGe(h.cntStartDefaultAuction(), 1);
        assertGe(h.cntBuyAuction(), 2);
        assertGe(h.cntRestartAuction(), 2);
        assertGe(h.cntCancelRecoveredAuction(), 1);
        assertGe(h.cntSurplusRefund(), 1);
        assertGe(h.cntOverCapPerLoanReverted(), 1);
        assertGe(h.cntOverCapAssetReverted(), 1);
        assertGe(h.cntOverCapGlobalReverted(), 1);
        assertGe(h.cntGateNonceBumped(), 2);
        assertGe(h.cntOrderNonceBumped(), 2);
        assertGe(h.cntEscrowIsolationProbed(), 1);
        assertGe(h.cntUnstoppableVerified(), 3);

        // Verify all 8 roadmap invariants on the exact ExtendedInvariantsTest instance
        suite.invariant_1_CollateralSolvency();
        suite.invariant_2_StrictEscrowIsolation();
        suite.invariant_3_UnstoppableProtocolLiquidity();
        suite.invariant_4_ValidAuctionConditionAndLockParity();
        suite.invariant_5_BorrowerSurplusProtection();
        suite.invariant_6_DebtPayoffCapsFeesAndNonces();
        suite.invariant_7_CreditConservation();
        suite.invariant_8_ClaimantEntitlement();
    }

    /// @notice WS4.2: Simulates a 500-call randomized Echidna campaign with random time warps (up to 7d)
    ///         from Echidna's default timestamp, verifying zero silent reverts and all 9 echidna_* properties at every step.
    function test_WS42_EchidnaHarnessRandom500StepCampaign() public {
        vm.warp(1_524_785_992); // Echidna default genesis timestamp (> 1h sequencer grace)
        EchidnaHarness eh = new EchidnaHarness();
        assertTrue(eh.router().isSequencerValid(), "Sequencer must be valid at Echidna start timestamp");

        uint256 rng = 0x5EED1234;
        for (uint256 step = 0; step < 500; step++) {
            rng = uint256(keccak256(abi.encode(rng, step)));
            // Randomly advance time (0s, 10m, 40m, or 2d) just like Echidna maxTimeDelay
            uint256 tMode = rng % 8;
            if (tMode == 1) vm.warp(block.timestamp + 600);
            else if (tMode == 2) vm.warp(block.timestamp + 2400);
            else if (tMode == 3) vm.warp(block.timestamp + 2 days);

            uint256 act = (rng >> 8) % 12;
            uint256 s1 = uint256(keccak256(abi.encode(rng, uint256(1))));
            uint256 s2 = uint256(keccak256(abi.encode(rng, uint256(2))));
            if (act == 0 || act == 1) eh.actionOpenLoan(s1, s2, (s1 & 1) == 1, (s1 & 2) == 2, (s1 & 4) == 4);
            else if (act == 2) eh.actionAttemptOverCapLoans((s1 & 1) == 1);
            else if (act == 3) eh.actionTopUp(s1, s2);
            else if (act == 4) eh.actionTransferNft(s1);
            else if (act == 5) eh.actionRepay(s1);
            else if (act == 6) eh.actionSetPriceAndLiquidate(s1, (s2 & 1) == 1);
            else if (act == 7) eh.actionStartDefaultAuction(s1);
            else if (act == 8) eh.actionBuyAuction(s1, s2);
            else if (act == 9) eh.actionProbeEscrowIsolation(s1);
            else if (act == 10) eh.actionTestPauseAndFreezeUnstoppable(s1, uint8(s2));
            else if (act == 11) {
                eh.actionBumpNonce();
                eh.actionClaimLender((s1 & 1) == 1);
            }

            assertTrue(eh.echidna_1_collateral_solvency(), "echidna_1 failed");
            assertTrue(eh.echidna_2_strict_escrow_isolation(), "echidna_2 failed");
            assertTrue(eh.echidna_3_unstoppable_liquidity(), "echidna_3 failed");
            assertTrue(eh.echidna_4_valid_auction_condition(), "echidna_4 failed");
            assertTrue(eh.echidna_5_borrower_surplus_protection(), "echidna_5 failed");
            assertTrue(eh.echidna_6_debt_payoff_caps_and_fees(), "echidna_6 failed");
            assertTrue(eh.echidna_7_credit_conservation(), "echidna_7 failed");
            assertTrue(eh.echidna_8_claimant_entitlement(), "echidna_8 failed");
            assertTrue(eh.echidna_9_liveness_no_silent_reverts(), "echidna_9 liveness failed");
        }

        console2.log("ECHIDNA_500 opened/liq/def:", eh.openedLoansCount(), eh.liquidationsStartedCount(), eh.defaultAuctionsStartedCount());
        console2.log("ECHIDNA_500 buy/surplus/repay:", eh.auctionBuysCount(), eh.surplusRefundsCount(), eh.repaidLoansCount());
        console2.log("ECHIDNA_500 capPL/capA/capG:", eh.overCapPerLoanRevertsCount(), eh.overCapAssetRevertsCount(), eh.overCapGlobalRevertsCount());

        assertGe(eh.openedLoansCount(), 20, "Random Echidna campaign must open many loans");
        assertGe(eh.liquidationsStartedCount(), 10, "Random Echidna campaign must trigger many liquidations");
        assertGe(eh.defaultAuctionsStartedCount(), 5, "Random Echidna campaign must trigger default auctions");
        assertGe(eh.auctionBuysCount(), 15, "Random Echidna campaign must execute many auction buys");
        assertGe(eh.surplusRefundsCount(), 3, "Random Echidna campaign must verify borrower surplus refunds");
        assertGe(eh.repaidLoansCount(), 15, "Random Echidna campaign must repay many loans");
        assertGe(eh.claimsCount(), 10, "Random Echidna campaign must execute many claims");
        assertGe(eh.nftTransfersCount(), 10, "Random Echidna campaign must transfer PositionNFTs");
        assertGe(eh.overCapAssetRevertsCount() + eh.overCapGlobalRevertsCount() + eh.overCapPerLoanRevertsCount(), 5);
        assertGe(eh.escrowIsolationProbesCount(), 10);
        assertGe(eh.unstoppableChecksCount(), 10);
        assertGe(eh.nonceBumpsCount(), 10);
    }

    /// @notice WS4.2: Executes a uniform-random 64x16 campaign (matching foundry.toml [invariant] runs=64, depth=16)
    ///         on ExtendedInvariantsTest, printing and strictly asserting high per-action aggregate success counts.
    function test_WS42_ExtendedInvariants64x16AggregateCounts() public {
        uint256 totOpen;
        uint256 totLiq;
        uint256 totDef;
        uint256 totBuy;
        uint256 totRestart;
        uint256 totCancel;
        uint256 totSurplus;
        uint256 totCapPL;
        uint256 totCapA;
        uint256 totCapG;
        uint256 totGateN;
        uint256 totOrderN;
        uint256 totUnstop;
        uint256 totIso;

        ExtendedInvariantsTest suite = new ExtendedInvariantsTest();
        suite.setUp();
        ExtendedProtocolHandler h = suite.handler();
        uint256 snap = vm.snapshotState();

        uint256 rng = 0xC0FFEE64;
        for (uint256 run = 0; run < 64; run++) {
            vm.revertToState(snap);

            for (uint256 step = 0; step < 16; step++) {
                rng = uint256(keccak256(abi.encode(rng, run, step)));
                uint256 act = rng % 15;
                uint256 s1 = uint256(keccak256(abi.encode(rng, uint256(11))));
                uint256 s2 = uint256(keccak256(abi.encode(rng, uint256(22))));
                if (act == 0) h.openLoanViaSettlement(s1, s2, (s1 & 1) == 1, (s1 & 2) == 2, (s1 & 4) == 4);
                else if (act == 1) h.attemptOverCapLoans((s1 & 1) == 1);
                else if (act == 2) h.topUp(s1, s2);
                else if (act == 3) h.partialRepay(s1, s2);
                else if (act == 4) h.extendLoan(s1, s2, s1);
                else if (act == 5) h.transferNft(s1);
                else if (act == 6) h.repay(s1);
                else if (act == 7) h.startLiquidation(s1, (s2 & 1) == 1);
                else if (act == 8) h.startDefaultAuction(s1);
                else if (act == 9) h.buyAuction(s1, s2);
                else if (act == 10) h.restartOrCancelAuction(s1, (s2 & 1) == 1);
                else if (act == 11) h.claimPayout((s1 & 1) == 1);
                else if (act == 12) h.probeEscrowIsolation(s1);
                else if (act == 13) h.testPauseAndFreezeUnstoppable(s1, uint8(s2));
                else h.bumpNoncesStrict((s1 & 1) == 1);
            }

            suite.invariant_1_CollateralSolvency();
            suite.invariant_2_StrictEscrowIsolation();
            suite.invariant_3_UnstoppableProtocolLiquidity();
            suite.invariant_4_ValidAuctionConditionAndLockParity();
            suite.invariant_5_BorrowerSurplusProtection();
            suite.invariant_6_DebtPayoffCapsFeesAndNonces();
            suite.invariant_7_CreditConservation();
            suite.invariant_8_ClaimantEntitlement();

            totOpen += h.cntOpenLoan();
            totLiq += h.cntStartLiquidation();
            totDef += h.cntStartDefaultAuction();
            totBuy += h.cntBuyAuction();
            totRestart += h.cntRestartAuction();
            totCancel += h.cntCancelRecoveredAuction();
            totSurplus += h.cntSurplusRefund();
            totCapPL += h.cntOverCapPerLoanReverted();
            totCapA += h.cntOverCapAssetReverted();
            totCapG += h.cntOverCapGlobalReverted();
            totGateN += h.cntGateNonceBumped();
            totOrderN += h.cntOrderNonceBumped();
            totUnstop += h.cntUnstoppableVerified();
            totIso += h.cntEscrowIsolationProbed();
        }

        console2.log("AGG_64x16 open/liq/def:", totOpen, totLiq, totDef);
        console2.log("AGG_64x16 buy/restart/cancel:", totBuy, totRestart, totCancel);
        console2.log("AGG_64x16 surplus/unstop/iso:", totSurplus, totUnstop, totIso);
        console2.log("AGG_64x16 capPL/capA/capG:", totCapPL, totCapA, totCapG);
        console2.log("AGG_64x16 gateNonce/orderNonce:", totGateN, totOrderN);

        assertGe(totOpen, 150, "Expected high openLoan successes across 64x16");
        assertGe(totLiq, 25, "Expected high startLiquidation successes across 64x16");
        assertGe(totDef, 25, "Expected high startDefaultAuction successes across 64x16");
        assertGe(totBuy, 20, "Expected high buyAuction successes across 64x16");
        assertGe(totRestart + totCancel, 20, "Expected high restart/cancel successes across 64x16");
        assertGe(totSurplus, 5, "Expected borrower surplus refunds across 64x16");
        assertGe(totCapA, 15, "Expected pure AssetCapExceeded reverts across 64x16");
        assertGe(totCapG, 15, "Expected pure GlobalCapExceeded reverts across 64x16");
        assertGe(totGateN, 30, "Expected strict EligibilityGate nonce bumps across 64x16");
        assertGe(totOrderN, 30, "Expected strict OrderSettlement nonce bumps across 64x16");
        assertGe(totUnstop, 20, "Expected unstoppable pause/freeze checks across 64x16");
        assertGe(totIso, 30, "Expected escrow isolation probes across 64x16");
    }
}
