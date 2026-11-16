// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IFeeCollector} from "./interfaces/IFeeCollector.sol";

/**
 * @title FeeCollector
 * @notice Manages protocol fees with immutable hardcoded contractual ceilings.
 */
contract FeeCollector is Initializable, UUPSUpgradeable, OwnableUpgradeable, IFeeCollector {
    using SafeERC20 for IERC20;

    // Hardcoded immutable protocol caps
    uint16 public constant MAX_ORIGINATION_BPS = 100;     // 1.00%
    uint16 public constant MAX_INTEREST_CUT_BPS = 2000;    // 20.00%
    uint16 public constant MAX_LIQUIDATION_BPS = 300;     // 3.00%

    uint16 public override originationFeeBps;
    uint16 public override interestCutBps;
    uint16 public override liquidationFeeBps;
    uint16 public override safetyReserveShareBps;

    address public treasury;
    address public safetyReserve;

    error ZeroAddress();
    error FeeCapExceeded();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        address initialTreasury,
        address initialReserve
    ) external initializer {
        if (initialOwner == address(0) || initialTreasury == address(0) || initialReserve == address(0)) {
            revert ZeroAddress();
        }
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();

        treasury = initialTreasury;
        safetyReserve = initialReserve;

        // Default starting fee parameters
        originationFeeBps = 10;        // 0.10%
        interestCutBps = 1000;         // 10.00%
        liquidationFeeBps = 100;       // 1.00%
        safetyReserveShareBps = 2000;  // 20.00%
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setFeeRates(
        uint16 newOriginationBps,
        uint16 newInterestCutBps,
        uint16 newLiquidationBps,
        uint16 newReserveShareBps
    ) external onlyOwner {
        if (newOriginationBps > MAX_ORIGINATION_BPS) revert FeeCapExceeded();
        if (newInterestCutBps > MAX_INTEREST_CUT_BPS) revert FeeCapExceeded();
        if (newLiquidationBps > MAX_LIQUIDATION_BPS) revert FeeCapExceeded();
        if (newReserveShareBps > 10000) revert FeeCapExceeded();

        originationFeeBps = newOriginationBps;
        interestCutBps = newInterestCutBps;
        liquidationFeeBps = newLiquidationBps;
        safetyReserveShareBps = newReserveShareBps;

        emit FeeRatesUpdated(newOriginationBps, newInterestCutBps, newLiquidationBps);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setSafetyReserve(address newReserve) external onlyOwner {
        if (newReserve == address(0)) revert ZeroAddress();
        safetyReserve = newReserve;
        emit SafetyReserveUpdated(newReserve);
    }

    function calculateOriginationFee(uint128 principal) external view override returns (uint128) {
        if (principal == 0 || originationFeeBps == 0) return 0;
        return uint128((uint256(principal) * originationFeeBps + 9999) / 10000);
    }

    function calculateInterestCut(uint128 interest) external view override returns (uint128) {
        if (interest == 0 || interestCutBps == 0) return 0;
        return uint128((uint256(interest) * interestCutBps + 9999) / 10000);
    }

    function calculateLiquidationFee(
        uint128 collateralValue
    ) external view override returns (uint128 fee, uint128 keeperReward) {
        if (collateralValue == 0 || liquidationFeeBps == 0) return (0, 0);
        uint128 totalFee = uint128((uint256(collateralValue) * liquidationFeeBps + 9999) / 10000);
        // Keeper receives 30% of liquidation fee
        keeperReward = (totalFee * 3000) / 10000;
        fee = totalFee - keeperReward;
    }

    function distributeFees(address token, uint128 amount) external override {
        if (amount == 0 || token == address(0)) return;

        uint256 reservePortion = (uint256(amount) * safetyReserveShareBps) / 10000;
        uint256 treasuryPortion = amount - reservePortion;

        if (reservePortion > 0) {
            IERC20(token).safeTransferFrom(msg.sender, safetyReserve, reservePortion);
        }
        if (treasuryPortion > 0) {
            IERC20(token).safeTransferFrom(msg.sender, treasury, treasuryPortion);
        }

        emit FeeCollected(token, treasuryPortion, reservePortion);
    }

    uint256[50] private __gap;
}
