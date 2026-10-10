"""Treasury relay policy with real EIP-712 signatures and explicit mocked chain reads."""

import json

import pytest
from eth_abi import encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from test_health import HEADERS

from app.funding import chain
from app.transactions import relay

OWNER = Account.create()
OTHER = Account.create()
SAFE = "0x" + "1" * 40
TOKEN = chain.USDC
RECIPIENT = "0x" + "2" * 40


def authorization(**changes):
    tx = {
        "to": TOKEN,
        "value": "0",
        "data": relay.abi_call(
            TOKEN, "transfer(address,uint256)", ["address", "uint256"], [RECIPIENT, 1_000_000]
        ),
        "operation": 0,
        "nonce": "0",
    }
    tx.update(changes)
    signature = OWNER.sign_message(
        encode_typed_data(full_message=relay.typed_data(SAFE, tx))
    ).signature
    return {
        "chain_id": 11155111,
        "safe_address": SAFE,
        "owner_address": OWNER.address,
        "kind": "transfer",
        "transaction": tx,
        "signature": "0x" + signature.hex(),
    }


@pytest.fixture
def policy(client, monkeypatch):
    monkeypatch.setenv("SWISSQUOTE_TREASURY_ADDRESS", OTHER.address)
    monkeypatch.setenv("ERC20_TEST_ADDRESS", TOKEN)
    monkeypatch.setattr(
        chain, "rpc_batch", lambda calls: ["0x" + encode(["uint256"], [0]).hex() for _ in calls]
    )
    return client


def test_relay_accepts_real_signature_and_deduplicates_before_nonce_recheck(policy, monkeypatch):
    request = authorization()
    first = policy.post("/transactions/relay", json=request, headers=HEADERS)
    assert first.status_code == 200, first.json()
    assert first.json()["status"] == "queued" and first.json()["transaction_hash"] is None
    assert first.json()["gas_payer"] == "swissquote_treasury"
    assert first.json()["id"] == relay.safe_hash(SAFE, request["transaction"])
    monkeypatch.setattr(
        chain,
        "rpc_batch",
        lambda calls: (_ for _ in ()).throw(AssertionError("no chain read on repeat")),
    )
    second = policy.post("/transactions/relay", json=request, headers=HEADERS)
    assert second.json() == first.json()
    assert policy.get("/transactions/" + first.json()["id"], headers=HEADERS).json() == first.json()
    assert "signature" not in json.dumps(first.json())


def test_relay_rejects_wrong_signature(policy):
    request = authorization()
    request["signature"] = (
        "0x"
        + OTHER.sign_message(
            encode_typed_data(full_message=relay.typed_data(SAFE, request["transaction"]))
        ).signature.hex()
    )
    assert policy.post("/transactions/relay", json=request, headers=HEADERS).status_code == 401


@pytest.mark.parametrize(
    "change",
    [
        {"nonce": "1"},
        {"to": RECIPIENT},
        {
            "data": relay.abi_call(
                TOKEN, "approve(address,uint256)", ["address", "uint256"], [RECIPIENT, 100]
            )
        },
        {
            "data": relay.abi_call(
                TOKEN, "transfer(address,uint256)", ["address", "uint256"], [relay.ZERO, 1]
            )
        },
        {
            "data": relay.abi_call(
                TOKEN, "transfer(address,uint256)", ["address", "uint256"], [RECIPIENT, 0]
            )
        },
        {
            "data": relay.abi_call(
                TOKEN,
                "transfer(address,uint256)",
                ["address", "uint256"],
                [RECIPIENT, 10_000_000_001],
            )
        },
        {"operation": 1},
    ],
)
def test_relay_refuses_wrong_nonce_target_call_amount_and_delegatecall(policy, change):
    result = policy.post("/transactions/relay", json=authorization(**change), headers=HEADERS)
    assert result.status_code in (403, 409), result.json()


def test_signed_payload_cannot_be_mutated(policy):
    request = authorization()
    request["transaction"]["data"] = relay.abi_call(
        TOKEN, "transfer(address,uint256)", ["address", "uint256"], [RECIPIENT, 2_000_000]
    )
    assert policy.post("/transactions/relay", json=request, headers=HEADERS).status_code == 401


def test_schema_forbids_native_value_reimbursement_and_foreign_chain(policy):
    for change in (
        {"gasPrice": "1"},
        {"value": "1"},
        {"nonce": "-1"},
        {"nonce": str(2**256)},
        {"data": "0x123"},
    ):
        request = authorization()
        request["transaction"].update(change)
        assert policy.post("/transactions/relay", json=request, headers=HEADERS).status_code == 422
    request = authorization()
    request["chain_id"] = 1
    assert policy.post("/transactions/relay", json=request, headers=HEADERS).status_code == 422


def test_active_safe_cannot_queue_different_authorization(policy):
    assert (
        policy.post("/transactions/relay", json=authorization(), headers=HEADERS).status_code == 200
    )
    request = authorization(
        data=relay.abi_call(
            TOKEN, "transfer(address,uint256)", ["address", "uint256"], [RECIPIENT, 2_000_000]
        )
    )
    assert policy.post("/transactions/relay", json=request, headers=HEADERS).status_code == 409


def test_auth_and_status_privacy(policy, monkeypatch):
    assert policy.post("/transactions/relay", json=authorization()).status_code == 401
    result = policy.post("/transactions/relay", json=authorization(), headers=HEADERS).json()
    monkeypatch.setenv("MOCK_USER_ID", "bob")
    assert policy.get("/transactions/" + result["id"], headers=HEADERS).status_code == 404


def test_cancellation_does_not_require_bank_kyc_or_registration(policy, monkeypatch):
    from app import chain as recovery

    monkeypatch.setenv("MOCK_KYC_STATUS", "rejected")
    monkeypatch.setattr(
        recovery,
        "recovery_state",
        lambda safe: recovery.RecoveryState(
            chain.RECOVERY_3D,
            [OWNER.address.lower(), OTHER.address.lower(), RECIPIENT],
            2,
            1,
            2,
            999,
            [RECIPIENT],
        ),
    )
    request = authorization(
        to=chain.RECOVERY_3D, data=relay.abi_call(chain.RECOVERY_3D, "cancelRecovery()")
    )
    request["kind"] = "cancel-recovery"
    assert policy.post("/transactions/relay", json=request, headers=HEADERS).status_code == 200


def test_noncanonical_data_and_malformed_uint_are_refused(policy):
    request = authorization(
        data=relay.abi_call(
            TOKEN, "transfer(address,uint256)", ["address", "uint256"], [RECIPIENT, 1]
        )
        + "00"
    )
    assert policy.post("/transactions/relay", json=request, headers=HEADERS).status_code == 403


def test_truncated_abi_is_a_client_error_not_server_error(policy):
    result = policy.post(
        "/transactions/relay",
        json=authorization(data=chain.selector("transfer(address,uint256)")),
        headers=HEADERS,
    )
    assert result.status_code == 422, result.json()


@pytest.mark.parametrize("signature", ["0x" + "00" * 65, "0x" + "ff" * 64 + "03"])
def test_malformed_signature_returns_client_error(policy, signature):
    request = authorization()
    request["signature"] = signature
    assert policy.post("/transactions/relay", json=request, headers=HEADERS).status_code == 422
