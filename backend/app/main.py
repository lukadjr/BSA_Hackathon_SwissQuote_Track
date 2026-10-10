"""Authenticated demo API: wallet linking, mock screening and recovery coordination."""

import os
import secrets
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Annotated

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import Depends, FastAPI, HTTPException
from pydantic import Field, StringConstraints
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import (
    SQLALCHEMY_DATABASE_URL,
    Address,
    Base,
    LinkChallengeDB,
    StrictRequest,
    UserId,
    WalletDB,
    current_user,
    engine,
    find_wallet,
    get_db,
    require_user,
    utcnow,
)
from app.recovery import routes as recovery_routes

Base.metadata.create_all(bind=engine)
_columns = {column["name"] for column in inspect(engine).get_columns("wallets")}
if not {"owner_verified_at", "safe_address"} <= _columns:
    raise RuntimeError(
        "The demo database uses an older schema. Delete or move it "
        f"({SQLALCHEMY_DATABASE_URL}) and restart; it only holds demo data."
    )
app = FastAPI(
    title="Swissquote Demo API",
    version="0.1.0",
    description=(
        "Mock metadata and screening. Wallet linking checks an owner-key signature. "
        "Recovery coordination: guardian invites, approvals, the Swissquote guardian "
        "signer and a relayer. The chain stays the source of truth."
    ),
)


class HealthResponse(StrictRequest):
    status: str
    service: str


@app.get("/health", response_model=HealthResponse, tags=["health"])
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="swissquote-demo")


class WalletRegistration(StrictRequest):
    user_id: UserId
    safe_address: Address
    owner_address: Address


def wallet_response(wallet: WalletDB) -> dict:
    return {
        "success": True,
        "ownership_verified": True,
        "data": {
            "user_id": wallet.user_id,
            "safe_address": wallet.safe_address,
            "owner_address": wallet.owner_address,
            "owner_verified_at": wallet.owner_verified_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
    }


@app.post("/wallets/register")
def register_wallet(
    wallet: WalletRegistration,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    """Change the Safe of a wallet whose owner key is already linked by signature."""
    require_user(wallet.user_id, user)
    existing_wallet = find_wallet(db, user)
    if existing_wallet is None:
        raise HTTPException(status_code=409, detail="Link the owner key before registering a Safe")
    if existing_wallet.owner_address != wallet.owner_address:
        raise HTTPException(status_code=409, detail="Owner key does not match the linked key")
    existing_wallet.safe_address = wallet.safe_address
    db.commit()
    return wallet_response(existing_wallet)


@app.get("/wallets/{user_id}")
def get_wallet(
    user_id: str,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    require_user(user_id, user)
    wallet = find_wallet(db, user)
    if not wallet:
        raise HTTPException(status_code=404, detail="Wallet not found for this user_id")
    return wallet_response(wallet)


LINK_CHALLENGE_TTL = timedelta(minutes=5)


class LinkChallengeRequest(StrictRequest):
    owner_address: Address
    safe_address: Address


class LinkCompleteRequest(StrictRequest):
    challenge_id: Annotated[str, StringConstraints(min_length=16, max_length=128)]
    signature: Annotated[str, StringConstraints(pattern=r"^0x[0-9a-fA-F]{130}$")]


def link_message(user_id: str, owner: str, safe: str, nonce: str, expires_at: datetime) -> str:
    # Shown verbatim on the phone before signing; must stay human-readable.
    return "\n".join(
        [
            "Swissquote Wallet: link this phone's wallet to your account.",
            f"Account: {user_id}",
            f"Owner key: {owner}",
            f"Safe: {safe}",
            f"Nonce: {nonce}",
            f"Expires: {expires_at.strftime('%Y-%m-%dT%H:%M:%SZ')}",
            "This moves no funds.",
        ]
    )


@app.post("/wallets/link/challenge")
def create_link_challenge(
    req: LinkChallengeRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    expires_at = utcnow() + LINK_CHALLENGE_TTL
    challenge = LinkChallengeDB(
        id=secrets.token_urlsafe(24),
        user_id=user,
        owner_address=req.owner_address,
        safe_address=req.safe_address,
        expires_at=expires_at,
        used=False,
    )
    challenge.message = link_message(
        user, req.owner_address, req.safe_address, challenge.id, expires_at
    )
    db.add(challenge)
    db.commit()
    return {
        "challenge_id": challenge.id,
        "message": challenge.message,
        "owner_address": req.owner_address,
        "safe_address": req.safe_address,
        "expires_at": expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


@app.post("/wallets/link/complete")
def complete_link(
    req: LinkCompleteRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    challenge = db.get(LinkChallengeDB, req.challenge_id)
    if challenge is None or challenge.user_id != user:
        raise HTTPException(status_code=404, detail="Unknown link challenge")
    if challenge.used:
        raise HTTPException(status_code=409, detail="Link challenge already used")
    if challenge.expires_at < utcnow():
        raise HTTPException(status_code=410, detail="Link challenge expired")
    # Single use, even when the signature is wrong.
    challenge.used = True
    db.commit()
    try:
        signer = Account.recover_message(
            encode_defunct(text=challenge.message), signature=req.signature
        )
    except Exception:
        signer = None
    if signer is None or signer.lower() != challenge.owner_address:
        raise HTTPException(status_code=401, detail="Signature does not match the owner key")

    wallet = find_wallet(db, user)
    if wallet is None:
        wallet = WalletDB(user_id=user)
        db.add(wallet)
    wallet.owner_address = challenge.owner_address
    wallet.safe_address = challenge.safe_address
    wallet.owner_verified_at = utcnow()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Wallet link conflict") from None
    return {
        "success": True,
        # Proves control of the owner key, which signed the Safe address too.
        # Not KYC, and not an on-chain check that the Safe is owned by this key.
        "owner_key_verified": True,
        "data": {
            "user_id": user,
            "owner_address": wallet.owner_address,
            "safe_address": wallet.safe_address,
        },
    }


class TransactionScreenRequest(StrictRequest):
    recipient_address: Address
    amount: Decimal = Field(gt=0, allow_inf_nan=False, max_digits=30, decimal_places=6)


@app.post("/transactions/screen")
def screen_transaction(
    tx: TransactionScreenRequest,
    user: Annotated[str, Depends(current_user)],
):
    # Valid test address; this is mock policy, not real sanctions enforcement.
    if tx.recipient_address == "0x000000000000000000000000000000000000dead":
        return {"status": "blocked", "mock": True, "reason": "Blocked by demo screening policy."}
    if tx.amount > Decimal("10000"):
        return {
            "status": "review_required",
            "mock": True,
            "reason": "Demo high-value review required.",
        }
    return {"status": "approved", "mock": True, "reason": "Passed demo screening only."}


app.include_router(recovery_routes.router)

# Optional on-chain watcher (push alerts). Off in tests and by default.
if os.getenv("RECOVERY_WATCHER_SECONDS", "").isdigit():
    recovery_routes.start_watcher(max(10, int(os.environ["RECOVERY_WATCHER_SECONDS"])))
