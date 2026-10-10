"""Public chain reads and SDK-based deployment construction. No client secrets."""

import json
import os
import re
import subprocess
from pathlib import Path

from eth_abi import decode, encode

from app.wallet_registry.control import CHAIN_ID, FACTORY, ControlError, rpc_batch, selector

USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"
RECOVERY_7D = "0x088f6cfd8bb1ddb1bb069ccb3fc1a98927d233f2"
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
ROOT = Path(__file__).resolve().parents[3]


def configured_address(name):
    value = os.getenv(name, "").lower()
    if not ADDRESS.fullmatch(value) or int(value, 16) == 0:
        raise ControlError("treasury_not_configured")
    return value


def public_config():
    return configured_address("SWISSQUOTE_TREASURY_ADDRESS"), configured_address(
        "ERC20_TEST_ADDRESS"
    )


def eth_call(to, signature, types=(), values=(), block="latest"):
    data = selector(signature) + encode(list(types), list(values)).hex()
    return "eth_call", [{"to": to, "data": data}, block]


def uint_result(value):
    return decode(["uint256"], bytes.fromhex(value[2:]))[0]


def snapshot():
    treasury, token = public_config()
    chain, block = rpc_batch([("eth_chainId", []), ("eth_blockNumber", [])])
    if int(chain, 16) != CHAIN_ID:
        raise ControlError("wrong_network")
    code, decimals, balance, eth = rpc_batch(
        [
            ("eth_getCode", [token, block]),
            eth_call(token, "decimals()", block=block),
            eth_call(token, "balanceOf(address)", ["address"], [treasury], block),
            ("eth_getBalance", [treasury, block]),
        ]
    )
    if code in ("0x", "0x0") or uint_result(decimals) != 6:
        raise ControlError("unsupported_test_token")
    return {
        "treasury_address": treasury,
        "token_address": token,
        "decimals": 6,
        "balance_units": str(uint_result(balance)),
        "eth_balance_wei": str(int(eth, 16)),
        "checked_block": int(block, 16),
        "chain_id": CHAIN_ID,
        "token_label": "Test USDC" if token == USDC else "Test token",
        "bank_mocked": True,
    }


def security_status(safe):
    # An explicit development exception is visible in both the consent and UI.
    # Normal mode verifies the selected seven-day recovery module and 2/3 setup.
    if os.getenv("FUNDING_ALLOW_UNPROTECTED_DEMO", "false") == "true":
        return "unprotected_test_demo"
    module = RECOVERY_7D
    enabled, guardians, threshold = rpc_batch(
        [
            eth_call(safe, "isModuleEnabled(address)", ["address"], [module]),
            eth_call(module, "getGuardians(address)", ["address"], [safe]),
            eth_call(module, "threshold(address)", ["address"], [safe]),
        ]
    )
    addresses = decode(["address[]"], bytes.fromhex(guardians[2:]))[0]
    if not decode(["bool"], bytes.fromhex(enabled[2:]))[0] or (
        len(addresses) != 3 or len(set(addresses)) != 3 or uint_result(threshold) != 2
    ):
        raise ControlError("recovery_not_ready")
    return "recovery_2_of_3_seven_days"


def deployment(owner):
    # Use the exact pinned wallet-core initializer, not a client-supplied calldata blob.
    try:
        result = subprocess.run(
            ["node", "--import", "tsx", "scripts/safe-deployment.ts", owner],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
            env={k: v for k, v in os.environ.items() if k != "SWISSQUOTE_TREASURY_PRIVATE_KEY"},
        )
        value = json.loads(result.stdout)
        if value["factory"].lower() != FACTORY or not ADDRESS.fullmatch(value["safe_address"]):
            raise ValueError()
        return value
    except Exception:
        raise ControlError("deployment_builder_unavailable") from None
