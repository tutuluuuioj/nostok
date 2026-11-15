// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ICollateralEscrow
 * @notice Immutable escrow holding all tokenized equity collateral in raw units.
 * Collateral can only be transferred in or out through authorized LoanCore versions
 * or LiquidationAuction.
 */
interface ICollateralEscrow {
    event CollateralDeposited(address indexed token, address indexed from, uint256 amount);
    event CollateralReleased(address indexed token, address indexed to, uint256 amount);
    event CoreAuthorized(address indexed core, bool authorized);

    function depositCollateral(address token, address from, uint256 amount) external;
    function releaseCollateral(address token, address to, uint256 amount) external;
    function getBalance(address token) external view returns (uint256);
    function isAuthorizedCore(address caller) external view returns (bool);
}
