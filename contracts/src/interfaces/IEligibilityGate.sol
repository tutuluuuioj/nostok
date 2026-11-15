// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IEligibilityGate
 * @notice Modular gate enforcing regulatory eligibility (Reg S non-US status, KYC, sanctions).
 */
interface IEligibilityGate {
    event AccountEligibilityUpdated(address indexed account, bool isEligible);

    function isEligible(address account, bytes calldata context) external view returns (bool);
}
