"""Optional real-EVM acceptance: pinned Safe deployment and mined ERC-20 transfer.

Requires scripts/funding-evm-fixture.cjs. This is a local chain, not Sepolia evidence.
"""

import json
import os
from pathlib import Path

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from test_health import HEADERS

from app import main as bank
from app.funding import chain, worker
from app.wallet_registry import control

pytestmark = pytest.mark.skipif(
    not os.getenv("FUNDING_EVM_FIXTURE"), reason="optional local EVM fixture not running"
)


def test_real_safe_deployment_bank_link_and_exact_token_transfer(client, monkeypatch, tmp_path):
    fixture = json.loads(Path(os.environ["FUNDING_EVM_FIXTURE"]).read_text())
    monkeypatch.setenv("SEPOLIA_RPC_URL", fixture["rpc_url"])
    monkeypatch.setenv("ERC20_TEST_ADDRESS", fixture["token"])
    monkeypatch.setenv("SWISSQUOTE_TREASURY_ADDRESS", fixture["treasury_address"])
    monkeypatch.setenv("SWISSQUOTE_TREASURY_PRIVATE_KEY", fixture["treasury_key"])
    monkeypatch.setenv("FUNDING_ALLOW_UNPROTECTED_DEMO", "true")
    monkeypatch.setattr(bank, "verify_control", control.verify_control)
    owner = Account.create()  # Fresh Safe on every run; this owner never needs gas.
    treasury = worker.treasury_account()
    payload = chain.deployment(owner.address)
    safe = payload["safe_address"]
    engine = create_engine(
        f"sqlite:///{tmp_path / 'evm-bank.sqlite'}", connect_args={"check_same_thread": False}
    )
    bank.Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)

    def override_db():
        with sessions() as db:
            yield db

    bank.app.dependency_overrides[bank.get_db] = override_db
    journal = worker.Journal(tmp_path / "evm-journal.sqlite")

    def signed(message):
        return "0x" + owner.sign_message(encode_defunct(text=message)).signature.hex()

    def operation(kind, amount, key):
        response = client.post(
            "/bank/funding/intents",
            headers=HEADERS,
            json={
                "kind": kind,
                "safe_address": safe,
                "owner_address": owner.address,
                "chain_id": 11155111,
                "amount": amount,
                "idempotency_key": key,
            },
        )
        assert response.status_code == 200, response.json()
        intent = response.json()
        assert (
            client.post(
                f"/bank/funding/intents/{intent['id']}/confirm",
                headers=HEADERS,
                json={"signature": signed(intent["message"])},
            ).status_code
            == 200
        )
        worker.process_once(sessions, journal, treasury)
        chain.rpc_batch([("evm_mine", [])])
        worker.process_once(sessions, journal, treasury)
        result = client.get(f"/bank/funding/intents/{intent['id']}", headers=HEADERS).json()
        assert result["status"] == "confirmed", result
        assert result["transaction_hash"]
        return intent, result

    try:
        assert (
            client.post(
                "/wallets/register",
                headers=HEADERS,
                json={
                    "user_id": "alice",
                    "safe_address": safe,
                    "owner_address": owner.address,
                },
            ).status_code
            == 200
        )
        # If rerun, the fixture Safe may already exist. A fresh fixture is recommended.
        deploy, deployed = operation("deploy", "0", "local-deploy-" + "x" * 24)
        control.verify_control(safe, owner.address.lower())
        link = client.post(
            "/wallets/link/challenge",
            headers=HEADERS,
            json={
                "safe_address": safe,
                "owner_address": owner.address,
                "chain_id": 11155111,
            },
        )
        assert link.status_code == 200, link.json()
        c = link.json()
        assert (
            client.post(
                "/wallets/link/complete",
                headers=HEADERS,
                json={
                    "challenge_id": c["challenge_id"],
                    "signature": signed(c["message"]),
                },
            ).status_code
            == 200
        )
        before = chain.snapshot()
        token = fixture["token"]
        before_safe = chain.uint_result(
            chain.rpc_batch([chain.eth_call(token, "balanceOf(address)", ["address"], [safe])])[0]
        )
        deposit, confirmed = operation("deposit", "20.000001", "local-deposit-" + "x" * 24)
        assert deposit["security_mode"] == "unprotected_test_demo"
        after = chain.snapshot()
        after_safe = chain.uint_result(
            chain.rpc_batch([chain.eth_call(token, "balanceOf(address)", ["address"], [safe])])[0]
        )
        assert int(before["balance_units"]) - int(after["balance_units"]) == 20_000_001
        assert after_safe - before_safe == 20_000_001
        assert int(after["eth_balance_wei"]) < int(before["eth_balance_wei"])
        # API replay and worker restart do not create another on-chain transfer.
        assert (
            client.post(
                f"/bank/funding/intents/{deposit['id']}/confirm",
                headers=HEADERS,
                json={"signature": signed(deposit["message"])},
            ).json()["transaction_hash"]
            == confirmed["transaction_hash"]
        )
        journal.close()
        journal = worker.Journal(tmp_path / "evm-journal.sqlite")
        assert not worker.process_once(sessions, journal, treasury)
        assert chain.snapshot()["balance_units"] == after["balance_units"]
        assert "private_key" not in json.dumps(confirmed)
    finally:
        journal.close()
        engine.dispose()
