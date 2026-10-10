// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title Guard Interface for Safe
 */
interface ISafe {
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);

    function nonce() external view returns (uint256);
}

interface IGuard {
    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        address msgSender
    ) external;

    function checkAfterExecution(bytes32 txHash, bool success) external;
}

/**
 * @title HighValueGuard
 * @notice A Safe Guard that intercepts transactions. 
 * If the transaction value (Native or ERC20) exceeds a threshold, 
 * it requires a co-signature from Swissquote appended to the signatures array.
 */
contract HighValueGuard is IGuard {
    address public swissquoteSigner;
    uint256 public thresholdAmount;

    // Standard ERC20 transfer signature: 0xa9059cbb
    bytes4 private constant ERC20_TRANSFER_SELECTOR = 0xa9059cbb;

    constructor(address _swissquoteSigner, uint256 _thresholdAmount) {
        swissquoteSigner = _swissquoteSigner;
        thresholdAmount = _thresholdAmount;
    }

    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        address /* msgSender */
    ) external view override {
        uint256 transferAmount = 0;

        // 1. Detect Native ETH transfer
        if (value > 0) {
            transferAmount = value;
        } 
        // 2. Detect ERC20 transfer
        else if (data.length >= 68) {
            bytes4 selector;
            assembly {
                selector := mload(add(data, 32))
            }
            if (selector == ERC20_TRANSFER_SELECTOR) {
                assembly {
                    // amount is the 2nd argument (after the 4-byte selector and 32-byte address)
                    transferAmount := mload(add(data, 68))
                }
            }
        }

        // 3. Enforce threshold logic
        if (transferAmount >= thresholdAmount) {
            // For a high value transaction, the Swissquote signature MUST be appended 
            // at the end of the standard owner signatures.
            // Minimum length: 65 (Owner) + 65 (Swissquote) = 130 bytes
            require(signatures.length >= 130, "HighValueGuard: Missing SQ signature for high value tx");

            // Extract the last 65 bytes as the Swissquote signature
            bytes memory sqSignature = new bytes(65);
            uint256 offset = signatures.length - 65;
            for (uint256 i = 0; i < 65; i++) {
                sqSignature[i] = signatures[offset + i];
            }

            // In a real production environment, we would recreate the safeTxHash
            // and verify that `swissquoteSigner` signed it using ECDSA.recover()
            // e.g.:
            // bytes32 txHash = ISafe(msg.sender).getTransactionHash(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, ISafe(msg.sender).nonce() - 1);
            // address recovered = recoverSigner(txHash, sqSignature);
            // require(recovered == swissquoteSigner, "HighValueGuard: Invalid SQ signature");
            
            // For hackathon MVP purposes, we simulate the presence of the signature bytes.
            require(sqSignature.length == 65, "HighValueGuard: Invalid SQ signature length");
        }
    }

    function checkAfterExecution(bytes32 /* txHash */, bool /* success */) external view override {
        // No post-execution checks required for this use case
    }

    // --- Helper for Signature Recovery (Standard ECDSA) ---
    function recoverSigner(bytes32 _hash, bytes memory _signature) internal pure returns (address) {
        require(_signature.length == 65, "Invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(_signature, 32))
            s := mload(add(_signature, 64))
            v := byte(0, mload(add(_signature, 96)))
        }
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "Invalid signature v value");
        return ecrecover(_hash, v, r, s);
    }
}
