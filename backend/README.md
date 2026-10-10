# Swissquote demo backend

FastAPI + SQLite. **Bank identity/KYC, AML, Travel Rule providers are mocked. The demo treasury submits real Sepolia transactions once funded;
the Swissquote account is simulated and manually funded through faucets.** All online fees are paid by this one treasury, including owner-authorized Safe calls and recovery. Funded Sepolia acceptance testing is still pending. Safe-control verification uses real EIP-191 signatures
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

`backend/.env.example` documents settings. `backend/.env` is loaded automatically
from the backend directory, regardless of cwd; shell settings take precedence.
The web API excludes the treasury private key when loading this file. The
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
| `GET /bank/account` | Actual treasury balance, conservative available balance and explicit single-client demo labels |
| `GET /bank/funding/intents` | Last ten authenticated client requests; supports restart/resume |
| `POST /bank/funding/intents` | Create a signed-consent instruction for `deploy` or `deposit`; client-scoped idempotency |
| `POST /bank/funding/intents/{intent_id}/confirm` | Verify client signature and queue once; the API never signs treasury transactions |
| `GET /bank/funding/intents/{intent_id}` | Receipt/status for that client only |
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
reads. It checks Sepolia, the official pinned Safe 1.4.1 proxy runtime artifact,
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

## Treasury relay and recovery integration

`app/core.py` reexports the existing bank auth/database dependencies so recovery,
wallet linking and funding share one database and identity. The owner key stays
on the phone. `POST /transactions/relay` accepts a standard EIP-712 Safe transaction
and its current-owner signature; `GET /transactions/{id}` returns durable status.
The worker executes `Safe.execTransaction` with all reimbursement fields zero.
It verifies the Safe signature/nonce, exact token/security call policy, simulation,
canonical receipt, matching indexed execution hash, payment=0 and required events.

The SAME `app.funding.worker` handles deployments, deposits, transfers, protection,
cancellation, guardian changes and `/recovery/requests/{id}/submit|finalize` jobs.
Recovery start/finalize endpoints queue and return operation IDs, not immediate
confirmation. Poll `/transactions/{id}` and recheck on-chain recovery state. Normal
funding requires the 3-day Candide module with three guardians/threshold two;
`RECOVERY_ALLOW_DEMO=true` selects the separate 3-minute module for explicit tests.
Do not use the unprotected funding bypass for the normal demo.

The guardian key is separate and unfunded; initialize it with
`PYTHONPATH=backend python -m app.guardian_policy.signer init`. There is no separate
recovery relayer private key. Owner-signed cancellation does not require bank KYC
or an existing bank attestation. Recovery uses the ORIGINAL Safe after rotation;
mobile persists that binding and obtains a new bank-control proof for deposits.

`/recovery/request` and `/recovery/swissquote-approve` remain legacy 501 routes;
the real flow uses `/recovery/requests/...`. The Swissquote guardian approval is
explicitly mocked (registered customer/session + confirmation). The independent
`RecoveryIdentityReview` contract remains a future production requirement, not a
claim that strong recovery identity verification has been implemented.

See [Xcode/phone acceptance](../docs/xcode-phone-test-handoff.md) and
[implementation/limits](../docs/gasless-implementation-plan.md).

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

## Add money: persistent demo treasury

From the feature checkout root, create the bank wallet **once**:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m app.funding.setup
```

The command prints only the public address. It writes a mode-0600, gitignored
`backend/.env`, preserves existing settings and reuses an existing valid key.
An existing address with a missing/mismatched key is refused instead of replaced.
Back up this file privately; neither `.env` nor the worker journal belongs in Git.
Funds live on-chain, and the private key is needed to spend them.

Manually send **Ethereum Sepolia ETH** and **Sepolia test USDC** to that printed
address using [an ETH faucet](https://ethereum.org/developers/docs/networks/) and
[Circle's test-token faucet](https://faucet.circle.com/). Match Ethereum Sepolia,
not Base Sepolia or mainnet. There is no automatic faucet or fabricated balance.
The configured six-decimal token must match the mobile token configuration.

For a demo identity, explicitly set `MOCK_KYC_STATUS=verified` in local `.env`.
Copy its disposable `MOCK_ACCESS_TOKEN` into the mobile's local
`EXPO_PUBLIC_DEMO_ACCESS_TOKEN`, and configure the API URL. Do not print the
server file to share the token: it also contains the treasury key.

Run these in **two terminals**, both from the feature root:

```bash
# API: reads public treasury configuration, never loads/signs with its private key
backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

```bash
# Worker: separate process, server-only treasury key and private transaction journal
PYTHONPATH=backend backend/.venv/bin/python -m app.funding.worker
```

`--once` runs one reconciliation pass. The worker's file lock prevents two workers
using the same journal. All workers must use the **same absolute journal and bank
DB paths**. Setup generates absolute paths automatically. The key is separate
from client and guardian keys; the treasury is refused as a client owner.

On the phone: **Add money → review wallet setup → authenticate/confirm → wait for
deployment → verify bank connection → enter amount → review → authenticate/confirm
→ confirmed receipt**. The setup transaction uses the exact same pinned SDK
initializer/address as the app and grants no bank ownership. The client signs
consent; the treasury signs the bank's deployment/withdrawal transaction.
The treasury pays those fees. No ETH top-up of the client's Safe is part of this
feature; outgoing ERC-4337 paymaster sponsorship is separate work.

Normal deposits require the linked current Safe owner and an enabled Candide
`After7Days` module with three distinct guardians and threshold two. Until recovery
is implemented, an operator can **explicitly** set
`FUNDING_ALLOW_UNPROTECTED_DEMO=true` for disposable test-token funding tests.
Both signed consent and UI disclose this exception; it is not recovery protection.
Keep the setting false for the complete track demo. Bank funding must not replace
an existing Safe with an address derived from a recovered owner. The recovery
workstream still needs to persist that Safe and accommodate the new module in the
mobile's currently strict module validator.

Funding instructions expire after five minutes and bind client, domain, action,
Safe, owner, chain, treasury, token, exact base-unit amount and security mode.
There is one active operation per client. Positive amounts have at most six decimal
places and a 10,000-token limit; higher amounts require simulated review and are
refused. Account balances are the single demo client's entire treasury balance,
not a production multi-client bank ledger or fiat account. Pending withdrawals
are conservatively reserved; a mined pending withdrawal can temporarily be counted
both in the chain balance decrease and the reservation until reconciliation.

Only a canonical receipt with two confirmations and exactly matching token,
sender, recipient and amount produces success. Worker storage commits the signed
transaction before publishing/broadcasting its hash. Timeouts rebroadcast identical
bytes; restarts/repeated confirmation cannot produce another payment. A definitively
reverted transaction fails. Unknown/mismatched receipts remain pending for review.
**Never delete pending request or journal data to force a retry.** A missing journal
for an already submitted request is quarantined, never signed again. The worker
serializes transactions; a stuck request intentionally prevents further dispatch.
A key/configuration change or owner rotation before signing blocks dispatch.
A transaction already signed/broadcast cannot be cancelled by subsequent recovery.

Two confirmations are a testnet policy, not a promise of irreversible finality.
Real bank infrastructure, KYC/AML/sanctions/Travel Rule providers and
ERC-4337 paymaster sponsorship remain outside this mocked treasury relay.

## Optional real local-EVM acceptance

The ordinary pytest/Vitest suites use explicitly mocked chain responses and real
library signatures. An additional opt-in test deploys the pinned Safe contracts,
links the owner through the real verifier, sends an OpenZeppelin ERC-20 with six
decimals, checks actual balance deltas and replay/restart behavior. It uses a local
chain with Sepolia's chain ID; it is **not** a positive Sepolia funding claim.

Install test tools in a temporary directory (not application dependencies):

```bash
npm install --prefix /tmp/swissquote-funding-evm --no-audit --no-fund ganache@7.9.2 solc@0.8.30 @openzeppelin/contracts@5.4.0
node scripts/funding-evm-fixture.cjs
```

The fixture copies public bytecode for the pinned Safe dependencies from Sepolia
and creates ephemeral funded keys in a mode-0600 file under `/tmp`. It never prints
those keys. In another terminal:

```bash
FUNDING_EVM_FIXTURE=/tmp/swissquote-funding-evm/fixture.json backend/.venv/bin/python -m pytest backend/tests -q
```

Each run creates a new owner/Safe; restart the fixture if its test-token supply runs
low. Stop the fixture after testing. Real funded Sepolia acceptance and native
biometric/background/navigation tests remain separate device/network gates.
