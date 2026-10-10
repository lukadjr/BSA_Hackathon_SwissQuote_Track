"""Recovery coordination with a fake chain. The real module is covered by
scripts/recovery-fork-e2e.ts and scripts/recovery_backend_fork_e2e.py."""

import pytest
from eth_abi import decode
from eth_account import Account
from eth_account.messages import _hash_eip191_message, encode_defunct, encode_typed_data
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import chain
from app import main as bank
from app.main import Base, app, get_db
from app.recovery import routes

MODULE = "0x38275826e1933303e508433dd5f289315da2541c"
TOKEN = "test-only-demo-token-" + "x" * 32
HEADERS = {"Authorization": f"Bearer {TOKEN}"}
OWNER = Account.create()
BACKUP = Account.create()
FRIEND = Account.create()
SWISSQUOTE = Account.create()
RELAYER = Account.create()
SAFE = "0x" + "1" * 40
NEW_OWNER = Account.create().address.lower()


class FakeChain:
    def __init__(self):
        self.guardians = [
            BACKUP.address.lower(),
            SWISSQUOTE.address.lower(),
            FRIEND.address.lower(),
        ]
        self.nonce = 0
        self.execute_after = 0
        self.new_owners: list[str] = []
        self.owners = [OWNER.address.lower()]
        self.now = 1_000_000
        self.sent: list[tuple[str, bytes]] = []
        self.protected = True

    def state(self, safe):
        if not self.protected:
            return None
        return chain.RecoveryState(
            module=MODULE,
            guardians=self.guardians,
            threshold=2,
            nonce=self.nonce,
            approvals=2 if self.execute_after else 0,
            execute_after=self.execute_after,
            new_owners=self.new_owners,
        )

    def send(self, key, to, data):
        assert key == "0x" + RELAYER.key.hex().removeprefix("0x")
        self.sent.append((to, data))
        selector = data[:4]
        if selector == bytes.fromhex("0728e1e7"):
            safe, owners, _t, sigs, _e = decode(
                ["address", "address[]", "uint256", "(address,bytes)[]", "bool"], data[4:]
            )
            signers = [s.lower() for s, _ in sigs]
            assert signers == sorted(signers, key=lambda a: int(a, 16))
            assert len(signers) >= 2 and all(s in self.guardians for s in signers)
            self.execute_after = self.now + 3 * 24 * 3600
            self.new_owners = [o.lower() for o in owners]
            self.nonce += 1  # like the module: starting a recovery bumps the nonce
        elif selector == bytes.fromhex("315a7af3"):
            assert self.now >= self.execute_after
            self.owners = self.new_owners
            self.execute_after, self.new_owners = 0, []
        return "0x" + "ab" * 32


@pytest.fixture
def fake(monkeypatch, tmp_path):
    fake = FakeChain()
    monkeypatch.setattr(chain, "recovery_state", fake.state)
    monkeypatch.setattr(chain, "owners", lambda safe: fake.owners)
    monkeypatch.setattr(chain, "send_transaction", fake.send)
    monkeypatch.setattr(chain, "latest_timestamp", lambda: fake.now)
    sq_file, relayer_file = tmp_path / "sq.key", tmp_path / "relayer.key"
    sq_file.write_text("0x" + SWISSQUOTE.key.hex().removeprefix("0x"))
    relayer_file.write_text("0x" + RELAYER.key.hex().removeprefix("0x"))
    monkeypatch.setenv("SWISSQUOTE_GUARDIAN_KEY_FILE", str(sq_file))
    monkeypatch.setenv("RELAYER_KEY_FILE", str(relayer_file))
    monkeypatch.setattr(routes, "send_push", lambda *a: None)
    return fake


@pytest.fixture
def client(monkeypatch, fake):
    monkeypatch.setenv("MOCK_ACCESS_TOKEN", TOKEN)
    monkeypatch.setenv("MOCK_USER_ID", "alice")
    monkeypatch.setenv("MOCK_KYC_STATUS", "verified")
    monkeypatch.setenv("SWISSQUOTE_TREASURY_ADDRESS", RELAYER.address)
    from app.wallet_registry.control import ControlEvidence

    monkeypatch.setattr(
        bank,
        "verify_control",
        lambda safe, owner: ControlEvidence(1, "0x" + "ab" * 32, owner.lower()),
    )
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)

    def override_db():
        with sessions() as db:
            yield db

    monkeypatch.setattr(routes, "SessionLocal", sessions)
    app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(app) as test_client:
            assert (
                test_client.post(
                    "/wallets/register",
                    json={"user_id": "alice", "owner_address": OWNER.address, "safe_address": SAFE},
                    headers=HEADERS,
                ).status_code
                == 200
            )
            data = test_client.post(
                "/wallets/link/challenge",
                json={"owner_address": OWNER.address, "safe_address": SAFE, "chain_id": 11155111},
                headers=HEADERS,
            ).json()
            signature = OWNER.sign_message(encode_defunct(text=data["message"])).signature
            assert (
                test_client.post(
                    "/wallets/link/complete",
                    json={
                        "challenge_id": data["challenge_id"],
                        "signature": "0x" + signature.hex().removeprefix("0x"),
                    },
                    headers=HEADERS,
                ).status_code
                == 200
            )
            yield test_client
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def hexsig(signed) -> str:
    return "0x" + signed.signature.hex().removeprefix("0x")


def approve(account, case):
    message = encode_typed_data(
        full_message=chain.recovery_typed_data(MODULE, SAFE, NEW_OWNER, int(case["nonce"]))
    )
    return hexsig(account.sign_message(message))


def test_typed_data_matches_the_deployed_module():
    # Vector read from the Sepolia contract's getRecoveryHash().
    message = encode_typed_data(
        full_message=chain.recovery_typed_data(MODULE, "0x" + "1" * 40, "0x" + "2" * 40, 5)
    )
    assert (
        "0x" + _hash_eip191_message(message).hex()
        == "0x960f9289e6d9f6a5288c1aeca4fbeb5b07c7e4783fb1134c64e61d9f3b37a080"
    )


def test_friend_invite_flow_checks_the_signature_and_is_single_use(client):
    invite = client.post("/guardians/invites", json={"safe_address": SAFE}, headers=HEADERS).json()
    message = routes.invite_message(SAFE, invite["invite_id"], FRIEND.address.lower())
    assert "This moves no funds." in message
    path = f"/guardians/invites/{invite['invite_id']}"
    wrong = hexsig(Account.create().sign_message(encode_defunct(text=message)))
    body = {"guardian_address": FRIEND.address, "signature": wrong}
    assert client.post(path + "/accept", json=body, headers=HEADERS).status_code == 401
    assert client.get(path, headers=HEADERS).json()["status"] == "open"
    body["signature"] = hexsig(FRIEND.sign_message(encode_defunct(text=message)))
    assert client.post(path + "/accept", json=body, headers=HEADERS).status_code == 200
    accepted = client.get(path, headers=HEADERS).json()
    assert accepted["status"] == "accepted"
    assert accepted["guardian_address"] == FRIEND.address.lower()
    assert client.post(path + "/accept", json=body, headers=HEADERS).status_code == 409


def test_owner_key_cannot_be_a_guardian(client):
    invite = client.post("/guardians/invites", json={"safe_address": SAFE}, headers=HEADERS).json()
    message = routes.invite_message(SAFE, invite["invite_id"], OWNER.address.lower())
    body = {
        "guardian_address": OWNER.address,
        "signature": hexsig(OWNER.sign_message(encode_defunct(text=message))),
    }
    response = client.post(
        f"/guardians/invites/{invite['invite_id']}/accept", json=body, headers=HEADERS
    )
    assert response.status_code == 422


def test_swissquote_guardian_address_never_exposes_the_key(client):
    response = client.get("/guardians/swissquote", headers=HEADERS).json()
    assert response == {
        "address": SWISSQUOTE.address.lower(),
        "relayer_address": RELAYER.address.lower(),
    }


def test_full_recovery_with_backup_and_swissquote(client, fake):
    case = client.post(
        "/recovery/requests",
        json={"safe_address": SAFE, "new_owner_address": NEW_OWNER},
        headers=HEADERS,
    ).json()
    assert case["status"] == "collecting" and case["approvals"] == []
    status = client.get(f"/wallets/{SAFE}/recovery-status", headers=HEADERS).json()
    assert status["alerts"][0]["kind"] == "recovery_requested"
    assert status["open_requests"][0]["case_id"] == case["case_id"]
    path = f"/recovery/requests/{case['case_id']}"
    assert client.post(path + "/submit", headers=HEADERS).status_code == 409

    stranger = Account.create()
    body = {"guardian_address": stranger.address, "signature": approve(stranger, case)}
    assert client.post(path + "/approvals", json=body, headers=HEADERS).status_code == 403
    body = {"guardian_address": BACKUP.address, "signature": approve(FRIEND, case)}
    assert client.post(path + "/approvals", json=body, headers=HEADERS).status_code == 401
    body = {"guardian_address": BACKUP.address, "signature": approve(BACKUP, case)}
    assert (
        len(client.post(path + "/approvals", json=body, headers=HEADERS).json()["approvals"]) == 1
    )

    no_id = client.post(
        path + "/swissquote-approve", json={"identity_confirmed": False}, headers=HEADERS
    )
    assert no_id.status_code == 403
    detail = client.post(
        path + "/swissquote-approve", json={"identity_confirmed": True}, headers=HEADERS
    ).json()
    assert len(detail["approvals"]) == 2
    assert any(a["is_swissquote"] for a in detail["approvals"])

    job = client.post(path + "/submit", headers=HEADERS).json()
    assert job["status"] == "queued" and job["tx_hash"] is None
    assert client.get(path, headers=HEADERS).json()["status"] == "collecting"
    # Model a mined worker dispatch here; real worker/contract coverage is separate.
    import json

    from app.transactions.relay import RelayDB

    with routes.SessionLocal() as db:
        row = db.get(RelayDB, job["id"])
        payload = json.loads(row.payload)
        fake.send(
            "0x" + RELAYER.key.hex().removeprefix("0x"), MODULE, bytes.fromhex(payload["data"][2:])
        )
        row.status = "confirmed"
        row.active_safe = None
        db.commit()
    detail = client.get(path, headers=HEADERS).json()
    assert detail["status"] == "started"
    status = client.get(f"/wallets/{SAFE}/recovery-status", headers=HEADERS).json()
    assert status["pending"]["new_owner_address"] == NEW_OWNER
    assert status["alerts"][0]["kind"] == "recovery_started"
    assert "cancel" in status["alerts"][0]["message"]

    assert client.post(path + "/finalize", headers=HEADERS).status_code == 409
    fake.now += 3 * 24 * 3600
    job = client.post(path + "/finalize", headers=HEADERS).json()
    assert job["status"] == "queued"
    with routes.SessionLocal() as db:
        row = db.get(RelayDB, job["id"])
        payload = json.loads(row.payload)
        fake.send(
            "0x" + RELAYER.key.hex().removeprefix("0x"), MODULE, bytes.fromhex(payload["data"][2:])
        )
        row.status = "confirmed"
        row.active_safe = None
        db.commit()
    assert client.get(path, headers=HEADERS).json()["status"] == "finalized"


def test_friend_sees_requests_for_safes_they_guard(client):
    invite = client.post("/guardians/invites", json={"safe_address": SAFE}, headers=HEADERS).json()
    message = routes.invite_message(SAFE, invite["invite_id"], FRIEND.address.lower())
    client.post(
        f"/guardians/invites/{invite['invite_id']}/accept",
        json={
            "guardian_address": FRIEND.address,
            "signature": hexsig(FRIEND.sign_message(encode_defunct(text=message))),
        },
        headers=HEADERS,
    )
    case = client.post(
        "/recovery/requests",
        json={"safe_address": SAFE, "new_owner_address": NEW_OWNER},
        headers=HEADERS,
    ).json()
    requests = client.get(f"/guardians/{FRIEND.address}/requests", headers=HEADERS).json()
    assert [r["case_id"] for r in requests["requests"]] == [case["case_id"]]
    assert requests["requests"][0]["approved_by_you"] is False
    other = client.get(f"/guardians/{BACKUP.address}/requests", headers=HEADERS).json()
    assert other == {"requests": []}


def test_guardian_lists_the_wallets_it_protects(client, fake):
    invite = client.post(
        "/guardians/invites",
        json={"safe_address": SAFE, "owner_name": "Alice"},
        headers=HEADERS,
    ).json()
    assert invite["from"] == "Alice"
    message = routes.invite_message(SAFE, invite["invite_id"], FRIEND.address.lower())
    client.post(
        f"/guardians/invites/{invite['invite_id']}/accept",
        json={
            "guardian_address": FRIEND.address,
            "signature": hexsig(FRIEND.sign_message(encode_defunct(text=message))),
        },
        headers=HEADERS,
    )
    wallets = client.get(f"/guardians/{FRIEND.address}/wallets", headers=HEADERS).json()
    assert wallets["wallets"] == [
        {
            "safe_address": SAFE,
            "from": "Alice",
            "accepted_at": wallets["wallets"][0]["accepted_at"],
            "active": True,
        }
    ]
    fake.guardians = [BACKUP.address.lower(), SWISSQUOTE.address.lower()]
    wallets = client.get(f"/guardians/{FRIEND.address}/wallets", headers=HEADERS).json()
    assert wallets["wallets"][0]["active"] is False
    other = client.get(f"/guardians/{BACKUP.address}/wallets", headers=HEADERS).json()
    assert other == {"wallets": []}
    bad = client.get("/guardians/not-an-address/wallets", headers=HEADERS)
    assert bad.status_code == 422


def test_cancelled_recovery_closes_the_request(client, fake):
    case = client.post(
        "/recovery/requests",
        json={"safe_address": SAFE, "new_owner_address": NEW_OWNER},
        headers=HEADERS,
    ).json()
    fake.nonce += 1  # the owner cancelled or rotated: old approvals are void
    path = f"/recovery/requests/{case['case_id']}"
    assert client.get(path, headers=HEADERS).json()["status"] == "closed"
    body = {"guardian_address": BACKUP.address, "signature": approve(BACKUP, case)}
    assert client.post(path + "/approvals", json=body, headers=HEADERS).status_code == 409


def test_recovery_rejects_unprotected_safe_and_current_owner(client, fake):
    body = {"safe_address": SAFE, "new_owner_address": OWNER.address}
    assert client.post("/recovery/requests", json=body, headers=HEADERS).status_code == 422
    fake.protected = False
    body["new_owner_address"] = NEW_OWNER
    assert client.post("/recovery/requests", json=body, headers=HEADERS).status_code == 409


def test_watcher_alerts_on_started_recovery(client, fake):
    fake.execute_after, fake.new_owners = fake.now + 100, [NEW_OWNER]
    routes.scan_once()
    status = client.get(f"/wallets/{SAFE}/recovery-status", headers=HEADERS).json()
    assert [a["kind"] for a in status["alerts"]] == ["recovery_started"]


def test_new_phone_finds_the_customers_safe(client):
    assert client.get("/me/wallet", headers=HEADERS).json() == {
        "user_id": "alice",
        "safe_address": SAFE,
    }


def test_invite_message_format():
    # Same literal as tests/wallet-core/recovery.test.ts (wallet-core guardianInviteMessage).
    assert routes.invite_message(SAFE, "invite-id-0123456789", "0x" + "a" * 40) == "\n".join(
        [
            "Swissquote Wallet: I agree to be a recovery guardian.",
            "Safe: 0x1111111111111111111111111111111111111111",
            "Guardian key: 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
            "Invite: invite-id-0123456789",
            "Chain: 11155111",
            "This moves no funds.",
        ]
    )


def test_rpc_sends_a_user_agent(monkeypatch):
    # publicnode (Cloudflare) answers 403 to urllib's default User-Agent.
    import io

    from app import chain

    seen = {}

    def fake_urlopen(request, timeout):
        seen["ua"] = request.get_header("User-agent")
        return io.BytesIO(b'{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}')

    monkeypatch.setenv("SEPOLIA_RPC_URL", "https://rpc.example")
    monkeypatch.setattr(chain.urllib.request, "urlopen", fake_urlopen)
    assert chain.chain_id() == chain.CHAIN_ID
    assert seen["ua"] and "Python-urllib" not in seen["ua"]
