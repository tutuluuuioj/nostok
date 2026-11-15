// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IFeeCollector
 * @notice Collects protocol fees with hardcoded contractual ceilings.
 */
interface IFeeCollector {
    event FeeCollected(address indexed asset, uint256 treasuryAmount, uint256 reserveAmount);
    event FeeRatesUpdated(uint16 originationBps, uint16 interestCutBps, uint16 liquidationBps);
    event TreasuryUpdated(address indexed treasury);
    event SafetyReserveUpdated(address indexed safetyReserve);

    function originationFeeBps() external view returns (uint16);
    function interestCutBps() external view returns (uint16);
    function liquidationFeeBps() external view returns (uint16);
    function safetyReserveShareBps() external view returns (uint16);

    function calculateOriginationFee(uint128 principal) external view returns (uint128);
    function calculateInterestCut(uint128 interest) external view returns (uint128);
    function calculateLiquidationFee(uint128 collateralValue) external view returns (uint128 fee, uint128 keeperReward);

    function distributeFees(address token, uint128 amount) external;
}
