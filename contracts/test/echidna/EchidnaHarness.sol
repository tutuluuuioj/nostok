// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {CollateralEscrow} from "../../src/CollateralEscrow.sol";
import {PositionNFT} from "../../src/PositionNFT.sol";
import {AssetRegistry} from "../../src/AssetRegistry.sol";
import {OracleRouter} from "../../src/OracleRouter.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {EligibilityGate} from "../../src/EligibilityGate.sol";
import {LiquidationAuction} from "../../src/LiquidationAuction.sol";
import {LoanCore} from "../../src/LoanCore.sol";
import {OrderSettlement} from "../../src/OrderSettlement.sol";
import {ILoanCore} from "../../src/interfaces/ILoanCore.sol";
import {IAssetRegistry} from "../../src/interfaces/IAssetRegistry.sol";
import {ILiquidationAuction} from "../../src/interfaces/ILiquidationAuction.sol";
import {IOracleRouter} from "../../src/interfaces/IOracleRouter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockSequencer} from "../mocks/MockSequencer.sol";

/**
 * @notice Minimal contract actor enabling multi-party harness actions without VM cheatcodes
 *         so Echidna (`crytic-compile`) and Foundry can both execute all 8 roadmap invariants.
 *         Implements IERC721Receiver so PositionNFT._safeMint succeeds for contract lenders.
 */
contract EchidnaActor is IERC721Receiver {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function callTarget(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/**
 * @title EchidnaHarness
 * @notice WS4.2 Echidna & Foundry dual-compatible fuzz harness mapped 1-to-1 onto all 8
 *         NOSTOK Production Roadmap invariants (lines 76-84), plus non-vacuity / liveness,
 *         independent fee verification, orthogonal over-cap revert probes, and strict nonce checks.
 */
contract EchidnaHarness {
    // Orthogonal caps so PerLoanCapExceeded, AssetCapExceeded, and GlobalCapExceeded are independently reachable
    uint128 public constant PER_LOAN_CAP = 50_000e6;
    uint128 public constant ASSET_CAP = 60_000e6;
    uint128 public constant GLOBAL_CAP = 80_000e6;

    // Independent expected FeeCollector parameters (never copied from contract fee outputs)
    uint16 public constant EXPECTED_ORIG_BPS = 10;       // 0.10%
    uint16 public constant EXPECTED_INT_CUT_BPS = 1000;  // 10.00%
    uint16 public constant EXPECTED_LIQ_BPS = 100;       // 1.00%
    uint16 public constant EXPECTED_KEEPER_BPS = 3000;   // 30.00% of liquidation fee

    CollateralEscrow public escrow;
    PositionNFT public nft;
    AssetRegistry public registry;
    OracleRouter public router;
    FeeCollector public feeCollector;
    EligibilityGate public gate;
    LoanCore public core;
    LiquidationAuction public auction;
    OrderSettlement public orderSettlement;

    MockERC20 public usdc;
    MockERC20 public stock8;
    MockERC20 public stock18;
    MockAggregator public feed8;
    MockAggregator public feed18;
    MockSequencer public sequencer;

    EchidnaActor public borrowerA;
    EchidnaActor public borrowerB;
    EchidnaActor public lenderA;
    EchidnaActor public lenderB;
    EchidnaActor public keeper;
    EchidnaActor public liquidator;
    EchidnaActor public guardianActor;

    address public settlement;
    address public guardian;
    address public treasury;
    address public safetyReserve;

    uint256[] public openLoanIds;
    mapping(address => uint256) public ghostEscrow;
    uint256 public ghostExpectedFees;
    uint256 public ghostExpectedGateNonce;
    uint256 public ghostExpectedOrderNonce;

    // Action attempt and success counters (used for non-vacuity / liveness verification)
    uint256 public openLoanAttempts;
    uint256 public openedLoansCount;
    uint256 public topUpsCount;
    uint256 public repayAttempts;
    uint256 public repaidLoansCount;
    uint256 public liquidationAttempts;
    uint256 public liquidationsStartedCount;
    uint256 public defaultAuctionAttempts;
    uint256 public defaultAuctionsStartedCount;
    uint256 public buyAttempts;
    uint256 public auctionBuysCount;
    uint256 public restartOrCancelCount;
    uint256 public claimAttempts;
    uint256 public claimsCount;
    uint256 public nftTransfersCount;
    uint256 public surplusRefundsCount;
    uint256 public overCapPerLoanRevertsCount;
    uint256 public overCapAssetRevertsCount;
    uint256 public overCapGlobalRevertsCount;
    uint256 public escrowIsolationProbesCount;
    uint256 public unstoppableChecksCount;
    uint256 public nonceBumpsCount;

    // Explicit violation latches checked by the 8 roadmap properties + liveness property
    bool private _escrowIsolationViolated;
    bool private _unstoppableViolated;
    bool private _auctionConditionViolated;
    bool private _surplusViolated;
    bool private _capOrFeeViolated;
    bool private _nonceViolated;
    bool private _creditViolated;
    bool private _entitlementViolated;
    bool private _unexpectedActionRevert;

    constructor() {
        settlement = address(this);
        guardianActor = new EchidnaActor();
        guardian = address(guardianActor);
        treasury = address(0xAAA1);
        safetyReserve = address(0xAAA2);

        borrowerA = new EchidnaActor();
        borrowerB = new EchidnaActor();
        lenderA = new EchidnaActor();
        lenderB = new EchidnaActor();
        keeper = new EchidnaActor();
        liquidator = new EchidnaActor();

        usdc = new MockERC20("USD Coin", "USDC", 6);
        stock8 = new MockERC20("NVIDIA B20", "NVDAc", 8);
        stock18 = new MockERC20("META B20", "METAc", 18);
        stock8.setUiMultiplier(1e18);
        stock18.setUiMultiplier(1e18);

        feed8 = new MockAggregator(8, 200e8);
        feed18 = new MockAggregator(8, 500e8);
        sequencer = new MockSequencer(0);

        gate = new EligibilityGate(address(this), address(this), true);
        escrow = new CollateralEscrow(address(this));
        nft = new PositionNFT(address(this), address(gate));

        registry = AssetRegistry(address(new ERC1967Proxy(address(new AssetRegistry()), "")));
        registry.initialize(address(this), guardian);

        router = OracleRouter(address(new ERC1967Proxy(address(new OracleRouter()), "")));
        router.initialize(address(this), address(registry), address(sequencer));
        router.setMarketSession(true, true);
        registry.setOracleRouter(address(router));

        feeCollector = FeeCollector(address(new ERC1967Proxy(address(new FeeCollector()), "")));
        feeCollector.initialize(address(this), treasury, safetyReserve);

        core = LoanCore(address(new ERC1967Proxy(address(new LoanCore()), "")));
        auction = LiquidationAuction(address(new ERC1967Proxy(address(new LiquidationAuction()), "")));
        orderSettlement = OrderSettlement(address(new ERC1967Proxy(address(new OrderSettlement()), "")));

        core.initialize(
            address(this),
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
        core.setGlobalCap(GLOBAL_CAP);
        auction.initialize(address(this), address(escrow), address(core), address(feeCollector), address(usdc));
        orderSettlement.initialize(address(this), address(core), address(gate));

        escrow.setAuthorizedCore(address(core), true);
        escrow.setAuthorizedCore(address(auction), true);
        nft.setAuthorizedCore(address(core), true);

        registry.setAssetConfig(address(stock8), _defaultCfg(address(feed8), ASSET_CAP));
        registry.setAssetConfig(address(stock18), _defaultCfg(address(feed18), ASSET_CAP));
        router.syncMultiplier(address(stock8));
        router.syncMultiplier(address(stock18));
    }

    function _defaultCfg(address feed, uint128 assetCap) internal pure returns (IAssetRegistry.AssetConfig memory) {
        return IAssetRegistry.AssetConfig({
            feed: feed,
            feedDecimals: 8,
            tier: 0,
            maxInitLtvBps: 6000,
            marginCallLtvBps: 7000,
            liqLtvBps: 7800,
            badDebtLtvBps: 9000,
            maxDiscountBps: 600,
            closedMarketHaircutBps: 500,
            perLoanCap: PER_LOAN_CAP,
            assetCap: assetCap,
            maxStaleOpenSecs: 86400,
            status: uint8(IAssetRegistry.AssetStatus.Active),
            restricted: false
        });
    }

    // ---------------- Independent Pure Fee Helpers ----------------

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

    function _findLoanByStatus(uint256 idxSeed, bool wantAuction) internal view returns (bool found, uint256 loanId) {
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

    function _safeColForPrincipal(uint128 principal, uint256 price8, uint256 colUnit, uint256 extraSeed) internal pure returns (uint128) {
        // 2.2x gross collateral value (~45% LTV, <= 48% after 5% closed-market haircut)
        uint256 minRaw = (uint256(principal) * 220 * colUnit) / price8 + colUnit;
        uint256 extra = (extraSeed % 15) * colUnit;
        return uint128(minRaw + extra);
    }

    // ---------------- Fuzz Actions ----------------

    function actionOpenLoan(
        uint256 colSeed,
        uint256 prinSeed,
        bool useAsset18,
        bool useBorrowerB,
        bool useLenderB
    ) external {
        if (openLoanIds.length >= 12) return;
        if (core.paused()) return;
        if (!router.isSequencerValid()) return;

        MockERC20 tok = useAsset18 ? stock18 : stock8;
        MockAggregator feed = useAsset18 ? feed18 : feed8;
        EchidnaActor b = useBorrowerB ? borrowerB : borrowerA;
        EchidnaActor lnd = useLenderB ? lenderB : lenderA;
        uint256 colUnit = useAsset18 ? 1e18 : 1e8;

        feed.setUpdatedAt(block.timestamp);
        (uint256 px, , IOracleRouter.OracleState st) = router.getPrice(address(tok));
        if (st != IOracleRouter.OracleState.VALID_OPEN && st != IOracleRouter.OracleState.VALID_CLOSED) return;
        if (px < 10e8) {
            px = useAsset18 ? 500e8 : 200e8;
            feed.setPrice(int256(px));
        }

        uint256 remGlobal = core.globalUsdcCap() > core.totalOutstandingPrincipal()
            ? core.globalUsdcCap() - core.totalOutstandingPrincipal()
            : 0;
        uint256 remAsset = ASSET_CAP > core.assetOutstandingPrincipal(address(tok))
            ? ASSET_CAP - core.assetOutstandingPrincipal(address(tok))
            : 0;
        uint256 maxAllowed = remGlobal < remAsset ? remGlobal : remAsset;
        if (maxAllowed > PER_LOAN_CAP) maxAllowed = PER_LOAN_CAP;
        if (maxAllowed < 500e6) return;

        uint128 principal = uint128(500e6 + (prinSeed % (maxAllowed - 500e6 + 1)));
        uint128 colAmt = _safeColForPrincipal(principal, px, colUnit, colSeed);

        tok.mint(address(b), colAmt);
        b.approveToken(address(tok), address(escrow), colAmt);
        usdc.mint(address(lnd), principal);
        lnd.approveToken(address(usdc), address(core), principal);

        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);
        uint256 borrowerUsdcBefore = usdc.balanceOf(address(b));
        uint128 expFee = _expectedOrigFee(principal);

        openLoanAttempts++;
        try core.openLoan(
            address(b),
            address(lnd),
            address(tok),
            colAmt,
            principal,
            800,
            7,
            6000,
            1,
            0
        ) returns (uint256 loanId) {
            openedLoansCount++;
            openLoanIds.push(loanId);
            ghostEscrow[address(tok)] += colAmt;

            uint256 actualFee = (usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore;
            uint256 actualProceeds = usdc.balanceOf(address(b)) - borrowerUsdcBefore;
            if (actualFee != expFee || actualProceeds != principal - expFee) {
                _capOrFeeViolated = true;
            }
            ghostExpectedFees += expFee;
        } catch {
            _unexpectedActionRevert = true;
        }
    }

    /// @notice Actively probes all 3 caps (perLoanCap, assetCap, globalUsdcCap) independently so any removed cap check fails immediately.
    function actionAttemptOverCapLoans(bool useAsset18) external {
        if (core.paused() || !router.isSequencerValid()) return;
        MockERC20 tok = useAsset18 ? stock18 : stock8;
        MockAggregator feed = useAsset18 ? feed18 : feed8;
        uint256 colUnit = useAsset18 ? 1e18 : 1e8;

        feed.setUpdatedAt(block.timestamp);
        (uint256 px, , IOracleRouter.OracleState st) = router.getPrice(address(tok));
        if (st != IOracleRouter.OracleState.VALID_OPEN && st != IOracleRouter.OracleState.VALID_CLOSED) return;
        if (px < 10e8) return;

        uint256 totalOut = core.totalOutstandingPrincipal();
        uint256 assetOut = core.assetOutstandingPrincipal(address(tok));

        // Probe 1: Pure PerLoanCapExceeded (exceeds PER_LOAN_CAP while staying within ASSET_CAP and GLOBAL_CAP)
        uint128 overPerLoan = PER_LOAN_CAP + 500e6;
        if (totalOut + overPerLoan <= GLOBAL_CAP && assetOut + overPerLoan <= ASSET_CAP) {
            uint128 col1 = _safeColForPrincipal(overPerLoan, px, colUnit, 0);
            tok.mint(address(borrowerA), col1);
            borrowerA.approveToken(address(tok), address(escrow), col1);
            usdc.mint(address(lenderA), overPerLoan);
            lenderA.approveToken(address(usdc), address(core), overPerLoan);
            try core.openLoan(address(borrowerA), address(lenderA), address(tok), col1, overPerLoan, 800, 7, 6000, 1, 0) {
                _capOrFeeViolated = true;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != LoanCore.PerLoanCapExceeded.selector) {
                    _capOrFeeViolated = true;
                } else {
                    overCapPerLoanRevertsCount++;
                }
            }
        }

        // Probe 2: Pure AssetCapExceeded (<= PER_LOAN_CAP and total+prin <= GLOBAL_CAP, ONLY exceeds ASSET_CAP)
        if (ASSET_CAP > assetOut) {
            uint256 remAsset = ASSET_CAP - assetOut;
            uint256 cand = remAsset + 500e6;
            if (cand <= PER_LOAN_CAP && totalOut + cand <= GLOBAL_CAP) {
                uint128 overAsset = uint128(cand);
                uint128 col2 = _safeColForPrincipal(overAsset, px, colUnit, 0);
                tok.mint(address(borrowerA), col2);
                borrowerA.approveToken(address(tok), address(escrow), col2);
                usdc.mint(address(lenderA), overAsset);
                lenderA.approveToken(address(usdc), address(core), overAsset);
                try core.openLoan(address(borrowerA), address(lenderA), address(tok), col2, overAsset, 800, 7, 6000, 1, 0) {
                    _capOrFeeViolated = true;
                } catch (bytes memory err) {
                    if (err.length < 4 || bytes4(err) != LoanCore.AssetCapExceeded.selector) {
                        _capOrFeeViolated = true;
                    } else {
                        overCapAssetRevertsCount++;
                    }
                }
            }
        }

        // Probe 3: Pure GlobalCapExceeded (<= PER_LOAN_CAP and asset+prin <= ASSET_CAP, ONLY exceeds GLOBAL_CAP)
        if (GLOBAL_CAP > totalOut) {
            uint256 remGlobal = GLOBAL_CAP - totalOut;
            uint256 candG = remGlobal + 500e6;
            if (candG <= PER_LOAN_CAP && assetOut + candG <= ASSET_CAP) {
                uint128 overGlobal = uint128(candG);
                uint128 col3 = _safeColForPrincipal(overGlobal, px, colUnit, 0);
                tok.mint(address(borrowerA), col3);
                borrowerA.approveToken(address(tok), address(escrow), col3);
                usdc.mint(address(lenderA), overGlobal);
                lenderA.approveToken(address(usdc), address(core), overGlobal);
                try core.openLoan(address(borrowerA), address(lenderA), address(tok), col3, overGlobal, 800, 7, 6000, 1, 0) {
                    _capOrFeeViolated = true;
                } catch (bytes memory err) {
                    if (err.length < 4 || bytes4(err) != LoanCore.GlobalCapExceeded.selector) {
                        _capOrFeeViolated = true;
                    } else {
                        overCapGlobalRevertsCount++;
                    }
                }
            }
        }
    }

    function actionTopUp(uint256 idxSeed, uint256 addSeed) external {
        (bool found, uint256 loanId) = _findLoanByStatus(idxSeed, false);
        if (!found) return;
        ILoanCore.Loan memory l = core.getLoan(loanId);

        MockERC20 tok = MockERC20(l.collateralToken);
        uint128 extra = l.collateralToken == address(stock18)
            ? uint128(1 + (addSeed % 5e18))
            : uint128(1 + (addSeed % 5e8));
        EchidnaActor actor = l.borrower == address(borrowerB) ? borrowerB : borrowerA;
        tok.mint(address(actor), extra);
        actor.approveToken(address(tok), address(escrow), extra);

        try actor.callTarget(address(core), abi.encodeCall(LoanCore.topUp, (loanId, extra))) {
            ghostEscrow[address(tok)] += extra;
            topUpsCount++;
        } catch {
            _unexpectedActionRevert = true;
        }
    }

    /// @notice Transfers PositionNFT between lenderA and lenderB (testing Roadmap #8) and probes auction transfer lock.
    function actionTransferNft(uint256 idxSeed) external {
        if (openLoanIds.length == 0) return;
        uint256 loanId = openLoanIds[idxSeed % openLoanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        address holderAddr = nft.ownerOf(loanId);
        EchidnaActor holder = holderAddr == address(lenderB) ? lenderB : lenderA;
        address dest = holderAddr == address(lenderB) ? address(lenderA) : address(lenderB);

        if (l.status == uint8(ILoanCore.LoanStatus.Auction)) {
            try holder.callTarget(
                address(nft),
                abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", holderAddr, dest, loanId)
            ) {
                _entitlementViolated = true;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != PositionNFT.AuctionTransferLocked.selector) {
                    _entitlementViolated = true;
                }
            }
            return;
        }

        try holder.callTarget(
            address(nft),
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", holderAddr, dest, loanId)
        ) {
            if (nft.ownerOf(loanId) != dest) _entitlementViolated = true;
            nftTransfersCount++;
        } catch {
            _unexpectedActionRevert = true;
        }
    }

    function actionRepay(uint256 idxSeed) external {
        if (openLoanIds.length == 0) return;
        uint256 loanId = openLoanIds[idxSeed % openLoanIds.length];
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.status > uint8(ILoanCore.LoanStatus.Auction)) return;

        address holder = nft.ownerOf(loanId);
        address otherLender = holder == address(lenderB) ? address(lenderA) : address(lenderB);
        uint256 holderClaimBefore = core.getClaimable(holder);
        uint256 otherClaimBefore = core.getClaimable(otherLender);
        uint256 borrowerClaimBefore = core.getClaimable(l.borrower);
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);
        uint256 bColBefore = MockERC20(l.collateralToken).balanceOf(l.borrower);

        uint128 rem = l.principal - l.principalRepaid;
        uint128 due = core.getDueInterest(loanId);
        uint128 need = rem + due;
        uint128 expCut = _expectedIntCut(due);

        EchidnaActor actor = l.borrower == address(borrowerB) ? borrowerB : borrowerA;
        usdc.mint(address(actor), need);
        actor.approveToken(address(usdc), address(core), need);

        uint128 colBefore = l.collateralRaw;
        repayAttempts++;
        try actor.callTarget(address(core), abi.encodeCall(LoanCore.repay, (loanId))) {
            repaidLoansCount++;
            _removeOpenLoan(loanId);
            ghostEscrow[l.collateralToken] -= colBefore;

            uint256 actualFee = (usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore;
            if (actualFee != expCut) _capOrFeeViolated = true;
            ghostExpectedFees += expCut;

            // Roadmap #8: NFT owner at instant of repayment is sole entity credited
            if (core.getClaimable(holder) - holderClaimBefore != uint256(rem) + (due - expCut)) {
                _entitlementViolated = true;
            }
            if (core.getClaimable(otherLender) != otherClaimBefore) _entitlementViolated = true;
            if (core.getClaimable(l.borrower) != borrowerClaimBefore) _entitlementViolated = true;
            if (MockERC20(l.collateralToken).balanceOf(l.borrower) - bColBefore != colBefore) {
                _surplusViolated = true;
            }
        } catch {
            _unexpectedActionRevert = true;
        }
    }

    /// @notice Probes Roadmap #4 healthy negative case, then targets exact liquidatable LTV (83% partial or 92% full/surplus).
    function actionSetPriceAndLiquidate(uint256 idxSeed, bool wantFullClose) external {
        if (!router.isSequencerValid()) return;
        (bool found, uint256 loanId) = _findLoanByStatus(idxSeed, false);
        if (!found) return;
        ILoanCore.Loan memory l = core.getLoan(loanId);
        if (l.collateralRaw < 2 && !wantFullClose) return;

        MockAggregator feed = l.collateralToken == address(stock18) ? feed18 : feed8;
        uint256 colUnit = l.collateralToken == address(stock18) ? 1e18 : 1e8;
        router.setMarketSession(true, true);
        feed.setUpdatedAt(block.timestamp);

        uint256 debt = uint256(l.principal - l.principalRepaid) + core.getDueInterest(loanId);

        // Roadmap #4 negative check: if currently healthy under VALID_OPEN, startLiquidation MUST revert
        (uint256 grossBefore, , IOracleRouter.OracleState stBefore) = router.getValue(l.collateralToken, l.collateralRaw);
        if (stBefore == IOracleRouter.OracleState.VALID_OPEN && grossBefore > 0 && (debt * 10000) / grossBefore < l.liqLtvBps) {
            try keeper.callTarget(address(core), abi.encodeCall(LoanCore.startLiquidation, (loanId))) {
                _auctionConditionViolated = true;
                return;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != LoanCore.LoanNotLiquidatable.selector) {
                    _auctionConditionViolated = true;
                }
            }
        }

        // Compute exact target crash price: 8300 bps (50% partial) or 9200 bps (100% full -> yields borrower surplus on buy!)
        uint256 targetLtv = wantFullClose ? 9200 : 8300;
        uint256 targetPrice8 = (debt * 10000 * colUnit * 100) / (uint256(l.collateralRaw) * targetLtv);
        if (targetPrice8 < 2e8) return;

        feed.setPrice(int256(targetPrice8));
        (uint256 grossAfter, , IOracleRouter.OracleState stAfter) = router.getValue(l.collateralToken, l.collateralRaw);
        if (stAfter != IOracleRouter.OracleState.VALID_OPEN || grossAfter == 0) return;
        if ((debt * 10000) / grossAfter < l.liqLtvBps) {
            targetPrice8 = (targetPrice8 * 97) / 100;
            if (targetPrice8 < 1e8) return;
            feed.setPrice(int256(targetPrice8));
        }

        liquidationAttempts++;
        try keeper.callTarget(address(core), abi.encodeCall(LoanCore.startLiquidation, (loanId))) {
            liquidationsStartedCount++;
            if (core.loanActiveAuction(loanId) == 0 || !nft.isAuctionLocked(loanId)) {
                _auctionConditionViolated = true;
            }
        } catch {
            _unexpectedActionRevert = true;
        }
    }

    function actionStartDefaultAuction(uint256 idxSeed) external {
        if (!router.isSequencerValid()) return;
        uint256 len = openLoanIds.length;
        if (len == 0) return;
        uint256 start = idxSeed % len;
        uint256 preGraceLoanId = 0;

        for (uint256 i = 0; i < len; i++) {
            uint256 id = openLoanIds[(start + i) % len];
            ILoanCore.Loan memory l = core.getLoan(id);
            if (l.status != uint8(ILoanCore.LoanStatus.Active) && l.status != uint8(ILoanCore.LoanStatus.Grace)) continue;
            if (block.timestamp <= l.maturity + core.GRACE_PERIOD_SECONDS()) {
                if (preGraceLoanId == 0) preGraceLoanId = id;
                continue;
            }

            MockAggregator feed = l.collateralToken == address(stock18) ? feed18 : feed8;
            router.setMarketSession(true, true);
            feed.setUpdatedAt(block.timestamp);

            defaultAuctionAttempts++;
            try keeper.callTarget(address(core), abi.encodeCall(LoanCore.startDefaultAuction, (id))) {
                defaultAuctionsStartedCount++;
                if (core.loanActiveAuction(id) == 0 || !nft.isAuctionLocked(id)) {
                    _auctionConditionViolated = true;
                }
            } catch {
                _unexpectedActionRevert = true;
            }
            return;
        }

        // Roadmap #4 negative check: pre-grace default auction MUST revert LoanNotInGrace
        if (preGraceLoanId != 0) {
            try keeper.callTarget(address(core), abi.encodeCall(LoanCore.startDefaultAuction, (preGraceLoanId))) {
                _auctionConditionViolated = true;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != LoanCore.LoanNotInGrace.selector) {
                    _auctionConditionViolated = true;
                }
            }
        }
    }

    /// @notice Buys active auction collateral and checks Roadmap #5 (Borrower Surplus), #6 (Fees), #8 (Claimant Entitlement).
    function actionBuyAuction(uint256 idxSeed, uint256 fracBpsSeed) external {
        (bool found, uint256 loanId) = _findLoanByStatus(idxSeed, true);
        if (!found) return;
        uint256 aucId = core.loanActiveAuction(loanId);
        ILiquidationAuction.Auction memory a = auction.getAuction(aucId);
        if (a.status != ILiquidationAuction.AuctionStatus.Active || a.collateralRemaining == 0) return;

        // If expired during open market, restart/cancel cleanly first
        if (block.timestamp > a.startTime + a.duration && router.isMarketOpen()) {
            MockAggregator feed = a.collateralToken == address(stock18) ? feed18 : feed8;
            feed.setUpdatedAt(block.timestamp);
            auction.restartOrCancelAuction(aucId);
            restartOrCancelCount++;
            a = auction.getAuction(aucId);
            if (a.status != ILiquidationAuction.AuctionStatus.Active || a.collateralRemaining == 0) return;
        }

        uint256 bps = (fracBpsSeed % 2 == 0) ? 10000 : (3000 + (fracBpsSeed % 7001));
        uint128 colToBuy = uint128((uint256(a.collateralRemaining) * bps) / 10000);
        if (colToBuy == 0) colToBuy = a.collateralRemaining;

        uint256 curPrice = auction.getCurrentPrice(aucId);
        uint256 colUnit = a.collateralToken == address(stock18) ? 1e18 : 1e8;
        uint256 den = colUnit * 1e8;
        uint256 num = uint256(colToBuy) * curPrice * 1e6;
        uint128 expectedPaid = uint128((num + den - 1) / den);
        if (expectedPaid < auction.MIN_BUY_USDC() && colToBuy != a.collateralRemaining) {
            colToBuy = a.collateralRemaining;
            num = uint256(colToBuy) * curPrice * 1e6;
            expectedPaid = uint128((num + den - 1) / den);
        }
        if (expectedPaid == 0) return;

        address holder = nft.ownerOf(loanId);
        address otherLender = holder == address(lenderB) ? address(lenderA) : address(lenderB);
        uint256 holderClaimBefore = core.getClaimable(holder);
        uint256 otherClaimBefore = core.getClaimable(otherLender);
        uint256 bUsdcBefore = usdc.balanceOf(a.borrower);
        uint256 bColBefore = MockERC20(a.collateralToken).balanceOf(a.borrower);
        uint256 kUsdcBefore = usdc.balanceOf(a.keeper);
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);
        uint128 loanColBefore = core.getLoan(loanId).collateralRaw;
        uint128 dueInterestBefore = core.getDueInterest(loanId);

        usdc.mint(address(liquidator), expectedPaid);
        liquidator.approveToken(address(usdc), address(auction), expectedPaid);

        buyAttempts++;
        try liquidator.callTarget(
            address(auction),
            abi.encodeCall(LiquidationAuction.buy, (aucId, colToBuy, expectedPaid))
        ) returns (bytes memory ret) {
            auctionBuysCount++;
            uint128 paid = abi.decode(ret, (uint128));

            (uint128 expLiqProt, uint128 expKeeper) = _expectedLiqFee(paid);
            uint128 netProceeds = paid - (expLiqProt + expKeeper);
            uint128 expIntPaid = netProceeds > dueInterestBefore ? dueInterestBefore : netProceeds;
            uint128 prinAvail = netProceeds - expIntPaid;
            uint128 expPrinPaid = prinAvail > a.debtPrincipalRemaining ? a.debtPrincipalRemaining : prinAvail;
            uint128 expSurplus = prinAvail - expPrinPaid;
            uint128 expIntCut = _expectedIntCut(expIntPaid);

            // Roadmap #5: Exact borrower USDC surplus
            if (usdc.balanceOf(a.borrower) - bUsdcBefore != expSurplus) {
                _surplusViolated = true;
            }
            if (expSurplus > 0) surplusRefundsCount++;

            // Roadmap #6: Independent liquidation fee, keeper reward, and interest cut math
            if (usdc.balanceOf(a.keeper) - kUsdcBefore != expKeeper) {
                _capOrFeeViolated = true;
            }
            uint256 actualFeeDelta = (usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore;
            if (actualFeeDelta != uint256(expLiqProt) + expIntCut) {
                _capOrFeeViolated = true;
            }
            ghostExpectedFees += uint256(expLiqProt) + expIntCut;

            // Roadmap #8: NFT holder at instant of settlement is sole entity credited
            if (core.getClaimable(holder) - holderClaimBefore != uint256(expPrinPaid) + (expIntPaid - expIntCut)) {
                _entitlementViolated = true;
            }
            if (core.getClaimable(otherLender) != otherClaimBefore) {
                _entitlementViolated = true;
            }

            ILoanCore.Loan memory lAfter = core.getLoan(loanId);
            ghostEscrow[a.collateralToken] -= (loanColBefore - lAfter.collateralRaw);

            if (lAfter.status > uint8(ILoanCore.LoanStatus.Auction)) {
                _removeOpenLoan(loanId);
                // Roadmap #5: Residual collateral returned directly to borrower when debt is 100% satisfied
                if (lAfter.principalRepaid >= lAfter.principal) {
                    if (
                        lAfter.collateralRaw != 0 ||
                        MockERC20(a.collateralToken).balanceOf(a.borrower) - bColBefore != loanColBefore - colToBuy
                    ) {
                        _surplusViolated = true;
                    }
                }
            }
        } catch {
            _unexpectedActionRevert = true;
        }
    }

    /// @notice Roadmap #2: Probes that NFT holder, borrower, and liquidator have ZERO direct withdrawal vectors on CollateralEscrow.
    function actionProbeEscrowIsolation(uint256 idxSeed) external {
        address tok = (idxSeed % 2 == 0) ? address(stock8) : address(stock18);
        EchidnaActor[4] memory intruders = [lenderA, lenderB, borrowerA, liquidator];
        for (uint256 i = 0; i < 4; i++) {
            try intruders[i].callTarget(
                address(escrow),
                abi.encodeCall(CollateralEscrow.releaseCollateral, (tok, address(intruders[i]), 1))
            ) {
                _escrowIsolationViolated = true;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != CollateralEscrow.UnauthorizedCaller.selector) {
                    _escrowIsolationViolated = true;
                }
            }
            try intruders[i].callTarget(
                address(escrow),
                abi.encodeCall(CollateralEscrow.depositCollateral, (tok, address(intruders[i]), 1))
            ) {
                _escrowIsolationViolated = true;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != CollateralEscrow.UnauthorizedCaller.selector) {
                    _escrowIsolationViolated = true;
                }
            }
        }
        escrowIsolationProbesCount++;
    }

    /// @notice Roadmap #3 & #4: Verifies topUp, repay, and claim NEVER fail under pause, asset freeze, or B20 split freeze,
    ///         while openLoan and startLiquidation are blocked under freeze/pause.
    function actionTestPauseAndFreezeUnstoppable(uint256 idxSeed, uint8 modeSeed) external {
        (bool found, uint256 loanId) = _findLoanByStatus(idxSeed, false);
        if (!found) return;
        ILoanCore.Loan memory l = core.getLoan(loanId);
        MockERC20 tok = MockERC20(l.collateralToken);
        EchidnaActor borrower = l.borrower == address(borrowerB) ? borrowerB : borrowerA;
        address holderAddr = nft.ownerOf(loanId);
        EchidnaActor holder = holderAddr == address(lenderB) ? lenderB : lenderA;
        uint8 mode = modeSeed % 3;

        if (mode == 0) {
            guardianActor.callTarget(address(core), abi.encodeCall(LoanCore.setPaused, (true)));
        } else if (mode == 1) {
            guardianActor.callTarget(
                address(registry),
                abi.encodeCall(AssetRegistry.setAssetStatus, (address(tok), IAssetRegistry.AssetStatus.Frozen))
            );
        } else {
            tok.setUiMultiplier(2e18); // >= 5% corporate-action jump -> FROZEN_CORPORATE_ACTION
        }

        // Negative: openLoan must revert with exact pause/freeze error under pause/freeze
        if (
            mode == 0 ||
            (core.totalOutstandingPrincipal() + 500e6 <= GLOBAL_CAP &&
                core.assetOutstandingPrincipal(address(tok)) + 500e6 <= ASSET_CAP)
        ) {
            try core.openLoan(address(borrower), address(lenderA), address(tok), 1e8, 500e6, 800, 7, 6000, 1, 0) {
                _unstoppableViolated = true;
            } catch (bytes memory err) {
                bytes4 expectedSel = mode == 0
                    ? LoanCore.ProtocolPaused.selector
                    : (mode == 1 ? LoanCore.AssetNotActive.selector : LoanCore.OracleInvalidForAction.selector);
                if (err.length < 4 || bytes4(err) != expectedSel) {
                    _unstoppableViolated = true;
                }
            }
        }

        // Negative (Roadmap #4): startLiquidation must revert under frozen oracle (modes 1 & 2)
        if (mode != 0) {
            try keeper.callTarget(address(core), abi.encodeCall(LoanCore.startLiquidation, (loanId))) {
                _auctionConditionViolated = true;
            } catch (bytes memory err) {
                if (err.length < 4 || bytes4(err) != LoanCore.OracleInvalidForAction.selector) {
                    _auctionConditionViolated = true;
                }
            }
        }

        // Positive 1: topUp MUST succeed
        tok.mint(address(borrower), 1);
        borrower.approveToken(address(tok), address(escrow), 1);
        try borrower.callTarget(address(core), abi.encodeCall(LoanCore.topUp, (loanId, 1))) {
            ghostEscrow[address(tok)] += 1;
            topUpsCount++;
        } catch {
            _unstoppableViolated = true;
        }

        // Positive 2: repay MUST succeed
        ILoanCore.Loan memory lMid = core.getLoan(loanId);
        uint128 rem = lMid.principal - lMid.principalRepaid;
        uint128 due = core.getDueInterest(loanId);
        uint128 need = rem + due;
        uint128 expCut = _expectedIntCut(due);
        uint256 feeBefore = usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve);
        uint256 holderClaimBefore = core.getClaimable(holderAddr);
        usdc.mint(address(borrower), need);
        borrower.approveToken(address(usdc), address(core), need);

        repayAttempts++;
        try borrower.callTarget(address(core), abi.encodeCall(LoanCore.repay, (loanId))) {
            repaidLoansCount++;
            _removeOpenLoan(loanId);
            ghostEscrow[address(tok)] -= lMid.collateralRaw;
            uint256 actualFee = (usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve)) - feeBefore;
            if (actualFee != expCut) _capOrFeeViolated = true;
            ghostExpectedFees += expCut;
            if (core.getClaimable(holderAddr) - holderClaimBefore != uint256(rem) + (due - expCut)) {
                _entitlementViolated = true;
            }
        } catch {
            _unstoppableViolated = true;
        }

        // Positive 3: claim MUST succeed for the NFT holder while still paused/frozen
        uint256 claimNow = core.getClaimable(holderAddr);
        if (claimNow > 0) {
            uint256 hBalBefore = usdc.balanceOf(holderAddr);
            claimAttempts++;
            try holder.callTarget(address(core), abi.encodeCall(LoanCore.claim, (holderAddr))) {
                claimsCount++;
                if (usdc.balanceOf(holderAddr) - hBalBefore != claimNow || core.getClaimable(holderAddr) != 0) {
                    _creditViolated = true;
                }
            } catch {
                _unstoppableViolated = true;
            }
        }

        // Restore cleanly for subsequent fuzz steps
        if (mode == 0) {
            guardianActor.callTarget(address(core), abi.encodeCall(LoanCore.setPaused, (false)));
        } else if (mode == 1) {
            registry.setAssetStatus(address(tok), IAssetRegistry.AssetStatus.Active);
        } else {
            tok.setUiMultiplier(1e18);
        }
        unstoppableChecksCount++;
    }

    function actionClaimLender(bool useLenderB) external {
        EchidnaActor lnd = useLenderB ? lenderB : lenderA;
        if (core.getClaimable(address(lnd)) == 0) {
            lnd = useLenderB ? lenderA : lenderB;
        }
        uint256 amt = core.getClaimable(address(lnd));
        if (amt == 0) return;
        uint256 balBefore = usdc.balanceOf(address(lnd));
        claimAttempts++;
        try lnd.callTarget(address(core), abi.encodeCall(LoanCore.claim, (address(lnd)))) {
            claimsCount++;
            if (usdc.balanceOf(address(lnd)) - balBefore != amt || core.getClaimable(address(lnd)) != 0) {
                _creditViolated = true;
            }
        } catch {
            _unexpectedActionRevert = true;
        }
    }

    /// @notice Strictly verifies BOTH EligibilityGate.bumpMyNonce() and OrderSettlement.bumpNonce() increment by +1.
    function actionBumpNonce() external {
        uint256 gBefore = gate.userNonce(address(borrowerA));
        try borrowerA.callTarget(address(gate), abi.encodeCall(EligibilityGate.bumpMyNonce, ())) {
            if (gate.userNonce(address(borrowerA)) != gBefore + 1) _nonceViolated = true;
            ghostExpectedGateNonce += 1;
        } catch {
            _unexpectedActionRevert = true;
        }

        uint256 oBefore = orderSettlement.getMakerNonce(address(borrowerA));
        try borrowerA.callTarget(address(orderSettlement), abi.encodeCall(OrderSettlement.bumpNonce, ())) returns (bytes memory ret) {
            uint256 retNonce = abi.decode(ret, (uint256));
            if (retNonce != oBefore + 1 || orderSettlement.getMakerNonce(address(borrowerA)) != oBefore + 1) {
                _nonceViolated = true;
            }
            ghostExpectedOrderNonce += 1;
        } catch {
            _unexpectedActionRevert = true;
        }
        nonceBumpsCount++;
    }

    // ---------------- 8 Roadmap Invariants (NOSTOK_PRODUCTION_ROADMAP.md lines 76-84) + Liveness ----------------

    /// @notice Roadmap Invariant 1 — Collateral Solvency:
    ///         Sum of collateral across active loans + active auctions equals CollateralEscrow ledger and physical ERC-20 balance.
    function echidna_1_collateral_solvency() public view returns (bool) {
        if (escrow.getBalance(address(stock8)) != ghostEscrow[address(stock8)]) return false;
        if (stock8.balanceOf(address(escrow)) != ghostEscrow[address(stock8)]) return false;
        if (escrow.getBalance(address(stock18)) != ghostEscrow[address(stock18)]) return false;
        if (stock18.balanceOf(address(escrow)) != ghostEscrow[address(stock18)]) return false;

        uint256 sum8;
        uint256 sum18;
        for (uint256 i = 0; i < openLoanIds.length; i++) {
            ILoanCore.Loan memory l = core.getLoan(openLoanIds[i]);
            if (l.collateralToken == address(stock8)) sum8 += l.collateralRaw;
            else if (l.collateralToken == address(stock18)) sum18 += l.collateralRaw;
        }
        return sum8 == ghostEscrow[address(stock8)] && sum18 == ghostEscrow[address(stock18)];
    }

    /// @notice Roadmap Invariant 2 — Strict Escrow Isolation:
    ///         Only LoanCore and LiquidationAuction are authorized on CollateralEscrow; NFT holders & users have zero direct exit vectors.
    function echidna_2_strict_escrow_isolation() public view returns (bool) {
        if (_escrowIsolationViolated) return false;
        if (!escrow.isAuthorizedCore(address(core)) || !escrow.isAuthorizedCore(address(auction))) return false;
        if (escrow.isAuthorizedCore(address(lenderA)) || escrow.isAuthorizedCore(address(lenderB))) return false;
        if (escrow.isAuthorizedCore(address(borrowerA)) || escrow.isAuthorizedCore(address(borrowerB))) return false;
        if (escrow.isAuthorizedCore(address(keeper)) || escrow.isAuthorizedCore(address(liquidator))) return false;
        return true;
    }

    /// @notice Roadmap Invariant 3 — Unstoppable Protocol Liquidity:
    ///         repay(), topUp(), and claim() are never blocked by LoanCore.paused, asset freeze, or B20 multiplier freeze.
    function echidna_3_unstoppable_liquidity() public view returns (bool) {
        return !_unstoppableViolated;
    }

    /// @notice Roadmap Invariant 4 — Valid Auction Condition & Stale/Closed Settlement:
    ///         Auctions only start on valid LTV breach / post-grace default under VALID_OPEN; active auctions stay locked with valid bounds.
    function echidna_4_valid_auction_condition() public view returns (bool) {
        if (_auctionConditionViolated) return false;
        for (uint256 i = 0; i < openLoanIds.length; i++) {
            uint256 id = openLoanIds[i];
            ILoanCore.Loan memory l = core.getLoan(id);
            bool isAuc = l.status == uint8(ILoanCore.LoanStatus.Auction);
            uint256 aucId = core.loanActiveAuction(id);
            if ((aucId != 0) != isAuc) return false;
            if (nft.isAuctionLocked(id) != isAuc) return false;
            if (isAuc) {
                ILiquidationAuction.Auction memory a = auction.getAuction(aucId);
                if (a.status != ILiquidationAuction.AuctionStatus.Active) return false;
                if (a.floorPrice == 0 || a.startPrice < a.floorPrice) return false;
            }
        }
        return true;
    }

    /// @notice Roadmap Invariant 5 — Borrower Surplus Protection:
    ///         Exact excess USDC proceeds and residual collateral after full payoff return directly to borrower.
    function echidna_5_borrower_surplus_protection() public view returns (bool) {
        return !_surplusViolated;
    }

    /// @notice Roadmap Invariant 6 — Debt Payoff Invariance, Protocol Caps, Independent Fee Math & Strict Nonces:
    ///         principalRepaid <= principal, caps strictly enforced, independent fee sum matches treasury+reserve, nonces strictly increment.
    function echidna_6_debt_payoff_caps_and_fees() public view returns (bool) {
        if (_capOrFeeViolated || _nonceViolated) return false;

        uint256 openPrincipal;
        uint256 p8;
        uint256 p18;
        for (uint256 i = 0; i < openLoanIds.length; i++) {
            ILoanCore.Loan memory l = core.getLoan(openLoanIds[i]);
            if (l.principalRepaid > l.principal) return false;
            uint256 rem = l.principal - l.principalRepaid;
            openPrincipal += rem;
            if (l.collateralToken == address(stock8)) p8 += rem;
            else if (l.collateralToken == address(stock18)) p18 += rem;
        }

        if (core.totalOutstandingPrincipal() != openPrincipal) return false;
        if (openPrincipal > core.globalUsdcCap()) return false;
        if (core.assetOutstandingPrincipal(address(stock8)) != p8 || p8 > ASSET_CAP) return false;
        if (core.assetOutstandingPrincipal(address(stock18)) != p18 || p18 > ASSET_CAP) return false;

        if (feeCollector.originationFeeBps() > feeCollector.MAX_ORIGINATION_BPS()) return false;
        if (feeCollector.interestCutBps() > feeCollector.MAX_INTEREST_CUT_BPS()) return false;
        if (feeCollector.liquidationFeeBps() > feeCollector.MAX_LIQUIDATION_BPS()) return false;
        if (usdc.balanceOf(treasury) + usdc.balanceOf(safetyReserve) != ghostExpectedFees) return false;

        if (gate.userNonce(address(borrowerA)) != ghostExpectedGateNonce) return false;
        if (orderSettlement.getMakerNonce(address(borrowerA)) != ghostExpectedOrderNonce) return false;
        return true;
    }

    /// @notice Roadmap Invariant 7 — Credit Conservation:
    ///         Total claimable USDC across all accounts never exceeds LoanCore USDC balance; LiquidationAuction retains 0 USDC.
    function echidna_7_credit_conservation() public view returns (bool) {
        if (_creditViolated) return false;
        uint256 totalClaimable =
            core.getClaimable(address(borrowerA)) +
            core.getClaimable(address(borrowerB)) +
            core.getClaimable(address(lenderA)) +
            core.getClaimable(address(lenderB)) +
            core.getClaimable(address(keeper)) +
            core.getClaimable(address(liquidator));
        if (usdc.balanceOf(address(core)) < totalClaimable) return false;
        if (usdc.balanceOf(address(auction)) != 0) return false;
        return true;
    }

    /// @notice Roadmap Invariant 8 — Claimant Entitlement:
    ///         The address owning PositionNFT(loanId) at repayment/settlement is the sole entity credited via claimable.
    function echidna_8_claimant_entitlement() public view returns (bool) {
        if (_entitlementViolated) return false;
        for (uint256 i = 0; i < openLoanIds.length; i++) {
            try nft.ownerOf(openLoanIds[i]) returns (address owner_) {
                if (owner_ == address(0)) return false;
            } catch {
                return false;
            }
        }
        return router.recordedMultiplier(address(stock8)) > 0 && router.recordedMultiplier(address(stock18)) > 0;
    }

    /// @notice Non-vacuity / Liveness Property:
    ///         Fails immediately if any valid-precondition openLoan, liquidation, buy, repay, or claim silently reverts.
    function echidna_9_liveness_no_silent_reverts() public view returns (bool) {
        if (_unexpectedActionRevert) return false;
        if (openLoanAttempts > 0 && openedLoansCount == 0) return false;
        if (liquidationAttempts > 0 && liquidationsStartedCount == 0) return false;
        if (buyAttempts > 0 && auctionBuysCount == 0) return false;
        if (repayAttempts > 0 && repaidLoansCount == 0) return false;
        if (claimAttempts > 0 && claimsCount == 0) return false;
        return true;
    }
}
