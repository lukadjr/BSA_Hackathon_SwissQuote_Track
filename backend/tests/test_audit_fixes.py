# ruff: noqa: F811 - pytest fixtures are imported from sibling test modules
"""Regression tests for the backend audit: authz, retries and stuck-queue fixes."""

from datetime import timedelta

from eth_account import Account
from eth_account.messages import encode_defunct
from test_recovery import (  # noqa: F401 - fixtures
    BACKUP,
    FRIEND,
    HEADERS,
    NEW_OWNER,
    OWNER,
    SAFE,
    approve,
    client,
    fake,
    hexsig,
)
from test_treasury_relay import authorization, policy  # noqa: F401 - fixture
from test_treasury_worker import job  # noqa: F401 - fixture

from app import main as bank
from app.funding import chain as funding_chain
from app.recovery import routes
from app.transactions import relay, worker
from app.wallet_registry.control import ControlError


def _login_as(client, monkeypatch, name):
    monkeypatch.setenv("MOCK_USER_ID", name)


def _create_case(client):
    return client.post(
        "/recovery/requests",
        json={"safe_address": SAFE, "new_owner_address": NEW_OWNER},
        headers=HEADERS,
    )


def test_registering_someone_elses_safe_cannot_get_swissquote_signature(client, monkeypatch):
    # Mallory only *claims* Alice's Safe address; she never proved control of it.
    _login_as(client, monkeypatch, "mallory")
    mallory_key = Account.create()
    assert (
        client.post(
            "/wallets/register",
            json={"user_id": "mallory", "safe_address": SAFE, "owner_address": mallory_key.address},
            headers=HEADERS,
        ).status_code
        == 200
    )
    assert _create_case(client).status_code == 403
    # Even a case Alice opened cannot be approved by Swissquote for Mallory.
    _login_as(client, monkeypatch, "alice")
    case = _create_case(client).json()
    _login_as(client, monkeypatch, "mallory")
    result = client.post(
        f"/recovery/requests/{case['case_id']}/swissquote-approve",
        json={"identity_confirmed": True},
        headers=HEADERS,
    )
    assert result.status_code == 403


def test_only_case_owner_can_submit_and_finalize(client, monkeypatch):
    case = _create_case(client).json()
    path = f"/recovery/requests/{case['case_id']}"
    for guardian in (BACKUP, FRIEND):
        body = {"guardian_address": guardian.address, "signature": approve(guardian, case)}
        assert client.post(path + "/approvals", json=body, headers=HEADERS).status_code == 200
    _login_as(client, monkeypatch, "bob")
    assert client.post(path + "/submit", headers=HEADERS).status_code == 404
    assert client.post(path + "/finalize", headers=HEADERS).status_code == 404
    # Guardians on other accounts still read the case.
    assert client.get(path, headers=HEADERS).status_code == 200
    _login_as(client, monkeypatch, "alice")
    assert client.post(path + "/submit", headers=HEADERS).json()["status"] == "queued"


def test_failed_recovery_submit_can_be_retried(client):
    case = _create_case(client).json()
    path = f"/recovery/requests/{case['case_id']}"
    for guardian in (BACKUP, FRIEND):
        body = {"guardian_address": guardian.address, "signature": approve(guardian, case)}
        client.post(path + "/approvals", json=body, headers=HEADERS)
    job_id = client.post(path + "/submit", headers=HEADERS).json()["id"]
    with routes.SessionLocal() as db:
        row = db.get(relay.RelayDB, job_id)
        row.status, row.active_safe, row.failure_reason = "failed", None, "verification_unavailable"
        db.commit()
    retry = client.post(path + "/submit", headers=HEADERS).json()
    assert retry["id"] == job_id and retry["status"] == "queued"
    assert retry["failure_reason"] is None


def test_failed_unbroadcast_relay_can_be_retried_but_mined_failure_cannot(policy):
    request = authorization()
    first = policy.post("/transactions/relay", json=request, headers=HEADERS).json()
    from app.main import get_db

    db = next(policy.app.dependency_overrides[get_db]())
    row = db.get(relay.RelayDB, first["id"])
    row.status, row.active_safe = "failed", None
    db.commit()
    again = policy.post("/transactions/relay", json=request, headers=HEADERS).json()
    assert again["status"] == "queued"
    row = db.get(relay.RelayDB, first["id"])
    db.refresh(row)
    row.status, row.active_safe, row.transaction_hash = "failed", None, "0x" + "ab" * 32
    db.commit()
    assert (
        policy.post("/transactions/relay", json=request, headers=HEADERS).json()["status"]
        == "failed"
    )
    db.close()


def test_reverting_relay_simulation_fails_instead_of_blocking_queue(job, monkeypatch):
    rpc = funding_chain.rpc_batch

    def reverting(calls):
        if any(method in ("eth_call", "eth_estimateGas") for method, _ in calls):
            raise ControlError("verification_unavailable")
        return rpc(calls)

    monkeypatch.setattr(funding_chain, "rpc_batch", reverting)
    worker.process_once(job.sessions, job.journal, job.account)
    row = job.read()
    assert row.status == "failed" and row.active_safe is None
    assert row.transaction_hash is None and job.journal.get(job.id) is None


def test_relay_outage_requeues_until_timeout(job, monkeypatch):
    def down(calls):
        if calls[0][0] == "eth_chainId":
            raise ControlError("verification_unavailable")
        raise AssertionError("unexpected")

    monkeypatch.setattr(funding_chain, "rpc_batch", down)
    worker.process_once(job.sessions, job.journal, job.account)
    assert job.read().status == "queued"
    with job.sessions() as db:
        row = db.get(relay.RelayDB, job.id)
        row.created_at = bank.utcnow() - worker.QUEUE_TIMEOUT - timedelta(seconds=1)
        db.commit()
    worker.process_once(job.sessions, job.journal, job.account)
    row = job.read()
    assert row.status == "failed" and row.active_safe is None


def test_push_token_follows_the_account_signed_in_on_the_phone(client, monkeypatch):
    token = "ExponentPushToken[abcdefghijkl]"
    body = {"safe_address": SAFE, "expo_push_token": token}
    assert client.post("/alerts/push-token", json=body, headers=HEADERS).status_code == 200
    other_safe = "0x" + "4" * 40
    _login_as(client, monkeypatch, "bob")
    client.post(
        "/wallets/register",
        json={"user_id": "bob", "safe_address": other_safe, "owner_address": OWNER.address},
        headers=HEADERS,
    )
    body = {"safe_address": other_safe, "expo_push_token": token}
    assert client.post("/alerts/push-token", json=body, headers=HEADERS).status_code == 200
    with routes.SessionLocal() as db:
        rows = db.query(routes.PushTokenDB).filter_by(token=token).all()
        assert [r.safe_address for r in rows] == [other_safe]


def test_duplicate_alert_race_is_not_a_server_error(client):
    with routes.SessionLocal() as db:
        db.add(
            routes.AlertDB(
                safe_address=SAFE,
                dedupe_key="k",
                kind="x",
                message="m",
                created_at=bank.utcnow(),
            )
        )
        db.commit()
    with routes.SessionLocal() as db:
        # Simulate the check-then-insert race: the pre-check misses the row.
        db.query = lambda *a, **k: type(
            "Q", (), {"filter_by": lambda self, **kw: type("R", (), {"first": lambda s: None})()}
        )()
        routes.raise_alert(db, SAFE, "k", "x", "m")  # must not raise IntegrityError


def test_invite_cannot_be_accepted_twice(client):
    invite = client.post("/guardians/invites", json={"safe_address": SAFE}, headers=HEADERS).json()
    message = routes.invite_message(SAFE, invite["invite_id"], FRIEND.address.lower())
    body = {
        "guardian_address": FRIEND.address,
        "signature": hexsig(FRIEND.sign_message(encode_defunct(text=message))),
    }
    url = f"/guardians/invites/{invite['invite_id']}/accept"
    assert client.post(url, json=body, headers=HEADERS).status_code == 200
    assert client.post(url, json=body, headers=HEADERS).status_code == 409
