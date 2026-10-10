"""Funding intents. The web API never signs treasury transactions."""

import os
import secrets
from datetime import timedelta
from decimal import Decimal
from typing import Annotated, Literal

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, StringConstraints
from sqlalchemy import Column, DateTime, String, UniqueConstraint, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import main as bank
from app.funding import chain
from app.wallet_registry.control import ControlError

router = APIRouter(tags=["funding"])
ACTIVE = ("awaiting_confirmation", "queued", "submitted", "reconciling")


class FundingDB(bank.Base):
    __tablename__ = "funding_intents"
    __table_args__ = (UniqueConstraint("user_id", "idempotency_key"),)
    id = Column(String, primary_key=True)
    user_id = Column(String, index=True)
    active_user = Column(String, unique=True, nullable=True)
    idempotency_key = Column(String)
    kind = Column(String)
    safe_address = Column(String)
    owner_address = Column(String)
    treasury_address = Column(String)
    token_address = Column(String)
    amount_units = Column(String)
    security_mode = Column(String)
    domain = Column(String)
    message = Column(String)
    signature = Column(String, nullable=True)
    status = Column(String)
    expires_at = Column(DateTime)
    created_at = Column(DateTime)
    transaction_hash = Column(String, nullable=True)
    receipt_block = Column(String, nullable=True)
    receipt_block_hash = Column(String, nullable=True)
    failure_reason = Column(String, nullable=True)


class IntentRequest(bank.StrictRequest):
    kind: Literal["deposit", "deploy"]
    safe_address: bank.Address
    owner_address: bank.Address
    chain_id: Literal[11155111]
    amount: Decimal = Field(ge=0, allow_inf_nan=False, max_digits=18, decimal_places=6)
    idempotency_key: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{16,128}$")]


class ConfirmRequest(bank.StrictRequest):
    signature: Annotated[str, StringConstraints(pattern=r"^0x[0-9a-fA-F]{130}$")]


def fail(error):
    raise HTTPException(status_code=503, detail=error.status) from None


def message(intent):
    return "\n".join(
        [
            "Swissquote Wallet: authorize this demo bank operation.",
            f"Domain: {intent.domain}",
            f"Purpose: bank-{intent.kind}",
            f"Account: {intent.user_id}",
            f"Safe: {intent.safe_address}",
            f"Owner key: {intent.owner_address}",
            f"Treasury: {intent.treasury_address}",
            "Chain ID: 11155111",
            f"Token: {intent.token_address}",
            f"Amount (base units): {intent.amount_units}",
            f"Security: {intent.security_mode}",
            f"Nonce: {intent.id}",
            f"Expires: {bank.timestamp(intent.expires_at)}",
            "Testnet only. Bank identity and compliance checks are simulated.",
        ]
    )


def response(intent):
    # Explicit allowlist: no signer key/raw transaction ever returned.
    return {
        "id": intent.id,
        "client_id": intent.user_id,
        "kind": intent.kind,
        "safe_address": intent.safe_address,
        "owner_address": intent.owner_address,
        "treasury_address": intent.treasury_address,
        "token_address": intent.token_address,
        "amount_units": intent.amount_units,
        "chain_id": 11155111,
        "decimals": 6,
        "security_mode": intent.security_mode,
        "domain": intent.domain,
        "message": intent.message,
        "expires_at": bank.timestamp(intent.expires_at),
        "status": intent.status,
        "transaction_hash": intent.transaction_hash,
        "receipt_block": intent.receipt_block,
        "failure_reason": intent.failure_reason,
        "bank_mocked": True,
    }


def expire_unsigned(db):
    db.execute(
        update(FundingDB)
        .where(
            FundingDB.status == "awaiting_confirmation",
            FundingDB.expires_at <= bank.utcnow(),
        )
        .values(status="expired", active_user=None)
    )
    db.commit()


def owned_intent(db, user, intent_id):
    intent = db.get(FundingDB, intent_id)
    if intent is None or intent.user_id != user:
        raise HTTPException(status_code=404, detail="Unknown funding request")
    return intent


def check_eligibility(intent, db):
    bank.require_kyc(intent.user_id, db)
    wallet = bank.registered_wallet(intent.user_id, db)
    if (wallet.safe_address, wallet.owner_address) != (intent.safe_address, intent.owner_address):
        raise HTTPException(status_code=409, detail="Wallet changed; relink required")
    treasury, token = chain.public_config()
    if intent.owner_address == treasury:
        raise HTTPException(status_code=409, detail="Treasury cannot be the client owner")
    if (treasury, token) != (intent.treasury_address, intent.token_address):
        raise HTTPException(status_code=409, detail="Treasury configuration changed")
    if intent.kind == "deposit":
        bank.require_bank_eligibility(intent.user_id, intent.safe_address, db)
        if chain.security_status(intent.safe_address) != intent.security_mode:
            raise HTTPException(status_code=409, detail="Security configuration changed")
    else:
        payload = chain.deployment(intent.owner_address)
        if payload["safe_address"] != intent.safe_address:
            raise HTTPException(status_code=409, detail="Safe address does not match pinned setup")
        code = chain.rpc_batch([("eth_getCode", [intent.safe_address, "latest"])])[0]
        if code not in ("0x", "0x0"):
            bank.verify_control(intent.safe_address, intent.owner_address)
            return "already_deployed"
    return None


@router.get("/bank/account")
def account(user: Annotated[str, Depends(bank.current_user)], db: Session = Depends(bank.get_db)):
    bank.require_kyc(user, db)
    expire_unsigned(db)
    try:
        result = chain.snapshot()
    except ControlError as e:
        fail(e)
    reserved = sum(
        int(row.amount_units)
        for row in db.query(FundingDB)
        .filter(
            FundingDB.kind == "deposit",
            FundingDB.status.in_(("queued", "submitted", "reconciling")),
        )
        .all()
    )
    # Conservative until pending receipts reconcile; never invent a spendable credit.
    result["available_units"] = str(max(0, int(result["balance_units"]) - reserved))
    result["reserved_units"] = str(reserved)
    result["single_client_demo"] = True
    return result


@router.get("/bank/funding/intents")
def latest(user: Annotated[str, Depends(bank.current_user)], db: Session = Depends(bank.get_db)):
    expire_unsigned(db)
    rows = (
        db.query(FundingDB).filter_by(user_id=user).order_by(FundingDB.created_at.desc()).limit(10)
    )
    return {"intents": [response(row) for row in rows]}


@router.post("/bank/funding/intents")
def create(
    req: IntentRequest,
    user: Annotated[str, Depends(bank.current_user)],
    db: Session = Depends(bank.get_db),
):
    expire_unsigned(db)
    units = str(int(req.amount * 1_000_000))
    if (req.kind == "deposit" and req.amount <= 0) or (req.kind == "deploy" and req.amount != 0):
        raise HTTPException(status_code=422, detail="Invalid amount for this operation")
    if req.amount > 10_000:
        raise HTTPException(status_code=403, detail="Simulated high-value review required")
    existing = (
        db.query(FundingDB).filter_by(user_id=user, idempotency_key=req.idempotency_key).first()
    )
    if existing:
        if (
            existing.kind,
            existing.safe_address,
            existing.owner_address,
            existing.amount_units,
        ) != (
            req.kind,
            req.safe_address,
            req.owner_address,
            units,
        ):
            raise HTTPException(status_code=409, detail="Idempotency key used for another request")
        return response(existing)
    bank.require_kyc(user, db)
    wallet = bank.registered_wallet(user, db)
    # Serialize every operation for this demo identity, including setup.
    db.execute(
        update(bank.WalletDB)
        .where(bank.WalletDB.id == wallet.id)
        .values(owner_address=wallet.owner_address)
    )
    active = (
        db.query(FundingDB).filter(FundingDB.user_id == user, FundingDB.status.in_(ACTIVE)).first()
    )
    if active:
        raise HTTPException(status_code=409, detail="Finish the existing bank operation first")
    try:
        treasury, token = chain.public_config()
        mode = chain.security_status(req.safe_address) if req.kind == "deposit" else "setup_only"
        domain = os.getenv("WALLET_LINK_DOMAIN", "swissquote-wallet.demo")
        if not domain or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for c in domain):
            raise ControlError("invalid_domain")
        intent = FundingDB(
            id=secrets.token_urlsafe(24),
            user_id=user,
            active_user=user,
            idempotency_key=req.idempotency_key,
            kind=req.kind,
            safe_address=req.safe_address,
            owner_address=req.owner_address,
            treasury_address=treasury,
            token_address=token,
            amount_units=units,
            security_mode=mode,
            domain=domain,
            status="awaiting_confirmation",
            created_at=bank.utcnow(),
            expires_at=bank.utcnow() + timedelta(minutes=5),
        )
        already = check_eligibility(intent, db)
        balances = chain.snapshot()
        if req.kind == "deposit" and int(balances["balance_units"]) < int(units):
            raise HTTPException(status_code=409, detail="Insufficient demo bank token balance")
        if int(balances["eth_balance_wei"]) == 0 and already is None:
            raise HTTPException(status_code=409, detail="Fund the demo treasury with Sepolia ETH")
    except ControlError as e:
        fail(e)
    intent.message = message(intent)
    db.add(intent)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        winner = (
            db.query(FundingDB).filter_by(user_id=user, idempotency_key=req.idempotency_key).first()
        )
        if winner and (
            winner.kind,
            winner.safe_address,
            winner.owner_address,
            winner.amount_units,
        ) == (
            req.kind,
            req.safe_address,
            req.owner_address,
            units,
        ):
            return response(winner)
        raise HTTPException(
            status_code=409, detail="Concurrent funding request; refresh status"
        ) from None
    return response(intent)


@router.post("/bank/funding/intents/{intent_id}/confirm")
def confirm(
    intent_id: str,
    req: ConfirmRequest,
    user: Annotated[str, Depends(bank.current_user)],
    db: Session = Depends(bank.get_db),
):
    intent = owned_intent(db, user, intent_id)
    if intent.status != "awaiting_confirmation":
        return response(intent)  # Repeated confirmation cannot queue a second transfer.
    if intent.expires_at <= bank.utcnow():
        intent.status = "expired"
        intent.active_user = None
        db.commit()
        raise HTTPException(status_code=410, detail="Funding instruction expired")
    try:
        signer = Account.recover_message(
            encode_defunct(text=intent.message), signature=req.signature
        )
    except Exception:
        signer = ""
    if signer.lower() != intent.owner_address:
        raise HTTPException(status_code=401, detail="Funding signature rejected")
    try:
        check_eligibility(intent, db)
    except ControlError as e:
        fail(e)
    locked = db.execute(
        update(bank.WalletDB)
        .where(
            bank.WalletDB.user_id == user,
            bank.WalletDB.safe_address == intent.safe_address,
            bank.WalletDB.owner_address == intent.owner_address,
        )
        .values(owner_address=intent.owner_address)
    )
    if intent.kind == "deposit":
        linked = db.get(bank.ControlAttestationDB, user)
        if linked:
            db.refresh(linked)
        if (
            linked is None
            or linked.invalidated
            or (linked.safe_address, linked.owner_address)
            != (
                intent.safe_address,
                intent.owner_address,
            )
        ):
            db.rollback()
            raise HTTPException(status_code=409, detail="Bank link changed during confirmation")
    if locked.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="Wallet changed during confirmation")
    consumed = db.execute(
        update(FundingDB)
        .where(
            FundingDB.id == intent_id,
            FundingDB.status == "awaiting_confirmation",
            FundingDB.expires_at > bank.utcnow(),
        )
        .values(status="queued", signature=req.signature)
    )
    if consumed.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="Funding request changed; refresh status")
    bank.audit(db, user, "funding_queued", intent=intent_id, kind=intent.kind)
    db.commit()
    db.refresh(intent)
    return response(intent)


@router.get("/bank/funding/intents/{intent_id}")
def status(
    intent_id: str,
    user: Annotated[str, Depends(bank.current_user)],
    db: Session = Depends(bank.get_db),
):
    expire_unsigned(db)
    return response(owned_intent(db, user, intent_id))
