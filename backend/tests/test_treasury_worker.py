"""Fault injection for the single treasury signer and durable relay journal."""

import json
from types import SimpleNamespace

import pytest
from eth_abi import encode
from eth_account import Account
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from test_treasury_relay import OWNER, RECIPIENT, SAFE, TOKEN, authorization

from app import main as bank
from app.funding import chain
from app.funding.worker import Journal
from app.transactions import worker
from app.transactions.relay import RelayDB, safe_hash
from app.wallet_registry.control import ControlError


@pytest.fixture
def job(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'bank.sqlite'}")
    bank.Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    request = authorization()
    request["owner_address"] = OWNER.address.lower()
    request_id = safe_hash(SAFE, request["transaction"])
    with sessions() as db:
        db.add(
            RelayDB(
                id=request_id,
                user_id="alice",
                safe_address=SAFE,
                active_safe=SAFE,
                kind="transfer",
                payload=json.dumps(request),
                status="queued",
                created_at=bank.utcnow(),
            )
        )
        db.commit()
    account = Account.create()
    journal_path = tmp_path / "journal.sqlite"
    journal = Journal(journal_path)
    state = {
        "eth": 10**18,
        "estimate": 100_000,
        "price": 10**9,
        "network": 11155111,
        "simulate": True,
        "timeout": False,
        "broadcasts": [],
        "receipt": None,
        "latest": 101,
        "canonical": "0x" + "a" * 64,
    }

    def rpc(calls):
        result = []
        for method, args in calls:
            if method == "eth_chainId":
                value = hex(state["network"])
            elif method == "eth_call":
                value = "0x" + encode(["bool"], [state["simulate"]]).hex()
            elif method == "eth_estimateGas":
                value = hex(state["estimate"])
            elif method == "eth_getTransactionCount":
                value = "0xc"
            elif method == "eth_gasPrice":
                value = hex(state["price"])
            elif method == "eth_getBalance":
                value = hex(state["eth"])
            elif method == "eth_blockNumber":
                value = hex(state["latest"])
            elif method == "eth_getTransactionReceipt":
                value = state["receipt"]
            elif method == "eth_getBlockByNumber":
                value = {"number": "0x64", "hash": state["canonical"]}
            elif method == "eth_sendRawTransaction":
                # The signed bytes MUST already be durable at broadcast time.
                assert journal.get(request_id)[2] == args[0]
                state["broadcasts"].append(args[0])
                if state["timeout"]:
                    raise ControlError("verification_unavailable")
                value = "0x" + worker.keccak(bytes.fromhex(args[0][2:])).hex()
            else:
                raise AssertionError(method)
            result.append(value)
        return result

    monkeypatch.setattr(chain, "rpc_batch", rpc)
    monkeypatch.setattr(worker, "validate", lambda row, db: row.id)

    def read():
        with sessions() as db:
            row = db.get(RelayDB, request_id)
            return SimpleNamespace(
                **{
                    key: getattr(row, key)
                    for key in ("status", "transaction_hash", "active_safe", "failure_reason")
                }
            )

    def receipt():
        tx = read().transaction_hash
        return {
            "transactionHash": tx,
            "blockNumber": "0x64",
            "blockHash": "0x" + "a" * 64,
            "status": "0x1",
            "logs": [
                {
                    "address": SAFE,
                    "topics": [worker.SUCCESS_TOPIC, request_id],
                    "data": "0x" + encode(["uint256"], [0]).hex(),
                },
                {
                    "address": TOKEN,
                    "topics": [
                        worker.TRANSFER_TOPIC,
                        "0x" + SAFE[2:].rjust(64, "0"),
                        "0x" + RECIPIENT[2:].rjust(64, "0"),
                    ],
                    "data": "0x" + encode(["uint256"], [1_000_000]).hex(),
                },
            ],
        }

    yield SimpleNamespace(
        sessions=sessions,
        journal=journal,
        path=journal_path,
        account=account,
        state=state,
        id=request_id,
        read=read,
        receipt=receipt,
    )
    journal.close()
    engine.dispose()


def tick(job):
    return worker.process_once(job.sessions, job.journal, job.account)


def test_timeout_restart_reuses_durable_signed_bytes_and_nonce(job, monkeypatch):
    job.state["timeout"] = True
    tick(job)
    assert job.read().status == "reconciling"
    original = job.journal.get(job.id)
    assert original[3] == 12
    assert Account.recover_transaction(original[2]).lower() == job.account.address.lower()
    job.journal.close()
    job.journal.__init__(job.path)
    monkeypatch.setattr(worker, "prepare", lambda *args: pytest.fail("Never re-sign after timeout"))
    job.state["timeout"] = False
    tick(job)
    assert job.state["broadcasts"] == [original[2], original[2]]
    assert job.journal.get(job.id) == original
    job.state["receipt"] = job.receipt()
    tick(job)
    assert job.read().status == "confirmed" and job.read().active_safe is None
    assert not tick(job)


def test_empty_treasury_queues_without_signing_then_resumes_after_refill(job):
    job.state["eth"] = 0
    tick(job)
    assert job.read().status == "queued"
    assert job.read().failure_reason == "treasury_eth_unavailable"
    assert job.journal.get(job.id) is None and not job.state["broadcasts"]
    job.state["eth"] = 10**18
    tick(job)
    assert job.read().status == "submitted" and len(job.state["broadcasts"]) == 1


@pytest.mark.parametrize(
    "change",
    [
        {"simulate": False},
        {"estimate": 2_000_000},
        {"price": 0},
        {"price": 10**12 + 1},
        {"network": 1},
    ],
)
def test_simulation_gas_and_network_refusal_happen_before_signing(job, change):
    job.state.update(change)
    tick(job)
    assert job.read().status == "failed" and job.read().active_safe is None
    assert job.journal.get(job.id) is None and not job.state["broadcasts"]


def test_owner_policy_is_rechecked_after_estimation_before_signing(job, monkeypatch):
    calls = []

    def validate(row, db):
        calls.append(row.id)
        if len(calls) == 2:
            raise HTTPException(409, "Owner changed during estimation")

    monkeypatch.setattr(worker, "validate", validate)
    tick(job)
    assert len(calls) == 2 and job.read().status == "failed"
    assert job.journal.get(job.id) is None


@pytest.mark.parametrize(
    "fault,expected",
    [
        ("one-confirmation", "submitted"),
        ("reorg", "reconciling"),
        ("missing-safe-event", "reconciling"),
        ("missing-transfer", "reconciling"),
        ("reimbursement", "reconciling"),
        ("removed-log", "reconciling"),
        ("wrong-hash", "reconciling"),
        ("safe-failure", "failed"),
        ("outer-revert", "failed"),
    ],
)
def test_receipt_validation_refuses_false_confirmations(job, fault, expected):
    tick(job)
    receipt = job.receipt()
    if fault == "one-confirmation":
        job.state["latest"] = 100
    elif fault == "reorg":
        job.state["canonical"] = "0x" + "b" * 64
    elif fault == "missing-safe-event":
        receipt["logs"].pop(0)
    elif fault == "missing-transfer":
        receipt["logs"].pop(1)
    elif fault == "reimbursement":
        receipt["logs"][0]["data"] = "0x" + encode(["uint256"], [1]).hex()
    elif fault == "removed-log":
        receipt["logs"][1]["removed"] = True
    elif fault == "wrong-hash":
        receipt["transactionHash"] = "0x" + "f" * 64
    elif fault == "safe-failure":
        receipt["logs"][0]["topics"][0] = worker.FAILURE_TOPIC
    elif fault == "outer-revert":
        receipt["status"] = "0x0"
    job.state["receipt"] = receipt
    tick(job)
    assert job.read().status == expected
    assert (job.read().active_safe is None) == (expected == "failed")


def test_missing_journal_never_signs_an_unknown_submitted_transaction(job, monkeypatch):
    with job.sessions() as db:
        db.get(RelayDB, job.id).transaction_hash = "0x" + "a" * 64
        db.commit()
    monkeypatch.setattr(
        worker, "prepare", lambda *args: pytest.fail("Missing journal must fail closed")
    )
    tick(job)
    assert job.read().status == "reconciling"
    assert job.read().failure_reason == "signed_transaction_journal_missing"
