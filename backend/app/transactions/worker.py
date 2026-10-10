"""Dispatch relay jobs with the funding worker's single treasury key and journal."""

import json

from eth_abi import decode
from eth_abi.exceptions import DecodingError
from eth_utils import keccak, to_checksum_address
from fastapi import HTTPException

from app import chain as recovery_chain
from app.funding import chain
from app.transactions.relay import RelayDB, RelayRequest, execution, validate_owner_request
from app.wallet_registry.control import ControlError

SUCCESS_TOPIC = "0x" + keccak(text="ExecutionSuccess(bytes32,uint256)").hex()
FAILURE_TOPIC = "0x" + keccak(text="ExecutionFailure(bytes32,uint256)").hex()
TRANSFER_TOPIC = "0x" + keccak(text="Transfer(address,address,uint256)").hex()


def validate(row, db):
    payload = json.loads(row.payload)
    if row.kind not in ("recovery-start", "recovery-finalize"):
        return validate_owner_request(RelayRequest.model_validate(payload))
    from app.recovery import routes

    case = routes.find_case(db, payload["case_id"])
    detail = routes.read_case(case.id, row.user_id, db)
    if payload["nonce"] != str(case.nonce) or payload["module"] != case.module:
        raise HTTPException(409, "Recovery authorization changed")
    if row.kind == "recovery-start":
        if detail["status"] != "collecting" or len(detail["approvals"]) < detail["threshold"]:
            raise HTTPException(409, "Recovery is no longer ready")
        expected = recovery_chain.multi_confirm_recovery_data(
            case.safe_address,
            case.new_owner,
            [(a["guardian_address"], a["signature"]) for a in detail["approvals"]],
        )
    else:
        if (
            detail["status"] != "started"
            or recovery_chain.latest_timestamp() < detail["execute_after"]
        ):
            raise HTTPException(409, "Recovery deadline has not passed")
        expected = recovery_chain.finalize_recovery_data(case.safe_address)
    if payload["data"] != "0x" + expected.hex():
        raise HTTPException(409, "Recovery signatures changed; refresh request")
    return row.id


def call_data(row):
    if row.kind in ("recovery-start", "recovery-finalize"):
        payload = json.loads(row.payload)
        return payload["module"], payload["data"]
    return execution(row)


def prepare(row, db, account):
    validate(row, db)
    to, data = call_data(row)
    chain_id = chain.rpc_batch([("eth_chainId", [])])[0]
    if int(chain_id, 16) != 11155111:
        raise ControlError("wrong_network")
    call = {"from": account.address, "to": to, "data": data, "value": "0x0"}
    result, estimate, nonce, price, balance = chain.rpc_batch(
        [
            ("eth_call", [call, "latest"]),
            ("eth_estimateGas", [call]),
            ("eth_getTransactionCount", [account.address, "pending"]),
            ("eth_gasPrice", []),
            ("eth_getBalance", [account.address, "latest"]),
        ]
    )
    if (
        row.kind not in ("recovery-start", "recovery-finalize")
        and not decode(["bool"], bytes.fromhex(result[2:]))[0]
    ):
        raise HTTPException(409, "Safe execution simulation failed")
    gas = (int(estimate, 16) * 130 + 99) // 100
    price = int(price, 16)
    if not 0 < gas <= 2_000_000 or not 0 < price <= 1_000_000_000_000:
        raise ControlError("invalid_gas_estimate")
    if int(balance, 16) < gas * price:
        raise ControlError("treasury_eth_unavailable")
    validate(row, db)
    tx = {
        "chainId": 11155111,
        "nonce": int(nonce, 16),
        "to": to_checksum_address(to),
        "data": data,
        "value": 0,
        "gas": gas,
        "gasPrice": price,
    }
    return account.sign_transaction(tx), tx["nonce"]


def verify_receipt(row, receipt, latest):
    if receipt.get("transactionHash", "").lower() != row.transaction_hash:
        raise ControlError("receipt_mismatch")
    number = int(receipt["blockNumber"], 16)
    block = chain.rpc_batch([("eth_getBlockByNumber", [receipt["blockNumber"], False])])[0]
    if block is None or block.get("hash") != receipt.get("blockHash"):
        return "reconciling"
    if int(block["number"], 16) != number:
        raise ControlError("receipt_mismatch")
    if latest - number + 1 < 2:
        return "submitted"
    if int(receipt["status"], 16) != 1:
        return "failed"
    logs = [log for log in receipt.get("logs", []) if not log.get("removed", False)]
    if row.kind not in ("recovery-start", "recovery-finalize"):
        events = []
        for log in logs:
            if (
                log.get("address", "").lower() != row.safe_address
                or len(log.get("topics", [])) != 2
            ):
                continue
            topic = log["topics"][0].lower()
            if topic not in (SUCCESS_TOPIC, FAILURE_TOPIC):
                continue
            (payment,) = decode(["uint256"], bytes.fromhex(log["data"][2:]))
            if log["topics"][1].lower() == row.id:
                if payment != 0:
                    raise ControlError("unexpected_safe_gas_reimbursement")
                events.append(topic)
        if len(events) != 1:
            raise ControlError("safe_execution_event_mismatch")
        if events[0] == FAILURE_TOPIC:
            return "failed"
        if row.kind == "transfer":
            req = RelayRequest.model_validate(json.loads(row.payload))
            recipient, amount = decode(
                ["address", "uint256"], bytes.fromhex(req.transaction.data[10:])
            )
            expected = [
                TRANSFER_TOPIC,
                "0x" + row.safe_address[2:].rjust(64, "0"),
                "0x" + recipient[2:].rjust(64, "0"),
            ]
            transfers = [
                log
                for log in logs
                if log.get("address", "").lower() == req.transaction.to
                and [t.lower() for t in log.get("topics", [])] == expected
                and log.get("data", "").lower() == "0x" + int(amount).to_bytes(32, "big").hex()
            ]
            if len(transfers) != 1:
                raise ControlError("transfer_event_mismatch")
    else:
        payload = json.loads(row.payload)
        # Contract events are required; validate resulting state too through a
        # block-pinned read of the exact module request/owners.
        topic = (
            "0x"
            + keccak(
                text=(
                    "RecoveryExecuted(address,address[],uint256,uint256,uint64,uint256)"
                    if row.kind == "recovery-start"
                    else "RecoveryFinalized(address,address[],uint256,uint256)"
                )
            ).hex()
        )
        # ABI/event signatures are verified by local-EVM acceptance; no API status
        # substitutes for a mined transaction and a matching contract event.
        if not any(
            log.get("address", "").lower() == payload["module"]
            and len(log.get("topics", [])) == 3
            and log["topics"][0].lower() == topic
            and log["topics"][1].lower() == "0x" + row.safe_address[2:].rjust(64, "0")
            for log in logs
        ):
            raise ControlError("recovery_event_mismatch")
        request, owners, threshold = chain.rpc_batch(
            [
                chain.eth_call(
                    payload["module"],
                    "getRecoveryRequest(address)",
                    ["address"],
                    [row.safe_address],
                    receipt["blockNumber"],
                ),
                chain.eth_call(row.safe_address, "getOwners()", block=receipt["blockNumber"]),
                chain.eth_call(row.safe_address, "getThreshold()", block=receipt["blockNumber"]),
            ]
        )
        ((approvals, new_threshold, deadline, new_owners),) = decode(
            ["(uint256,uint256,uint64,address[])"], bytes.fromhex(request[2:])
        )
        if row.kind == "recovery-start":
            if (
                approvals < 2
                or new_threshold != 1
                or not deadline
                or list(new_owners) != [payload["new_owner"]]
            ):
                raise ControlError("recovery_state_mismatch")
        else:
            if (
                deadline
                or decode(["address[]"], bytes.fromhex(owners[2:]))[0] != (payload["new_owner"],)
                or chain.uint_result(threshold) != 1
            ):
                raise ControlError("recovery_state_mismatch")
    row.receipt_block = str(number)
    row.receipt_block_hash = receipt["blockHash"]
    return "confirmed"


def process_once(sessions, journal, account, row_id=None):
    with sessions() as db:
        query = db.query(RelayDB).filter(RelayDB.status.in_(("queued", "submitted", "reconciling")))
        row = (
            query.filter_by(id=row_id).first()
            if row_id
            else query.order_by(RelayDB.created_at).first()
        )
        if row is None:
            return False
        saved = journal.get(row.id)
        submitted = row.transaction_hash is not None
        try:
            if saved is None and submitted:
                raise ControlError("signed_transaction_journal_missing")
            if saved is None:
                signed, nonce = prepare(row, db, account)
                saved = journal.save(row.id, account.address.lower(), signed, nonce)
            if saved[0] != account.address.lower():
                raise ControlError("journal_treasury_mismatch")
            row.transaction_hash = saved[1]
            row.status = "submitted"
            db.commit()
            if row.kind in ("recovery-start", "recovery-finalize"):
                from app.recovery.routes import RecoveryCaseDB

                case = db.get(RecoveryCaseDB, json.loads(row.payload)["case_id"])
                setattr(
                    case, "execute_tx" if row.kind == "recovery-start" else "finalize_tx", saved[1]
                )
                db.commit()
            network, latest, receipt = chain.rpc_batch(
                [
                    ("eth_chainId", []),
                    ("eth_blockNumber", []),
                    ("eth_getTransactionReceipt", [saved[1]]),
                ]
            )
            if int(network, 16) != 11155111:
                raise ControlError("wrong_network")
            if receipt is None:
                returned = chain.rpc_batch([("eth_sendRawTransaction", [saved[2]])])[0]
                if returned.lower() != saved[1]:
                    raise ControlError("broadcast_hash_mismatch")
                row.failure_reason = None
            else:
                row.status = verify_receipt(row, receipt, int(latest, 16))
                row.failure_reason = "transaction_reverted" if row.status == "failed" else None
                if row.status in ("confirmed", "failed"):
                    row.active_safe = None
            db.commit()
        except (
            ControlError,
            HTTPException,
            ValueError,
            TypeError,
            KeyError,
            recovery_chain.ChainError,
            DecodingError,
        ) as error:
            if saved is not None or submitted:
                row.status = "reconciling"
                if saved:
                    row.transaction_hash = saved[1]
            elif isinstance(error, ControlError) and error.status in (
                "verification_unavailable",
                "treasury_eth_unavailable",
            ):
                row.status = "queued"
            else:
                row.status = "failed"
                row.active_safe = None
            row.failure_reason = (
                error.status
                if isinstance(error, ControlError)
                else error.detail
                if isinstance(error, HTTPException)
                else "invalid_chain_response"
            )
            db.commit()
        return True
