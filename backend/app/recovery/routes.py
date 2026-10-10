"""Recovery coordination: guardian invites, approvals, Swissquote guardian, relayer, alerts.

Nothing here can change a Safe by itself: the recovery module checks every
guardian signature on-chain, and the owner can cancel during the grace period.
The backend only carries public data (addresses and signatures) between phones.
"""

import json
import logging
import re
import secrets
import threading
import time
import urllib.request
from datetime import timedelta
from typing import Annotated

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import to_checksum_address
from fastapi import APIRouter, Depends, HTTPException
from pydantic import StringConstraints
from sqlalchemy import Column, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Session

from app import chain
from app.core import (
    Address,
    Base,
    SessionLocal,
    StrictRequest,
    WalletDB,
    current_user,
    find_wallet,
    get_db,
    utcnow,
)
from app.guardian_policy import signer

log = logging.getLogger(__name__)
router = APIRouter(tags=["recovery"])
INVITE_TTL = timedelta(minutes=15)
Signature = Annotated[str, StringConstraints(pattern=r"^0x[0-9a-fA-F]{130}$")]
CaseId = Annotated[str, StringConstraints(pattern=r"^[\w-]{16,128}$")]


class GuardianInviteDB(Base):
    __tablename__ = "guardian_invites"
    id = Column(String, primary_key=True)
    user_id = Column(String, index=True, nullable=False)
    safe_address = Column(String, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    guardian_address = Column(String, index=True)
    accepted_at = Column(DateTime)


class RecoveryCaseDB(Base):
    __tablename__ = "recovery_cases"
    id = Column(String, primary_key=True)
    user_id = Column(String, index=True, nullable=False)
    safe_address = Column(String, index=True, nullable=False)
    module = Column(String, nullable=False)
    new_owner = Column(String, nullable=False)
    nonce = Column(Integer, nullable=False)
    created_at = Column(DateTime, nullable=False)
    execute_tx = Column(String)
    finalize_tx = Column(String)


class ApprovalDB(Base):
    __tablename__ = "recovery_approvals"
    __table_args__ = (UniqueConstraint("case_id", "guardian_address"),)
    id = Column(Integer, primary_key=True)
    case_id = Column(String, index=True, nullable=False)
    guardian_address = Column(String, nullable=False)
    signature = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False)


class AlertDB(Base):
    __tablename__ = "recovery_alerts"
    id = Column(Integer, primary_key=True)
    safe_address = Column(String, index=True, nullable=False)
    dedupe_key = Column(String, unique=True, nullable=False)
    kind = Column(String, nullable=False)
    message = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False)


class PushTokenDB(Base):
    __tablename__ = "push_tokens"
    id = Column(Integer, primary_key=True)
    safe_address = Column(String, index=True, nullable=False)
    token = Column(String, unique=True, nullable=False)


def iso(value) -> str | None:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ") if value else None


def chain_or_503(action):
    try:
        return action()
    except chain.ChainError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


def user_wallet(db: Session, user: str, safe: str) -> WalletDB:
    wallet = find_wallet(db, user)
    if wallet is None:
        raise HTTPException(status_code=404, detail="Wallet not found for this user")
    if wallet.safe_address.lower() != safe:
        raise HTTPException(status_code=409, detail="Safe does not match the registered wallet")
    return wallet


# ---------------------------------------------------------------- alerts / push


def send_push(db: Session, safe: str, title: str, body: str) -> None:
    tokens = [row.token for row in db.query(PushTokenDB).filter_by(safe_address=safe)]
    if not tokens:
        return
    payload = json.dumps(
        [
            {"to": t, "title": title, "body": body, "priority": "high", "sound": "default"}
            for t in tokens
        ]
    ).encode()
    request = urllib.request.Request(
        "https://exp.host/--/api/v2/push/send",
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        urllib.request.urlopen(request, timeout=10).close()
    except Exception:
        # A push is best effort: the on-chain grace period does not depend on it.
        log.warning("Expo push delivery failed")


def raise_alert(db: Session, safe: str, key: str, kind: str, message: str) -> None:
    if db.query(AlertDB).filter_by(dedupe_key=key).first():
        return
    db.add(
        AlertDB(safe_address=safe, dedupe_key=key, kind=kind, message=message, created_at=utcnow())
    )
    db.commit()
    send_push(db, safe, "Security alert: wallet recovery", message)


def alert_for_chain_state(db: Session, safe: str, state: chain.RecoveryState | None) -> None:
    if state and state.execute_after:
        raise_alert(
            db,
            safe,
            f"started:{safe}:{state.nonce}:{state.execute_after}",
            "recovery_started",
            "Someone wants to replace the key of your wallet with "
            f"{state.new_owners[0][:6]}…{state.new_owners[0][-4:]}. If it is not you, "
            "open Swissquote Wallet and cancel before the deadline.",
        )


class PushTokenRequest(StrictRequest):
    safe_address: Address
    expo_push_token: Annotated[
        str, StringConstraints(pattern=r"^(Exponent|Expo)PushToken\[[\w-]{10,100}\]$")
    ]


@router.post("/alerts/push-token")
def register_push_token(
    req: PushTokenRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    user_wallet(db, user, req.safe_address)
    if not db.query(PushTokenDB).filter_by(token=req.expo_push_token).first():
        db.add(PushTokenDB(safe_address=req.safe_address, token=req.expo_push_token))
        db.commit()
    return {"registered": True}


def scan_once() -> None:
    """Watcher: alert owners of every linked Safe about a started recovery."""
    with SessionLocal() as db:
        for wallet in db.query(WalletDB).all():
            safe = wallet.safe_address.lower()
            try:
                alert_for_chain_state(db, safe, chain.recovery_state(safe))
            except chain.ChainError:
                log.warning("Recovery watcher could not read the chain")
                return


def start_watcher(interval_seconds: int) -> threading.Thread:
    def loop():
        while True:
            scan_once()
            time.sleep(interval_seconds)

    thread = threading.Thread(target=loop, name="recovery-watcher", daemon=True)
    thread.start()
    return thread


# ---------------------------------------------------------------- guardians


@router.get("/guardians/swissquote")
def swissquote_guardian(user: Annotated[str, Depends(current_user)]):
    try:
        address = signer.guardian_address()
    except signer.SignerUnavailable:
        raise HTTPException(
            status_code=503, detail="Swissquote guardian signer is not configured"
        ) from None
    try:
        relayer = signer.relayer_address()
    except signer.SignerUnavailable:
        relayer = None
    # The relayer pays gas for public recovery calls; fund it with Sepolia ETH.
    return {"address": address, "relayer_address": relayer}


class InviteRequest(StrictRequest):
    safe_address: Address


@router.post("/guardians/invites")
def create_invite(
    req: InviteRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    user_wallet(db, user, req.safe_address)
    invite = GuardianInviteDB(
        id=secrets.token_urlsafe(24),
        user_id=user,
        safe_address=req.safe_address,
        expires_at=utcnow() + INVITE_TTL,
    )
    db.add(invite)
    db.commit()
    return {
        "invite_id": invite.id,
        "safe_address": invite.safe_address,
        "from": user,
        "expires_at": iso(invite.expires_at),
    }


def find_invite(db: Session, invite_id: str) -> GuardianInviteDB:
    invite = db.get(GuardianInviteDB, invite_id)
    if invite is None:
        raise HTTPException(status_code=404, detail="Unknown invite")
    return invite


@router.get("/guardians/invites/{invite_id}")
def read_invite(
    invite_id: str,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    invite = find_invite(db, invite_id)
    if invite.user_id != user:
        raise HTTPException(status_code=404, detail="Unknown invite")
    return {
        "invite_id": invite.id,
        "safe_address": invite.safe_address,
        "status": "accepted" if invite.guardian_address else "open",
        "guardian_address": invite.guardian_address,
        "expires_at": iso(invite.expires_at),
    }


def invite_message(safe: str, invite_id: str, guardian: str) -> str:
    # Must stay identical to wallet-core guardianInviteMessage().
    return "\n".join(
        [
            "Swissquote Wallet: I agree to be a recovery guardian.",
            f"Safe: {to_checksum_address(safe)}",
            f"Guardian key: {to_checksum_address(guardian)}",
            f"Invite: {invite_id}",
            f"Chain: {chain.CHAIN_ID}",
            "This moves no funds.",
        ]
    )


class AcceptInviteRequest(StrictRequest):
    guardian_address: Address
    signature: Signature


@router.post("/guardians/invites/{invite_id}/accept")
def accept_invite(
    invite_id: str,
    req: AcceptInviteRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    # Called from the FRIEND's app: the signature, not the session, proves the key.
    invite = find_invite(db, invite_id)
    if invite.guardian_address:
        raise HTTPException(status_code=409, detail="Invite already used")
    if invite.expires_at < utcnow():
        raise HTTPException(status_code=410, detail="Invite expired")
    try:
        signer_address = Account.recover_message(
            encode_defunct(
                text=invite_message(invite.safe_address, invite.id, req.guardian_address)
            ),
            signature=req.signature,
        ).lower()
    except Exception:
        signer_address = None
    if signer_address != req.guardian_address:
        raise HTTPException(status_code=401, detail="Signature does not match the guardian key")
    wallet = db.query(WalletDB).filter(WalletDB.user_id == invite.user_id).first()
    if wallet and wallet.owner_address.lower() == req.guardian_address:
        raise HTTPException(status_code=422, detail="The owner key cannot be its own guardian")
    invite.guardian_address = req.guardian_address
    invite.accepted_at = utcnow()
    db.commit()
    return {"status": "accepted", "safe_address": invite.safe_address}


@router.get("/guardians/{guardian_address}/requests")
def guardian_requests(
    guardian_address: str,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    """Open recovery requests for the Safes this guardian accepted to protect."""
    guardian = guardian_address.lower()
    if not re.fullmatch(r"0x[0-9a-f]{40}", guardian):
        raise HTTPException(status_code=422, detail="Invalid guardian address")
    safes = {
        row.safe_address for row in db.query(GuardianInviteDB).filter_by(guardian_address=guardian)
    }
    cases = (
        db.query(RecoveryCaseDB)
        .filter(RecoveryCaseDB.safe_address.in_(safes), RecoveryCaseDB.execute_tx.is_(None))
        .order_by(RecoveryCaseDB.created_at.desc())
        .all()
    )
    approved = {row.case_id for row in db.query(ApprovalDB).filter_by(guardian_address=guardian)}
    return {
        "requests": [
            {**case_summary(case), "approved_by_you": case.id in approved} for case in cases
        ]
    }


# ---------------------------------------------------------------- recovery cases


def case_summary(case: RecoveryCaseDB) -> dict:
    return {
        "case_id": case.id,
        "safe_address": case.safe_address,
        "module": case.module,
        "new_owner_address": case.new_owner,
        "nonce": str(case.nonce),
        "created_at": iso(case.created_at),
    }


def case_detail(db: Session, case: RecoveryCaseDB, state: chain.RecoveryState | None) -> dict:
    approvals = db.query(ApprovalDB).filter_by(case_id=case.id).all()
    # The module increments its nonce when a recovery starts, which also voids
    # every approval signed for the previous nonce.
    if state is None:
        status = "closed"
    elif state.execute_after:
        ours = state.new_owners == [case.new_owner] and state.nonce == case.nonce + 1
        status = "started" if ours else "other_request_pending"
    elif state.nonce == case.nonce:
        status = "collecting"
    else:
        status = "closed"  # cancelled, or superseded by another recovery
    owners = chain_or_503(lambda: chain.owners(case.safe_address))
    if owners == [case.new_owner]:
        status = "finalized"
    guardians = state.guardians if state else []
    return {
        **case_summary(case),
        "status": status,
        "execute_after": state.execute_after if state and state.execute_after else None,
        "approvals": [
            {
                "guardian_address": a.guardian_address,
                "signature": a.signature,
                "is_swissquote": a.guardian_address == _swissquote_address_or_none(),
            }
            for a in approvals
            if a.guardian_address in guardians
        ],
        "threshold": state.threshold if state else chain.RECOVERY_THRESHOLD,
        "execute_tx": case.execute_tx,
        "finalize_tx": case.finalize_tx,
    }


def _swissquote_address_or_none() -> str | None:
    try:
        return signer.guardian_address()
    except signer.SignerUnavailable:
        return None


def find_case(db: Session, case_id: str) -> RecoveryCaseDB:
    case = db.get(RecoveryCaseDB, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="Unknown recovery request")
    return case


class CreateCaseRequest(StrictRequest):
    safe_address: Address
    new_owner_address: Address


@router.post("/recovery/requests")
def create_case(
    req: CreateCaseRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    user_wallet(db, user, req.safe_address)
    state = chain_or_503(lambda: chain.recovery_state(req.safe_address))
    if state is None:
        raise HTTPException(status_code=409, detail="Recovery is not set up for this Safe")
    owners = chain_or_503(lambda: chain.owners(req.safe_address))
    if req.new_owner_address in owners:
        raise HTTPException(status_code=422, detail="Recovery needs a different owner")
    if state.execute_after:
        raise HTTPException(status_code=409, detail="A recovery is already pending on-chain")
    case = (
        db.query(RecoveryCaseDB)
        .filter_by(
            safe_address=req.safe_address, new_owner=req.new_owner_address, nonce=state.nonce
        )
        .first()
    )
    if case is None:
        case = RecoveryCaseDB(
            id=secrets.token_urlsafe(24),
            user_id=user,
            safe_address=req.safe_address,
            module=state.module,
            new_owner=req.new_owner_address,
            nonce=state.nonce,
            created_at=utcnow(),
        )
        db.add(case)
        db.commit()
        raise_alert(
            db,
            req.safe_address,
            f"requested:{case.id}",
            "recovery_requested",
            "A recovery of your wallet was requested for the new key "
            f"{req.new_owner_address[:6]}…{req.new_owner_address[-4:]}. "
            "If it is not you, contact Swissquote and keep your phone at hand.",
        )
    return case_detail(db, case, state)


@router.get("/recovery/requests/{case_id}")
def read_case(
    case_id: CaseId,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    case = find_case(db, case_id)
    state = chain_or_503(lambda: chain.recovery_state(case.safe_address))
    return case_detail(db, case, state)


class ApprovalRequest(StrictRequest):
    guardian_address: Address
    signature: Signature


def store_approval(db: Session, case: RecoveryCaseDB, guardian: str, signature: str) -> None:
    state = chain_or_503(lambda: chain.recovery_state(case.safe_address))
    if state is None or state.nonce != case.nonce or state.execute_after:
        raise HTTPException(status_code=409, detail="This request is no longer open")
    if guardian not in state.guardians:
        raise HTTPException(status_code=403, detail="Not a guardian of this Safe")
    recovered = chain.recover_approval_signer(
        case.module, case.safe_address, case.new_owner, case.nonce, signature
    )
    if recovered != guardian:
        raise HTTPException(status_code=401, detail="Signature does not match the guardian")
    existing = db.query(ApprovalDB).filter_by(case_id=case.id, guardian_address=guardian).first()
    if existing is None:
        db.add(
            ApprovalDB(
                case_id=case.id,
                guardian_address=guardian,
                signature=signature,
                created_at=utcnow(),
            )
        )
        db.commit()


@router.post("/recovery/requests/{case_id}/approvals")
def add_approval(
    case_id: CaseId,
    req: ApprovalRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    # Any guardian (backup phrase, friend) proves itself by its signature.
    case = find_case(db, case_id)
    store_approval(db, case, req.guardian_address, req.signature)
    return read_case(case_id, user, db)


class SwissquoteApproveRequest(StrictRequest):
    identity_confirmed: bool


@router.post("/recovery/requests/{case_id}/swissquote-approve")
def swissquote_approve(
    case_id: CaseId,
    req: SwissquoteApproveRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    case = find_case(db, case_id)
    # Mock identity review: the customer's banking session owns this Safe and the
    # customer confirmed the identity check. A real bank adds KYC, a call-back
    # and its own delay before this signer is used.
    user_wallet(db, user, case.safe_address)
    if case.user_id != user or not req.identity_confirmed:
        raise HTTPException(status_code=403, detail="Identity review not passed")
    try:
        guardian = signer.guardian_address()
        signature = signer.sign_recovery_approval(
            case.module, case.safe_address, case.new_owner, case.nonce
        )
    except signer.SignerUnavailable:
        raise HTTPException(
            status_code=503, detail="Swissquote guardian signer is not configured"
        ) from None
    store_approval(db, case, guardian, signature)
    return read_case(case_id, user, db)


def relay(to: str, data: bytes) -> str:
    try:
        key = signer.relayer_key()
    except signer.SignerUnavailable:
        raise HTTPException(status_code=503, detail="Relayer is not configured") from None
    return chain_or_503(lambda: chain.send_transaction(key, to, data))


@router.post("/recovery/requests/{case_id}/submit")
def submit_case(
    case_id: CaseId,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    """Relay multiConfirmRecovery: starts the grace period. Anyone may do this."""
    case = find_case(db, case_id)
    detail = read_case(case_id, user, db)
    if detail["status"] != "collecting":
        raise HTTPException(status_code=409, detail="This request is no longer open")
    approvals = [(a["guardian_address"], a["signature"]) for a in detail["approvals"]]
    if len(approvals) < detail["threshold"]:
        raise HTTPException(status_code=409, detail="Not enough guardian approvals yet")
    case.execute_tx = relay(
        case.module,
        chain.multi_confirm_recovery_data(case.safe_address, case.new_owner, approvals),
    )
    db.commit()
    return {"tx_hash": case.execute_tx}


@router.post("/recovery/requests/{case_id}/finalize")
def finalize_case(
    case_id: CaseId,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    case = find_case(db, case_id)
    detail = read_case(case_id, user, db)
    if detail["status"] != "started":
        raise HTTPException(status_code=409, detail="No started recovery for this request")
    if chain_or_503(chain.latest_timestamp) < detail["execute_after"]:
        raise HTTPException(status_code=409, detail="The grace period is not over yet")
    case.finalize_tx = relay(case.module, chain.finalize_recovery_data(case.safe_address))
    db.commit()
    return {"tx_hash": case.finalize_tx}


@router.get("/wallets/{safe_address}/recovery-status")
def recovery_status(
    safe_address: str,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    """For the owner's phone: on-chain pending recovery, open requests and alerts."""
    safe = safe_address.lower()
    user_wallet(db, user, safe)
    state = chain_or_503(lambda: chain.recovery_state(safe))
    alert_for_chain_state(db, safe, state)
    open_cases = [
        case_summary(c)
        for c in db.query(RecoveryCaseDB).filter_by(safe_address=safe, execute_tx=None)
        if state is not None and c.nonce == state.nonce and not state.execute_after
    ]
    alerts = (
        db.query(AlertDB)
        .filter_by(safe_address=safe)
        .order_by(AlertDB.created_at.desc())
        .limit(20)
        .all()
    )
    return {
        "protected": state is not None,
        "guardians": state.guardians if state else [],
        "threshold": state.threshold if state else None,
        "pending": (
            {"new_owner_address": state.new_owners[0], "execute_after": state.execute_after}
            if state and state.execute_after
            else None
        ),
        "open_requests": open_cases,
        "alerts": [
            {"kind": a.kind, "message": a.message, "created_at": iso(a.created_at)} for a in alerts
        ],
        "swissquote_guardian": _swissquote_address_or_none(),
    }


@router.get("/me/wallet")
def my_wallet(user: Annotated[str, Depends(current_user)], db: Session = Depends(get_db)):
    """For a new phone: the Safe Swissquote has on file for this customer."""
    wallet = find_wallet(db, user)
    if wallet is None:
        raise HTTPException(status_code=404, detail="Wallet not found for this user")
    return {"user_id": user, "safe_address": wallet.safe_address}
