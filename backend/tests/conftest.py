import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import main
from app.main import Base, app, get_db


@pytest.fixture(autouse=True)
def product_recovery_policy(monkeypatch):
    # backend/.env may enable the 3-minute demo module locally; tests assume the product policy.
    monkeypatch.setenv("RECOVERY_ALLOW_DEMO", "false")


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("MOCK_ACCESS_TOKEN", "test-only-demo-token-" + "x" * 32)
    monkeypatch.setenv("MOCK_USER_ID", "alice")
    monkeypatch.setenv("MOCK_KYC_STATUS", "verified")
    from app.wallet_registry.control import ControlEvidence

    monkeypatch.setattr(
        main,
        "verify_control",
        lambda safe, owner: ControlEvidence(123, "0x" + "a" * 64, owner.lower()),
    )
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)

    def override_db():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
