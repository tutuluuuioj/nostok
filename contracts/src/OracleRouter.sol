// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {IAssetRegistry} from "./interfaces/IAssetRegistry.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

interface IB20Token {
    function uiMultiplier() external view returns (uint256);
}

/**
 * @title OracleRouter
 * @notice Validates prices, market sessions, Base sequencer status, and corporate action freezes.
 */
contract OracleRouter is Initializable, UUPSUpgradeable, OwnableUpgradeable, IOracleRouter {
    address public assetRegistry;
    address public sequencerUptimeFeed;
    uint256 public sequencerGracePeriod;

    // Market session state: true = market open, false = market closed
    bool public isMarketOpenManual;
    bool public useManualMarketSession;

    // Track recorded B20 multipliers to catch unexpected corporate action changes
    mapping(address => uint256) public lastSeenMultiplier;

    error ZeroAddress();
    error InvalidAnswer();
    error AssetNotConfigured();

    event MarketSessionUpdated(bool isOpen, bool isManual);
    event AssetRegistryUpdated(address indexed registry);
    event SequencerFeedUpdated(address indexed feed, uint256 gracePeriod);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        address initialRegistry,
        address initialSequencerFeed
    ) external initializer {
        if (initialOwner == address(0) || initialRegistry == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();

        assetRegistry = initialRegistry;
        sequencerUptimeFeed = initialSequencerFeed;
        sequencerGracePeriod = 3600; // 1 hour grace period
        isMarketOpenManual = true;
        useManualMarketSession = false;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function setAssetRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        assetRegistry = newRegistry;
        emit AssetRegistryUpdated(newRegistry);
    }

    function setSequencerUptimeFeed(address newFeed, uint256 newGracePeriod) external onlyOwner {
        sequencerUptimeFeed = newFeed;
        sequencerGracePeriod = newGracePeriod;
        emit SequencerFeedUpdated(newFeed, newGracePeriod);
    }

    function setMarketSession(bool isOpen, bool isManual) external onlyOwner {
        isMarketOpenManual = isOpen;
        useManualMarketSession = isManual;
        emit MarketSessionUpdated(isOpen, isManual);
    }

    /**
     * @notice Evaluates whether US equity market is open.
     * US regular sessions: Mon-Fri 09:30 - 16:00 ET (14:30 - 21:00 UTC, subject to DST).
     * If useManualMarketSession is enabled, respects the manual override.
     */
    function isMarketOpen() public view returns (bool) {
        if (useManualMarketSession) {
            return isMarketOpenManual;
        }

        // Calendar computation based on UTC:
        // Day of week: 1 = Monday, ..., 5 = Friday, 6 = Saturday, 7 = Sunday
        uint256 dayOfWeek = ((block.timestamp / 86400) + 4) % 7;
        if (dayOfWeek == 0 || dayOfWeek == 6) {
            // Saturday or Sunday
            return false;
        }

        uint256 secondsInDay = block.timestamp % 86400;
        // Standard session window in UTC (13:30 to 20:00 UTC covers US Eastern trading hours)
        if (secondsInDay >= 48600 && secondsInDay <= 72000) {
            return true;
        }

        return false;
    }

    /**
     * @notice Checks the Chainlink L2 Sequencer Uptime Feed.
     * @return isUp True if sequencer is active and grace period has elapsed.
     */
    function isSequencerValid() public view returns (bool) {
        if (sequencerUptimeFeed == address(0)) return true;

        (
            ,
            int256 answer,
            uint256 startedAt,
            ,
        ) = AggregatorV3Interface(sequencerUptimeFeed).latestRoundData();

        // Answer == 0 means sequencer is UP; Answer == 1 means sequencer is DOWN
        if (answer != 0) return false;

        // Ensure grace period after restart has elapsed
        if (block.timestamp - startedAt < sequencerGracePeriod) {
            return false;
        }

        return true;
    }

    /**
     * @notice Returns the validated price, decimals, and current OracleState.
     */
    function getPrice(
        address token
    ) public view override returns (uint256 price, uint8 decimals, OracleState state) {
        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry(assetRegistry).getAssetConfig(token);
        decimals = cfg.feedDecimals;

        // Check 1: Asset status in registry
        if (cfg.status == uint8(IAssetRegistry.AssetStatus.Frozen)) {
            return (0, decimals, OracleState.FROZEN_CORPORATE_ACTION);
        }

        // Check 2: L2 Sequencer uptime
        if (!isSequencerValid()) {
            return (0, decimals, OracleState.INVALID_SEQUENCER);
        }

        // Check 3: Price feed reading
        (
            uint80 roundId,
            int256 rawPrice,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = AggregatorV3Interface(cfg.feed).latestRoundData();

        if (rawPrice <= 0 || updatedAt == 0 || answeredInRound < roundId) {
            return (0, decimals, OracleState.STALE_FEED);
        }

        price = uint256(rawPrice);
        bool marketOpen = isMarketOpen();

        // Check 4: Stale feed check during market open
        if (marketOpen) {
            uint32 maxStale = cfg.maxStaleOpenSecs > 0 ? cfg.maxStaleOpenSecs : 86400;
            if (block.timestamp - updatedAt > maxStale) {
                return (price, decimals, OracleState.STALE_FEED);
            }
            state = OracleState.VALID_OPEN;
        } else {
            // Market is closed (weekend / overnight)
            state = OracleState.VALID_CLOSED;
        }
    }

    /**
     * @notice Computes gross value and effective value in USDC (6 decimals).
     * Applies closed-market haircut if state is VALID_CLOSED.
     */
    function getValue(
        address token,
        uint256 rawAmount
    )
        external
        view
        override
        returns (uint256 grossValueUsdc, uint256 effectiveValueUsdc, OracleState state)
    {
        if (rawAmount == 0) return (0, 0, OracleState.VALID_OPEN);

        (uint256 price, uint8 feedDecimals, OracleState oracleState) = getPrice(token);
        state = oracleState;

        if (price == 0) return (0, 0, state);

        uint8 tokenDecimals = IERC20Metadata(token).decimals();

        // Standardize output to USDC (6 decimals):
        // grossValueUsdc = (rawAmount * price * 10^6) / (10^tokenDecimals * 10^feedDecimals)
        uint256 numerator = rawAmount * price * 1e6;
        uint256 denominator = (10 ** tokenDecimals) * (10 ** feedDecimals);
        grossValueUsdc = numerator / denominator;

        IAssetRegistry.AssetConfig memory cfg = IAssetRegistry(assetRegistry).getAssetConfig(token);

        if (state == OracleState.VALID_CLOSED) {
            uint256 haircut = (grossValueUsdc * cfg.closedMarketHaircutBps) / 10000;
            effectiveValueUsdc = grossValueUsdc - haircut;
        } else {
            effectiveValueUsdc = grossValueUsdc;
        }
    }

    function getOracleState(address token) external view override returns (OracleState state) {
        (, , state) = getPrice(token);
    }
}
