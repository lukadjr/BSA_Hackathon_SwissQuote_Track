# Swissquote Self-Custody Wallet — Backend Service

> **BSA Hackathon — Swissquote Wallet Challenge**  
> **Component:** Backend API (Python / FastAPI)  
> **Status:** Prototype Implementation  

---

## Overview

This backend service acts as the simulated institutional core for Swissquote in the self-custody wallet prototype. It provides metadata tracking, identity-to-wallet linkage, and governance/guardian approval workflows for the Safe Smart Accounts. 

*Note: The backend **never** handles, stores, or transmits user private keys. All cryptographic signing happens locally on the user's mobile device.*

---

## Tech Stack

- **Language:** Python 3.11+
- **Framework:** FastAPI
- **Data Validation:** Pydantic
- **Database:** SQLite (local prototype storage via SQLAlchemy)
- **Server:** Uvicorn

---

## Implemented Features (Current Progress)

1. **Health Check (`GET /health`)**
   - Verifies the service status and ensures the API is running smoothly.
2. **Wallet Registration (`POST /wallets/register`)**
   - Receives and stores public metadata from the mobile application when a user creates or connects their wallet.
   - Links a unique `user_id` to their `safe_address` (on-chain Safe smart account) and `owner_address` (client EOA signing key).
3. **Wallet Retrieval (`GET /wallets/{user_id}`)**
   - Fetches registered public wallet addresses for a given user.
4. **Recovery Request (`POST /recovery/request`)**
   - Registers a social recovery request when a user loses access to their device/key and requests institutional assistance.
5. **Swissquote Guardian Approval (`POST /recovery/swissquote-approve`)**
   - Simulates the institutional guardian's digital approval/signature required to reach the 2/3 threshold for account recovery.

---

## Project Structure

```text
backend/
├── app/
│   ├── __init__.py
│   └── main.py          # FastAPI application, database models, and routes
├── venv/                # Python virtual environment
└── requirements.txt     # Python dependencies
