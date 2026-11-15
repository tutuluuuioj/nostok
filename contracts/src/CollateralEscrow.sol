// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICollateralEscrow} from "./interfaces/ICollateralEscrow.sol";

/**
 * @title CollateralEscrow
 * @notice Immutable singleton escrow for tokenized stock collateral.
 * Collateral is tracked strictly in raw token units and can only move via
 * authorized LoanCore versions and LiquidationAuction.
 */
contract CollateralEscrow is ICollateralEscrow, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    mapping(address => bool) public override isAuthorizedCore;
    mapping(address => uint256) private _tokenBalances;

    error UnauthorizedCaller();
    error ZeroAddress();
    error InsufficientBalance();

    modifier onlyAuthorizedCore() {
        if (!isAuthorizedCore[msg.sender]) revert UnauthorizedCaller();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    /**
     * @notice Authorizes or deauthorizes a LoanCore version or auction contract.
     * @param core The contract address to set.
     * @param authorized True to authorize, false to revoke.
     */
    function setAuthorizedCore(address core, bool authorized) external onlyOwner {
        if (core == address(0)) revert ZeroAddress();
        isAuthorizedCore[core] = authorized;
        emit CoreAuthorized(core, authorized);
    }

    /**
     * @notice Pulls collateral into escrow from the borrower during loan opening or top-up.
     * @param token Address of the collateral token.
     * @param from Address of the borrower.
     * @param amount Raw amount of tokens to escrow.
     */
    function depositCollateral(
        address token,
        address from,
        uint256 amount
    ) external override nonReentrant onlyAuthorizedCore {
        if (token == address(0) || from == address(0)) revert ZeroAddress();
        if (amount == 0) return;

        _tokenBalances[token] += amount;
        IERC20(token).safeTransferFrom(from, address(this), amount);

        emit CollateralDeposited(token, from, amount);
    }

    /**
     * @notice Releases collateral from escrow upon loan repayment, partial repayment, or auction.
     * @param token Address of the collateral token.
     * @param to Recipient address (borrower or liquidator).
     * @param amount Raw amount of tokens to release.
     */
    function releaseCollateral(
        address token,
        address to,
        uint256 amount
    ) external override nonReentrant onlyAuthorizedCore {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) return;

        uint256 currentBalance = _tokenBalances[token];
        if (currentBalance < amount) revert InsufficientBalance();

        _tokenBalances[token] = currentBalance - amount;
        IERC20(token).safeTransfer(to, amount);

        emit CollateralReleased(token, to, amount);
    }

    /**
     * @notice Returns the recorded collateral balance for a given token.
     */
    function getBalance(address token) external view override returns (uint256) {
        return _tokenBalances[token];
    }
}
