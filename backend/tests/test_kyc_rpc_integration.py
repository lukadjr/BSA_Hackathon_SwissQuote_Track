"""Full API→HTTP JSON-RPC→ABI roundtrip against an explicitly mocked chain.

No Sepolia claim is made by these fixtures. Signatures use real viem and
eth-account implementations; the test client/chain use disposable public data.
"""

import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from eth_abi import encode
from test_health import HEADERS, NEW_OWNER, OWNER_KEY, REGISTRATION, SAFE, complete, sign

from app import main
from app.wallet_registry import control


@pytest.fixture
def rpc_server(monkeypatch):
    state = {
        "owner": OWNER_KEY.address.lower(),
        "code": "0x60006000",
        "chain": hex(11155111),
        "requests": [],
    }

    def abi(types, values):
        return "0x" + encode(types, values).hex()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            calls = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["requests"].extend(calls)
            results = []
            for c in calls:
                method, params = c["method"], c["params"]
                if method == "eth_chainId":
                    value = state["chain"]
                elif method == "eth_blockNumber":
                    value = "0x7b"
                elif method == "eth_getCode":
                    value = state["code"]
                elif method == "eth_getStorageAt":
                    value = hex(int(control.SINGLETON, 16))
                elif method == "eth_getBlockByNumber":
                    value = {"number": "0x7b", "hash": "0x" + "a" * 64}
                elif method == "eth_call":
                    function = params[0]["data"][:10]
                    value = {
                        control.selector("proxyRuntimeCode()"): abi(
                            ["bytes"], [bytes.fromhex("60006000")]
                        ),
                        control.selector("getOwners()"): abi(["address[]"], [[state["owner"]]]),
                        control.selector("getThreshold()"): abi(["uint256"], [1]),
                        control.selector("VERSION()"): abi(["string"], ["1.4.1"]),
                        control.selector("isModuleEnabled(address)"): abi(["bool"], [True]),
                    }[function]
                else:
                    raise AssertionError(method)
                results.append({"jsonrpc": "2.0", "id": c["id"], "result": value})
            # Deliberately out of order: correlate by ID, never by array order.
            body = json.dumps(list(reversed(results))).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("SEPOLIA_RPC_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setattr(main, "verify_control", control.verify_control)
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def issue(client):
    client.post(
        "/wallets/register",
        headers=HEADERS,
        json={**REGISTRATION, "owner_address": OWNER_KEY.address},
    )
    r = client.post(
        "/wallets/link/challenge",
        headers=HEADERS,
        json={
            "owner_address": OWNER_KEY.address,
            "safe_address": SAFE,
            "chain_id": 11155111,
        },
    )
    assert r.status_code == 200, r.json()
    return r.json()


def test_real_viem_signature_through_api_and_http_rpc(client, rpc_server):
    data = issue(client)
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            """
import {readFileSync} from 'node:fs';
import {privateKeyToAccount} from 'viem/accounts';
const data = JSON.parse(readFileSync(0, 'utf8'));
const signature = await privateKeyToAccount(data.key).signMessage({message: data.message});
process.stdout.write(signature);
""",
        ],
        input=json.dumps({"key": OWNER_KEY.key.to_0x_hex(), "message": data["message"]}),
        capture_output=True,
        text=True,
        cwd=root,
        timeout=15,
        check=True,
    )
    response = complete(client, data["challenge_id"], result.stdout)
    assert response.status_code == 200, response.json()
    assert response.json()["ownership_verified"] is True
    assert client.get("/wallets/link/status", headers=HEADERS).json()["bank_transfers_allowed"]
    reply = client.post(
        "/bank/transfers/authorize",
        headers=HEADERS,
        json={
            "safe_address": SAFE,
            "chain_id": 11155111,
            "direction": "bank_to_wallet",
            "amount": "10",
        },
    )
    assert reply.json()["status"] == "approved"
    assert reply.json()["funds_moved"] is False
    assert all(
        c["params"][-1] == "0x7b"
        for c in rpc_server["requests"]
        if c["method"] in ["eth_call", "eth_getStorageAt", "eth_getCode"]
    )
    assert complete(client, data["challenge_id"], result.stdout).status_code == 409
    rpc_server["owner"] = NEW_OWNER
    status = client.get("/wallets/link/status", headers=HEADERS).json()
    assert status["control_status"] == "relink_required"
    assert status["bank_transfers_allowed"] is False


def test_http_rpc_owner_change_between_challenge_and_complete(client, rpc_server):
    data = issue(client)
    rpc_server["owner"] = NEW_OWNER
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 409
    assert not client.get("/wallets/link/status", headers=HEADERS).json()["bank_transfers_allowed"]


def test_http_rpc_undeployed_and_wrong_chain_are_refused(client, rpc_server):
    client.post(
        "/wallets/register",
        headers=HEADERS,
        json={**REGISTRATION, "owner_address": OWNER_KEY.address},
    )
    for changed, reason in [
        ({"code": "0x"}, "pending_deployment"),
        ({"code": "0x60006000", "chain": "0x1"}, "verification_unavailable"),
    ]:
        rpc_server.update(changed)
        r = client.post(
            "/wallets/link/challenge",
            headers=HEADERS,
            json={
                "owner_address": OWNER_KEY.address,
                "safe_address": SAFE,
                "chain_id": 11155111,
            },
        )
        assert r.status_code in (409, 503)
        assert r.json()["detail"] == reason
