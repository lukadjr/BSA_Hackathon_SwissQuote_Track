# Gasless funding, transfers and recovery: treasury relay

Status: implemented locally, 10 October 2026. The owner-signed treasury relay,
shared worker, mobile integration and recovery are implemented. Local-EVM
acceptance passed; funded Sepolia and physical iPhone acceptance remain pending.

## Decisions confirmed by the user

- Recovery uses **three days**, matching the fetched recovery code. Keep a
  separate, explicitly labelled three-minute module for accelerated demos.
- One mocked Swissquote treasury funds deposits and pays every network fee in
  the normal online flow. One worker owns its signing key, nonce and journal.
- Client spending keys stay on phones. The treasury receives no client Safe
  owner role or unrestricted execution permission.
- Use owner-signed ordinary Safe transactions relayed through `execTransaction`.
  No paymaster, sponsorship provider or ERC-4337 bundler is required for this path.
  Keep the existing Safe deployment parameters and address unchanged.

This replaces the previous paymaster plan. The demo proves gasless treasury-paid
Safe relaying; it does not prove ERC-4337 paymaster sponsorship. The existing
ERC-4337 execution path can remain as a separate route.

## Reviewed code and merge state

- Starting commit: `5641bd4` on `feature/kyc-wallet-link` (mock KYC and signed
  Safe-control linking with live owner checks and bank-link invalidation).
- Merged `feature/add-wallet-funds` through `20f0b3a`, including `02d0496`:
  treasury deployment/deposits, signed funding consent, durable worker and UI.
  The last commit fixes pinned Safe proxy verification and validates funding.
- Reviewed recovery `0cfcb9a` on fetched `origin/main`, and preceding owner/Safe
  linking `d07e75d`. Recovery is integrated in this checkout; no main-branch pull was performed.

## Sponsorship and the simpler alternative

Sponsorship means someone other than the user pays a fee. In ERC-4337 a paymaster
can cover the UserOperation's EntryPoint gas accounting. Paying only the bundler's
outer transaction does not remove sender prefund. The current UserOperation
builders require Safe ETH and reject paymaster fields.

A Safe also supports ordinary transactions: its owner signs the exact Safe
transaction off-chain, and the treasury submits `execTransaction` as a regular
Ethereum transaction. The treasury pays the network fee; Safe verifies the
owner's signature before executing the call.

Set the INNER Safe transaction `gasPrice = 0` so the Safe reimburses nobody.
The OUTER treasury transaction still pays normal gas. This allows zero ETH in
both client owner and client Safe, without a paymaster or user token gas charge.

| Action                                           | Authorization                                   | Submission and fee payer            |
| ------------------------------------------------ | ----------------------------------------------- | ----------------------------------- |
| Deploy Safe                                      | Existing signed setup consent                   | Treasury calls pinned factory       |
| Add USDC                                         | Existing signed funding consent and bank checks | Treasury transfers its USDC         |
| Send client USDC                                 | Current owner signs exact Safe transaction      | Treasury calls Safe execTransaction |
| Protect / cancel / invalidate / replace guardian | Current owner signs exact Safe transaction      | Treasury calls Safe execTransaction |
| Guardian approval                                | Guardian EIP-712 signature                      | Off-chain; no fee                   |
| Start / finalize recovery                        | Contract verifies guardians, state and deadline | Treasury calls recovery module      |

## 1. Integrate recovery and align the three-day policy

Reconcile recovery's `core.py` and this branch's `main.py` into one database Base,
WalletDB, session factory and authentication implementation. Preserve stronger
KYC/control verification and funding's signed consent/journal. Load environment
before database creation; migrate records as needed rather than resetting them.
Resolve shared mobile routes, dashboard, onboarding, API helpers and tests.

Change funding's seven-day module requirement in `backend/app/funding/chain.py`
to the fetched recovery's pinned three-day module
`0x38275826E1933303E508433dD5f289315Da2541c`. Verify deployed code/period and align
consent labels, UI, tests and documentation. Keep three distinct guardians and
threshold two. Allow the three-minute module only in explicit disposable demo
mode, with real protection checks; do not use the unprotected funding bypass.

Preserve recovery's public `{safe, owner}` binding. After rotation, all reads,
transfers, funding intents and confirmations use the ORIGINAL Safe, never a Safe
predicted from the replacement key. Invalidate the old bank attestation and
obtain a fresh owner proof before subsequent bank deposits.

Gate: funding accepts a genuinely protected three-day Safe; recovery/KYC coexist;
a recovered owner re-links the unchanged Safe.

## 2. Build and sign ordinary Safe transactions on the phone

Add `packages/wallet-core/transactions/safeTransaction.ts`. Reuse transfer encoding,
account verification, recovery call builders and SecureStore protections. Replace
UserOperation construction on the treasury route with standard Safe EIP-712
transaction construction, using a supported Safe SDK or viem with the verified
Safe schema. Read `Safe.nonce()`, not the EntryPoint nonce; compare the local hash
with on-chain `getTransactionHash`. Do not reuse `signUserOperation` signatures.

Use zero reimbursement fields (`gasPrice`, `baseGas`, `gasToken`, `refundReceiver`)
and simulate the chosen execution gas configuration. Supported calls send zero
native value. Protect and guardian replacement use an exact batch through pinned
Safe MultiSendCallOnly: allow that expected outer delegatecall and validate every
inner call; refuse arbitrary delegatecalls and unexpected batches.

1. Read chain, current owner, Safe nonce and security state; build exact calls.
2. Show decoded recipient/amount/security changes and the treasury-covered fee.
3. Recheck state and app activity; unlock through SecureStore biometrics.
4. Sign the FINAL Safe transaction locally and submit its public payload/signature.
5. Persist expected Safe hash and pending tracking; reconcile on-chain execution.

Ordinary Safe signatures have no built-in expiry timestamp. API expiry is relay
policy, not cryptographic revocation. A signed transaction remains usable while
its nonce/owner authorization is valid. Do not claim that UI cancellation or queue
expiry revokes it; resolving an outstanding signed transaction may require
consuming that Safe nonce.

Gate: a zero-ETH Safe executes a signed transfer and cancellation, with no
Safe reimbursement and no EntryPoint prefund.

## 3. Generalize the treasury worker into the single relay worker

Add `backend/app/transactions/routes.py` with a proposed API:

```text
POST /transactions/relay    # signed Safe transaction plus idempotency key
GET  /transactions/{id}     # durable queued/submitted/confirmed/failed status
```

Validate chain, Safe authenticity, current owner signature, nonce and decoded
calls. Simulate execution from the treasury before dispatch. Restrict requests
to configured test-USDC transfers and exact protect/cancel/invalidate/guardian
replacement operations. Apply per-client limits, bounded gas and an operator ETH
reserve. Bank login alone never authorizes client spending.

Extend the existing funding worker and journal to dispatch deployment, deposits,
Safe execution and public recovery calls. Every transaction from the treasury
shares ONE nonce allocator, process lock and signed-byte journal. Retire the
separate recovery relayer signer; do not run independent workers with the same
key. Keep the Swissquote GUARDIAN key separate from the treasury key.

Persist signed outer transaction bytes before broadcast. Reconcile ambiguous
timeouts and restart using identical bytes. Deduplicate by Safe/nonce/hash as
well as API idempotency key; track Safe and treasury nonces separately. Recheck
owner/policy/security state immediately before signing the outer transaction.

Verify canonical receipts and the matching Safe `ExecutionSuccess` hash plus
required token/recovery events/state. Outer receipt success alone does not prove
inner Safe execution success. Handle failure and consumed nonces explicitly.

Prioritize cancellation and reserve treasury gas for it. Ordinary unsigned or
unbroadcast queued requests must not block urgent cancellation. A broadcast
transaction can still block the shared treasury nonce: support bounded same-nonce
fee replacement and report inclusion uncertainty instead of promising instant
cancellation. The single-account throughput tradeoff is acceptable for this demo.

Gate: one treasury pays all online gas without nonce collisions or duplicate
payments; invalid client signatures cannot move client funds.

## 4. Wire funding and recovery into mobile

Normal sequence: create → treasury-paid deployment → owner-signed/treasury-relayed
Protect → bank-control link → Add money → owner-signed/treasury-relayed Send.
Deployment happens BEFORE Protect on this path; do not depend on a UserOperation
to deploy/configure the Safe together. Add money guides unprotected users to
Protect before deposits and retains its existing signed consent/worker.

Route mobile transfer and security operations to the treasury adapter rather
than bundler. Share persistent pending tracking and concurrency guards across
both. Remove Safe ETH checks only on this route. Preserve biometrics, decoded
previews, background cancellation before signing and honest pending/error states.

Guardian signatures remain unchanged. Queue `multiConfirmRecovery` and
`finalizeRecovery` through the same treasury worker. Verify guardians/signatures,
module nonce, pending request and on-chain deadline. Cancel must execute THROUGH
the client Safe; a direct treasury call to `cancelRecovery()` cannot cancel that
Safe's request. Cancellation needs current-owner proof even when the bank link
is invalidated; it must not depend on successful bank KYC.

After finalization retain the Safe/assets, accept the new owner and re-link the
bank. Treasury ETH shortage means relay unavailable; USDC shortage blocks deposits.
Never silently charge client balances or report simulated confirmation.

## 5. Preserve independence and prove the complete flow

A single Swissquote treasury supplies gasless execution while its service is
available. It cannot pay when Swissquote is permanently offline. Preserve A+B
approval export/QR and independent execution: an outside payer can submit valid
owner-signed Safe transactions or public recovery calls. That fallback payer
needs ETH; the client Safe can stay at zero ETH. Bank-offline gasless execution
requires an independent willing fee payer beyond this single-treasury scope.

Use a local Sepolia fork with treasury ETH/USDC but zero ETH in client owner,
replacement owner and Safe, and zero client EntryPoint deposit. Cover:

- Deploy, protect, link, fund and send; verify only treasury ETH pays fees.
- Recovery start, rejected early finalization, cancellation and finalization.
- Post-recovery sending/funding at the unchanged Safe address.
- Replay, signature/payload tampering, depleted treasury and worker restart.
- Concurrent requests, distinct Safe/treasury nonces and urgent cancellation.
- A+B recovery with bank API stopped and an independent fee payer.

Use the three-minute module only for explicit accelerated tests; separately
verify the real three-day configuration. Repeat on Sepolia/iPhone, retaining
hashes/events/balance evidence and biometric/background checks. Run TS tests,
typecheck, lint and backend pytest after implementation.

The add-money merge passed 125 TS and 148 backend tests, with one optional local
EVM test skipped; that does not prove this planned relay implementation.

## References

- [Safe transaction execution and zero reimbursement](https://docs.safe.global/advanced/smart-account-concepts)
- [Safe execTransaction reference](https://docs.safe.global/reference-smart-account/transactions/execTransaction)
- [Safe signature encoding](https://docs.safe.global/advanced/smart-account-signatures)
- Existing funding worker/journal and fetched `origin/main:docs/recovery.md`.

## Implementation evidence and practical limits

- Shared authenticated database retains stronger KYC, wallet-link and funding checks.
- `transactions/relay.py` enforces real owner signatures, Safe nonces, configured
  token and exact security calls; `transactions/worker.py` shares the treasury
  funding journal/lock and verifies canonical receipts, Safe payment=0 and events.
- Mobile uses treasury execution by default, stores signed public authorizations
  for retry and resumes security operations from Security & recovery.
- Real local-EVM acceptance covers 3-day and 3-minute modules, zero client ETH,
  TypeScript signatures, deposits, transfers, guardian replacement, cancellation,
  invalidation, relinking, post-recovery operations and independent-payer recovery.
- The receipt event ABI was corrected for the deployed Candide version and indexed
  Safe transaction hash; these fixes are regression tested.
- Outer transactions awaiting inclusion reconcile their original signed bytes.
  Automatic fee replacement, a reserved emergency ETH budget, robust per-user
  daily relay quotas and a production auth service are not implemented. A stuck
  treasury nonce can delay cancellation; do not promise instant cancellation.
- Missing treasury ETH keeps relay jobs queued without charging the client. An
  operator must refill it. A permanently offline treasury needs an independent
  fee payer for protocol recovery; the phone fallback explicitly needs ETH.
- Ordinary Safe signatures have no expiry; a network timeout is not revocation.
