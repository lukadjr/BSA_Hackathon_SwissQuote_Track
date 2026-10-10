"""Real Safe/Candide bytecode: all online gas is paid by ONE treasury, zero client ETH."""

import json
import os
import subprocess
from pathlib import Path

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct, encode_typed_data
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from test_health import HEADERS

from app import chain as recovery
from app import main as bank
from app.funding import chain, worker
from app.transactions import relay
from app.wallet_registry import control

pytestmark = pytest.mark.skipif(
    not os.getenv("FUNDING_EVM_FIXTURE"), reason="optional local EVM fixture not running"
)


@pytest.mark.parametrize("demo", [True, False], ids=["three-minutes", "three-days"])
def test_zero_eth_full_flow_and_recovery(client, monkeypatch, tmp_path, demo):
    fixture = json.loads(Path(os.environ["FUNDING_EVM_FIXTURE"]).read_text())
    for key, value in {
        "SEPOLIA_RPC_URL": fixture["rpc_url"],
        "ERC20_TEST_ADDRESS": fixture["token"],
        "SWISSQUOTE_TREASURY_ADDRESS": fixture["treasury_address"],
        "SWISSQUOTE_TREASURY_PRIVATE_KEY": fixture["treasury_key"],
        "FUNDING_ALLOW_UNPROTECTED_DEMO": "false",
        "RECOVERY_ALLOW_DEMO": "true" if demo else "false",
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(bank, "verify_control", control.verify_control)
    owner = Account.create()
    backup = Account.create()
    friend = Account.create()
    sq = Account.create()
    new_owner = Account.create()
    keyfile = tmp_path / "guardian.key"
    keyfile.write_text("0x" + sq.key.hex())
    keyfile.chmod(0o600)
    monkeypatch.setenv("SWISSQUOTE_GUARDIAN_KEY_FILE", str(keyfile))
    treasury = worker.treasury_account()
    safe = chain.deployment(owner.address)["safe_address"]
    module = "0x949d01d424be050d09c16025dd007cb59b3a8c66" if demo else chain.RECOVERY_3D
    period = 180 if demo else 3 * 24 * 60 * 60
    engine = create_engine(
        f"sqlite:///{tmp_path / 'bank.sqlite'}", connect_args={"check_same_thread": False}
    )
    bank.Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)

    def db_override():
        with sessions() as db:
            yield db

    bank.app.dependency_overrides[bank.get_db] = db_override
    journal = worker.Journal(tmp_path / "journal.sqlite")

    def rpc(method, params):
        return chain.rpc_batch([(method, params)])[0]

    def balance(address):
        return int(rpc("eth_getBalance", [address, "latest"]), 16)

    treasury_before = balance(treasury.address)

    def token_balance(address):
        return chain.uint_result(
            chain.rpc_batch(
                [chain.eth_call(fixture["token"], "balanceOf(address)", ["address"], [address])]
            )[0]
        )

    def tick():
        worker.process_once(sessions, journal, treasury)

    def finish(url):
        # Ganache mines outer tx immediately; a second block satisfies receipt policy.
        tick()
        rpc("evm_mine", [])
        tick()
        status = client.get(url, headers=HEADERS).json()
        assert status["status"] == "confirmed", status
        assert status["transaction_hash"]
        return status

    def funding(kind, amount, key, account):
        result = client.post(
            "/bank/funding/intents",
            headers=HEADERS,
            json={
                "kind": kind,
                "safe_address": safe,
                "owner_address": account.address,
                "chain_id": 11155111,
                "amount": amount,
                "idempotency_key": key,
            },
        ).json()
        assert "message" in result, result
        signature = (
            "0x" + account.sign_message(encode_defunct(text=result["message"])).signature.hex()
        )
        response = client.post(
            f"/bank/funding/intents/{result['id']}/confirm",
            json={"signature": signature},
            headers=HEADERS,
        )
        assert response.status_code == 200, response.json()
        return finish("/bank/funding/intents/" + result["id"])

    def register(account):
        r = client.post(
            "/wallets/register",
            headers=HEADERS,
            json={"user_id": "alice", "safe_address": safe, "owner_address": account.address},
        )
        assert r.status_code == 200, r.json()

    def link(account):
        register(account)
        result = client.post(
            "/wallets/link/challenge",
            headers=HEADERS,
            json={"safe_address": safe, "owner_address": account.address, "chain_id": 11155111},
        ).json()
        assert "message" in result, result
        signature = (
            "0x" + account.sign_message(encode_defunct(text=result["message"])).signature.hex()
        )
        response = client.post(
            "/wallets/link/complete",
            json={"challenge_id": result["challenge_id"], "signature": signature},
            headers=HEADERS,
        )
        assert response.status_code == 200, response.json()

    def execute(kind, calls, account=owner):
        nonce = chain.uint_result(chain.rpc_batch([chain.eth_call(safe, "nonce()")])[0])
        if len(calls) == 1:
            to, data = calls[0]
            operation = 0
        else:
            packed = b"".join(
                b"\x00"
                + bytes.fromhex(to[2:])
                + (0).to_bytes(32, "big")
                + len(bytes.fromhex(data[2:])).to_bytes(32, "big")
                + bytes.fromhex(data[2:])
                for to, data in calls
            )
            to = relay.MULTISEND
            data = relay.abi_call(to, "multiSend(bytes)", ["bytes"], [packed])
            operation = 1
        tx = {"to": to, "value": "0", "data": data, "operation": operation, "nonce": str(nonce)}
        local = relay.safe_hash(safe, tx)
        hashed = chain.rpc_batch(
            [
                chain.eth_call(
                    safe,
                    "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)",
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
                        "uint256",
                    ],
                    [
                        to,
                        0,
                        bytes.fromhex(data[2:]),
                        operation,
                        0,
                        0,
                        0,
                        relay.ZERO,
                        relay.ZERO,
                        nonce,
                    ],
                )
            ]
        )[0]
        assert hashed.lower() == local
        request = {
            "chain_id": 11155111,
            "safe_address": safe,
            "owner_address": account.address,
            "kind": kind,
            "transaction": tx,
            "signature": "0x"
            + account.sign_message(
                encode_typed_data(full_message=relay.typed_data(safe, tx))
            ).signature.hex(),
        }
        built = subprocess.run(
            ["node", "--import", "tsx", "scripts/treasury-relay-test-sign.ts"],
            input=json.dumps(
                {
                    "safe": safe,
                    "key": "0x" + account.key.hex(),
                    "kind": kind,
                    "nonce": nonce,
                    "calls": calls,
                }
            ),
            cwd=chain.ROOT,
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        )
        typescript_request = json.loads(built.stdout)
        assert {
            **typescript_request["transaction"],
            "to": typescript_request["transaction"]["to"].lower(),
        } == tx
        assert typescript_request["signature"] == request["signature"]
        request = typescript_request
        response = client.post("/transactions/relay", json=request, headers=HEADERS)
        assert response.status_code == 200, response.json()
        result = response.json()
        assert result["id"] == local
        # Repeated POST cannot create a second transfer, even before mining.
        assert (
            client.post("/transactions/relay", json=request, headers=HEADERS).json()["id"] == local
        )
        status = finish("/transactions/" + local)
        # Resume with a reopened durable journal. No fresh bytes or fee are generated.
        journal.close()
        from app.transactions.worker import process_once as relay_tick

        reopened = worker.Journal(tmp_path / "journal.sqlite")
        assert not relay_tick(sessions, reopened, treasury, local)
        reopened.close()
        journal.__init__(tmp_path / "journal.sqlite")
        assert (
            client.post("/transactions/relay", json=request, headers=HEADERS).json()["status"]
            == "confirmed"
        )
        return status

    def recovery_case():
        response = client.post(
            "/recovery/requests",
            headers=HEADERS,
            json={"safe_address": safe, "new_owner_address": new_owner.address},
        )
        assert response.status_code == 200, response.json()
        case = response.json()
        path = "/recovery/requests/" + case["case_id"]
        for guardian in (backup, friend):
            signature = (
                "0x"
                + guardian.sign_message(
                    encode_typed_data(
                        full_message=recovery.recovery_typed_data(
                            module, safe, new_owner.address, int(case["nonce"])
                        )
                    )
                ).signature.hex()
            )
            response = client.post(
                path + "/approvals",
                json={"guardian_address": guardian.address, "signature": signature},
                headers=HEADERS,
            )
            assert response.status_code == 200, response.json()
        response = client.post(path + "/submit", headers=HEADERS)
        assert response.status_code == 200, response.json()
        finish("/transactions/" + response.json()["id"])
        assert client.get(path, headers=HEADERS).json()["status"] == "started"
        return path

    try:
        register(owner)
        funding("deploy", "0", "evm-deploy-" + "x" * 24, owner)
        assert balance(owner.address) == balance(safe) == 0
        guardians = [backup.address.lower(), sq.address.lower(), friend.address.lower()]
        calls = [(safe, relay.abi_call(safe, "enableModule(address)", ["address"], [module]))] + [
            (
                module,
                relay.abi_call(
                    module,
                    "addGuardianWithThreshold(address,uint256)",
                    ["address", "uint256"],
                    [g, 2 if i == 2 else 1],
                ),
            )
            for i, g in enumerate(guardians)
        ]
        execute("protect", calls)
        assert recovery.recovery_state(safe).threshold == 2
        link(owner)
        funding("deposit", "20", "evm-deposit-" + "x" * 24, owner)
        assert token_balance(safe) == 20_000_000
        recipient = Account.create().address.lower()
        execute(
            "transfer",
            [
                (
                    fixture["token"].lower(),
                    relay.abi_call(
                        fixture["token"],
                        "transfer(address,uint256)",
                        ["address", "uint256"],
                        [recipient, 2_000_000],
                    ),
                )
            ],
        )
        assert token_balance(safe) == 18_000_000 and token_balance(recipient) == 2_000_000
        replacement = Account.create()
        state = recovery.recovery_state(safe)
        old = friend.address.lower()
        i = state.guardians.index(old)
        prev = relay.SENTINEL if i == 0 else state.guardians[i - 1]
        execute(
            "replace-guardian",
            [
                (
                    module,
                    relay.abi_call(
                        module,
                        "revokeGuardianWithThreshold(address,address,uint256)",
                        ["address", "address", "uint256"],
                        [prev, old, 2],
                    ),
                ),
                (
                    module,
                    relay.abi_call(
                        module,
                        "addGuardianWithThreshold(address,uint256)",
                        ["address", "uint256"],
                        [replacement.address, 2],
                    ),
                ),
            ],
        )
        assert old not in recovery.recovery_state(safe).guardians
        friend = replacement
        path = recovery_case()
        assert client.post(path + "/finalize", headers=HEADERS).status_code == 409
        execute("cancel-recovery", [(module, relay.abi_call(module, "cancelRecovery()"))])
        assert recovery.recovery_state(safe).execute_after == 0
        execute("invalidate-approvals", [(module, relay.abi_call(module, "invalidateNonce()"))])
        path = recovery_case()
        rpc("evm_increaseTime", [period + 1])
        rpc("evm_mine", [])
        response = client.post(path + "/finalize", headers=HEADERS)
        assert response.status_code == 200, response.json()
        finish("/transactions/" + response.json()["id"])
        assert recovery.owners(safe) == [new_owner.address.lower()]
        assert token_balance(safe) == 18_000_000
        assert (
            client.get("/wallets/link/status", headers=HEADERS).json()["control_status"]
            == "relink_required"
        )
        link(new_owner)
        execute(
            "transfer",
            [
                (
                    fixture["token"].lower(),
                    relay.abi_call(
                        fixture["token"],
                        "transfer(address,uint256)",
                        ["address", "uint256"],
                        [recipient, 1_000_000],
                    ),
                )
            ],
            new_owner,
        )
        funding("deposit", "1", "evm-after-recovery-" + "x" * 24, new_owner)
        assert token_balance(safe) == 18_000_000
        assert all(
            balance(a) == 0
            for a in (owner.address, new_owner.address, safe, backup.address, friend.address)
        )
        # Independent recovery works without calling FastAPI or the treasury worker.
        outside_payer = Account.from_key(fixture["owner_key"])
        offline_owner = Account.create()
        current = recovery.recovery_state(safe)
        approvals = [
            (
                a.address.lower(),
                "0x"
                + a.sign_message(
                    encode_typed_data(
                        full_message=recovery.recovery_typed_data(
                            module, safe, offline_owner.address, current.nonce
                        )
                    )
                ).signature.hex(),
            )
            for a in (backup, friend)
        ]

        def outside_call(data):
            tx = {
                "chainId": 11155111,
                "nonce": int(
                    rpc("eth_getTransactionCount", [outside_payer.address, "pending"]), 16
                ),
                "to": __import__("eth_utils").to_checksum_address(module),
                "data": "0x" + data.hex(),
                "gas": 1_000_000,
                "gasPrice": int(rpc("eth_gasPrice", []), 16),
                "value": 0,
            }
            signed = outside_payer.sign_transaction(tx)
            txhash = rpc("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex()])
            assert int(rpc("eth_getTransactionReceipt", [txhash])["status"], 16) == 1

        outside_call(recovery.multi_confirm_recovery_data(safe, offline_owner.address, approvals))
        pending = recovery.recovery_state(safe)
        assert pending.new_owners == [offline_owner.address.lower()]
        assert pending.execute_after - recovery.latest_timestamp() == period
        rpc("evm_increaseTime", [period + 1])
        rpc("evm_mine", [])
        outside_call(recovery.finalize_recovery_data(safe))
        assert recovery.owners(safe) == [offline_owner.address.lower()]
        assert balance(offline_owner.address) == balance(safe) == 0
        assert token_balance(safe) == 18_000_000
        assert balance(treasury.address) < treasury_before
    finally:
        journal.close()
        engine.dispose()
