# Swissquote demo backend

FastAPI + SQLAlchemy/SQLite for authenticated prototype metadata.

## Wallet linking

Onboarding order on the phone: (1) create the owner key, (2) derive the Safe
address from it (counterfactual: nothing is deployed), (3) link both with
Swissquote. For step 3 the app asks for a challenge naming the owner key and the
Safe, the user reads and confirms it, the phone signs it locally (EIP-191) and the
backend checks the signature.

The `wallets` table holds one row per user: the owner key, the Safe and the time
the owner key proved control. A row exists only after a successful link, so
`ownership_verified` is always `true` when a wallet is returned. Because the owner
key signed the Safe address, the backend knows the key holder claims that Safe; it
does not check on-chain that the Safe is owned by that key.

Existing demo databases from before this schema need to be deleted or moved: the
backend refuses to start on the old schema and says so.

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
| `POST /wallets/link/challenge` | Issue a single-use, 5-minute challenge message for `owner_address` and `safe_address` |
| `POST /wallets/link/complete` | Check the challenge's EIP-191 signature, then store the owner key and Safe in `wallets` |
| `POST /wallets/register` | Change the Safe of a wallet whose owner key is already linked; `409` before linking or for another owner key |
| `GET /wallets/{user_id}` | Read that user's linked wallet; before linking it returns `404` |
| `POST /transactions/screen` | Mock policy only: blocked test address, high-value review or approved |
| `POST /recovery/request` | Validate user and registered Safe, then return `501` |
| `POST /recovery/swissquote-approve` | Validate user and registered Safe, then return `501`; never emit a fake signature |

Requests reject unknown fields (including private keys), malformed/zero addresses,
and nonpositive/nonfinite amounts. Amounts use Decimal with six decimal places for
the test USDC policy; values above 10,000 require mock review. The test blocklist
contains `0x000000000000000000000000000000000000dead` and matches case-insensitively.

Linking proves control of the owner key only (`owner_key_verified: true`); it is
not KYC or proof of on-chain Safe ownership. A challenge is burned after one attempt.
Linking again replaces the user's single wallet row.
For the phone, set the app's `EXPO_PUBLIC_DEMO_ACCESS_TOKEN` to this disposable
demo token; anything in an Expo build is readable, so never reuse a real secret.

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
