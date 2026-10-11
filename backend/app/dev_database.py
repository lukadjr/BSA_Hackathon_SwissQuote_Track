"""Explicitly enabled local-demo reset; never removes the treasury journal."""

import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import main as bank

router = APIRouter(tags=["development"])


class ResetRequest(bank.StrictRequest):
    confirmation: Literal["RESET DATABASE"]


@router.post("/dev/reset-database")
def reset_database(
    req: ResetRequest,
    user: Annotated[str, Depends(bank.current_user)],
    db: Session = Depends(bank.get_db),
):
    if os.getenv("ENABLE_DEV_DATABASE_RESET", "false").lower() != "true":
        raise HTTPException(404, "Development database reset is disabled")
    # Serialize with confirmation/worker DB writes. Queued transactions must finish.
    db.execute(text("BEGIN IMMEDIATE"))
    for table in ("funding_intents", "treasury_relay_requests"):
        pending = db.execute(
            text(
                f"SELECT COUNT(*) FROM {table} WHERE status IN ('queued','submitted','reconciling')"
            )
        ).scalar()
        if pending:
            db.rollback()
            raise HTTPException(
                409, "Wait for queued or submitted transactions before resetting the database"
            )
    database = db.get_bind().url.database
    backup_name = None
    if database and database != ":memory:":
        folder = Path(database).resolve().parent / "backups"
        folder.mkdir(parents=True, exist_ok=True)
        backup = folder / (
            "before-dev-reset-" + datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ") + ".sqlite"
        )
        source = sqlite3.connect(database)
        target = sqlite3.connect(backup)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        os.chmod(backup, 0o600)
        backup_name = backup.name
    removed = {}
    for table in reversed(bank.Base.metadata.sorted_tables):
        removed[table.name] = db.execute(table.delete()).rowcount
    # The old prototype table is not in current metadata; remove its requests too.
    legacy = db.execute(
        text("SELECT name FROM sqlite_master WHERE name='link_challenges'")
    ).scalar()
    if legacy:
        removed[legacy] = db.execute(text("DELETE FROM link_challenges")).rowcount
    db.commit()
    return {
        "reset": True,
        "removed": removed,
        "backup": backup_name,
        "phone_keys_preserved": True,
        "on_chain_state_preserved": True,
    }
