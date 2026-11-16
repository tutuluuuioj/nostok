// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IEligibilityGate} from "./interfaces/IEligibilityGate.sol";

/**
 * @title EligibilityGate
 * @notice Validates that counterparties meet non-US / Reg S and compliance requirements.
 * Supports direct allowlisting as well as signed EIP-712 / ECDSA attestations from KYC signers.
 */
contract EligibilityGate is IEligibilityGate, Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 chainId,address gate,address account,uint256 nonce,uint256 expiry)"
    );

    address public attestationSigner;
    bool public permissionlessMode;

    mapping(address => bool) public allowlist;
    mapping(address => bool) public isOperator;
    mapping(address => bool) public isRevoked;
    mapping(address => uint256) public userNonce;

    error ZeroAddress();
    error Unauthorized();
    error InvalidSignature();

    event AttestationSignerUpdated(address indexed newSigner);
    event PermissionlessModeUpdated(bool enabled);
    event OperatorUpdated(address indexed operator, bool isAllowed);
    event UserRevocationUpdated(address indexed account, bool isRevoked);
    event UserNonceBumped(address indexed account, uint256 newNonce);

    modifier onlyAdminOrOperator() {
        if (msg.sender != owner() && !isOperator[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(
        address initialOwner,
        address initialSigner,
        bool initialPermissionless
    ) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        attestationSigner = initialSigner;
        permissionlessMode = initialPermissionless;
        isOperator[initialOwner] = true;
    }

    function setOperator(address operator, bool isAllowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = isAllowed;
        emit OperatorUpdated(operator, isAllowed);
    }

    function setAttestationSigner(address newSigner) external onlyOwner {
        attestationSigner = newSigner;
        emit AttestationSignerUpdated(newSigner);
    }

    function setPermissionlessMode(bool enabled) external onlyOwner {
        permissionlessMode = enabled;
        emit PermissionlessModeUpdated(enabled);
    }

    function setAllowlist(address account, bool isAllowed) external onlyAdminOrOperator {
        if (account == address(0)) revert ZeroAddress();
        allowlist[account] = isAllowed;
        emit AccountEligibilityUpdated(account, isAllowed);
    }

    function setAllowlistBatch(address[] calldata accounts, bool isAllowed) external onlyAdminOrOperator {
        for (uint256 i = 0; i < accounts.length; i++) {
            address acc = accounts[i];
            if (acc != address(0)) {
                allowlist[acc] = isAllowed;
                emit AccountEligibilityUpdated(acc, isAllowed);
            }
        }
    }

    function revokeUser(address account, bool revoked) external onlyAdminOrOperator {
        if (account == address(0)) revert ZeroAddress();
        isRevoked[account] = revoked;
        emit UserRevocationUpdated(account, revoked);
    }

    function bumpUserNonce(address account) external onlyAdminOrOperator {
        if (account == address(0)) revert ZeroAddress();
        uint256 newNonce = ++userNonce[account];
        emit UserNonceBumped(account, newNonce);
    }

    function bumpMyNonce() external {
        uint256 newNonce = ++userNonce[msg.sender];
        emit UserNonceBumped(msg.sender, newNonce);
    }

    function getAttestationDigest(
        address account,
        uint256 nonce,
        uint256 expiry
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(ATTESTATION_TYPEHASH, block.chainid, address(this), account, nonce, expiry)
        );
        return structHash.toEthSignedMessageHash();
    }

    function isEligible(
        address account,
        bytes calldata context
    ) external view override returns (bool) {
        if (isRevoked[account]) return false;
        if (permissionlessMode) return true;
        if (allowlist[account]) return true;

        if (context.length > 0 && attestationSigner != address(0)) {
            // Standard ABI-encoded attestation: (uint256 expiry, bytes signature)
            if (context.length >= 96) {
                (uint256 expiry, bytes memory signature) = abi.decode(context, (uint256, bytes));
                if (block.timestamp > expiry) return false;

                bytes32 digest = getAttestationDigest(account, userNonce[account], expiry);
                return SignatureChecker.isValidSignatureNow(attestationSigner, digest, signature);
            }

            // Compact raw 65-byte ECDSA signature with no expiry (legacy fallback)
            if (context.length == 65) {
                bytes32 digest = getAttestationDigest(account, userNonce[account], type(uint256).max);
                return SignatureChecker.isValidSignatureNow(attestationSigner, digest, context);
            }
        }

        return false;
    }
}
