from datetime import timedelta

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct

from app import main

SAFE = "0x" + "1" * 40
OWNER = "0x" + "2" * 40
NEW_OWNER = "0x" + "3" * 40
TOKEN = "test-only-demo-token-" + "x" * 32
HEADERS = {"Authorization": f"Bearer {TOKEN}"}
REGISTRATION = {"user_id": "alice", "safe_address": SAFE, "owner_address": OWNER}
RECOVERY = {"user_id": "alice", "safe_address": SAFE, "new_owner_address": NEW_OWNER}


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


def test_registration_and_authorized_update(client):
    assert client.get("/wallets/alice", headers=HEADERS).status_code == 404
    response = client.post("/wallets/register", json=REGISTRATION, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["ownership_verified"] is False
    assert client.get("/wallets/alice", headers=HEADERS).json()["data"] == REGISTRATION
    changed = {**REGISTRATION, "owner_address": NEW_OWNER}
    assert client.post("/wallets/register", json=changed, headers=HEADERS).status_code == 200
    assert client.get("/wallets/alice", headers=HEADERS).json()["data"] == changed


def test_cannot_read_overwrite_or_recover_another_users_wallet(client, monkeypatch):
    client.post("/wallets/register", json=REGISTRATION, headers=HEADERS)
    monkeypatch.setenv("MOCK_USER_ID", "bob")
    assert client.get("/wallets/alice", headers=HEADERS).status_code == 403
    assert client.post("/wallets/register", json=REGISTRATION, headers=HEADERS).status_code == 403
    assert client.post("/recovery/request", json=RECOVERY, headers=HEADERS).status_code == 403
    monkeypatch.setenv("MOCK_USER_ID", "alice")
    assert client.get("/wallets/alice", headers=HEADERS).json()["data"] == REGISTRATION


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
    payload = {**REGISTRATION, field: value}
    assert client.post("/wallets/register", json=payload, headers=HEADERS).status_code == 422
    assert client.get("/wallets/alice", headers=HEADERS).status_code == 404


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
    client.post("/wallets/register", json=REGISTRATION, headers=HEADERS)
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
    assert {
        "/health",
        "/auth/me",
        "/wallets/link/status",
        "/bank/transfers/authorize",
        "/bank/account",
        "/bank/funding/intents",
        "/bank/funding/intents/{intent_id}",
        "/bank/funding/intents/{intent_id}/confirm",
        "/wallets/register",
        "/wallets/{user_id}",
        "/wallets/link/challenge",
        "/wallets/link/complete",
        "/transactions/screen",
        "/recovery/request",
        "/recovery/swissquote-approve",
    } <= set(client.get("/openapi.json").json()["paths"])


# Throwaway key generated for tests only.
OWNER_KEY = Account.create()


def sign(message, account=OWNER_KEY):
    return "0x" + account.sign_message(encode_defunct(text=message)).signature.hex().removeprefix(
        "0x"
    )


def challenge(client, owner=None):
    owner = owner or OWNER_KEY.address
    client.post("/wallets/register", json={**REGISTRATION, "owner_address": owner}, headers=HEADERS)

    response = client.post(
        "/wallets/link/challenge",
        json={"owner_address": owner, "safe_address": SAFE, "chain_id": 11155111},
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


def test_link_requires_credentials(client):
    body = {"owner_address": OWNER_KEY.address}
    assert client.post("/wallets/link/challenge", json=body).status_code == 401
    body = {"challenge_id": "x" * 32, "signature": "0x" + "1" * 130}
    assert client.post("/wallets/link/complete", json=body).status_code == 401


def test_link_with_valid_signature(client):
    data = challenge(client)
    assert OWNER_KEY.address.lower() in data["message"]
    assert "alice" in data["message"]
    response = complete(client, data["challenge_id"], sign(data["message"]))
    assert response.status_code == 200
    assert response.json()["owner_key_verified"] is True
    assert response.json()["ownership_verified"] is True
    assert response.json()["data"] == {
        "user_id": "alice",
        "safe_address": SAFE,
        "chain_id": 11155111,
        "owner_address": OWNER_KEY.address.lower(),
    }


def test_link_rejects_wrong_signer_and_is_single_use(client):
    data = challenge(client)
    other = Account.create()
    assert complete(client, data["challenge_id"], sign(data["message"], other)).status_code == 401
    # A failed attempt burns the challenge.
    assert complete(client, data["challenge_id"], sign(data["message"])).status_code == 409


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


def test_link_challenge_validates_owner(client):
    for owner in ["invalid", "0x" + "0" * 40]:
        response = client.post(
            "/wallets/link/challenge",
            json={"owner_address": owner, "safe_address": SAFE, "chain_id": 11155111},
            headers=HEADERS,
        )
        assert response.status_code == 422
