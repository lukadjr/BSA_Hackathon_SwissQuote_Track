"""Separate Sepolia treasury signer. Durable journal precedes every broadcast."""

import argparse
import fcntl
import os
import sqlite3
import time
from pathlib import Path

from eth_abi import encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address
from fastapi import HTTPException

from app.config import load_environment

load_environment(treasury=True)

from app import main as bank  # noqa: E402
from app.funding import chain  # noqa: E402
from app.funding.routes import FundingDB, check_eligibility  # noqa: E402
from app.wallet_registry.control import ControlError  # noqa: E402

TRANSFER_TOPIC = "0x" + keccak(text="Transfer(address,address,uint256)").hex()


def treasury_account():
    try:
        account = Account.from_key(os.environ["SWISSQUOTE_TREASURY_PRIVATE_KEY"])
        if account.address.lower() != chain.configured_address("SWISSQUOTE_TREASURY_ADDRESS"):
            raise ValueError()
        return account
    except Exception:
        raise ControlError("treasury_key_missing_or_mismatched") from None


class Journal:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Prevent accidental group-readable signed transactions, including WAL files.
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(path, 0o600)
        self.db = sqlite3.connect(path)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS signed (id TEXT PRIMARY KEY, "
            "treasury TEXT NOT NULL, hash TEXT NOT NULL, raw TEXT NOT NULL, "
            "nonce INTEGER NOT NULL)"
        )
        self.db.commit()

    def get(self, intent_id):
        return self.db.execute(
            "SELECT treasury, hash, raw, nonce FROM signed WHERE id=?", (intent_id,)
        ).fetchone()

    def save(self, intent_id, treasury, signed, nonce):
        tx_hash = "0x" + signed.hash.hex().removeprefix("0x")
        raw = "0x" + signed.raw_transaction.hex().removeprefix("0x")
        self.db.execute(
            "INSERT INTO signed VALUES (?, ?, ?, ?, ?)", (intent_id, treasury, tx_hash, raw, nonce)
        )
        self.db.commit()
        return self.get(intent_id)

    def close(self):
        self.db.close()


def prepare(intent, db, account):
    # Do all fallible policy/config checks before generating a spend authorization.
    if intent.expires_at <= bank.utcnow():
        raise HTTPException(status_code=410, detail="Funding instruction expired before dispatch")
    already = check_eligibility(intent, db)
    balances = chain.snapshot()
    if intent.treasury_address != account.address.lower():
        raise ControlError("treasury_configuration_changed")
    if already:
        return None
    if intent.kind == "deposit":
        if int(balances["balance_units"]) < int(intent.amount_units):
            raise HTTPException(status_code=409, detail="Insufficient treasury tokens")
        to = intent.token_address
        data = (
            chain.selector("transfer(address,uint256)")
            + encode(["address", "uint256"], [intent.safe_address, int(intent.amount_units)]).hex()
        )
    else:
        payload = chain.deployment(intent.owner_address)
        to, data = payload["factory"], payload["data"]
    nonce, gas_price, gas = chain.rpc_batch(
        [
            ("eth_getTransactionCount", [account.address, "pending"]),
            ("eth_gasPrice", []),
            (
                "eth_estimateGas",
                [{"from": account.address, "to": to, "data": data, "value": "0x0"}],
            ),
        ]
    )
    gas_limit = (int(gas, 16) * 120 + 99) // 100
    price = int(gas_price, 16)
    if price <= 0 or gas_limit <= 0 or gas_limit > 2_000_000:
        raise ControlError("invalid_gas_estimate")
    if int(balances["eth_balance_wei"]) < gas_limit * price:
        raise HTTPException(status_code=409, detail="Insufficient treasury Sepolia ETH for fees")
    # Recheck current owner/policy after slow estimation and immediately before signing.
    check_eligibility(intent, db)
    if intent.expires_at <= bank.utcnow():
        raise HTTPException(status_code=410, detail="Funding instruction expired before dispatch")
    tx = {
        "chainId": 11155111,
        "nonce": int(nonce, 16),
        "to": to_checksum_address(to),
        "value": 0,
        "data": data,
        "gas": gas_limit,
        "gasPrice": price,
    }
    return account.sign_transaction(tx), tx["nonce"]


def verify_receipt(intent, receipt, latest_block):
    if receipt.get("transactionHash", "").lower() != intent.transaction_hash:
        raise ControlError("receipt_mismatch")
    number = int(receipt["blockNumber"], 16)
    header = chain.rpc_batch([("eth_getBlockByNumber", [receipt["blockNumber"], False])])[0]
    if header is None or header.get("hash") != receipt.get("blockHash"):
        return "reconciling"  # Receipt is not in the current canonical chain.
    if int(header["number"], 16) != number:
        raise ControlError("receipt_mismatch")
    if latest_block - number + 1 < 2:
        return "submitted"
    if int(receipt["status"], 16) != 1:
        return "failed"
    if intent.kind == "deploy":
        bank.verify_control(intent.safe_address, intent.owner_address)
    else:
        expected = [
            TRANSFER_TOPIC,
            "0x" + intent.treasury_address[2:].rjust(64, "0"),
            "0x" + intent.safe_address[2:].rjust(64, "0"),
        ]
        matches = [
            log
            for log in receipt.get("logs", [])
            if (
                log.get("address", "").lower() == intent.token_address
                and [topic.lower() for topic in log.get("topics", [])] == expected
                and log.get("data", "").lower()
                == "0x" + int(intent.amount_units).to_bytes(32, "big").hex()
                and not log.get("removed", False)
            )
        ]
        if len(matches) != 1:
            raise ControlError("transfer_event_mismatch")
    intent.receipt_block = str(number)
    intent.receipt_block_hash = receipt["blockHash"]
    return "confirmed"


def process_once(sessions, journal, account):
    with sessions() as db:
        # One outstanding bank transaction at a time avoids nonce/reservation races.
        intent = (
            db.query(FundingDB)
            .filter(FundingDB.status.in_(("queued", "submitted", "reconciling")))
            .order_by(FundingDB.created_at)
            .first()
        )
        if intent is None:
            return False
        saved = journal.get(intent.id)
        has_submission = intent.transaction_hash is not None
        try:
            if saved is None and has_submission:
                raise ControlError("signed_transaction_journal_missing")
            if saved is None:
                prepared = prepare(intent, db, account)
                if prepared is None:
                    intent.status = "confirmed"
                    intent.active_user = None
                    db.commit()
                    return True
                signed, nonce = prepared
                saved = journal.save(intent.id, account.address.lower(), signed, nonce)
            if saved[0] != account.address.lower():
                raise ControlError("journal_treasury_mismatch")
            # A crash between journal commit and this DB write resumes the SAME tx.
            intent.transaction_hash = saved[1]
            intent.status = "submitted"
            db.commit()
            chain_id, latest = chain.rpc_batch([("eth_chainId", []), ("eth_blockNumber", [])])
            if int(chain_id, 16) != 11155111:
                raise ControlError("wrong_network")
            receipt = chain.rpc_batch([("eth_getTransactionReceipt", [saved[1]])])[0]
            if receipt is None:
                # Re-broadcasting identical signed bytes cannot create another payment.
                try:
                    returned = chain.rpc_batch([("eth_sendRawTransaction", [saved[2]])])[0]
                    if returned.lower() != saved[1]:
                        raise ControlError("broadcast_hash_mismatch")
                    intent.failure_reason = None
                except ControlError:
                    intent.status = "reconciling"
                    intent.failure_reason = "broadcast_uncertain_check_status"
            else:
                intent.status = verify_receipt(intent, receipt, int(latest, 16))
                intent.failure_reason = (
                    "transaction_reverted" if intent.status == "failed" else None
                )
                if intent.status in ("confirmed", "failed"):
                    intent.active_user = None
            db.commit()
        except (ControlError, HTTPException, ValueError, TypeError, KeyError) as error:
            # Never release a signed transaction merely because the RPC timed out.
            if saved is not None or has_submission:
                intent.status = "reconciling"
                if saved is not None:
                    intent.transaction_hash = saved[1]
            elif isinstance(error, ControlError) and error.status == "verification_unavailable":
                intent.status = "queued"  # retry temporary infrastructure failure
            else:
                intent.status = "failed"
                intent.active_user = None
            intent.failure_reason = (
                error.status
                if isinstance(error, ControlError)
                else error.detail
                if isinstance(error, HTTPException)
                else "invalid_chain_response"
            )
            db.commit()
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    account = treasury_account()
    path = Path(
        os.getenv("TREASURY_JOURNAL_PATH", str(chain.ROOT / "backend/data/treasury.sqlite"))
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    # Shared across API processes/restarts. Do not run workers with separate journals.
    with path.with_suffix(".worker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("A treasury worker is already running for this journal.") from None
        journal = Journal(path)
        try:
            print(f"Sepolia treasury worker: {account.address} (public address only)", flush=True)
            while True:
                process_once(bank.SessionLocal, journal, account)
                if args.once:
                    break
                time.sleep(3)
        finally:
            journal.close()


if __name__ == "__main__":
    try:
        main()
    except ControlError as error:
        raise SystemExit(error.status) from None
