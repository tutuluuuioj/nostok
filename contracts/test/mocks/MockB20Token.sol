// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockB20Token is ERC20 {
    uint8 private _decimals;
    uint256 public uiMultiplier;

    constructor(
        string memory name,
        string memory symbol,
        uint8 dec,
        uint256 initialMultiplier
    ) ERC20(name, symbol) {
        _decimals = dec;
        uiMultiplier = initialMultiplier;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function setUIMultiplier(uint256 newMultiplier) external {
        uiMultiplier = newMultiplier;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
