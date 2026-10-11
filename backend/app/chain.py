"""Minimal Sepolia JSON-RPC client for recovery state and relayed transactions.

The chain is the source of truth: the API never trusts a client-supplied nonce,
guardian list or recovery status.
"""

import json
import os
import urllib.request
from dataclasses import dataclass

from eth_abi import decode, encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address

CHAIN_ID = 11155111
SENTINEL = "0x0000000000000000000000000000000000000001"
# Candide SocialRecoveryModule deployments (same as wallet-core).
RECOVERY_MODULES = {
    "0x38275826e1933303e508433dd5f289315da2541c": 3 * 24 * 3600,  # product: 3 days
    "0x949d01d424be050d09c16025dd007cb59b3a8c66": 3 * 60,  # legacy demo: 3 minutes
    "0x09fab55bfc4b5bc016aa634a2194fe3186219fd1": 60,  # demo: 1 minute
}
RECOVERY_THRESHOLD = 2


class ChainError(Exception):
    """Safe message only; never includes the RPC URL."""


def _selector(signature: str) -> bytes:
    return keccak(text=signature)[:4]


def rpc_url() -> str:
    url = os.getenv("SEPOLIA_RPC_URL", "").strip()
    if not url.startswith(("http://", "https://")):
        raise ChainError("SEPOLIA_RPC_URL is not configured")
    return url


def rpc(method: str, params: list) -> object:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    # Public RPCs behind Cloudflare (e.g. publicnode) answer 403 to urllib's default UA.
    request = urllib.request.Request(
        rpc_url(),
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "SwissquoteWalletPrototype/0.1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read())
    except Exception as exc:
        raise ChainError("Sepolia RPC request failed") from exc
    if "error" in payload:
        raise ChainError(f"Sepolia RPC error: {str(payload['error'].get('message'))[:200]}")
    return payload["result"]


def eth_call(to: str, data: bytes) -> bytes:
    result = rpc("eth_call", [{"to": to, "data": "0x" + data.hex()}, "latest"])
    return bytes.fromhex(str(result)[2:])


def call(to: str, signature: str, types: list[str], args: list, out: list[str]) -> tuple:
    raw = eth_call(to, _selector(signature) + encode(types, args))
    return decode(out, raw)


@dataclass
class RecoveryState:
    module: str
    guardians: list[str]
    threshold: int
    nonce: int
    approvals: int
    execute_after: int
    new_owners: list[str]


def chain_id() -> int:
    return int(str(rpc("eth_chainId", [])), 16)


def recovery_module(safe: str) -> str | None:
    code = rpc("eth_getCode", [safe, "latest"])
    if code in (None, "0x"):
        return None
    (modules, _next) = call(
        safe,
        "getModulesPaginated(address,uint256)",
        ["address", "uint256"],
        [SENTINEL, 10],
        ["address[]", "address"],
    )
    for module in modules:
        if module.lower() in RECOVERY_MODULES:
            return module.lower()
    return None


def owners(safe: str) -> list[str]:
    (result,) = call(safe, "getOwners()", [], [], ["address[]"])
    return [o.lower() for o in result]


def recovery_state(safe: str) -> RecoveryState | None:
    if chain_id() != CHAIN_ID:
        raise ChainError("The RPC is not Sepolia")
    module = recovery_module(safe)
    if module is None:
        return None
    (guardians,) = call(module, "getGuardians(address)", ["address"], [safe], ["address[]"])
    (threshold,) = call(module, "threshold(address)", ["address"], [safe], ["uint256"])
    (nonce,) = call(module, "nonce(address)", ["address"], [safe], ["uint256"])
    ((approvals, _new_threshold, execute_after, new_owners),) = call(
        module,
        "getRecoveryRequest(address)",
        ["address"],
        [safe],
        ["(uint256,uint256,uint64,address[])"],
    )
    return RecoveryState(
        module=module,
        guardians=[g.lower() for g in guardians],
        threshold=int(threshold),
        nonce=int(nonce),
        approvals=int(approvals),
        execute_after=int(execute_after),
        new_owners=[o.lower() for o in new_owners],
    )


def latest_timestamp() -> int:
    block = rpc("eth_getBlockByNumber", ["latest", False])
    return int(block["timestamp"], 16)  # type: ignore[index]


def recovery_typed_data(module: str, safe: str, new_owner: str, nonce: int) -> dict:
    """Same EIP-712 data as wallet-core recoveryTypedData and the module itself."""
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "ExecuteRecovery": [
                {"name": "wallet", "type": "address"},
                {"name": "newOwners", "type": "address[]"},
                {"name": "newThreshold", "type": "uint256"},
                {"name": "nonce", "type": "uint256"},
            ],
        },
        "primaryType": "ExecuteRecovery",
        "domain": {
            "name": "Social Recovery Module",
            "version": "0.0.1",
            "chainId": CHAIN_ID,
            "verifyingContract": to_checksum_address(module),
        },
        "message": {
            "wallet": to_checksum_address(safe),
            "newOwners": [to_checksum_address(new_owner)],
            "newThreshold": 1,
            "nonce": nonce,
        },
    }


def recover_approval_signer(
    module: str, safe: str, new_owner: str, nonce: int, signature: str
) -> str | None:
    try:
        message = encode_typed_data(
            full_message=recovery_typed_data(module, safe, new_owner, nonce)
        )
        return Account.recover_message(message, signature=signature).lower()
    except Exception:
        return None


def multi_confirm_recovery_data(safe: str, new_owner: str, approvals: list[tuple[str, str]]):
    ordered = sorted(approvals, key=lambda a: int(a[0], 16))
    return _selector("multiConfirmRecovery(address,address[],uint256,(address,bytes)[],bool)") + (
        encode(
            ["address", "address[]", "uint256", "(address,bytes)[]", "bool"],
            [
                safe,
                [new_owner],
                1,
                [(signer, bytes.fromhex(sig[2:])) for signer, sig in ordered],
                True,
            ],
        )
    )


def finalize_recovery_data(safe: str) -> bytes:
    return _selector("finalizeRecovery(address)") + encode(["address"], [safe])


def send_transaction(private_key: str, to: str, data: bytes) -> str:
    """Simulate, then sign and broadcast from a server testnet key."""
    account = Account.from_key(private_key)
    tx_call = {"from": account.address, "to": to, "data": "0x" + data.hex()}
    rpc("eth_call", [tx_call, "latest"])  # raises ChainError on revert
    gas = int(str(rpc("eth_estimateGas", [tx_call])), 16)
    nonce = int(str(rpc("eth_getTransactionCount", [account.address, "pending"])), 16)
    base_fee = int(rpc("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)  # type: ignore[index]
    tip = 2 * 10**9
    signed = account.sign_transaction(
        {
            "chainId": CHAIN_ID,
            "nonce": nonce,
            "to": to_checksum_address(to),
            "value": 0,
            "data": data,
            "gas": gas * 13 // 10,
            "maxFeePerGas": base_fee * 2 + tip,
            "maxPriorityFeePerGas": tip,
            "type": 2,
        }
    )
    return str(
        rpc("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex().removeprefix("0x")])
    )


def transaction_status(tx_hash: str) -> str:
    receipt = rpc("eth_getTransactionReceipt", [tx_hash])
    if receipt is None:
        return "pending"
    return "success" if receipt["status"] == "0x1" else "failed"  # type: ignore[index]
