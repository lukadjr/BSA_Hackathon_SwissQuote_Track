"""Public Safe authorizations and recovery calls; only the treasury worker signs gas."""

import json
import os
from typing import Annotated, Literal

from eth_abi import decode, encode
from eth_abi.exceptions import DecodingError
from eth_account import Account
from eth_account.messages import _hash_eip191_message, encode_typed_data
from eth_keys.exceptions import BadSignature
from eth_utils import keccak
from fastapi import APIRouter, Depends, HTTPException
from pydantic import StringConstraints, field_validator
from sqlalchemy import Column, DateTime, String
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import chain as recovery_chain
from app import main as bank
from app.funding import chain
from app.wallet_registry.control import ControlError

MULTISEND = "0x9641d764fc13c8b624c04430c7356c1c7c8102e2"
MULTISEND_CODE_HASH = "ecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939"
ZERO = "0x" + "0" * 40
SENTINEL = "0x" + "0" * 39 + "1"
ACTIVE = ("queued", "submitted", "reconciling")
router = APIRouter(tags=["treasury relay"])


class RelayDB(bank.Base):
    __tablename__ = "treasury_relay_requests"
    id = Column(String, primary_key=True)  # Safe EIP-712 hash, or public recovery action hash
    user_id = Column(String, index=True, nullable=False)
    safe_address = Column(String, index=True, nullable=False)
    active_safe = Column(String, unique=True, nullable=True)
    kind = Column(String, nullable=False)
    payload = Column(String, nullable=False)
    status = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False)
    transaction_hash = Column(String)
    failure_reason = Column(String)
    receipt_block = Column(String)
    receipt_block_hash = Column(String)


Quantity = Annotated[str, StringConstraints(pattern=r"^(0|[1-9][0-9]{0,77})$")]
Data = Annotated[str, StringConstraints(pattern=r"^0x(?:[0-9a-fA-F]{2}){4,4096}$")]


class SafeTransaction(bank.StrictRequest):
    to: bank.Address
    value: Literal["0"] = "0"
    data: Data
    operation: Literal[0, 1]
    nonce: Quantity

    @field_validator("nonce")
    @classmethod
    def uint256_nonce(cls, value):
        if int(value) >= 2**256:
            raise ValueError("Nonce exceeds uint256")
        return value


class RelayRequest(bank.StrictRequest):
    chain_id: Literal[11155111]
    safe_address: bank.Address
    owner_address: bank.Address
    kind: Literal[
        "transfer", "protect", "cancel-recovery", "invalidate-approvals", "replace-guardian"
    ]
    transaction: SafeTransaction
    signature: Annotated[str, StringConstraints(pattern=r"^0x[0-9a-fA-F]{130}$")]


def typed_data(safe, tx):
    return {
        "types": {
            "EIP712Domain": [
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "SafeTx": [
                {"name": n, "type": t}
                for n, t in [
                    ("to", "address"),
                    ("value", "uint256"),
                    ("data", "bytes"),
                    ("operation", "uint8"),
                    ("safeTxGas", "uint256"),
                    ("baseGas", "uint256"),
                    ("gasPrice", "uint256"),
                    ("gasToken", "address"),
                    ("refundReceiver", "address"),
                    ("nonce", "uint256"),
                ]
            ],
        },
        "primaryType": "SafeTx",
        "domain": {"chainId": 11155111, "verifyingContract": safe},
        "message": {
            **tx,
            "value": 0,
            "nonce": int(tx["nonce"]),
            "safeTxGas": 0,
            "baseGas": 0,
            "gasPrice": 0,
            "gasToken": ZERO,
            "refundReceiver": ZERO,
        },
    }


def safe_hash(safe, tx):
    return "0x" + _hash_eip191_message(encode_typed_data(full_message=typed_data(safe, tx))).hex()


def abi_call(to, signature, types=(), values=()):
    return chain.selector(signature) + encode(list(types), list(values)).hex()


def unpack_calls(tx):
    if tx["operation"] == 0:
        return [(tx["to"], bytes.fromhex(tx["data"][2:]))]
    if tx["to"] != MULTISEND or tx["data"][:10] != chain.selector("multiSend(bytes)"):
        raise HTTPException(403, "Unsupported batch")
    packed = decode(["bytes"], bytes.fromhex(tx["data"][10:]))[0]
    if tx["data"].lower() != abi_call(MULTISEND, "multiSend(bytes)", ["bytes"], [packed]):
        raise ValueError("noncanonical batch")
    calls, offset = [], 0
    while offset < len(packed):
        if offset + 85 > len(packed) or packed[offset] != 0:
            raise ValueError("invalid call")
        to = "0x" + packed[offset + 1 : offset + 21].hex()
        value = int.from_bytes(packed[offset + 21 : offset + 53], "big")
        length = int.from_bytes(packed[offset + 53 : offset + 85], "big")
        end = offset + 85 + length
        if value or end > len(packed) or length < 4 or len(calls) >= 4:
            raise ValueError("invalid call")
        calls.append((to, packed[offset + 85 : end]))
        offset = end
    if len(calls) < 2:
        raise ValueError("empty batch")
    return calls


def canonical(call, signature, types=()):
    to, data = call
    if data[:4].hex() != chain.selector(signature)[2:]:
        raise HTTPException(403, "Unsupported call")
    values = decode(list(types), data[4:]) if types else ()
    if data != bytes.fromhex(abi_call(to, signature, types, values)[2:]):
        raise HTTPException(403, "Noncanonical call")
    return values


def validate_owner_request(req):
    try:
        bank.verify_control(req.safe_address, req.owner_address)
        nonce_hex = chain.rpc_batch([chain.eth_call(req.safe_address, "nonce()")])[0]
        if int(req.transaction.nonce) != chain.uint_result(nonce_hex):
            raise HTTPException(409, "Safe nonce changed")
        tx = req.transaction.model_dump()
        if int(tx["nonce"]) >= 2**256:
            raise HTTPException(422, "Invalid nonce")
        recovered = Account.recover_message(
            encode_typed_data(full_message=typed_data(req.safe_address, tx)),
            signature=req.signature,
        )
        if recovered.lower() != req.owner_address:
            raise HTTPException(401, "Owner signature rejected")
        calls = unpack_calls(tx)
        if req.kind == "transfer":
            if len(calls) != 1 or calls[0][0] != chain.configured_address("ERC20_TEST_ADDRESS"):
                raise HTTPException(403, "Unsupported token")
            recipient, amount = canonical(
                calls[0], "transfer(address,uint256)", ["address", "uint256"]
            )
            if (
                recipient in (ZERO, req.safe_address, "0x" + "0" * 36 + "dead")
                or not 0 < amount <= 10_000 * 10**6
            ):
                raise HTTPException(403, "Transfer refused by demo policy")
        else:
            state = recovery_chain.recovery_state(req.safe_address)
            if req.kind == "protect":
                if state is not None or len(calls) != 4 or calls[0][0] != req.safe_address:
                    raise HTTPException(409, "Recovery is already configured or batch is invalid")
                (module,) = canonical(calls[0], "enableModule(address)", ["address"])
                if module not in recovery_chain.RECOVERY_MODULES or (
                    module != chain.RECOVERY_3D
                    and os.getenv("RECOVERY_ALLOW_DEMO", "false") != "true"
                ):
                    raise HTTPException(403, "Unsupported recovery module")
                guardians = []
                for i, call in enumerate(calls[1:]):
                    if call[0] != module:
                        raise HTTPException(403, "Mixed modules")
                    guardian, threshold = canonical(
                        call, "addGuardianWithThreshold(address,uint256)", ["address", "uint256"]
                    )
                    if threshold != (2 if i == 2 else 1):
                        raise HTTPException(403, "Invalid threshold")
                    guardians.append(guardian)
                if len(set(guardians)) != 3 or any(
                    g
                    in (
                        ZERO,
                        SENTINEL,
                        req.owner_address,
                        chain.configured_address("SWISSQUOTE_TREASURY_ADDRESS"),
                    )
                    for g in guardians
                ):
                    raise HTTPException(403, "Invalid guardians")
            else:
                if state is None or state.threshold != 2 or len(state.guardians) != 3:
                    raise HTTPException(409, "Recovery is not configured")
                if any(to != state.module for to, _ in calls):
                    raise HTTPException(403, "Wrong recovery module")
                if req.kind == "cancel-recovery":
                    if not state.execute_after or len(calls) != 1:
                        raise HTTPException(409, "No pending recovery")
                    canonical(calls[0], "cancelRecovery()")
                elif req.kind == "invalidate-approvals":
                    if state.execute_after or len(calls) != 1:
                        raise HTTPException(409, "Cancel pending recovery first")
                    canonical(calls[0], "invalidateNonce()")
                else:
                    if state.execute_after or len(calls) != 2:
                        raise HTTPException(409, "Cancel pending recovery first")
                    prev, old, threshold = canonical(
                        calls[0],
                        "revokeGuardianWithThreshold(address,address,uint256)",
                        ["address", "address", "uint256"],
                    )
                    new, added_threshold = canonical(
                        calls[1],
                        "addGuardianWithThreshold(address,uint256)",
                        ["address", "uint256"],
                    )
                    if old not in state.guardians:
                        raise HTTPException(409, "Unknown guardian")
                    index = state.guardians.index(old)
                    if (
                        prev != (SENTINEL if index == 0 else state.guardians[index - 1])
                        or threshold != 2
                        or added_threshold != 2
                        or new
                        in state.guardians
                        + [
                            ZERO,
                            SENTINEL,
                            req.owner_address,
                            chain.configured_address("SWISSQUOTE_TREASURY_ADDRESS"),
                        ]
                    ):
                        raise HTTPException(403, "Invalid guardian replacement")
        if tx["operation"] == 1:
            code = chain.rpc_batch([("eth_getCode", [MULTISEND, "latest"])])[0]
            if keccak(bytes.fromhex(code[2:])).hex() != MULTISEND_CODE_HASH:
                raise ControlError("unsupported_multisend")
        return safe_hash(req.safe_address, tx)
    except ControlError:
        raise
    except recovery_chain.ChainError:
        raise ControlError("verification_unavailable") from None
    except (ValueError, TypeError, KeyError, DecodingError, BadSignature):
        raise HTTPException(422, "Invalid Safe transaction") from None


def response(row):
    return {
        "id": row.id,
        "safe_address": row.safe_address,
        "kind": row.kind,
        "status": row.status,
        "transaction_hash": row.transaction_hash,
        "failure_reason": row.failure_reason,
        "receipt_block": row.receipt_block,
        "gas_payer": "swissquote_treasury",
    }


def queue(db, user, safe, kind, payload, request_id):
    old = db.get(RelayDB, request_id)
    if old:
        if old.user_id != user or json.loads(old.payload) != payload:
            raise HTTPException(409, "Request hash belongs to another authorization")
        if old.status == "failed" and old.transaction_hash is None:
            # Refused before anything was signed/broadcast (no journal entry): the
            # caller just re-validated it, so let the same authorization retry.
            old.status = "queued"
            old.active_safe = safe
            old.failure_reason = None
            old.created_at = bank.utcnow()
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                raise HTTPException(
                    409, "A relay operation is already active for this Safe"
                ) from None
        return old
    row = RelayDB(
        id=request_id,
        user_id=user,
        safe_address=safe,
        active_safe=safe,
        kind=kind,
        payload=json.dumps(payload, sort_keys=True),
        status="queued",
        created_at=bank.utcnow(),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        old = db.get(RelayDB, request_id)
        if old and old.user_id == user and json.loads(old.payload) == payload:
            return old
        raise HTTPException(409, "A relay operation is already active for this Safe") from None
    return row


@router.post("/transactions/relay")
def relay(
    req: RelayRequest,
    user: Annotated[str, Depends(bank.current_user)],
    db: Session = Depends(bank.get_db),
):
    payload = req.model_dump()
    request_id = safe_hash(req.safe_address, req.transaction.model_dump())
    old = db.get(RelayDB, request_id)
    if old:
        if old.user_id != user or json.loads(old.payload) != payload:
            raise HTTPException(409, "Conflicting authorization")
        if not (old.status == "failed" and old.transaction_hash is None):
            return response(old)
    try:
        request_id = validate_owner_request(req)
        chain.configured_address("SWISSQUOTE_TREASURY_ADDRESS")
    except ControlError as error:
        raise HTTPException(503, error.status) from None
    return response(queue(db, user, req.safe_address, req.kind, payload, request_id))


@router.get("/transactions/{request_id}")
def status(
    request_id: str,
    user: Annotated[str, Depends(bank.current_user)],
    db: Session = Depends(bank.get_db),
):
    row = db.get(RelayDB, request_id)
    if row is None or row.user_id != user:
        raise HTTPException(404, "Unknown relay operation")
    return response(row)


def execution(row):
    req = RelayRequest.model_validate(json.loads(row.payload))
    tx = req.transaction
    data = abi_call(
        req.safe_address,
        "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
        [
            "address",
            "uint256",
            "bytes",
            "uint8",
            "uint256",
            "uint256",
            "uint256",
            "address",
            "address",
            "bytes",
        ],
        [
            tx.to,
            0,
            bytes.fromhex(tx.data[2:]),
            tx.operation,
            0,
            0,
            0,
            ZERO,
            ZERO,
            bytes.fromhex(req.signature[2:]),
        ],
    )
    return req.safe_address, data
