"""Mock bank identity plus real signed, on-chain Safe-control attestations."""

import hashlib
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import Boolean, Column, DateTime, Integer, String, create_engine, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from app.config import load_environment
from app.wallet_registry.control import CHAIN_ID, ControlError, verify_control

load_environment()

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./swissquote_mock.db")
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class WalletDB(Base):
    __tablename__ = "wallets"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, unique=True, index=True)
    safe_address = Column(String)
    owner_address = Column(String)


# New tables intentionally do not upgrade old owner-key-only links into Safe proofs.
class MockUserDB(Base):
    __tablename__ = "mock_users"
    id = Column(String, primary_key=True)
    display_name = Column(String)
    kyc_status = Column(String)
    verified_at = Column(DateTime, nullable=True)


class LinkChallengeDB(Base):
    __tablename__ = "safe_link_challenges_v2"
    id = Column(String, primary_key=True)
    user_id = Column(String, index=True)
    owner_address = Column(String)
    safe_address = Column(String)
    chain_id = Column(Integer)
    domain = Column(String)
    message = Column(String)
    expires_at = Column(DateTime)
    used = Column(Boolean, default=False)
    revoked = Column(Boolean, default=False)


class ControlAttestationDB(Base):
    __tablename__ = "safe_control_attestations"
    user_id = Column(String, primary_key=True)
    owner_address = Column(String)
    safe_address = Column(String)
    chain_id = Column(Integer)
    challenge_id = Column(String)
    signature = Column(String)
    linked_at = Column(DateTime)
    block_number = Column(Integer)
    block_hash = Column(String)
    invalidated = Column(Boolean, default=False)


class AuditEventDB(Base):
    __tablename__ = "kyc_audit_events"
    id = Column(Integer, primary_key=True)
    user_id = Column(String, index=True)
    action = Column(String)
    created_at = Column(DateTime)
    details = Column(String)


class DemoSessionDB(Base):
    __tablename__ = "demo_sessions"
    token_hash = Column(String, primary_key=True)
    user_id = Column(String, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)


Base.metadata.create_all(bind=engine)
app = FastAPI(
    title="Swissquote Demo API",
    version="0.2.0",
    description=(
        "Mock bank identity and screening; real signed Sepolia Safe-control verification. "
        "Funding uses a separate testnet treasury worker. Recovery remains separate."
    ),
)
bearer = HTTPBearer(auto_error=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    db: Session = Depends(get_db),
) -> str:
    # One server-provisioned demo identity. Never mint a session for a caller's user_id.
    token = os.getenv("MOCK_ACCESS_TOKEN", "")
    user_id = os.getenv("MOCK_USER_ID", "demo-user")
    if len(token) < 32 or not user_id.strip():
        raise HTTPException(status_code=503, detail="Demo authentication is not configured")
    if (
        credentials is not None
        and os.getenv("MOCK_ALLOW_USERNAME_LOGIN", "false").lower() == "true"
    ):
        session = db.get(
            DemoSessionDB, hashlib.sha256(credentials.credentials.encode()).hexdigest()
        )
        if session is not None and session.expires_at > utcnow():
            return session.user_id
    if credentials is None or not secrets.compare_digest(
        credentials.credentials.encode(), token.encode()
    ):
        raise HTTPException(
            status_code=401,
            detail="Invalid demo credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user_id


def require_user(user_id: str, authenticated_user: str) -> None:
    if user_id != authenticated_user:
        raise HTTPException(status_code=403, detail="Cannot access another user's wallet")


def validate_address(value: str) -> str:
    if int(value[2:], 16) == 0:
        raise ValueError("The zero address is not allowed")
    return value.lower()


Address = Annotated[
    str,
    StringConstraints(pattern=r"^0x[0-9a-fA-F]{40}$"),
    AfterValidator(validate_address),
]
UserId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


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
        "ownership_verified": False,
        "data": {
            "user_id": wallet.user_id,
            "safe_address": wallet.safe_address,
            "owner_address": wallet.owner_address,
        },
    }


class DemoLoginRequest(StrictRequest):
    username: UserId


@app.post("/auth/demo/login")
def demo_login(
    req: DemoLoginRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    if os.getenv("MOCK_ALLOW_USERNAME_LOGIN", "false").lower() != "true":
        raise HTTPException(404, "Username demo login is disabled")
    name = req.username.strip().lower()
    token = secrets.token_urlsafe(32)
    mock_profile(name, db)
    db.add(
        DemoSessionDB(
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            user_id=name,
            expires_at=utcnow() + timedelta(days=30),
        )
    )
    db.commit()
    return {"token": token, "client_id": name, "mocked": True}


@app.post("/wallets/register")
def register_wallet(
    wallet: WalletRegistration,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    require_user(wallet.user_id, user)
    existing_wallet = db.query(WalletDB).filter(WalletDB.user_id == user).first()
    if existing_wallet and (
        existing_wallet.safe_address != wallet.safe_address
        or existing_wallet.owner_address != wallet.owner_address
    ):
        # Lock the registration before changing it, as confirmation does.
        db.execute(
            update(WalletDB)
            .where(WalletDB.id == existing_wallet.id)
            .values(owner_address=existing_wallet.owner_address)
        )
        from app.funding.routes import FundingDB

        active = (
            db.query(FundingDB)
            .filter(
                FundingDB.user_id == user,
                FundingDB.status.in_(("queued", "submitted", "reconciling")),
            )
            .first()
        )
        if active is not None:
            db.rollback()
            raise HTTPException(409, "Finish the existing bank operation first")
        db.query(FundingDB).filter(
            FundingDB.user_id == user, FundingDB.status == "awaiting_confirmation"
        ).update(
            {
                "status": "expired",
                "active_user": None,
                "failure_reason": "wallet_registration_changed",
            }
        )
        db.query(ControlAttestationDB).filter_by(user_id=user).update({"invalidated": True})
        db.query(LinkChallengeDB).filter_by(user_id=user).update({"revoked": True})
        audit(db, user, "registration_changed")
    if existing_wallet:
        existing_wallet.safe_address = wallet.safe_address
        existing_wallet.owner_address = wallet.owner_address
        registered = existing_wallet
    else:
        registered = WalletDB(**wallet.model_dump())
        db.add(registered)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Wallet registration conflict") from None
    return wallet_response(registered)


LINK_CHALLENGE_TTL = timedelta(minutes=5)


def utcnow() -> datetime:
    # SQLite drops tzinfo, so compare naive UTC values throughout.
    return datetime.now(UTC).replace(tzinfo=None)


def timestamp(value):
    return value.strftime("%Y-%m-%dT%H:%M:%SZ") if value else None


def audit(db: Session, user: str, action: str, **details):
    db.add(
        AuditEventDB(user_id=user, action=action, created_at=utcnow(), details=json.dumps(details))
    )


def mock_profile(user: str, db: Session) -> MockUserDB:
    status = os.getenv("MOCK_KYC_STATUS", "pending")
    if status not in {"verified", "pending", "rejected"}:
        raise HTTPException(status_code=503, detail="Demo identity is not configured")
    profile = db.get(MockUserDB, user)
    if profile is None:
        profile = MockUserDB(id=user)
        db.add(profile)
    if profile.kyc_status != status:
        profile.verified_at = utcnow() if status == "verified" else None
        profile.kyc_status = status
        audit(db, user, "mock_identity_status", status=status)
    profile.display_name = os.getenv("MOCK_DISPLAY_NAME", "Swissquote demo client")
    db.commit()
    return profile


def require_kyc(user: str, db: Session):
    if mock_profile(user, db).kyc_status != "verified":
        raise HTTPException(status_code=403, detail="identity_not_verified")


@app.get("/auth/me")
def identity(user: Annotated[str, Depends(current_user)], db: Session = Depends(get_db)):
    profile = mock_profile(user, db)
    return {
        "client_id": profile.id,
        "display_name": profile.display_name,
        "kyc_status": profile.kyc_status,
        "verified_at": timestamp(profile.verified_at),
        "mocked": True,
    }


class LinkChallengeRequest(StrictRequest):
    owner_address: Address
    safe_address: Address
    chain_id: Literal[11155111]


class LinkCompleteRequest(StrictRequest):
    challenge_id: Annotated[str, StringConstraints(min_length=16, max_length=128)]
    signature: Annotated[str, StringConstraints(pattern=r"^0x[0-9a-fA-F]{130}$")]


def link_message(challenge: LinkChallengeDB) -> str:
    # Canonical text is reconstructed and checked by mobile before signing.
    return "\n".join(
        [
            "Swissquote Wallet: link this Safe to your demo bank account.",
            f"Domain: {challenge.domain}",
            "Purpose: link-safe",
            f"Account: {challenge.user_id}",
            f"Safe: {challenge.safe_address}",
            f"Owner key: {challenge.owner_address}",
            f"Chain ID: {challenge.chain_id}",
            f"Nonce: {challenge.id}",
            f"Expires: {timestamp(challenge.expires_at)}",
            "This moves no funds. Bank identity checks are simulated.",
        ]
    )


def registered_wallet(user: str, db: Session) -> WalletDB:
    wallet = db.query(WalletDB).filter_by(user_id=user).first()
    if wallet is None:
        raise HTTPException(status_code=404, detail="Wallet not registered")
    return wallet


@app.post("/wallets/link/challenge")
def create_link_challenge(
    req: LinkChallengeRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    require_kyc(user, db)
    wallet = registered_wallet(user, db)
    if (wallet.safe_address, wallet.owner_address) != (req.safe_address, req.owner_address):
        raise HTTPException(status_code=409, detail="Wallet registration changed")
    try:
        verify_control(req.safe_address, req.owner_address)
    except ControlError as e:
        raise HTTPException(
            status_code=503 if e.status == "verification_unavailable" else 409, detail=e.status
        ) from None
    domain = os.getenv("WALLET_LINK_DOMAIN", "swissquote-wallet.demo")
    if not domain or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for char in domain):
        raise HTTPException(status_code=503, detail="Link domain is not configured")
    challenge = LinkChallengeDB(
        id=secrets.token_urlsafe(24),
        user_id=user,
        owner_address=req.owner_address,
        safe_address=req.safe_address,
        chain_id=CHAIN_ID,
        domain=domain,
        expires_at=utcnow() + LINK_CHALLENGE_TTL,
        used=False,
        revoked=False,
    )
    challenge.message = link_message(challenge)
    db.add(challenge)
    audit(db, user, "link_challenge_issued", safe=req.safe_address)
    db.commit()
    return {
        "challenge_id": challenge.id,
        "message": challenge.message,
        "user_id": user,
        "owner_address": challenge.owner_address,
        "safe_address": challenge.safe_address,
        "chain_id": challenge.chain_id,
        "domain": challenge.domain,
        "expires_at": timestamp(challenge.expires_at),
    }


@app.post("/wallets/link/complete")
def complete_link(
    req: LinkCompleteRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    require_kyc(user, db)
    challenge = db.get(LinkChallengeDB, req.challenge_id)
    if challenge is None or challenge.user_id != user:
        raise HTTPException(status_code=404, detail="Unknown link challenge")
    if challenge.expires_at <= utcnow():
        raise HTTPException(status_code=410, detail="Link challenge expired")
    # Conditional write is atomic across requests/processes, including bad signatures.
    consumed = db.execute(
        update(LinkChallengeDB)
        .where(
            LinkChallengeDB.id == req.challenge_id,
            LinkChallengeDB.used.is_(False),
            LinkChallengeDB.revoked.is_(False),
            LinkChallengeDB.expires_at > utcnow(),
        )
        .values(used=True)
    )
    db.commit()
    if consumed.rowcount != 1:
        raise HTTPException(status_code=409, detail="Link challenge used or revoked")
    try:
        signer = Account.recover_message(
            encode_defunct(text=challenge.message), signature=req.signature
        )
    except Exception:
        signer = None
    if signer is None or signer.lower() != challenge.owner_address:
        audit(db, user, "link_signature_rejected")
        db.commit()
        raise HTTPException(status_code=401, detail="Signature does not match the owner key")
    try:
        evidence = verify_control(challenge.safe_address, challenge.owner_address)
    except ControlError as e:
        audit(db, user, "link_control_rejected", reason=e.status)
        db.commit()
        raise HTTPException(
            status_code=503 if e.status == "verification_unavailable" else 409, detail=e.status
        ) from None
    # Serialize with registration writes; recheck revocation after the slow RPC reads.
    locked = db.execute(
        update(WalletDB)
        .where(
            WalletDB.user_id == user,
            WalletDB.safe_address == challenge.safe_address,
            WalletDB.owner_address == challenge.owner_address,
        )
        .values(owner_address=challenge.owner_address)
    )
    db.refresh(challenge)
    if locked.rowcount != 1 or challenge.revoked or challenge.expires_at <= utcnow():
        db.rollback()
        raise HTTPException(status_code=409, detail="Wallet or challenge changed; relink required")
    linked = db.get(ControlAttestationDB, user)
    if linked is None:
        linked = ControlAttestationDB(user_id=user)
        db.add(linked)
    linked.owner_address = challenge.owner_address
    linked.safe_address = challenge.safe_address
    linked.chain_id = challenge.chain_id
    linked.challenge_id = challenge.id
    linked.signature = req.signature
    linked.linked_at = utcnow()
    linked.block_number = evidence.block_number
    linked.block_hash = evidence.block_hash
    linked.invalidated = False
    audit(db, user, "safe_control_verified", safe=linked.safe_address, block=evidence.block_number)
    db.commit()
    return {
        "success": True,
        "owner_key_verified": True,
        "ownership_verified": True,
        "identity_mocked": True,
        "security_configuration_verified": False,
        "data": {
            "user_id": user,
            "owner_address": linked.owner_address,
            "safe_address": linked.safe_address,
            "chain_id": linked.chain_id,
        },
    }


@app.get("/wallets/link/status")
def link_status(user: Annotated[str, Depends(current_user)], db: Session = Depends(get_db)):
    profile = mock_profile(user, db)
    wallet = db.query(WalletDB).filter_by(user_id=user).first()
    linked = db.get(ControlAttestationDB, user)
    state = "unlinked"
    evidence = None
    if (
        linked
        and not linked.invalidated
        and wallet
        and (
            linked.safe_address == wallet.safe_address
            and linked.owner_address == wallet.owner_address
        )
    ):
        try:
            evidence = verify_control(linked.safe_address, linked.owner_address)
            state = "verified"
        except ControlError as e:
            state = e.status
            if state != "verification_unavailable":
                linked.invalidated = True
                audit(db, user, "safe_control_invalidated", reason=state)
                db.commit()
        if state == "verified":
            # An operator/device may re-register while RPC is in flight. Do not
            # authorize against the stale ORM snapshot or a revoked attestation.
            locked = db.execute(
                update(WalletDB)
                .where(
                    WalletDB.user_id == user,
                    WalletDB.safe_address == linked.safe_address,
                    WalletDB.owner_address == linked.owner_address,
                )
                .values(owner_address=linked.owner_address)
            )
            db.refresh(linked)
            db.refresh(wallet)
            if locked.rowcount != 1 or linked.invalidated:
                state = "relink_required"
                evidence = None
            db.commit()
    elif linked:
        state = "relink_required"
    return {
        "client_id": user,
        "kyc_status": profile.kyc_status,
        "identity_mocked": True,
        "control_status": state,
        "bank_transfers_allowed": profile.kyc_status == "verified" and state == "verified",
        "safe_address": wallet.safe_address if wallet else None,
        "owner_address": wallet.owner_address if wallet else None,
        "chain_id": CHAIN_ID,
        "verified_at": timestamp(linked.linked_at) if linked else None,
        "checked_block": evidence.block_number if evidence else None,
        "security_configuration_verified": False,
    }


class BankTransferAuthorization(StrictRequest):
    safe_address: Address
    chain_id: Literal[11155111]
    direction: Literal["bank_to_wallet", "wallet_to_bank"]
    amount: Decimal = Field(gt=0, allow_inf_nan=False, max_digits=30, decimal_places=6)


def require_bank_eligibility(user: str, safe: str, db: Session):
    status = link_status(user, db)
    if status["safe_address"] != safe:
        raise HTTPException(status_code=409, detail="Safe does not match registered wallet")
    if not status["bank_transfers_allowed"]:
        raise HTTPException(
            status_code=503 if status["control_status"] == "verification_unavailable" else 403,
            detail="bank_transfer_not_eligible",
        )
    return status


@app.post("/bank/transfers/authorize")
def authorize_bank_transfer(
    req: BankTransferAuthorization,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    status = require_bank_eligibility(user, req.safe_address, db)
    decision = "review_required" if req.amount > Decimal("10000") else "approved"
    audit(
        db,
        user,
        "mock_bank_transfer_review",
        direction=req.direction,
        safe=req.safe_address,
        decision=decision,
    )
    db.commit()
    return {
        "status": decision,
        "mocked": True,
        "funds_moved": False,
        "checked_block": status["checked_block"],
        "reason": "Demo authorization preview only; AML and Travel Rule services are mocked.",
    }


@app.get("/wallets/{user_id}")
def get_wallet(
    user_id: str,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    require_user(user_id, user)
    wallet = db.query(WalletDB).filter(WalletDB.user_id == user).first()
    if not wallet:
        raise HTTPException(status_code=404, detail="Wallet not found for this user_id")
    return wallet_response(wallet)


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


class RecoveryRequest(StrictRequest):
    user_id: UserId
    safe_address: Address
    new_owner_address: Address


def require_recovery_wallet(req: RecoveryRequest, user: str, db: Session) -> None:
    require_user(req.user_id, user)
    wallet = db.query(WalletDB).filter(WalletDB.user_id == user).first()
    if not wallet:
        raise HTTPException(status_code=404, detail="Wallet not found for this user")
    if req.safe_address != wallet.safe_address.lower():
        raise HTTPException(status_code=409, detail="Safe does not match the registered wallet")
    if req.new_owner_address == wallet.owner_address.lower():
        raise HTTPException(status_code=422, detail="Recovery needs a different owner")


@app.post("/recovery/request")
def request_recovery(
    req: RecoveryRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    require_recovery_wallet(req, user, db)
    raise HTTPException(status_code=501, detail="Recovery case tracking is not implemented")


@app.post("/recovery/swissquote-approve")
def swissquote_guardian_approve(
    req: RecoveryRequest,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    require_recovery_wallet(req, user, db)
    # A demo session is not identity review or permission to rotate an owner.
    raise HTTPException(
        status_code=501, detail="Guardian policy and isolated signer are not implemented"
    )


# Import after the bank dependencies/models exist; funding adds its own table.
from app.funding.routes import router as funding_router  # noqa: E402

app.include_router(funding_router)
Base.metadata.create_all(bind=engine)

from app.recovery.routes import router as recovery_router  # noqa: E402
from app.recovery.routes import start_watcher  # noqa: E402

app.include_router(recovery_router)
Base.metadata.create_all(bind=engine)
if int(os.getenv("RECOVERY_WATCHER_SECONDS", "0") or "0") > 0:
    start_watcher(int(os.environ["RECOVERY_WATCHER_SECONDS"]))

from app.transactions.relay import router as relay_router  # noqa: E402

app.include_router(relay_router)
Base.metadata.create_all(bind=engine)

from app.dev_database import router as dev_router  # noqa: E402

app.include_router(dev_router)
