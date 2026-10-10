# Swissquote demo backend

FastAPI + SQLite. **Bank identity/KYC, AML, Travel Rule providers and bank-transfer
execution are mocked.** Safe-control verification uses real EIP-191 signatures
and read-only Sepolia RPC calls. No client private key is accepted or stored.

## Run

From the repository root (Python 3.11+):

```bash
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements-dev.txt
export MOCK_USER_ID=demo-user
export MOCK_DISPLAY_NAME="Swissquote demo client"
export MOCK_KYC_STATUS=verified
export MOCK_ACCESS_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
python -m uvicorn app.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

`backend/.env.example` documents settings; it is not loaded automatically. The
SQLite URL defaults to `sqlite:///./swissquote_mock.db`, relative to the working
directory. The token must contain at least 32 characters. Unconfigured auth returns
`503`; `/health` remains public. Set `MOCK_KYC_STATUS=pending` or `rejected` and
restart the server to demonstrate refusal. Missing KYC configuration defaults to
pending; invalid configuration fails closed. Only the server operator controls it.
The demo verification timestamp is when the configured status was recorded, not a
claim that a real identity review occurred.

This is one server-provisioned demo identity, not production banking login. Use
`Authorization: Bearer <MOCK_ACCESS_TOKEN>`. Keep the token out of Git and logs.
Mobile uses the same **disposable** credential through
`EXPO_PUBLIC_DEMO_ACCESS_TOKEN`; Expo public values are readable in the build.
Never reuse a production credential. There is no public KYC-approval endpoint.

## Routes

| Route | Behavior |
| --- | --- |
| `GET /health` | Public health check |
| `GET /auth/me` | Server-provisioned demo identity and KYC status, `mocked: true` |
| `POST /wallets/register` | Register public Safe/owner metadata; does not itself verify control |
| `GET /wallets/{user_id}` | Read the authenticated user's registration |
| `POST /wallets/link/challenge` | Verified demo identity + deployed supported Safe required; issue a 5-minute challenge |
| `POST /wallets/link/complete` | Atomically consume challenge, verify signature and recheck on-chain control; record evidence |
| `GET /wallets/link/status` | Recheck ownership against the attestation; report bank eligibility |
| `POST /bank/transfers/authorize` | Recheck eligibility and return a **mock authorization preview**; moves no funds |
| `POST /transactions/screen` | Mock destination/high-value policy for client transfers |
| `POST /recovery/request` | Existing recovery stub, `501` |
| `POST /recovery/swissquote-approve` | Existing guardian-policy/signer stub, `501` |

A challenge request contains `owner_address`, `safe_address`, and
`chain_id: 11155111`; a matching registration must exist. The canonical signed
message binds the service domain, purpose `link-safe`, authenticated client,
Safe, owner, chain, unique nonce and expiry. Mobile reconstructs the exact text
before signing; it requests a fresh protected-key read through the existing
biometric signing path. Completion accepts only challenge ID and signature.
Challenges cannot be replayed, including concurrent requests and failed signature
attempts. A registration change revokes all old challenges and attestations.

The verifier uses a **server-configured RPC** and one block number for all state
reads. It checks Sepolia, the proxy runtime returned by the pinned Safe factory,
pinned Safe singleton, version 1.4.1, one matching owner, threshold 1 and enabled
Safe4337Module 0.3.0. It records the checked block number/hash, signature, challenge
and timestamp. It does **not** certify guardians, timelocks, arbitrary enabled
modules, legal exclusive ownership or universal Travel Rule compliance:
`security_configuration_verified: false` is explicit. Recovery configuration
verification stays with the blockchain/recovery implementation.

An undeployed predicted address is `pending_deployment`; RPC failures are
`verification_unavailable`, never verified. Missing attestation is `unlinked`.
Owner mismatch invalidates the proof persistently and requires relinking. An RPC
outage blocks bank authorization temporarily without destroying the existing
proof. A status check is a point-in-time observation; it is not an on-chain
spending restriction or a production bank settlement guarantee.

`/bank/transfers/authorize` accepts `safe_address`, `chain_id`, `direction`
(`bank_to_wallet` or `wallet_to_bank`) and a positive decimal `amount` with at most
six decimal places. It returns `approved` up to 10,000 or `review_required` above
10,000, with `mocked: true` and `funds_moved: false`. It issues no reusable payment
token and executes no transfer. P2P signing remains independently client-controlled.

## Recovery integration

`app/guardian_policy/identity_review.py` defines the server-side
`RecoveryIdentityReview` and `permits_swissquote_approval` contract. A trusted,
stored review must bind request ID, client, Safe, Sepolia and proposed new owner,
and have an unexpired approval after an independent identity check. A verified
onboarding profile, email or phone/session alone is insufficient. Mobile must
never submit an approval object. This contract is **not wired to the recovery
stubs** and performs no KYC checks or signatures by itself.

The recovery coordinator must authenticate its review operator/provider, store
and consume decisions, bind the current on-chain recovery nonce, apply guardian
policy and use its separate signer. A+B recovery must work without the bank.
After rotation, register the **same recovered Safe**, challenge/sign with its new
owner and relink; do not replace it with an address predicted from the new key.
The mobile Safe resolver currently derives addresses from the owner, so the
recovery implementation must supply/persist the recovered Safe binding.

## Storage compatibility and checks

New `mock_users`, `safe_link_challenges_v2`, `safe_control_attestations` and
`kyc_audit_events` tables are created automatically alongside existing metadata.
Old owner-only link tables/phone flags confer no bank eligibility. Existing
wallet metadata is retained; no database deletion is required.

```bash
python -m pytest backend
python -m ruff check backend
python -m ruff format --check backend
```

Tests include real cross-language viem→eth-account signatures, atomic concurrent
endpoint completion, expiry/replay, cross-client access, registration races,
owner rotation, identity downgrade and transport/ABI failures. The HTTP RPC fixture
is an **explicitly mocked chain**, not evidence of a positive live Sepolia link.
See [iPhone handoff](../docs/kyc-iphone-handoff.md) for native acceptance checks.
