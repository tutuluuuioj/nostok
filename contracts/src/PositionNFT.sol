// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IPositionNFT} from "./interfaces/IPositionNFT.sol";
import {IEligibilityGate} from "./interfaces/IEligibilityGate.sol";

/**
 * @title PositionNFT
 * @notice Immutable ERC-721 representing transferable fixed-term repo lender claims.
 * tokenId matches loanId. Mints and burns only by authorized LoanCore contracts.
 */
contract PositionNFT is ERC721, IPositionNFT, Ownable {
    using Strings for uint256;

    mapping(address => bool) public override isAuthorizedCore;
    mapping(uint256 => bool) public override isAuctionLocked;

    address public eligibilityGate;

    error UnauthorizedCaller();
    error ZeroAddress();
    error AuctionTransferLocked();
    error IneligibleRecipient();

    event EligibilityGateUpdated(address indexed newGate);

    modifier onlyAuthorizedCore() {
        if (!isAuthorizedCore[msg.sender]) revert UnauthorizedCaller();
        _;
    }

    constructor(
        address initialOwner,
        address initialGate
    ) ERC721("NOSTOK Position Claim", "NOSTOK-POS") Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        eligibilityGate = initialGate;
    }

    function setAuthorizedCore(address core, bool authorized) external onlyOwner {
        if (core == address(0)) revert ZeroAddress();
        isAuthorizedCore[core] = authorized;
        emit LoanCoreAuthorized(core, authorized);
    }

    function setEligibilityGate(address newGate) external onlyOwner {
        eligibilityGate = newGate;
        emit EligibilityGateUpdated(newGate);
    }

    function mint(address to, uint256 loanId) external override onlyAuthorizedCore {
        if (to == address(0)) revert ZeroAddress();
        _safeMint(to, loanId);
        emit LoanClaimMinted(to, loanId);
    }

    bytes private _currentAttestation;

    function burn(uint256 loanId) external override onlyAuthorizedCore {
        _burn(loanId);
        emit LoanClaimBurned(loanId);
    }

    function setAuctionLock(uint256 loanId, bool locked) external override onlyAuthorizedCore {
        isAuctionLocked[loanId] = locked;
        emit LoanAuctionLocked(loanId, locked);
    }

    /**
     * @notice Transfer position NFT passing recipient's regulatory attestation.
     */
    function transferWithAttestation(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata recipientAttestation
    ) external override {
        _currentAttestation = recipientAttestation;
        transferFrom(from, to, tokenId);
        delete _currentAttestation;
    }

    /**
     * @dev OpenZeppelin v5 transfer hook. Reverts if loan is auction-locked or recipient is ineligible.
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = super._update(to, tokenId, auth);

        // If not minting and not burning, check transfer restrictions
        if (from != address(0) && to != address(0)) {
            if (isAuctionLocked[tokenId]) revert AuctionTransferLocked();

            if (eligibilityGate != address(0)) {
                if (!IEligibilityGate(eligibilityGate).isEligible(to, _currentAttestation)) {
                    revert IneligibleRecipient();
                }
            }
        }

        return from;
    }

    /**
     * @notice Generates onchain SVG and JSON metadata for marketplaces and wallets.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        string memory svg = string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">',
                '<rect width="100%" height="100%" fill="#0a0b0d"/>',
                '<text x="24" y="48" fill="#ffffff" font-family="sans-serif" font-size="20" font-weight="bold">NOSTOK Position Claim</text>',
                '<text x="24" y="80" fill="#9ba1a6" font-family="sans-serif" font-size="14">Loan ID #', tokenId.toString(), '</text>',
                '<rect x="24" y="110" width="352" height="1" fill="#202428"/>',
                '<text x="24" y="150" fill="#22c55e" font-family="sans-serif" font-size="14">Fixed-Term Repo Debt Claim</text>',
                '<text x="24" y="180" fill="#9ba1a6" font-family="sans-serif" font-size="12">Base Mainnet (8453)</text>',
                '</svg>'
            )
        );

        string memory json = Base64.encode(
            bytes(
                string(
                    abi.encodePacked(
                        '{"name": "NOSTOK Position Claim #', tokenId.toString(), '", ',
                        '"description": "Institutional fixed-term repo debt claim secured by escrowed tokenized equity.", ',
                        '"image": "data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '"}'
                    )
                )
            )
        );

        return string(abi.encodePacked("data:application/json;base64,", json));
    }
}
