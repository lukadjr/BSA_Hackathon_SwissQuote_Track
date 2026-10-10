"""Authenticated demo metadata API; on-chain ownership and recovery remain unimplemented."""

import os
import secrets
from decimal import Decimal
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import Column, Integer, String, create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

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


Base.metadata.create_all(bind=engine)
app = FastAPI(
    title="Swissquote Demo API",
    version="0.1.0",
    description=(
        "Mock metadata and screening. Ownership verification and recovery are unimplemented."
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
) -> str:
    # One server-provisioned demo identity. Never mint a session for a caller's user_id.
    token = os.getenv("MOCK_ACCESS_TOKEN", "")
    user_id = os.getenv("MOCK_USER_ID", "demo-user")
    if len(token) < 32 or not user_id.strip():
        raise HTTPException(status_code=503, detail="Demo authentication is not configured")
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


@app.post("/wallets/register")
def register_wallet(
    wallet: WalletRegistration,
    user: Annotated[str, Depends(current_user)],
    db: Session = Depends(get_db),
):
    require_user(wallet.user_id, user)
    existing_wallet = db.query(WalletDB).filter(WalletDB.user_id == user).first()
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
