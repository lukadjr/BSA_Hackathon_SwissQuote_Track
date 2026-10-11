"""Username demo sessions isolate accounts; reset remains explicitly gated."""

from test_health import HEADERS, NEW_OWNER, REGISTRATION

from app import main
from app.funding.routes import FundingDB


def login(client, name):
    r = client.post("/auth/demo/login", headers=HEADERS, json={"username": name})
    assert r.status_code == 200, r.json()
    return {"Authorization": "Bearer " + r.json()["token"]}


def test_accounts_isolate_wallets_and_pending_requests(client, monkeypatch):
    monkeypatch.setenv("MOCK_ALLOW_USERNAME_LOGIN", "true")
    alice = login(client, "Alice")
    bob = login(client, "bob")
    assert client.get("/auth/me", headers=alice).json()["client_id"] == "alice"
    assert client.get("/auth/me", headers=bob).json()["client_id"] == "bob"
    assert client.post("/wallets/register", headers=alice, json=REGISTRATION).status_code == 200
    bob_wallet = dict(
        REGISTRATION, user_id="bob", owner_address=NEW_OWNER, safe_address="0x" + "3" * 40
    )
    assert client.post("/wallets/register", headers=bob, json=bob_wallet).status_code == 200
    assert client.get("/wallets/alice", headers=alice).json()["data"] == REGISTRATION
    assert client.get("/wallets/bob", headers=bob).json()["data"] == bob_wallet
    assert client.get("/wallets/alice", headers=bob).status_code == 403
    assert client.post("/wallets/register", headers=bob, json=REGISTRATION).status_code == 403
    relogin = login(client, " alice ")
    assert relogin != alice
    assert client.get("/wallets/alice", headers=relogin).json()["data"] == REGISTRATION
    third = login(client, "new-user-123")
    assert client.get("/auth/me", headers=third).json()["client_id"] == "new-user-123"
    generator = main.app.dependency_overrides[main.get_db]()
    db = next(generator)
    try:
        db.add(FundingDB(id="alice-pending", user_id="alice", status="queued", active_user="alice"))
        db.commit()
        assert client.get("/bank/funding/intents/alice-pending", headers=bob).status_code == 404
        assert (
            client.post(
                "/bank/funding/intents/alice-pending/confirm",
                headers=bob,
                json={"signature": "0x" + "1" * 130},
            ).status_code
            == 404
        )
        sessions = db.query(main.DemoSessionDB).all()
        assert all(row.token_hash != alice["Authorization"][7:] for row in sessions)
    finally:
        generator.close()


def test_login_gated_and_unknown_token_rejected(client, monkeypatch):
    monkeypatch.setenv("MOCK_ALLOW_USERNAME_LOGIN", "false")
    assert (
        client.post("/auth/demo/login", headers=HEADERS, json={"username": "alice"}).status_code
        == 404
    )
    assert (
        client.get("/auth/me", headers={"Authorization": "Bearer " + "c" * 40}).status_code == 401
    )


def test_reset_disabled_by_default(client, monkeypatch):
    monkeypatch.setenv("ENABLE_DEV_DATABASE_RESET", "false")
    assert (
        client.post(
            "/dev/reset-database", headers=HEADERS, json={"confirmation": "RESET DATABASE"}
        ).status_code
        == 404
    )


def test_reset_clears_accounts_and_sessions(client, monkeypatch):
    monkeypatch.setenv("MOCK_ALLOW_USERNAME_LOGIN", "true")
    monkeypatch.setenv("ENABLE_DEV_DATABASE_RESET", "true")
    alice = login(client, "alice")
    client.post("/wallets/register", headers=alice, json=REGISTRATION)
    assert (
        client.post(
            "/dev/reset-database", headers=alice, json={"confirmation": "wrong"}
        ).status_code
        == 422
    )
    result = client.post(
        "/dev/reset-database", headers=alice, json={"confirmation": "RESET DATABASE"}
    )
    assert result.status_code == 200, result.json()
    assert result.json()["removed"]["wallets"] == 1
    assert client.get("/auth/me", headers=alice).status_code == 401
    fresh = login(client, "alice")
    assert client.get("/wallets/alice", headers=fresh).status_code == 404


def test_reset_refuses_queued_transactions(client, monkeypatch):
    monkeypatch.setenv("ENABLE_DEV_DATABASE_RESET", "true")
    generator = main.app.dependency_overrides[main.get_db]()
    db = next(generator)
    try:
        db.add(FundingDB(id="queued", user_id="alice", status="queued", active_user="alice"))
        db.commit()
        result = client.post(
            "/dev/reset-database", headers=HEADERS, json={"confirmation": "RESET DATABASE"}
        )
        assert result.status_code == 409
        assert db.get(FundingDB, "queued") is not None
    finally:
        generator.close()


def test_registration_change_expires_only_unsigned_request(client):
    client.post("/wallets/register", headers=HEADERS, json=REGISTRATION)
    generator = main.app.dependency_overrides[main.get_db]()
    db = next(generator)
    try:
        db.add(
            FundingDB(
                id="unsigned", user_id="alice", status="awaiting_confirmation", active_user="alice"
            )
        )
        db.commit()
        changed = dict(REGISTRATION, owner_address=NEW_OWNER)
        assert client.post("/wallets/register", headers=HEADERS, json=changed).status_code == 200
        db.expire_all()
        assert db.get(FundingDB, "unsigned").status == "expired"
        assert db.get(FundingDB, "unsigned").active_user is None
        db.add(FundingDB(id="queued", user_id="alice", status="queued", active_user="alice"))
        db.commit()
        assert (
            client.post("/wallets/register", headers=HEADERS, json=REGISTRATION).status_code == 409
        )
        db.expire_all()
        assert (
            db.query(main.WalletDB).filter_by(user_id="alice").one().owner_address
            == NEW_OWNER.lower()
        )
    finally:
        generator.close()
