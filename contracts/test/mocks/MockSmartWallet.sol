// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title MockSmartWallet
 * @notice ERC-1271 compliant smart contract wallet for testing smart wallet signatures.
 */
contract MockSmartWallet is IERC1271 {
    address public signer;

    constructor(address _signer) {
        signer = _signer;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view override returns (bytes4) {
        address recovered = ECDSA.recover(hash, signature);
        if (recovered == signer) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}
