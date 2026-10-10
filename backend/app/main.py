"""Health-only starter; business endpoints are left for the team."""

from fastapi import FastAPI, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import create_engine, Column, String, Integer
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session

# SQLite database URL for local prototype storage
SQLALCHEMY_DATABASE_URL = "sqlite:///./swissquote_mock.db"
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Database model representing registered wallets (metadata only, NO private keys!)
class WalletDB(Base):
    __tablename__ = "wallets"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, unique=True, index=True)
    safe_address = Column(String)
    owner_address = Column(String)

# Create database tables if they do not exist
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Swissquote Demo API",
    version="0.1.0",
    description="Hackathon starter. Wallet and recovery endpoints are not implemented.",
)

# Dependency to get a database session for each request
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    service: str

# Simple health check endpoint
@app.get("/health", response_model=HealthResponse, tags=["health"])
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="swissquote-demo")

# Pydantic model for validating incoming wallet registration data
class WalletRegistration(BaseModel):
    user_id: str
    safe_address: str
    owner_address: str


# Endpoint to register or update a client's wallet public addresses
@app.post("/wallets/register")
def register_wallet(wallet: WalletRegistration, db: Session = Depends(get_db)):
    # Check if the user already exists in the database
    existing_wallet = db.query(WalletDB).filter(WalletDB.user_id == wallet.user_id).first()

    if existing_wallet:
        # Update addresses if they have changed
        existing_wallet.safe_address = wallet.safe_address
        existing_wallet.owner_address = wallet.owner_address
    else:
        # Create a new record for a new user
        db_wallet = WalletDB(
            user_id=wallet.user_id,
            safe_address=wallet.safe_address,
            owner_address=wallet.owner_address
        )
        db.add(db_wallet)

    # Commit changes to the SQLite database
    db.commit()

    return {
        "success": True,
        "message": "Wallet successfully registered and stored in the database!",
        "data": {
            "user_id": wallet.user_id,
            "safe_address": wallet.safe_address,
            "owner_address": wallet.owner_address
        }
    }


# Endpoint to retrieve wallet information by user_id
@app.get("/wallets/{user_id}")
def get_wallet(user_id: str, db: Session = Depends(get_db)):
    # Search for the user in the database
    wallet = db.query(WalletDB).filter(WalletDB.user_id == user_id).first()

    # If the user does not exist, return a 404 HTTP error
    if not wallet:
        raise HTTPException(status_code=404, model_not_found=True, detail="Wallet not found for this user_id")

    return {
        "success": True,
        "data": {
            "user_id": wallet.user_id,
            "safe_address": wallet.safe_address,
            "owner_address": wallet.owner_address
        }
    }


class TransactionScreenRequest(BaseModel):
    recipient_address: str
    amount: float

@app.post("/transactions/screen")
def screen_transaction(tx: TransactionScreenRequest):
    # Simulation de liste noire / sanctions ou dApps non approuvées
    blacklisted_addresses = ["0xBadAddress000000000000000000000000000000"]

    if tx.recipient_address in blacklisted_addresses:
        return {
            "status": "blocked",
            "reason": "Address is blacklisted by compliance screening (Sanctions check)."
        }

    if tx.amount > 10000:
        return {
            "status": "review_required",
            "reason": "High-value transaction requires additional Swissquote check."
        }

    return {
        "status": "approved",
        "reason": "Transaction passed all compliance checks."
    }



# GUARDIAN A (SWISSQUOTE) recovery request

class RecoveryRequest(BaseModel):
    user_id: str
    safe_address: str
    new_owner_address: str

# Endpoint where the client or app requests a recovery assistance from Swissquote guardian
@app.post("/recovery/request")
def request_recovery(req: RecoveryRequest, db: Session = Depends(get_db)):
    # 1. Check if the user/wallet exists in our backend registry
    wallet = db.query(WalletDB).filter(WalletDB.user_id == req.user_id).first()
    if not wallet:
        raise HTTPException(status_code=404, detail="Wallet not found for this user")

    # 2. Simulate security checks, identity verification (KYC check mock)
    # In a real scenario, this triggers a verification flow.

    return {
        "success": True,
        "status": "pending_guardian_approval",
        "message": "Recovery request registered. Awaiting Swissquote guardian validation.",
        "data": {
            "safe_address": req.safe_address,
            "new_owner_address": req.new_owner_address
        }
    }

# Endpoint representing the Swissquote Guardian signature / approval
@app.post("/recovery/swissquote-approve")
def swissquote_guardian_approve(req: RecoveryRequest):
    # The Swissquote backend mock signs or approves the recovery payload
    # so it can be combined with Guardian A or B to reach the 2/3 threshold[span_1](start_span)[span_1](end_span).

    # For the hackathon prototype, we simulate a cryptographic signature or approval token
    mock_guardian_signature = "0xMockSwissquoteGuardianSignatureForRecovery123456789"

    return {
        "success": True,
        "guardian": "Swissquote",
        "approved": True,
        "signature": mock_guardian_signature,
        "message": "Swissquote guardian has successfully approved the recovery request."
    }
