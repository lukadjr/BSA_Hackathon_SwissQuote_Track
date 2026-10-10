"""Optional guard deployed in a real Safe: cryptographic enforcement and bypass tests."""

import json
import os
import subprocess
from pathlib import Path

import pytest
from eth_abi import encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import to_checksum_address

from app.funding import chain
from app.transactions import relay

pytestmark = pytest.mark.skipif(
    not os.getenv("FUNDING_EVM_FIXTURE"), reason="optional local EVM fixture not running"
)


def test_guard_real_safe_signatures_native_token_batch_and_removal(monkeypatch):
    fixture = json.loads(Path(os.environ["FUNDING_EVM_FIXTURE"]).read_text())
    monkeypatch.setenv("SEPOLIA_RPC_URL", fixture["rpc_url"])
    treasury = Account.from_key(fixture["treasury_key"])
    owner, sq, wrong = Account.create(), Account.create(), Account.create()
    token, recipient = fixture["token"].lower(), Account.create().address.lower()
    safe = chain.deployment(owner.address)["safe_address"]

    def rpc(method, args):
        return chain.rpc_batch([(method, args)])[0]

    def call(to, signature, types=(), values=(), output="uint256"):
        from eth_abi import decode

        return decode(
            [output],
            bytes.fromhex(chain.rpc_batch([chain.eth_call(to, signature, types, values)])[0][2:]),
        )[0]

    def outer(to, data, value=0):
        tx = {
            "chainId": 11155111,
            "nonce": int(rpc("eth_getTransactionCount", [treasury.address, "pending"]), 16),
            "gasPrice": int(rpc("eth_gasPrice", []), 16),
            "gas": 2_000_000,
            "value": value,
            "data": data,
        }
        if to:
            tx["to"] = to_checksum_address(to)
        signed = treasury.sign_transaction(tx)
        txhash = rpc("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex()])
        return rpc("eth_getTransactionReceipt", [txhash])

    deployment = chain.deployment(owner.address)
    assert outer(deployment["factory"], deployment["data"])["status"] == "0x1"
    artifact = json.loads(
        subprocess.run(
            ["node", "scripts/compile-high-value-guard.cjs"],
            cwd=chain.ROOT,
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        ).stdout
    )
    bytecode = "0x" + artifact["evm"]["bytecode"]["object"]
    constructor = encode(
        ["address", "uint256", "address", "uint256"], [sq.address, 10**17, token, 2_000_000]
    ).hex()
    guard_receipt = outer(None, bytecode + constructor)
    assert guard_receipt["status"] == "0x1"
    guard = guard_receipt["contractAddress"]
    assert call(guard, "supportsInterface(bytes4)", ["bytes4"], [bytes.fromhex("01ffc9a7")], "bool")
    assert not call(
        guard, "supportsInterface(bytes4)", ["bytes4"], [bytes.fromhex("ffffffff")], "bool"
    )

    def execute(to, data, value=0, signer=None, cosig=None, operation=0):
        nonce = call(safe, "nonce()")
        tx = {"to": to, "value": "0", "data": data, "operation": operation, "nonce": str(nonce)}
        typed = relay.typed_data(safe, tx)
        typed["message"]["value"] = value
        message = encode_typed_data(full_message=typed)
        owner_sig = owner.sign_message(message).signature
        extra = (
            cosig
            if cosig is not None
            else signer.sign_message(message).signature
            if signer
            else b""
        )
        data = relay.abi_call(
            safe,
            "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
            [
                "address",
                "uint256",
                "bytes",
                "uint8",
                "uint256",
                "uint256",
                "uint256",
                "address",
                "address",
                "bytes",
            ],
            [
                to,
                value,
                bytes.fromhex(data[2:]),
                operation,
                0,
                0,
                0,
                relay.ZERO,
                relay.ZERO,
                owner_sig + extra,
            ],
        )
        result = outer(safe, data)
        assert call(safe, "nonce()") == nonce + (1 if result["status"] == "0x1" else 0)
        return result["status"] == "0x1", message

    # ERC-165 acceptance and the Safe's actual pre-guard nonce ordering are tested here.
    assert execute(safe, relay.abi_call(safe, "setGuard(address)", ["address"], [guard]))[0]
    assert (
        outer(
            token,
            relay.abi_call(
                token, "transfer(address,uint256)", ["address", "uint256"], [safe, 20_000_000]
            ),
        )["status"]
        == "0x1"
    )
    assert outer(safe, "0x", 10**18)["status"] == "0x1"

    def transfer(amount, **kwargs):
        return execute(
            token,
            relay.abi_call(
                token, "transfer(address,uint256)", ["address", "uint256"], [recipient, amount]
            ),
            **kwargs,
        )

    assert transfer(1_000_000)[0]
    # Exactly at the threshold requires a cryptographically valid extra signature.
    assert not transfer(2_000_000)[0]
    assert not transfer(2_000_000, cosig=bytes(65))[0]
    assert not transfer(2_000_000, signer=wrong)[0]
    allowed, message = transfer(2_000_000, signer=sq)
    assert allowed
    old = sq.sign_message(message).signature
    assert not transfer(2_000_000, cosig=old)[0]  # replay at a new nonce
    assert not transfer(3_000_000, cosig=old)[0]  # altered amount
    assert call(token, "balanceOf(address)", ["address"], [recipient]) == 3_000_000
    assert execute(recipient, "0x", 10**16)[0]
    assert not execute(recipient, "0x", 10**17)[0]
    assert execute(recipient, "0x", 10**17, signer=sq)[0]
    # Approvals, unknown tokens and batches cannot bypass the direct-transfer policy.
    assert not execute(
        token,
        relay.abi_call(token, "approve(address,uint256)", ["address", "uint256"], [recipient, 99]),
    )[0]
    assert not execute(
        guard,
        relay.abi_call(guard, "transfer(address,uint256)", ["address", "uint256"], [recipient, 1]),
    )[0]
    packed = (
        b"\x00"
        + bytes.fromhex(token[2:])
        + (0).to_bytes(32, "big")
        + (68).to_bytes(32, "big")
        + bytes.fromhex(
            relay.abi_call(
                token, "transfer(address,uint256)", ["address", "uint256"], [recipient, 3_000_000]
            )[2:]
        )
    )
    assert not execute(
        relay.MULTISEND,
        relay.abi_call(relay.MULTISEND, "multiSend(bytes)", ["bytes"], [packed]),
        operation=1,
    )[0]
    removal = relay.abi_call(safe, "setGuard(address)", ["address"], [relay.ZERO])
    assert not execute(safe, removal)[0]
    assert execute(safe, removal, signer=sq)[0]
    assert transfer(3_000_000)[0]
    assert int(rpc("eth_getBalance", [owner.address, "latest"]), 16) == 0
