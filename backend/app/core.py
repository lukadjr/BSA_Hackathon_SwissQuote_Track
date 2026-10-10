"""Shared recovery dependencies; a single bank database/auth implementation."""

from app.main import (
    Address,
    Base,
    SessionLocal,
    StrictRequest,
    WalletDB,
    current_user,
    get_db,
    utcnow,
)


def find_wallet(db, user):
    return db.query(WalletDB).filter_by(user_id=user).first()


__all__ = [
    "Address",
    "Base",
    "SessionLocal",
    "StrictRequest",
    "WalletDB",
    "current_user",
    "get_db",
    "utcnow",
    "find_wallet",
]
