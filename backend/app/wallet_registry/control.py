"""Read-only Sepolia Safe verification. Trust the configured RPC, never client claims."""

import json
import os
from dataclasses import dataclass
from urllib.request import Request, urlopen

from eth_abi import decode, encode
from eth_utils import keccak

CHAIN_ID = 11155111
SINGLETON = "0x29fcb43b46531bca003ddc8fcb67ffe91900c762"
FACTORY = "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67"
MODULE = "0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226"

# Official @safe-global/safe-contracts 1.4.1 SafeProxy deployedBytecode.
# https://github.com/safe-global/safe-smart-account/tree/v1.4.1/contracts/proxies
# Its factory exposes proxyCreationCode(), not proxyRuntimeCode().
PROXY_RUNTIME = bytes.fromhex(
    "608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000"
    "000000000000000000000000000000000000000000000060003514156050578060005260206000f3"
    "5b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264"
    "697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f314413"
    "64736f6c63430007060033"
)


class ControlError(Exception):
    def __init__(self, status: str):
        self.status = status


@dataclass(frozen=True)
class ControlEvidence:
    block_number: int
    block_hash: str
    owner_address: str


def selector(signature: str) -> str:
    return "0x" + keccak(text=signature)[:4].hex()


def rpc_batch(calls: list[tuple[str, list]]) -> list:
    url = os.getenv("SEPOLIA_RPC_URL", "").strip()
    if not url.startswith(("https://", "http://")):
        raise ControlError("verification_unavailable")
    payload = [
        {"jsonrpc": "2.0", "id": i, "method": method, "params": params}
        for i, (method, params) in enumerate(calls)
    ]
    try:
        request = Request(
            url,
            json.dumps(payload).encode(),
            {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "SwissquoteWalletPrototype/0.1",
            },
        )
        with urlopen(request, timeout=5) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError()
        results = json.loads(raw)
        if not isinstance(results, list) or len(results) != len(calls):
            raise ValueError()
        by_id = {item["id"]: item for item in results}
        if set(by_id) != set(range(len(calls))):
            raise ValueError()
        if any(item.get("error") or item.get("jsonrpc") != "2.0" for item in results):
            raise ValueError()
        return [by_id[i]["result"] for i in range(len(calls))]
    except Exception:
        # Never expose provider URL/API credentials or raw RPC errors.
        raise ControlError("verification_unavailable") from None


def verify_control(safe: str, owner: str) -> ControlEvidence:
    try:
        chain, block = rpc_batch([("eth_chainId", []), ("eth_blockNumber", [])])
        if int(chain, 16) != CHAIN_ID:
            raise ControlError("verification_unavailable")
        number = int(block, 16)
        if number < 0:
            raise ValueError()

        # Every state read uses the same block, avoiding mixed ownership snapshots.
        def call(address, signature, args=""):
            return ("eth_call", [{"to": address, "data": selector(signature) + args}, block])

        code = rpc_batch([("eth_getCode", [safe, block])])[0]
        if code in ("0x", "0x0", None):
            raise ControlError("pending_deployment")
        singleton, owners, threshold, version, enabled, header = rpc_batch(
            [
                ("eth_getStorageAt", [safe, "0x0", block]),
                call(safe, "getOwners()"),
                call(safe, "getThreshold()"),
                call(safe, "VERSION()"),
                call(safe, "isModuleEnabled(address)", encode(["address"], [MODULE]).hex()),
                ("eth_getBlockByNumber", [block, False]),
            ]
        )
        # Reject impostor contracts that simply return plausible getOwners()/VERSION().
        if bytes.fromhex(code[2:]) != PROXY_RUNTIME:
            raise ControlError("unsupported_safe")
        if int(singleton, 16) != int(SINGLETON, 16):
            raise ControlError("unsupported_safe")
        if decode(["string"], bytes.fromhex(version[2:]))[0] != "1.4.1":
            raise ControlError("unsupported_safe")
        addresses = decode(["address[]"], bytes.fromhex(owners[2:]))[0]
        if (
            len(addresses) != 1
            or addresses[0].lower() != owner.lower()
            or decode(["uint256"], bytes.fromhex(threshold[2:]))[0] != 1
        ):
            raise ControlError("relink_required")
        if not decode(["bool"], bytes.fromhex(enabled[2:]))[0]:
            raise ControlError("unsupported_safe")
        if int(header["number"], 16) != number or len(bytes.fromhex(header["hash"][2:])) != 32:
            raise ValueError()
        return ControlEvidence(number, header["hash"], addresses[0].lower())
    except ControlError:
        raise
    except Exception:
        raise ControlError("verification_unavailable") from None
