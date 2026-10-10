"""Integration contract for recovery. Only trusted bank-side code may supply a review.

This module creates no reviews or guardian signatures. In particular, a client
session, verified onboarding identity, phone or email is never an approval.
"""

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RecoveryIdentityReview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(min_length=1, max_length=128)
    client_id: str = Field(min_length=1, max_length=128)
    safe_address: str = Field(pattern=r"^0x[0-9a-fA-F]{40}$")
    chain_id: Literal[11155111]
    new_owner_address: str = Field(pattern=r"^0x[0-9a-fA-F]{40}$")
    status: Literal["pending", "approved", "rejected"] = "pending"
    reviewer_id: str = Field(min_length=1, max_length=128)
    independent_check_completed: bool = False
    expires_at: datetime
    mocked: Literal[True] = True


def permits_swissquote_approval(
    review: RecoveryIdentityReview,
    *,
    request_id: str,
    client_id: str,
    safe_address: str,
    new_owner_address: str,
    now: datetime | None = None,
) -> bool:
    """Called with a server-stored review, never a review supplied by mobile.

    The recovery coordinator must also check the current on-chain request/nonce,
    guardian policy and consumed-review state before asking its isolated signer.
    """
    return (
        review.status == "approved"
        and review.independent_check_completed
        and review.request_id == request_id
        and review.client_id == client_id
        and review.safe_address.lower() == safe_address.lower()
        and review.new_owner_address.lower() == new_owner_address.lower()
        and int(review.safe_address, 16) != 0
        and int(review.new_owner_address, 16) != 0
        and review.expires_at.tzinfo is not None
        and review.expires_at > (now or datetime.now(UTC))
    )
