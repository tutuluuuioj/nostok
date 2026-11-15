// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";

/**
 * @title AssetRegistry
 * @notice UUPS upgradeable registry of risk parameters and lifecycle statuses for tokenized stock collateral.
 */
contract AssetRegistry is Initializable, UUPSUpgradeable, OwnableUpgradeable, IAssetRegistry {
    address public guardian;

    mapping(address => AssetConfig) private _configs;
    mapping(address => bool) private _supported;

    error UnauthorizedCaller();
    error ZeroAddress();
    error AssetNotSupported();
    error InvalidLtvParameters();
    error InvalidDiscountParameters();
    error GuardianCanOnlyTighten();

    event GuardianUpdated(address indexed newGuardian);

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) revert UnauthorizedCaller();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner, address initialGuardian) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        guardian = initialGuardian;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    /**
     * @notice Configures risk parameters for an asset. Only owner (multisig / timelock).
     */
    function setAssetConfig(address token, AssetConfig calldata config) external onlyOwner {
        if (token == address(0) || config.feed == address(0)) revert ZeroAddress();
        if (
            config.maxInitLtvBps > config.marginCallLtvBps ||
            config.marginCallLtvBps > config.liqLtvBps ||
            config.liqLtvBps > config.badDebtLtvBps ||
            config.badDebtLtvBps > 10000
        ) {
            revert InvalidLtvParameters();
        }

        // maxDiscountBps must be between 1% (100 bps) and 30% (3000 bps)
        // Values < 100 bps will brick the Dutch auction since start price is 99% (100 bps discount)
        if (config.maxDiscountBps < 100 || config.maxDiscountBps > 3000) {
            revert InvalidDiscountParameters();
        }

        _configs[token] = config;
        _supported[token] = true;

        emit AssetConfigSet(token, config);
    }

    /**
     * @notice Updates asset operational status.
     * Guardian can only tighten (transition to ReduceOnly or Frozen).
     * Only Owner can loosen (transition to Active).
     */
    function setAssetStatus(address token, AssetStatus newStatus) external onlyGuardianOrOwner {
        if (!_supported[token]) revert AssetNotSupported();

        AssetStatus currentStatus = AssetStatus(_configs[token].status);

        if (msg.sender == guardian && msg.sender != owner()) {
            // Guardian can only move to ReduceOnly or Frozen
            if (newStatus != AssetStatus.ReduceOnly && newStatus != AssetStatus.Frozen) {
                revert GuardianCanOnlyTighten();
            }
            if (currentStatus == AssetStatus.Frozen && newStatus == AssetStatus.Active) {
                revert GuardianCanOnlyTighten();
            }
        }

        _configs[token].status = uint8(newStatus);
        emit AssetStatusSet(token, newStatus);
    }

    function getAssetConfig(address token) external view override returns (AssetConfig memory) {
        if (!_supported[token]) revert AssetNotSupported();
        return _configs[token];
    }

    function getAssetStatus(address token) external view override returns (AssetStatus) {
        if (!_supported[token]) revert AssetNotSupported();
        return AssetStatus(_configs[token].status);
    }

    function isAssetSupported(address token) external view override returns (bool) {
        return _supported[token];
    }
}
