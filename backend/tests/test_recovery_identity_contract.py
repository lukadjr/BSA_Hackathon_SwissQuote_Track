from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError
from test_health import NEW_OWNER, SAFE

from app.guardian_policy.identity_review import RecoveryIdentityReview, permits_swissquote_approval


def review(**changes):
    return RecoveryIdentityReview(
        **{
            "request_id": "request-1",
            "client_id": "alice",
            "safe_address": SAFE,
            "chain_id": 11155111,
            "new_owner_address": NEW_OWNER,
            "reviewer_id": "bank-reviewer",
            "expires_at": datetime.now(UTC) + timedelta(minutes=5),
            **changes,
        }
    )


def permits(value, **changes):
    return permits_swissquote_approval(
        value,
        **{
            "request_id": "request-1",
            "client_id": "alice",
            "safe_address": SAFE,
            "new_owner_address": NEW_OWNER,
            **changes,
        },
    )


def test_session_and_email_alone_never_approve_recovery():
    assert not permits(review())
    assert not permits(review(status="approved"))
    assert permits(review(status="approved", independent_check_completed=True))


@pytest.mark.parametrize(
    "changes",
    [
        {"status": "pending"},
        {"status": "rejected"},
        {"independent_check_completed": False},
        {"expires_at": datetime.now(UTC) - timedelta(seconds=1)},
        {"expires_at": datetime.now()},
        {"safe_address": "0x" + "0" * 40},
        {"new_owner_address": "0x" + "0" * 40},
    ],
)
def test_review_fails_closed(changes):
    values = {"status": "approved", "independent_check_completed": True, **changes}
    assert not permits(review(**values))


@pytest.mark.parametrize(
    "changes",
    [
        {"request_id": "other-request"},
        {"client_id": "mallory"},
        {"safe_address": NEW_OWNER},
        {"new_owner_address": SAFE},
    ],
)
def test_approval_cannot_be_rebound(changes):
    assert not permits(review(status="approved", independent_check_completed=True), **changes)


def test_recovery_contract_rejects_wrong_chain_and_extra_fields():
    with pytest.raises(ValidationError):
        review(chain_id=1)
    with pytest.raises(ValidationError):
        review(email_access=True)
