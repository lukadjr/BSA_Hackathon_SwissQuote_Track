import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import Base, app, get_db

SAFE = "0x" + "1" * 40
OWNER = "0x" + "2" * 40
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
    assert set(client.get("/openapi.json").json()["paths"]) == {
        "/health",
        "/wallets/register",
        "/wallets/{user_id}",
        "/transactions/screen",
        "/recovery/request",
        "/recovery/swissquote-approve",
    }
