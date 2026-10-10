# Swissquote demo backend

FastAPI + SQLAlchemy/SQLite for authenticated prototype metadata. The mobile app
currently signs locally and does not call this API. Registration records public
addresses only and returns `ownership_verified: false`: it is not an on-chain
proof of control or KYC attestation.

## Run

From the repository root:

```bash
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements-dev.txt
export MOCK_USER_ID=demo-user
export MOCK_ACCESS_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
python -m uvicorn app.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

`backend/.env.example` documents settings; the file is not loaded automatically.
`DATABASE_URL` defaults to `sqlite:///./swissquote_mock.db`, relative to the server's
working directory. The token must contain at least 32 characters. Without a
configured token, business endpoints return `503`; `/health` remains available.

This is one server-provisioned demo identity, not production banking login. Supply
`Authorization: Bearer <MOCK_ACCESS_TOKEN>` to business endpoints. Keep the token
out of Git, logs and public Expo configuration. A request cannot select another
identity by changing `user_id`; those requests return `403`.

## Routes

| Route | Behavior |
| --- | --- |
| `GET /health` | Public health check |
| `POST /wallets/register` | Register/update the authenticated demo user's unverified metadata |
| `GET /wallets/{user_id}` | Read that user's metadata; missing registration returns `404` |
| `POST /transactions/screen` | Mock policy only: blocked test address, high-value review or approved |
| `POST /recovery/request` | Validate user and registered Safe, then return `501` |
| `POST /recovery/swissquote-approve` | Validate user and registered Safe, then return `501`; never emit a fake signature |

Requests reject unknown fields (including private keys), malformed/zero addresses,
and nonpositive/nonfinite amounts. Amounts use Decimal with six decimal places for
the test USDC policy; values above 10,000 require mock review. The test blocklist
contains `0x000000000000000000000000000000000000dead` and matches case-insensitively.

Recovery tracking, strengthened identity review, an isolated guardian signer,
nonce/chain binding and on-chain verification remain separate implementation work.
The API never claims a recovery was submitted or approved. The intended on-chain
policy is any two guardians SQ/A/B, including A+B without this backend.

## Checks

```bash
python -m pytest backend
python -m ruff check backend
python -m ruff format --check backend
```

Tests use an isolated in-memory database and cover authentication, cross-user
access, validation, registration, mock screening and recovery failing closed.
