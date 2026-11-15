// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";

contract MockSequencer is AggregatorV3Interface {
    int256 private _status; // 0 = UP, 1 = DOWN
    uint256 private _startedAt;

    constructor(int256 initialStatus) {
        _status = initialStatus;
        _startedAt = block.timestamp > 7200 ? block.timestamp - 7200 : 0;
    }

    function setStatus(int256 newStatus, uint256 startedAt) external {
        _status = newStatus;
        _startedAt = startedAt;
    }

    function decimals() external pure override returns (uint8) {
        return 0;
    }

    function description() external pure override returns (string memory) {
        return "Mock Base Sequencer Uptime Feed";
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    function getRoundData(
        uint80 roundId
    ) external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, _status, _startedAt, block.timestamp, roundId);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, _status, _startedAt, block.timestamp, 1);
    }
}
