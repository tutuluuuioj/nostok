// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title NostokTimelock
 * @notice 48-hour TimelockController governing smart contract upgrades and authorized escrow cores.
 */
contract NostokTimelock is TimelockController {
    uint256 public constant MIN_DELAY = 48 hours;

    constructor(
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(MIN_DELAY, proposers, executors, admin) {}
}
