// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOracleRouter
 * @notice Validates price feeds against market calendar, L2 sequencer, and corporate actions.
 */
interface IOracleRouter {
    enum OracleState {
        VALID_OPEN,               // 0: Open session, feed fresh, full operations
        VALID_CLOSED,             // 1: Closed session (weekend/night), haircut on new loans, no liquidation
        FROZEN_CORPORATE_ACTION,  // 2: Corporate action freeze (splits, unexpected multiplier shift)
        STALE_FEED,               // 3: Feed heartbeat exceeded
        INVALID_SEQUENCER,        // 4: Base Sequencer down or within 1h grace
        DISPUTED                  // 5: Primary feed deviates significantly from sanity source / TWAP
    }

    event SequencerGracePeriodUpdated(uint256 gracePeriod);
    event MarketCalendarUpdated(address indexed calendar);
    event SanityThresholdUpdated(uint16 thresholdBps);

    function getPrice(address token)
        external
        view
        returns (uint256 price, uint8 decimals, OracleState state);

    function getValue(address token, uint256 rawAmount)
        external
        view
        returns (uint256 grossValueUsdc, uint256 effectiveValueUsdc, OracleState state);

    function getOracleState(address token) external view returns (OracleState state);

    function isMarketOpen() external view returns (bool);

    function syncMultiplier(address token) external returns (uint256);
}
