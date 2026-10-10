from datetime import timedelta

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import main
from app.main import Base, app, get_db

# Throwaway key generated for tests only.
OWNER_KEY = Account.create()
SAFE = "0x" + "1" * 40
OWNER = OWNER_KEY.address.lower()
NEW_OWNER = "0x" + "3" * 40
TOKEN = "test-only-demo-token-" + "x" * 32
HEADERS = {"Authorization": f"Bearer {TOKEN}"}
REGISTRATION = {"user_id": "alice", "safe_address": SAFE, "owner_address": OWNER}
RECOVERY = {"user_id": "alice", "safe_address": SAFE, "new_owner_address": NEW_OWNER}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("MOCK_ACCESS_TOKEN", TOKEN)
    monkeypatch.setenv("MOCK_USER_ID", "alice")
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)

    def override_db():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def sign(message, account=OWNER_KEY):
    return "0x" + account.sign_message(encode_defunct(text=message)).signature.hex().removeprefix(
        "0x"
    )


def challenge(client, owner=OWNER, safe=SAFE):
    response = client.post(
        "/wallets/link/challenge",
        json={"owner_address": owner, "safe_address": safe},
        headers=HEADERS,
    )
    assert response.status_code == 200
    return response.json()


def complete(client, challenge_id, signature):
    return client.post(
        "/wallets/link/complete",
        json={"challenge_id": challenge_id, "signature": signature},
        headers=HEADERS,
    )


def link(client, safe=SAFE):
    data = challenge(client, safe=safe)
    response = complete(client, data["challenge_id"], sign(data["message"]))
    assert response.status_code == 200
    return response


def test_health_without_credentials_or_external_services(client, monkeypatch):
    monkeypatch.delenv("MOCK_ACCESS_TOKEN")
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "swissquote-demo"}
    assert client.post("/wallets/register", json=REGISTRATION).status_code == 503


def test_business_routes_require_valid_credentials(client):
    assert client.post("/wallets/register", json=REGISTRATION).status_code == 401
    assert (
        client.post(
            "/wallets/register", json=REGISTRATION, headers={"Authorization": "Bearer wrong"}
        ).status_code
        == 401
    )
    assert client.get("/wallets/alice").status_code == 401
    assert client.post("/recovery/swissquote-approve", json=RECOVERY).status_code == 401


def test_wallet_exists_only_after_linking(client):
    assert client.get("/wallets/alice", headers=HEADERS).status_code == 404
    link(client)
    wallet = client.get("/wallets/alice", headers=HEADERS).json()
    assert wallet["ownership_verified"] is True
    assert wallet["data"]["owner_address"] == OWNER
    assert wallet["data"]["safe_address"] == SAFE
    assert wallet["data"]["owner_verified_at"].endswith("Z")


def test_register_requires_a_linked_owner_key(client):
    response = client.post("/wallets/register", json=REGISTRATION, headers=HEADERS)
    assert response.status_code == 409
    assert client.get("/wallets/alice", headers=HEADERS).status_code == 404


def test_register_updates_the_safe_of_the_linked_key_only(client):
    link(client)
    new_safe = "0x" + "4" * 40
    response = client.post(
        "/wallets/register", json={**REGISTRATION, "safe_address": new_safe}, headers=HEADERS
    )
    assert response.status_code == 200
    data = client.get("/wallets/alice", headers=HEADERS).json()["data"]
    assert data["safe_address"] == new_safe
    assert data["owner_address"] == OWNER
    other_owner = {**REGISTRATION, "owner_address": NEW_OWNER}
    assert client.post("/wallets/register", json=other_owner, headers=HEADERS).status_code == 409
    assert client.get("/wallets/alice", headers=HEADERS).json()["data"]["owner_address"] == OWNER


def test_cannot_read_overwrite_or_recover_another_users_wallet(client, monkeypatch):
    link(client)
    monkeypatch.setenv("MOCK_USER_ID", "bob")
    assert client.get("/wallets/alice", headers=HEADERS).status_code == 403
    assert client.post("/wallets/register", json=REGISTRATION, headers=HEADERS).status_code == 403
    assert client.post("/recovery/request", json=RECOVERY, headers=HEADERS).status_code == 403
    monkeypatch.setenv("MOCK_USER_ID", "alice")
    assert client.get("/wallets/alice", headers=HEADERS).json()["data"]["owner_address"] == OWNER


@pytest.mark.parametrize(
    "field,value",
    [
        ("safe_address", "not-an-address"),
        ("owner_address", "0x" + "0" * 40),
        ("user_id", " "),
        ("private_key", "dummy-test-value"),
    ],
)
def test_invalid_registration_is_rejected(client, field, value):
    link(client)
    payload = {**REGISTRATION, field: value}
    assert client.post("/wallets/register", json=payload, headers=HEADERS).status_code == 422
    assert client.get("/wallets/alice", headers=HEADERS).json()["data"]["safe_address"] == SAFE


@pytest.mark.parametrize("amount", [-1, 0, "NaN", "Infinity", "0.0000001"])
def test_invalid_amounts_are_rejected(client, amount):
    assert (
        client.post(
            "/transactions/screen",
            json={
                "recipient_address": SAFE,
                "amount": amount,
            },
            headers=HEADERS,
        ).status_code
        == 422
    )


def test_screening_validates_address_and_distinguishes_mock_outcomes(client):
    def screen(address, amount):
        return client.post(
            "/transactions/screen",
            json={
                "recipient_address": address,
                "amount": amount,
            },
            headers=HEADERS,
        )

    assert screen("invalid", 1).status_code == 422
    assert screen(SAFE, "10000").json()["status"] == "approved"
    assert screen(SAFE, "10000.000001").json()["status"] == "review_required"
    result = screen("0x000000000000000000000000000000000000dEaD", 1).json()
    assert result["status"] == "blocked"
    assert result["mock"] is True


@pytest.mark.parametrize("path", ["/recovery/request", "/recovery/swissquote-approve"])
def test_recovery_fails_closed_and_requires_matching_registry(client, path):
    assert client.post(path, json=RECOVERY, headers=HEADERS).status_code == 404
    link(client)
    assert (
        client.post(path, json={**RECOVERY, "safe_address": NEW_OWNER}, headers=HEADERS).status_code
        == 409
    )
    assert (
        client.post(
            path, json={**RECOVERY, "new_owner_address": OWNER}, headers=HEADERS
        ).status_code
        == 422
    )
    assert (
        client.post(
            path, json={**RECOVERY, "new_owner_address": "invalid"}, headers=HEADERS
        ).status_code
        == 422
    )
    response = client.post(path, json=RECOVERY, headers=HEADERS)
    assert response.status_code == 501
    assert "signature" not in response.json()
    assert "approved" not in response.json()


def test_documented_routes(client):
    assert set(client.get("/openapi.json").json()["paths"]) == {
        "/health",
        "/wallets/register",
        "/wallets/{user_id}",
        "/wallets/link/challenge",
        "/wallets/link/complete",
        "/transactions/screen",
        "/recovery/request",
        "/recovery/swissquote-approve",
    }


def test_link_requires_credentials(client):
    body = {"owner_address": OWNER, "safe_address": SAFE}
    assert client.post("/wallets/link/challenge", json=body).status_code == 401
    body = {"challenge_id": "x" * 32, "signature": "0x" + "1" * 130}
    assert client.post("/wallets/link/complete", json=body).status_code == 401


def test_challenge_shows_both_addresses_and_link_stores_both(client):
    data = challenge(client)
    assert OWNER in data["message"]
    assert SAFE in data["message"]
    assert "alice" in data["message"]
    assert data["owner_address"] == OWNER
    assert data["safe_address"] == SAFE
    response = complete(client, data["challenge_id"], sign(data["message"]))
    assert response.status_code == 200
    assert response.json()["owner_key_verified"] is True
    assert response.json()["data"] == {
        "user_id": "alice",
        "owner_address": OWNER,
        "safe_address": SAFE,
    }


def test_link_rejects_wrong_signer_and_is_single_use(client):
    data = challenge(client)
    other = Account.create()
    assert complete(client, data["challenge_id"], sign(data["message"], other)).status_code == 401
    # A failed attempt burns the challenge and stores nothing.
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 409
    assert client.get("/wallets/alice", headers=HEADERS).status_code == 404


def test_signature_for_another_safe_is_rejected(client):
    other_safe = "0x" + "5" * 40
    signed = challenge(client, safe=other_safe)
    data = challenge(client)
    # A signature over a different Safe's message cannot link this challenge.
    assert complete(client, data["challenge_id"], sign(signed["message"])).status_code == 401
    assert client.get("/wallets/alice", headers=HEADERS).status_code == 404


def test_link_rejects_replay_other_message_and_unknown_challenge(client):
    data = challenge(client)
    assert complete(client, data["challenge_id"], sign("something else")).status_code == 401
    data = challenge(client)
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 200
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 409
    assert complete(client, "y" * 32, sign(data["message"])).status_code == 404
    assert complete(client, data["challenge_id"], "0x1234").status_code == 422


def test_link_rejects_expired_and_other_users_challenge(client, monkeypatch):
    data = challenge(client)
    monkeypatch.setattr(main, "LINK_CHALLENGE_TTL", timedelta(seconds=-1))
    expired = challenge(client)
    assert complete(client, expired["challenge_id"], sign(expired["message"])).status_code == 410
    monkeypatch.setenv("MOCK_USER_ID", "bob")
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 404


def test_relinking_replaces_the_single_wallet_row(client):
    link(client)
    new_safe = "0x" + "6" * 40
    link(client, safe=new_safe)
    assert client.get("/wallets/alice", headers=HEADERS).json()["data"]["safe_address"] == new_safe


@pytest.mark.parametrize(
    "owner,safe",
    [
        ("invalid", SAFE),
        ("0x" + "0" * 40, SAFE),
        (OWNER, "invalid"),
        (OWNER, "0x" + "0" * 40),
    ],
)
def test_link_challenge_validates_addresses(client, owner, safe):
    response = client.post(
        "/wallets/link/challenge",
        json={"owner_address": owner, "safe_address": safe},
        headers=HEADERS,
    )
    assert response.status_code == 422


def test_link_challenge_requires_a_safe_address(client):
    response = client.post(
        "/wallets/link/challenge", json={"owner_address": OWNER}, headers=HEADERS
    )
    assert response.status_code == 422
