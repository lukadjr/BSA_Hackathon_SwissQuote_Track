"""Shared database, authentication and validation for the demo API."""

import os
import secrets
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints
from sqlalchemy import Boolean, Column, DateTime, Integer, String, create_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./swissquote_mock.db")
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class WalletDB(Base):
    """One row per user: the owner key proven by signature, and the user's Safe."""

    __tablename__ = "wallets"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, unique=True, index=True)
    owner_address = Column(String, nullable=False)
    safe_address = Column(String, nullable=False)
    # Set when the owner key signed a link challenge for this owner and Safe.
    owner_verified_at = Column(DateTime, nullable=False)


class LinkChallengeDB(Base):
    __tablename__ = "link_challenges"
    id = Column(String, primary_key=True)
    user_id = Column(String, index=True)
    owner_address = Column(String)
    safe_address = Column(String)
    message = Column(String)
    expires_at = Column(DateTime)
    used = Column(Boolean, default=False)


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


def utcnow() -> datetime:
    # SQLite drops tzinfo, so compare naive UTC values throughout.
    return datetime.now(UTC).replace(tzinfo=None)


def find_wallet(db: Session, user: str) -> "WalletDB | None":
    return db.query(WalletDB).filter(WalletDB.user_id == user).first()
