"""Funding API and durable worker tests. Chain responses are explicit test fixtures."""

from datetime import timedelta

import pytest
from dotenv import dotenv_values
from eth_account import Account
from eth_account.messages import encode_defunct
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from test_health import HEADERS, OWNER_KEY, SAFE, challenge, complete, sign

from app import main as bank
from app.funding import chain, routes, worker
from app.funding.setup import initialize
from app.wallet_registry.control import ControlError

TOKEN = chain.USDC


@pytest.fixture
def treasury(client, monkeypatch, tmp_path):
    signer = Account.create()
    monkeypatch.setenv("SWISSQUOTE_TREASURY_PRIVATE_KEY", signer.key.hex())
    monkeypatch.setenv("SWISSQUOTE_TREASURY_ADDRESS", signer.address)
    monkeypatch.setenv("ERC20_TEST_ADDRESS", TOKEN)
    monkeypatch.setattr(chain, "security_status", lambda safe: "recovery_2_of_3_seven_days")
    state = {
        "balance": 100_000_000,
        "eth": 10**18,
        "receipt": None,
        "broadcasts": [],
        "latest": 101,
        "hash": "0x" + "a" * 64,
        "network": 11155111,
        "timeout": False,
    }

    def snapshot():
        return {
            "treasury_address": signer.address.lower(),
            "token_address": TOKEN,
            "decimals": 6,
            "balance_units": str(state["balance"]),
            "eth_balance_wei": str(state["eth"]),
            "chain_id": 11155111,
            "checked_block": 101,
            "token_label": "Test USDC",
            "bank_mocked": True,
        }

    def rpc(calls):
        out = []
        for method, args in calls:
            if method == "eth_getTransactionCount":
                out.append("0x0")
            elif method == "eth_gasPrice":
                out.append(hex(10**9))
            elif method == "eth_estimateGas":
                out.append(hex(60_000))
            elif method == "eth_chainId":
                out.append(hex(state["network"]))
            elif method == "eth_blockNumber":
                out.append(hex(state["latest"]))
            elif method == "eth_getTransactionReceipt":
                out.append(state["receipt"])
            elif method == "eth_getBlockByNumber":
                out.append({"hash": state["hash"], "number": "0x64"})
            elif method == "eth_getCode":
                out.append("0x")
            elif method == "eth_sendRawTransaction":
                state["broadcasts"].append(args[0])
                if state["timeout"]:
                    raise ControlError("verification_unavailable")
                out.append("0x" + worker.keccak(bytes.fromhex(args[0][2:])).hex())
            else:
                raise AssertionError(method)
        return out

    monkeypatch.setattr(chain, "snapshot", snapshot)
    monkeypatch.setattr(chain, "rpc_batch", rpc)
    monkeypatch.setattr(
        chain,
        "deployment",
        lambda owner: {"safe_address": SAFE, "factory": chain.FACTORY, "data": "0x1234"},
    )
    # Use a real file database to cover worker restart and independent sessions.
    engine = create_engine(
        f"sqlite:///{tmp_path / 'bank.sqlite'}", connect_args={"check_same_thread": False}
    )
    bank.Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)

    def db_override():
        with sessions() as db:
            yield db

    bank.app.dependency_overrides[bank.get_db] = db_override
    data = challenge(client)
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 200
    journal_path = tmp_path / "journal.sqlite"
    journal = worker.Journal(journal_path)
    yield {
        "signer": signer,
        "state": state,
        "sessions": sessions,
        "journal": journal,
        "journal_path": journal_path,
    }
    journal.close()
    engine.dispose()


def create(client, **changes):
    return client.post(
        "/bank/funding/intents",
        headers=HEADERS,
        json={
            "kind": "deposit",
            "safe_address": SAFE,
            "owner_address": OWNER_KEY.address,
            "chain_id": 11155111,
            "amount": "20",
            "idempotency_key": "request-" + "x" * 24,
            **changes,
        },
    )


def confirm(client, intent, signature=None):
    return client.post(
        f"/bank/funding/intents/{intent['id']}/confirm",
        headers=HEADERS,
        json={"signature": signature or sign(intent["message"])},
    )


def status(client, intent):
    result = client.get(f"/bank/funding/intents/{intent['id']}", headers=HEADERS)
    assert result.status_code == 200
    return result.json()


def tick(t):
    return worker.process_once(t["sessions"], t["journal"], t["signer"])


def receipt(t, intent, **changes):
    tx = status_intent(t, intent)
    return {
        "transactionHash": tx.transaction_hash,
        "blockNumber": "0x64",
        "blockHash": t["state"]["hash"],
        "status": "0x1",
        "logs": [
            {
                "address": TOKEN,
                "topics": [
                    worker.TRANSFER_TOPIC,
                    "0x" + t["signer"].address[2:].lower().rjust(64, "0"),
                    "0x" + SAFE[2:].rjust(64, "0"),
                ],
                "data": "0x" + int(intent["amount_units"]).to_bytes(32, "big").hex(),
            }
        ],
        **changes,
    }


def status_intent(t, intent):
    with t["sessions"]() as db:
        return db.get(routes.FundingDB, intent["id"])


def test_account_returns_real_read_balances_and_no_secrets(client, treasury):
    result = client.get("/bank/account", headers=HEADERS)
    assert result.status_code == 200
    data = result.json()
    assert data["available_units"] == "100000000"
    assert data["single_client_demo"] is True
    assert data["bank_mocked"] is True
    assert "private" not in result.text and treasury["signer"].key.hex() not in result.text
    assert client.get("/bank/account").status_code == 401
    assert client.get("/bank/funding/intents").status_code == 401


@pytest.mark.parametrize(
    "changes",
    [
        {"amount": "0"},
        {"amount": "-1"},
        {"amount": "NaN"},
        {"amount": "Infinity"},
        {"amount": "0.0000001"},
        {"chain_id": 1},
        {"safe_address": "invalid"},
        {"owner_address": "0x" + "0" * 40},
        {"kind": "mint"},
        {"private_key": "forbidden"},
        {"idempotency_key": "short"},
        {"kind": "deploy", "amount": "1"},
    ],
)
def test_invalid_instructions_are_rejected(client, treasury, changes):
    assert create(client, **changes).status_code == 422
    assert client.get("/bank/funding/intents", headers=HEADERS).json()["intents"] == []


def test_creation_is_idempotent_and_only_one_active_request(client, treasury):
    first = create(client)
    assert first.status_code == 200, first.json()
    assert create(client).json()["id"] == first.json()["id"]
    assert create(client, amount="21").status_code == 409
    assert create(client, idempotency_key="another-" + "z" * 24).status_code == 409
    assert first.json()["amount_units"] == "20000000"
    assert first.json()["security_mode"] == "recovery_2_of_3_seven_days"


@pytest.mark.parametrize("kyc", ["pending", "rejected"])
def test_kyc_blocks_create_and_confirm(client, treasury, monkeypatch, kyc):
    intent = create(client).json()
    monkeypatch.setenv("MOCK_KYC_STATUS", kyc)
    assert confirm(client, intent).status_code == 403
    assert client.get("/bank/account", headers=HEADERS).status_code == 403


def test_destination_and_owner_must_match_bank_link(client, treasury):
    assert create(client, safe_address="0x" + "3" * 40).status_code == 409
    assert create(client, owner_address="0x" + "3" * 40).status_code == 409


def test_high_value_and_insufficient_funds_are_rejected(client, treasury):
    assert create(client, amount="10000.000001").status_code == 403
    assert create(client, amount="101").status_code == 409
    treasury["state"]["eth"] = 0
    assert create(client).status_code == 409


def test_signature_replay_and_wrong_signer_never_queue(client, treasury):
    intent = create(client).json()
    bad = Account.create().sign_message(encode_defunct(text=intent["message"]))
    assert confirm(client, intent, "0x" + bad.signature.hex()).status_code == 401
    assert confirm(client, intent, sign("different purpose")).status_code == 401
    assert status(client, intent)["status"] == "awaiting_confirmation"
    assert confirm(client, intent).json()["status"] == "queued"
    assert confirm(client, intent).json()["status"] == "queued"
    assert client.get("/bank/account", headers=HEADERS).json()["available_units"] == "80000000"


def test_other_identity_cannot_read_confirm_or_discover_intent(client, treasury, monkeypatch):
    intent = create(client).json()
    monkeypatch.setenv("MOCK_USER_ID", "bob")
    assert client.get(f"/bank/funding/intents/{intent['id']}", headers=HEADERS).status_code == 404
    assert confirm(client, intent).status_code == 404
    assert client.get("/bank/funding/intents", headers=HEADERS).json()["intents"] == []


def test_expired_unsigned_request_releases_slot(client, treasury):
    intent = create(client).json()
    with treasury["sessions"]() as db:
        db.get(routes.FundingDB, intent["id"]).expires_at = bank.utcnow() - timedelta(seconds=1)
        db.commit()
    assert confirm(client, intent).status_code == 410
    assert status(client, intent)["status"] == "expired"
    assert create(client, idempotency_key="replacement-" + "z" * 24).status_code == 200


def test_owner_rotation_blocks_confirmation_and_worker(client, treasury, monkeypatch):
    intent = create(client).json()
    assert confirm(client, intent).status_code == 200
    monkeypatch.setattr(
        bank, "verify_control", lambda *args: (_ for _ in ()).throw(ControlError("relink_required"))
    )
    tick(treasury)
    assert status(client, intent)["status"] == "failed"
    assert treasury["state"]["broadcasts"] == []
    assert treasury["journal"].get(intent["id"]) is None


def test_registration_change_during_final_rpc_blocks_confirmation(client, treasury, monkeypatch):
    intent = create(client).json()
    original = chain.security_status

    def change(safe):
        with treasury["sessions"]() as db:
            wallet = db.query(bank.WalletDB).filter_by(user_id="alice").first()
            wallet.owner_address = "0x" + "3" * 40
            db.get(bank.ControlAttestationDB, "alice").invalidated = True
            db.commit()
        return original(safe)

    monkeypatch.setattr(chain, "security_status", change)
    assert confirm(client, intent).status_code == 409
    assert status(client, intent)["status"] == "awaiting_confirmation"


def test_worker_signs_broadcasts_and_confirms_exact_transfer(client, treasury):
    intent = create(client).json()
    confirm(client, intent)
    tick(treasury)
    data = status(client, intent)
    assert data["status"] == "submitted"
    raw = treasury["state"]["broadcasts"][0]
    assert Account.recover_transaction(raw).lower() == treasury["signer"].address.lower()
    assert data["transaction_hash"] == "0x" + worker.keccak(bytes.fromhex(raw[2:])).hex()
    treasury["state"]["receipt"] = receipt(treasury, intent)
    tick(treasury)
    assert status(client, intent)["status"] == "confirmed"
    assert status(client, intent)["receipt_block"] == "100"
    assert tick(treasury) is False
    assert len(treasury["state"]["broadcasts"]) == 1


def test_broadcast_timeout_restart_and_duplicate_confirmation_reuse_same_bytes(client, treasury):
    intent = create(client).json()
    confirm(client, intent)
    treasury["state"]["timeout"] = True
    tick(treasury)
    assert status(client, intent)["status"] == "reconciling"
    treasury["journal"].close()
    treasury["journal"] = worker.Journal(treasury["journal_path"])
    assert confirm(client, intent).json()["status"] == "reconciling"
    treasury["state"]["timeout"] = False
    tick(treasury)
    assert len(treasury["state"]["broadcasts"]) == 2
    assert treasury["state"]["broadcasts"][0] == treasury["state"]["broadcasts"][1]
    treasury["state"]["receipt"] = receipt(treasury, intent)
    tick(treasury)
    assert status(client, intent)["status"] == "confirmed"


def test_crash_between_signing_journal_and_api_commit_does_not_resign(
    client, treasury, monkeypatch
):
    intent = create(client).json()
    confirm(client, intent)
    with treasury["sessions"]() as db:
        row = db.get(routes.FundingDB, intent["id"])
        signed, nonce = worker.prepare(row, db, treasury["signer"])
        treasury["journal"].save(row.id, treasury["signer"].address.lower(), signed, nonce)
    monkeypatch.setattr(
        worker, "prepare", lambda *args: pytest.fail("must reuse persisted signature")
    )
    tick(treasury)
    assert status(client, intent)["transaction_hash"] == "0x" + signed.hash.hex()
    assert len(treasury["state"]["broadcasts"]) == 1


@pytest.mark.parametrize(
    "mutation", ["token", "recipient", "source", "amount", "missing", "duplicate", "hash"]
)
def test_mismatched_success_receipt_never_credits_wallet(client, treasury, mutation):
    intent = create(client).json()
    confirm(client, intent)
    tick(treasury)
    result = receipt(treasury, intent)
    if mutation == "token":
        result["logs"][0]["address"] = SAFE
    elif mutation in ("recipient", "source"):
        result["logs"][0]["topics"][2 if mutation == "recipient" else 1] = "0x" + "0" * 64
    elif mutation == "amount":
        result["logs"][0]["data"] = "0x" + "0" * 64
    elif mutation == "missing":
        result["logs"] = []
    elif mutation == "duplicate":
        result["logs"] *= 2
    else:
        result["transactionHash"] = "0x" + "b" * 64
    treasury["state"]["receipt"] = result
    tick(treasury)
    assert status(client, intent)["status"] == "reconciling"
    assert status(client, intent)["receipt_block"] is None
    assert len(treasury["state"]["broadcasts"]) == 1


def test_revert_releases_request_but_never_claims_success(client, treasury):
    intent = create(client).json()
    confirm(client, intent)
    tick(treasury)
    treasury["state"]["receipt"] = receipt(treasury, intent, status="0x0", logs=[])
    tick(treasury)
    assert status(client, intent)["status"] == "failed"
    assert create(client, idempotency_key="new-request-" + "z" * 24).status_code == 200


def test_one_confirmation_and_reorg_wait_for_canonical_two_confirmations(client, treasury):
    intent = create(client).json()
    confirm(client, intent)
    tick(treasury)
    treasury["state"]["receipt"] = receipt(treasury, intent)
    treasury["state"]["latest"] = 100
    tick(treasury)
    assert status(client, intent)["status"] == "submitted"
    treasury["state"]["latest"] = 101
    treasury["state"]["hash"] = "0x" + "b" * 64
    tick(treasury)
    assert status(client, intent)["status"] == "reconciling"
    treasury["state"]["receipt"]["blockHash"] = treasury["state"]["hash"]
    tick(treasury)
    assert status(client, intent)["status"] == "confirmed"


@pytest.mark.parametrize("change", ["eth", "tokens", "expired", "rpc"])
def test_prebroadcast_failure_has_no_signed_transaction(client, treasury, monkeypatch, change):
    intent = create(client).json()
    confirm(client, intent)
    if change == "eth":
        treasury["state"]["eth"] = 1
    elif change == "tokens":
        treasury["state"]["balance"] = 1
    elif change == "expired":
        with treasury["sessions"]() as db:
            db.get(routes.FundingDB, intent["id"]).expires_at = bank.utcnow() - timedelta(seconds=1)
            db.commit()
    else:
        monkeypatch.setattr(
            chain,
            "snapshot",
            lambda: (_ for _ in ()).throw(ControlError("verification_unavailable")),
        )
    tick(treasury)
    assert status(client, intent)["status"] == ("queued" if change == "rpc" else "failed")
    assert treasury["journal"].get(intent["id"]) is None
    assert treasury["state"]["broadcasts"] == []


def test_deployment_can_be_signed_before_bank_linking(client, treasury):
    with treasury["sessions"]() as db:
        db.get(bank.ControlAttestationDB, "alice").invalidated = True
        db.commit()
    intent = create(client, kind="deploy", amount="0").json()
    assert intent["security_mode"] == "setup_only"
    assert confirm(client, intent).json()["status"] == "queued"
    tick(treasury)
    treasury["state"]["receipt"] = receipt(treasury, intent, logs=[])
    tick(treasury)
    assert status(client, intent)["status"] == "confirmed"


def test_setup_creates_once_preserves_key_and_does_not_print_secrets(tmp_path, capsys):
    path = tmp_path / ".env"
    first = initialize(path)
    before = dotenv_values(path)
    assert initialize(path) == first
    assert dotenv_values(path) == before
    assert path.stat().st_mode & 0o777 == 0o600
    assert before["FUNDING_ALLOW_UNPROTECTED_DEMO"] == "false"
    assert before["MOCK_KYC_STATUS"] == "pending"
    assert capsys.readouterr().out == ""
    assert Account.from_key(before["SWISSQUOTE_TREASURY_PRIVATE_KEY"]).address == first


def test_setup_refuses_to_replace_missing_or_mismatched_existing_key(tmp_path):
    path = tmp_path / ".env"
    path.write_text(f"SWISSQUOTE_TREASURY_ADDRESS={SAFE}\n")
    with pytest.raises(ValueError):
        initialize(path)
    key = Account.create()
    path.write_text(
        f"SWISSQUOTE_TREASURY_ADDRESS={SAFE}\nSWISSQUOTE_TREASURY_PRIVATE_KEY={key.key.hex()}\n"
    )
    before = path.read_text()
    with pytest.raises(ValueError):
        initialize(path)
    assert path.read_text() == before


def test_worker_refuses_wrong_key_or_network(client, treasury, monkeypatch):
    monkeypatch.setenv("SWISSQUOTE_TREASURY_ADDRESS", SAFE)
    with pytest.raises(ControlError):
        worker.treasury_account()


def test_sdk_deployment_builder_uses_pinned_safe_and_rejects_invalid_owner(monkeypatch):
    monkeypatch.undo()
    value = chain.deployment(OWNER_KEY.address)
    assert value["factory"] == chain.FACTORY
    assert len(value["safe_address"]) == 42
    assert value["data"].startswith("0x1688f0b9")
    with pytest.raises(ControlError):
        chain.deployment("not-an-address")
