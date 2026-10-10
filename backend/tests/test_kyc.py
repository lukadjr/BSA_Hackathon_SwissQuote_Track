"""Bank identity/attestation adversarial tests; RPC is explicitly substituted here."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from test_health import (
    HEADERS,
    NEW_OWNER,
    OWNER_KEY,
    REGISTRATION,
    SAFE,
    challenge,
    complete,
    sign,
)

from app import main
from app.wallet_registry.control import ControlError, ControlEvidence


def status(client):
    return client.get("/wallets/link/status", headers=HEADERS)


def link(client):
    data = challenge(client)
    response = complete(client, data["challenge_id"], sign(data["message"]))
    assert response.status_code == 200, response.json()
    return data


def bank(client, **fields):
    return client.post(
        "/bank/transfers/authorize",
        headers=HEADERS,
        json={
            "safe_address": SAFE,
            "chain_id": 11155111,
            "direction": "bank_to_wallet",
            "amount": "10",
            **fields,
        },
    )


def test_identity_is_authenticated_server_controlled_and_labelled(client):
    assert client.get("/auth/me").status_code == 401
    profile = client.get("/auth/me", headers=HEADERS).json()
    assert profile["client_id"] == "alice"
    assert profile["kyc_status"] == "verified"
    assert profile["mocked"] is True
    assert profile["verified_at"]
    assert (
        client.post("/auth/me", headers=HEADERS, json={"kyc_status": "verified"}).status_code == 405
    )


@pytest.mark.parametrize("kyc", ["pending", "rejected"])
def test_unverified_identity_cannot_link_or_authorize(client, monkeypatch, kyc):
    monkeypatch.setenv("MOCK_KYC_STATUS", kyc)
    assert client.get("/auth/me", headers=HEADERS).json()["verified_at"] is None
    client.post("/wallets/register", json=REGISTRATION, headers=HEADERS)
    assert (
        client.post(
            "/wallets/link/challenge",
            headers=HEADERS,
            json={
                "owner_address": REGISTRATION["owner_address"],
                "safe_address": SAFE,
                "chain_id": 11155111,
            },
        ).status_code
        == 403
    )
    assert bank(client).status_code == 403
    assert status(client).json()["bank_transfers_allowed"] is False


def test_missing_and_invalid_kyc_configuration_fail_closed(client, monkeypatch):
    monkeypatch.delenv("MOCK_KYC_STATUS")
    assert client.get("/auth/me", headers=HEADERS).json()["kyc_status"] == "pending"
    monkeypatch.setenv("MOCK_KYC_STATUS", "fake-verified")
    assert client.get("/auth/me", headers=HEADERS).status_code == 503


def test_link_challenge_binds_every_context_field(client):
    data = challenge(client)
    for item in [
        "Purpose: link-safe",
        "Domain: swissquote-wallet.demo",
        "Account: alice",
        f"Safe: {SAFE}",
        f"Owner key: {OWNER_KEY.address.lower()}",
        "Chain ID: 11155111",
        f"Nonce: {data['challenge_id']}",
        f"Expires: {data['expires_at']}",
    ]:
        assert item in data["message"]
    assert data["chain_id"] == 11155111


@pytest.mark.parametrize(
    "changed",
    [
        {"safe_address": NEW_OWNER},
        {"owner_address": NEW_OWNER},
        {"chain_id": 1},
        {"kyc_status": "verified"},
        {"rpc_url": "http://attacker.test"},
        {"private_key": "secret"},
    ],
)
def test_challenge_rejects_wrong_or_untrusted_context(client, changed):
    client.post("/wallets/register", json=REGISTRATION, headers=HEADERS)
    response = client.post(
        "/wallets/link/challenge",
        headers=HEADERS,
        json={
            "owner_address": REGISTRATION["owner_address"],
            "safe_address": SAFE,
            "chain_id": 11155111,
            **changed,
        },
    )
    assert response.status_code in (409, 422)


@pytest.mark.parametrize(
    "reason,code",
    [
        ("pending_deployment", 409),
        ("relink_required", 409),
        ("unsupported_safe", 409),
        ("verification_unavailable", 503),
    ],
)
def test_chain_failure_cannot_issue_attestation(client, monkeypatch, reason, code):
    data = challenge(client)

    def refuse(safe, owner):
        raise ControlError(reason)

    monkeypatch.setattr(main, "verify_control", refuse)
    result = complete(client, data["challenge_id"], sign(data["message"]))
    assert result.status_code == code
    assert status(client).json()["bank_transfers_allowed"] is False
    assert bank(client).status_code == 403
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 409


def test_link_evidence_is_persisted_and_bank_checks_chain_each_time(client, monkeypatch):
    link(client)
    calls = []

    def verify(safe, owner):
        calls.append(safe)
        return ControlEvidence(234, "0x" + "b" * 64, owner)

    monkeypatch.setattr(main, "verify_control", verify)
    result = status(client).json()
    assert result["control_status"] == "verified"
    assert result["bank_transfers_allowed"] is True
    assert result["checked_block"] == 234
    assert result["security_configuration_verified"] is False
    for direction in ["bank_to_wallet", "wallet_to_bank"]:
        for amount, outcome in [("10000", "approved"), ("10000.000001", "review_required")]:
            reply = bank(client, direction=direction, amount=amount).json()
            assert reply["status"] == outcome
            assert reply["funds_moved"] is False
            assert reply["mocked"] is True
    assert len(calls) == 5


def test_kyc_downgrade_blocks_bank_and_challenge_completion(client, monkeypatch):
    data = link(client)
    pending = challenge(client)
    monkeypatch.setenv("MOCK_KYC_STATUS", "rejected")
    assert status(client).json()["bank_transfers_allowed"] is False
    assert bank(client).status_code == 403
    assert complete(client, pending["challenge_id"], sign(pending["message"])).status_code == 403
    assert data["safe_address"] == SAFE


def test_owner_rotation_invalidates_persistently_and_relink_restores(client, monkeypatch):
    link(client)
    original = main.verify_control

    def rotated(safe, owner):
        raise ControlError("relink_required")

    monkeypatch.setattr(main, "verify_control", rotated)
    assert status(client).json()["control_status"] == "relink_required"
    assert bank(client).status_code == 403
    monkeypatch.setattr(main, "verify_control", original)
    assert status(client).json()["control_status"] == "relink_required"
    link(client)
    assert bank(client).status_code == 200


def test_rpc_failure_blocks_temporarily_without_destroying_link(client, monkeypatch):
    link(client)
    original = main.verify_control

    def unavailable(safe, owner):
        raise ControlError("verification_unavailable")

    monkeypatch.setattr(main, "verify_control", unavailable)
    assert status(client).json()["control_status"] == "verification_unavailable"
    assert bank(client).status_code == 503
    monkeypatch.setattr(main, "verify_control", original)
    assert bank(client).status_code == 200


def test_registration_change_revokes_attestation_and_all_challenges(client):
    link(client)
    data = challenge(client)
    client.post(
        "/wallets/register", headers=HEADERS, json={**REGISTRATION, "owner_address": NEW_OWNER}
    )
    # Changing back cannot revive a previously revoked challenge/attestation.
    client.post(
        "/wallets/register",
        headers=HEADERS,
        json={**REGISTRATION, "owner_address": OWNER_KEY.address},
    )
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 409
    assert status(client).json()["control_status"] == "relink_required"
    assert bank(client).status_code == 403


def test_registration_race_during_rpc_does_not_create_attestation(client, monkeypatch):
    data = challenge(client)
    original = main.verify_control

    def change(safe, owner):
        client.post(
            "/wallets/register", headers=HEADERS, json={**REGISTRATION, "owner_address": NEW_OWNER}
        )
        return original(safe, owner)

    monkeypatch.setattr(main, "verify_control", change)
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 409
    assert status(client).json()["control_status"] == "unlinked"


@pytest.mark.parametrize(
    "changed",
    [
        {"safe_address": NEW_OWNER},
        {"chain_id": 1},
        {"amount": "NaN"},
        {"amount": "-1"},
        {"amount": "0.0000001"},
        {"direction": "p2p"},
        {"kyc_status": "verified"},
    ],
)
def test_bank_authorization_validates_all_inputs(client, changed):
    link(client)
    assert bank(client, **changed).status_code in (409, 422)


def test_legacy_tables_cannot_grant_bank_authorization(client):
    client.post("/wallets/register", json=REGISTRATION, headers=HEADERS)
    assert status(client).json()["control_status"] == "unlinked"
    assert bank(client).status_code == 403


def test_challenge_expiring_during_verification_is_refused(client, monkeypatch):
    data = challenge(client)
    original = main.verify_control

    def slow(safe, owner):
        monkeypatch.setattr(
            main,
            "utcnow",
            lambda: main.datetime.now(main.UTC).replace(tzinfo=None) + timedelta(minutes=6),
        )
        return original(safe, owner)

    monkeypatch.setattr(main, "verify_control", slow)
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 409
    assert bank(client).status_code == 403


def test_concurrent_challenge_consumption_has_one_winner(client, tmp_path):
    # Full endpoint race with separate sessions and file-backed SQLite.
    engine = create_engine(
        f"sqlite:///{tmp_path}/race.db", connect_args={"check_same_thread": False}
    )
    main.Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)

    def override_db():
        with sessions() as db:
            yield db

    main.app.dependency_overrides[main.get_db] = override_db
    data = challenge(client)
    signature = sign(data["message"])
    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(
            pool.map(
                lambda _: complete(client, data["challenge_id"], signature).status_code, range(8)
            )
        )
    assert sorted(outcomes) == [200] + [409] * 7
    with sessions() as db:
        assert db.query(main.ControlAttestationDB).count() == 1
        attestation = db.get(main.ControlAttestationDB, "alice")
        assert attestation.challenge_id == data["challenge_id"]
        assert attestation.signature == signature
        assert attestation.block_number == 123
        assert db.query(main.AuditEventDB).filter_by(action="safe_control_verified").count() == 1
    engine.dispose()


def test_registration_race_during_status_cannot_authorize_stale_proof(client, monkeypatch):
    link(client)
    original = main.verify_control

    def change(safe, owner):
        client.post(
            "/wallets/register", headers=HEADERS, json={**REGISTRATION, "owner_address": NEW_OWNER}
        )
        return original(safe, owner)

    monkeypatch.setattr(main, "verify_control", change)
    response = status(client).json()
    assert response["control_status"] == "relink_required"
    assert response["bank_transfers_allowed"] is False
    assert response["owner_address"] == NEW_OWNER
    assert response["checked_block"] is None
    assert bank(client).status_code == 403
