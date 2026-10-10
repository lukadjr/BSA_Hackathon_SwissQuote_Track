"""Actual ABI decoding, batch RPC protocol and pinned Safe configuration checks."""

import io
import json

import pytest
from eth_abi import encode
from test_health import OWNER, SAFE

from app.wallet_registry import control

BLOCK = "0x7b"
HASH = "0x" + "a" * 64
PROXY = b"canonical-proxy-test-runtime"


def abi(types, values):
    return "0x" + encode(types, values).hex()


@pytest.fixture
def snapshot(monkeypatch):
    state = {
        "chain": hex(control.CHAIN_ID),
        "block": BLOCK,
        "code": "0x" + PROXY.hex(),
        "singleton": "0x" + int(control.SINGLETON, 16).to_bytes(32, "big").hex(),
        "runtime": abi(["bytes"], [PROXY]),
        "owners": abi(["address[]"], [[OWNER]]),
        "threshold": abi(["uint256"], [1]),
        "version": abi(["string"], ["1.4.1"]),
        "enabled": abi(["bool"], [True]),
        "header": {"number": BLOCK, "hash": HASH},
        "calls": [],
    }

    def rpc(calls):
        state["calls"].extend(calls)
        if calls[0][0] == "eth_chainId":
            return [state["chain"], state["block"]]
        if calls[0][0] == "eth_getCode":
            return [state["code"]]
        return [
            state[key]
            for key in [
                "singleton",
                "runtime",
                "owners",
                "threshold",
                "version",
                "enabled",
                "header",
            ]
        ]

    monkeypatch.setattr(control, "rpc_batch", rpc)
    return state


def test_real_decoding_and_consistent_snapshot(snapshot):
    evidence = control.verify_control(SAFE, OWNER)
    assert evidence == control.ControlEvidence(123, HASH, OWNER)
    for method, params in snapshot["calls"][2:]:
        if method != "eth_getBlockByNumber":
            assert params[-1] == BLOCK
    assert any(
        method == "eth_call" and params[0]["to"] == control.FACTORY
        for method, params in snapshot["calls"]
    )


@pytest.mark.parametrize(
    "key,value,reason",
    [
        ("chain", "0x1", "verification_unavailable"),
        ("block", "invalid", "verification_unavailable"),
        ("code", "0x", "pending_deployment"),
        ("code", "0x1234", "unsupported_safe"),
        ("singleton", "0x1234", "unsupported_safe"),
        ("version", abi(["string"], ["1.3.0"]), "unsupported_safe"),
        ("owners", abi(["address[]"], [[]]), "relink_required"),
        ("owners", abi(["address[]"], [[OWNER, SAFE]]), "relink_required"),
        ("owners", abi(["address[]"], [[SAFE]]), "relink_required"),
        ("threshold", abi(["uint256"], [2]), "relink_required"),
        ("enabled", abi(["bool"], [False]), "unsupported_safe"),
        ("owners", "0xgarbage", "verification_unavailable"),
        ("header", {"number": "0x1", "hash": HASH}, "verification_unavailable"),
        ("header", {"number": BLOCK, "hash": "0x12"}, "verification_unavailable"),
    ],
)
def test_control_refuses_impostors_mismatches_and_bad_rpc(snapshot, key, value, reason):
    snapshot[key] = value
    with pytest.raises(control.ControlError) as exc:
        control.verify_control(SAFE, OWNER)
    assert exc.value.status == reason


def test_rpc_missing_configuration_fails_closed(monkeypatch):
    monkeypatch.delenv("SEPOLIA_RPC_URL", raising=False)
    with pytest.raises(control.ControlError):
        control.rpc_batch([("eth_chainId", [])])


def test_rpc_matches_out_of_order_ids_and_sends_jsonrpc(monkeypatch):
    monkeypatch.setenv("SEPOLIA_RPC_URL", "http://rpc.test")

    def response(request, timeout):
        assert timeout == 5
        payload = json.loads(request.data)
        assert [item["id"] for item in payload] == [0, 1]
        return io.BytesIO(
            json.dumps(
                [
                    {"jsonrpc": "2.0", "id": 1, "result": "second"},
                    {"jsonrpc": "2.0", "id": 0, "result": "first"},
                ]
            ).encode()
        )

    monkeypatch.setattr(control, "urlopen", response)
    assert control.rpc_batch([("one", []), ("two", [])]) == ["first", "second"]


@pytest.mark.parametrize(
    "reply",
    [
        b"invalid json",
        b"{}",
        b"[]",
        b"x" * 1_000_001,
        b'[{"jsonrpc":"2.0","id":0,"error":{"message":"provider-secret"}}]',
        b'[{"jsonrpc":"2.0","id":1,"result":"wrong-id"}]',
        b'[{"jsonrpc":"1.0","id":0,"result":"wrong-version"}]',
    ],
)
def test_rpc_malformed_data_never_leaks_or_verifies(monkeypatch, reply):
    monkeypatch.setenv("SEPOLIA_RPC_URL", "http://rpc.test/provider-secret")
    monkeypatch.setattr(control, "urlopen", lambda *args, **kw: io.BytesIO(reply))
    with pytest.raises(control.ControlError) as exc:
        control.rpc_batch([("eth_chainId", [])])
    assert str(exc.value) == "verification_unavailable"


def test_rpc_network_error_is_sanitized(monkeypatch):
    monkeypatch.setenv("SEPOLIA_RPC_URL", "http://rpc.test/provider-secret")

    def fail(*args, **kwargs):
        raise OSError("provider-secret")

    monkeypatch.setattr(control, "urlopen", fail)
    with pytest.raises(control.ControlError) as exc:
        control.rpc_batch([("eth_chainId", [])])
    assert str(exc.value) == "verification_unavailable"
