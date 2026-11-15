// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEligibilityGate} from "./interfaces/IEligibilityGate.sol";

/**
 * @title EligibilityGate
 * @notice Validates that counterparties meet non-US / Reg S and compliance requirements.
 * Supports direct allowlisting as well as signed EIP-712 / ECDSA attestations from KYC signers.
 */
contract EligibilityGate is IEligibilityGate, Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    address public attestationSigner;
    bool public permissionlessMode;

    mapping(address => bool) public allowlist;

    error ZeroAddress();
    error InvalidSignature();

    event AttestationSignerUpdated(address indexed newSigner);
    event PermissionlessModeUpdated(bool enabled);

    constructor(
        address initialOwner,
        address initialSigner,
        bool initialPermissionless
    ) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        attestationSigner = initialSigner;
        permissionlessMode = initialPermissionless;
    }

    function setAttestationSigner(address newSigner) external onlyOwner {
        attestationSigner = newSigner;
        emit AttestationSignerUpdated(newSigner);
    }

    function setPermissionlessMode(bool enabled) external onlyOwner {
        permissionlessMode = enabled;
        emit PermissionlessModeUpdated(enabled);
    }

    function setAllowlist(address account, bool isAllowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        allowlist[account] = isAllowed;
        emit AccountEligibilityUpdated(account, isAllowed);
    }

    function isEligible(
        address account,
        bytes calldata context
    ) external view override returns (bool) {
        if (permissionlessMode) return true;
        if (allowlist[account]) return true;

        if (context.length == 65 && attestationSigner != address(0)) {
            bytes32 messageHash = keccak256(
                abi.encodePacked("NOSTOK_ELIGIBLE_NON_US:", block.chainid, account)
            );
            bytes32 ethHash = messageHash.toEthSignedMessageHash();
            (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(ethHash, context);
            if (err == ECDSA.RecoverError.NoError && recovered == attestationSigner) {
                return true;
            }
        }

        return false;
    }
}
