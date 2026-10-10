// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface ISafe {
    function getTransactionHash(
        address to, uint256 value, bytes calldata data, uint8 operation,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken,
        address refundReceiver, uint256 nonce
    ) external view returns (bytes32);
    function nonce() external view returns (uint256);
}

interface IGuard {
    function checkTransaction(
        address to, uint256 value, bytes memory data, uint8 operation,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken,
        address payable refundReceiver, bytes memory signatures, address msgSender
    ) external;
    function checkAfterExecution(bytes32 txHash, bool success) external;
}

/**
 * Optional Safe 1.4.1 transaction guard, not installed by the mobile demo.
 * Native and configured-token thresholds use their respective smallest units.
 * Only direct low-value transfers are unconditionally allowed. Other calls,
 * batches, approvals and guard removal require a real Swissquote co-signature.
 * Safe module execution bypasses transaction guards; see contracts/README.md.
 */
contract HighValueGuard is IGuard {
    address public immutable swissquoteSigner;
    address public immutable token;
    uint256 public immutable nativeThresholdWei;
    uint256 public immutable tokenThresholdUnits;
    bytes4 private constant TRANSFER = 0xa9059cbb;
    uint256 private constant HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    constructor(address signer, uint256 nativeLimit, address tokenAddress, uint256 tokenLimit) {
        require(signer != address(0), "Invalid SQ signer");
        require(tokenAddress.code.length > 0, "Invalid token");
        require(nativeLimit > 0 && tokenLimit > 0, "Invalid threshold");
        swissquoteSigner = signer;
        nativeThresholdWei = nativeLimit;
        token = tokenAddress;
        tokenThresholdUnits = tokenLimit;
    }

    // Safe.setGuard checks ERC-165 support for its Guard interface.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == type(IGuard).interfaceId;
    }

    function checkTransaction(
        address to, uint256 value, bytes memory data, uint8 operation,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken,
        address payable refundReceiver, bytes memory signatures, address /* msgSender */
    ) external view override {
        if (!requiresCoSignature(to, value, data, operation)) return;
        require(signatures.length == 130, "Missing SQ signature");
        // Safe increments its nonce BEFORE calling the guard in execTransaction.
        uint256 currentNonce = ISafe(msg.sender).nonce();
        require(currentNonce > 0, "Invalid Safe nonce");
        bytes32 txHash = ISafe(msg.sender).getTransactionHash(
            to, value, data, operation, safeTxGas, baseGas, gasPrice,
            gasToken, refundReceiver, currentNonce - 1
        );
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signatures, 97))
            s := mload(add(signatures, 129))
            v := byte(0, mload(add(signatures, 161)))
        }
        require(uint256(s) > 0 && uint256(s) <= HALF_ORDER, "Invalid SQ signature s");
        require(v == 27 || v == 28, "Invalid SQ signature v");
        require(ecrecover(txHash, v, r, s) == swissquoteSigner, "Invalid SQ signature");
    }

    function requiresCoSignature(address to, uint256 value, bytes memory data, uint8 operation)
        internal view returns (bool)
    {
        if (operation != 0) return true;
        // Native transfers to EOAs only; arbitrary contract fallbacks need review.
        if (data.length == 0 && to.code.length == 0) return value >= nativeThresholdWei;
        if (to != token || value != 0 || data.length != 68) return true;
        bytes4 selector;
        uint256 amount;
        assembly {
            selector := mload(add(data, 32))
            amount := mload(add(data, 68))
        }
        return selector != TRANSFER || amount >= tokenThresholdUnits;
    }

    function checkAfterExecution(bytes32, bool) external pure override {}
}
