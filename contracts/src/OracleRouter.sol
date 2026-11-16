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
 * @notice Validates prices, market sessions (DST & holidays), Base sequencer status,
 * and automatic B20 corporate action multiplier freezes.
 */
contract OracleRouter is Initializable, UUPSUpgradeable, OwnableUpgradeable, IOracleRouter {
    address public assetRegistry;
    address public sequencerUptimeFeed;
    uint256 public sequencerGracePeriod;

    // Market session manual override
    bool public isMarketOpenManual;
    bool public useManualMarketSession;

    // Stale feed tolerance when market is closed (default 4 days = 345,600s)
    uint32 public maxStaleClosedSecs;

    // Holidays and half-days keyed by epoch day (timestamp / 86400)
    mapping(uint256 => bool) public isHoliday;
    mapping(uint256 => bool) public isHalfDay;

    // Track recorded B20 multipliers to auto-freeze unexpected splits or corporate actions
    mapping(address => uint256) public recordedMultiplier;

    error ZeroAddress();
    error InvalidAnswer();
    error AssetNotConfigured();
    error CorporateActionSplitPending();

    event MarketSessionUpdated(bool isOpen, bool isManual);
    event AssetRegistryUpdated(address indexed registry);
    event SequencerFeedUpdated(address indexed feed, uint256 gracePeriod);
    event HolidaySet(uint256 indexed dayNumber, bool isHoliday);
    event HalfDaySet(uint256 indexed dayNumber, bool isHalfDay);
    event MultiplierSynced(address indexed token, uint256 multiplier);
    event MaxStaleClosedUpdated(uint32 maxStaleSecs);

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
        maxStaleClosedSecs = 360000; // 100 hours (allows weekends and 3-day long weekends)
        isMarketOpenManual = true;
        useManualMarketSession = false;

        _loadDefaultHolidays();
    }

    function _loadDefaultHolidays() internal {
        // Pre-load NYSE holidays & half-days for 2024 through 2030
        uint256[70] memory holidays = [
            // 2024
            uint256(19723), 19737, 19772, 19811, 19870, 19893, 19908, 19968, 20055, 20082,
            // 2025
            uint256(20089), 20108, 20136, 20196, 20234, 20258, 20273, 20332, 20419, 20447,
            // 2026
            uint256(20454), 20472, 20500, 20546, 20598, 20623, 20637, 20703, 20783, 20812,
            // 2027
            uint256(20819), 20836, 20864, 20903, 20969, 20987, 21004, 21067, 21147, 21176,
            // 2028
            uint256(21184), 21200, 21235, 21288, 21333, 21354, 21369, 21431, 21511, 21543,
            // 2029
            uint256(21550), 21564, 21599, 21638, 21697, 21719, 21734, 21795, 21875, 21908,
            // 2030
            uint256(21915), 21935, 21963, 22023, 22061, 22084, 22099, 22159, 22246, 22273
        ];
        for (uint256 i = 0; i < 70; i++) {
            isHoliday[holidays[i]] = true;
        }

        // Half-days (close 13:00 ET / 17:00 UTC EDT / 18:00 UTC EST)
        // 2024: July 3, Black Friday (Nov 29), Christmas Eve (Dec 24)
        // 2025: July 3, Black Friday (Nov 28), Christmas Eve (Dec 24)
        // 2026: Black Friday (Nov 27), Christmas Eve (Dec 24)
        // 2027: Black Friday (Nov 26)
        // 2028: July 3, Black Friday (Nov 24)
        // 2029: July 3, Black Friday (Nov 23), Christmas Eve (Dec 24)
        // 2030: July 3, Black Friday (Nov 29), Christmas Eve (Dec 24)
        uint256[17] memory halfDays = [
            uint256(19907), 20056, 20081,
            uint256(20272), 20420, 20446,
            uint256(20784), 20811,
            uint256(21148),
            uint256(21368), 21512,
            uint256(21733), 21876, 21907,
            uint256(22098), 22247, 22272
        ];
        for (uint256 j = 0; j < 17; j++) {
            isHalfDay[halfDays[j]] = true;
        }
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

    function setMaxStaleClosedSecs(uint32 newMaxStale) external onlyOwner {
        maxStaleClosedSecs = newMaxStale;
        emit MaxStaleClosedUpdated(newMaxStale);
    }

    function setHoliday(uint256 dayNumber, bool holiday) external onlyOwner {
        isHoliday[dayNumber] = holiday;
        emit HolidaySet(dayNumber, holiday);
    }

    function setHalfDay(uint256 dayNumber, bool halfDay) external onlyOwner {
        isHalfDay[dayNumber] = halfDay;
        emit HalfDaySet(dayNumber, halfDay);
    }

    function setHolidays(uint256[] calldata dayNumbers, bool holiday) external onlyOwner {
        for (uint256 i = 0; i < dayNumbers.length; i++) {
            isHoliday[dayNumbers[i]] = holiday;
            emit HolidaySet(dayNumbers[i], holiday);
        }
    }

    /**
     * @notice Synchronizes recorded multiplier with current token uiMultiplier.
     * - If recordedMultiplier[token] == 0 (initial baseline) or diff < 5% (dividend drift):
     *   Permissionless (callable by anyone or daily keeper to ratchet baseline).
     * - If diff >= 5% (corporate action split):
     *   Restricted to Owner or Protocol Guardian (post-split unfreeze).
     */
    function syncMultiplier(address token) public returns (uint256 current) {
        current = 1e18;
        (bool success, bytes memory ret) = token.staticcall(
            abi.encodeWithSelector(IB20Token.uiMultiplier.selector)
        );
        if (success && ret.length == 32) {
            uint256 m = abi.decode(ret, (uint256));
            if (m > 0) current = m;
        }

        uint256 prev = recordedMultiplier[token];
        address guardian = assetRegistry != address(0) ? IAssetRegistry(assetRegistry).guardian() : address(0);
        bool isPrivileged = (msg.sender == owner() || (guardian != address(0) && msg.sender == guardian));

        if (prev != 0 && !isPrivileged) {
            uint256 diff = current > prev ? current - prev : prev - current;
            uint256 diffBps = (diff * 10000) / prev;
            if (diffBps >= 500) {
                revert CorporateActionSplitPending();
            }
        }

        recordedMultiplier[token] = current;
        emit MultiplierSynced(token, current);
    }

    /**
     * @notice Checks whether US Daylight Saving Time (EDT = UTC-4) is active.
     */
    function isUSDaylightSaving(uint256 timestamp) public pure returns (bool) {
        uint256 z = timestamp / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 d = doy - (153 * mp + 2) / 5 + 1;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;

        if (m < 3 || m > 11) return false;
        if (m > 3 && m < 11) return true;

        uint256 dayOfWeek = ((timestamp / 86400) + 4) % 7;

        if (m == 3) {
            // Second Sunday in March (between March 8 and March 14)
            int256 prevSunday = int256(d) - int256(dayOfWeek);
            if (prevSunday < 8) return false;
            if (int256(d) > prevSunday) return true;
            uint256 hourUtc = (timestamp % 86400) / 3600;
            return hourUtc >= 7; // 2:00 AM EST = 7:00 AM UTC
        } else {
            // First Sunday in November (between November 1 and November 7)
            int256 prevSunday = int256(d) - int256(dayOfWeek);
            if (prevSunday < 1) return true;
            if (int256(d) > prevSunday) return false;
            uint256 hourUtc = (timestamp % 86400) / 3600;
            return hourUtc < 6; // 2:00 AM EDT = 6:00 AM UTC
        }
    }

    /**
     * @notice Evaluates whether US equity market is currently open.
     * Respects weekdays, NYSE holidays, early half-day closes, and DST.
     */
    function isMarketOpen() public view returns (bool) {
        if (useManualMarketSession) {
            return isMarketOpenManual;
        }

        uint256 epochDay = block.timestamp / 86400;

        // Check 1: NYSE Holiday
        if (isHoliday[epochDay]) return false;

        // Check 2: Day of week (0 = Sunday, 1 = Monday, ..., 5 = Friday, 6 = Saturday)
        uint256 dayOfWeek = (epochDay + 4) % 7;
        if (dayOfWeek == 0 || dayOfWeek == 6) {
            return false;
        }

        uint256 secondsInDay = block.timestamp % 86400;
        bool isEDT = isUSDaylightSaving(block.timestamp);
        bool halfDay = isHalfDay[epochDay];

        if (isEDT) {
            // EDT (UTC-4): Regular hours 09:30-16:00 ET = 13:30-20:00 UTC (48600s - 72000s)
            // Early close 13:00 ET = 17:00 UTC (48600s - 61200s)
            uint256 closeSeconds = halfDay ? 61200 : 72000;
            return (secondsInDay >= 48600 && secondsInDay <= closeSeconds);
        } else {
            // EST (UTC-5): Regular hours 09:30-16:00 ET = 14:30-21:00 UTC (52200s - 75600s)
            // Early close 13:00 ET = 18:00 UTC (52200s - 64800s)
            uint256 closeSeconds = halfDay ? 64800 : 75600;
            return (secondsInDay >= 52200 && secondsInDay <= closeSeconds);
        }
    }

    /**
     * @notice Checks the Chainlink L2 Sequencer Uptime Feed.
     */
    function isSequencerValid() public view returns (bool) {
        if (sequencerUptimeFeed == address(0)) return true;

        (
            ,
            int256 answer,
            uint256 startedAt,
            ,
        ) = AggregatorV3Interface(sequencerUptimeFeed).latestRoundData();

        if (answer != 0) return false;
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

        // Check 2: B20 Multiplier corporate action check
        (bool success, bytes memory ret) = token.staticcall(
            abi.encodeWithSelector(IB20Token.uiMultiplier.selector)
        );
        if (success && ret.length == 32) {
            uint256 currentMult = abi.decode(ret, (uint256));
            if (currentMult > 0) {
                uint256 recMult = recordedMultiplier[token];
                if (recMult == 0) {
                    return (0, decimals, OracleState.FROZEN_CORPORATE_ACTION);
                }
                uint256 diff = currentMult > recMult ? currentMult - recMult : recMult - currentMult;
                uint256 diffBps = (diff * 10000) / recMult;
                // Freeze on sudden jump (split-sized >= 5% / 500 bps), tolerate dividend drift (< 5%)
                if (diffBps >= 500) {
                    return (0, decimals, OracleState.FROZEN_CORPORATE_ACTION);
                }
            }
        }

        // Check 3: L2 Sequencer uptime
        if (!isSequencerValid()) {
            return (0, decimals, OracleState.INVALID_SEQUENCER);
        }

        // Check 4: Price feed reading
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

        // Price: Chainlink feeds for Coinbase B20 tokens already price the token directly
        price = uint256(rawPrice);
        bool marketOpen = isMarketOpen();

        if (marketOpen) {
            uint32 maxStale = cfg.maxStaleOpenSecs > 0 ? cfg.maxStaleOpenSecs : 3600;
            if (block.timestamp - updatedAt > maxStale) {
                return (price, decimals, OracleState.STALE_FEED);
            }
            state = OracleState.VALID_OPEN;
        } else {
            // Market is closed: check closed stale threshold
            if (block.timestamp - updatedAt > maxStaleClosedSecs) {
                return (price, decimals, OracleState.STALE_FEED);
            }
            state = OracleState.VALID_CLOSED;
        }
    }

    /**
     * @notice Computes gross value and effective value in USDC (6 decimals).
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

    uint256[50] private __gap;
}
