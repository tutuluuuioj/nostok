// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title IPositionNFT
 * @notice ERC-721 representing the lender's claim to bullet repayment (principal + interest).
 * tokenId == loanId. Mints/burns only by authorized LoanCore.
 * Enforces transfer locks during Dutch auction and checks eligibility.
 */
interface IPositionNFT is IERC721 {
    event LoanClaimMinted(address indexed to, uint256 indexed loanId);
    event LoanClaimBurned(uint256 indexed loanId);
    event LoanAuctionLocked(uint256 indexed loanId, bool locked);
    event LoanCoreAuthorized(address indexed core, bool authorized);

    function mint(address to, uint256 loanId) external;
    function burn(uint256 loanId) external;
    function setAuctionLock(uint256 loanId, bool locked) external;
    function isAuctionLocked(uint256 loanId) external view returns (bool);
    function isAuthorizedCore(address caller) external view returns (bool);
}
