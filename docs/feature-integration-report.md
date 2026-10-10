# Feature integration and test report

## Delivered behavior

The integrated `main` contains KYC/Safe linking, add-money, three-day social
recovery, mock login and the optional high-value contract. One mocked Swissquote
treasury supplies test USDC and pays the outer transaction gas for deployment,
protection, sending, guardian changes, recovery start/cancel and finalization.
The client signs standard Safe EIP-712 authorizations locally; its spending key
never goes to the backend. The normal route needs no paymaster or bundler.

An existing funded Safe remains the same Safe after owner recovery. Online
operations work with zero native ETH in both the client EOA and Safe. Backend
identity and passwords remain explicitly mocked. The high-value contract is
available and tested separately, but has no mobile/API co-signing integration and
is not enabled on the default wallet.

Follow [the Xcode/phone handoff](xcode-phone-test-handoff.md) for operator setup,
installation and the complete interaction checklist. The
[gasless implementation plan](gasless-implementation-plan.md) explains the
architecture and the remaining production work.

## Branches inspected and integrated in sequence

Recovery had already been pulled by the user. It was not pulled again. GitHub
branch discovery used `gh`; only the newly discovered mock-login and high-value
branches were fetched. Each feature was inspected, integrated and checked before
moving to the next. The final full suite then exercised their combination.

| Feature/source                                                       | Source commit                  | Integration and verification                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KYC and live Safe control, starting branch `feature/kyc-wallet-link` | `5641bd4`                      | Retained the stronger deployment/control challenges, current owner verification, client/domain/expiry checks, KYC gating and transactional ownership linking.                                                                                                          |
| `feature/add-wallet-funds`                                           | `20f0b3a`, including `02d0496` | Fast-forwarded first. Checked consent, deployment, deposits, exact token deltas, idempotency and durable signed-byte recovery with the funding tests and real Safe fixture.                                                                                            |
| Already-pulled recovery on `origin/main`                             | `0cfcb9a`, including `d07e75d` | Integrated as `916a769` with the treasury route and shared worker. Resolved API/model conflicts while retaining the stronger KYC/link behavior. Tested all recovery operations in mock suites and actual Candide/Safe bytecode, including the real three-day contract. |
| `feature/mock-login`                                                 | `19bf7eb`                      | Integrated as `d5fe509`. Added explicit mock identity verification and storage/error tests, preserved independent wallet/guardian/recovery access and existing keys after logout.                                                                                      |
| `feature/high-value-guard`                                           | `f62ec3b`                      | Integrated as `fe5585f`. Corrected the contract's signature/policy enforcement and compiled/installed it in a real Safe for boundary, tampering and bypass tests.                                                                                                      |
| `omp/ui-beauty-test`                                                 | `2b3042c`                      | Already an ancestor of the integrated branch; no unique changes needed another merge.                                                                                                                                                                                  |

All discovered local/remote feature heads are ancestors of the completed `main`.
The user's requested local commit is not an automatic GitHub push. Record
`git rev-parse HEAD` when handing over the checkout/build.

## Issues found and fixes

| Issue                                                                                                         | Fix and evidence                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recovery/security setup and spending asked for client gas.                                                    | Standard Safe owner authorization plus a treasury-paid outer transaction replaces the default self-funded UserOperation route. Recovery start/finalize are durable treasury jobs. Both local chain acceptance flows keep client/Safe ETH at zero.                                                                 |
| Recovery and funding branches had incompatible backend/model assumptions.                                     | Unified routers on the existing DB/auth model and one worker/key/journal. Strong KYC/control checks survive the merge; recovery cancellation remains available without bank KYC approval.                                                                                                                         |
| Retrying a network timeout or restarting the worker could submit a fresh treasury nonce.                      | Persist signed outer bytes before broadcast, reconcile outstanding transactions first and resubmit the identical bytes. Timeout/restart tests check the signature, bytes, nonce and one-time execution. Missing journal state is quarantined instead of guessed.                                                  |
| ABI, current owner/nonce or Safe signatures could be invalid despite a plausible request.                     | Strict chain/contract/operation allowlists, canonical ABI validation, on-chain owner/nonce and hash checks before signing. Recheck policy after estimation. Malformed 65-byte signatures return a controlled rejection rather than a server error.                                                                |
| Arbitrary call batches could misuse the treasury relay.                                                       | Pin and verify MultiSendCallOnly bytecode; bound call counts; require zero-value CALL entries and exact permitted security operations. Treasury cannot become an owner or guardian. Unsupported calls never reach outer signing.                                                                                  |
| An outer receipt alone could imply success despite an inner Safe failure.                                     | Require canonical confirmations and indexed matching `ExecutionSuccess` with zero reimbursement; transfers also need the matching token event and exact balances. False/missing events, reorgs, nonzero reimbursements and reverted receipts are covered.                                                         |
| Owner changes during authentication, double taps or storage failure could leave unsafe/invisible submissions. | Check nonce/owner around fresh protected-key authentication, serialize pending operations, write tracking/public authorization before transport and roll back pre-submission partial writes. Backgrounding and ambiguous network failures have separate tested handling.                                          |
| Recovery could predict a new Safe for the replacement owner and lose sight of existing assets.                | Verify and persist the recovered binding to the original Safe. Re-link using the new owner; end-to-end tests fund and spend again from the unchanged Safe.                                                                                                                                                        |
| A treasury with no ETH could strand a valid owner relay as a terminal failure.                                | Keep it queued with `treasury_eth_unavailable`; refill resumes. Pre-signing funding failures are reported honestly and may need a new intent. No automatic phone-gas fallback.                                                                                                                                    |
| Login trusted arbitrary input and could lock independent wallet/recovery access behind a bank session.        | Verify configured backend identity and token, reject wrong client IDs, label the password as mocked and never store/send it. Allow existing wallets, recovery and guardian roles without bank login; logout removes only the session. Tests cover partial writes, storage failures and key/tracking preservation. |
| HighValueGuard accepted any extra 65 bytes as bank approval.                                                  | Recover the bank signer from the exact Safe EIP-712 hash with low-s/v validation and correct hook nonce. Separate native/token thresholds; require real co-signatures for approvals, arbitrary calls, batches and removal. Real Safe tests reject forged, wrong-signer, stale and changed-payload signatures.     |
| Recovery deadline/event handling and demo policy were inconsistent.                                           | Normal configuration pins three days; three-minute mode requires explicit server opt-in. Receipt checks use the deployed Candide finalization event and verify owner/threshold/module state at the receipt block. Both period policies pass actual bytecode acceptance.                                           |
| Native handoff lacked a complete reproducible checklist.                                                      | Generated the Expo iOS project, inspected scene lifecycle/Face ID/camera/network configuration and exported the iOS bundle. Added operator setup, device prerequisites, 30 ordered interactions, interruptions, negative cases and evidence requirements.                                                         |

## Final verification

The final run uses the actual repository implementation, not a separate demo
implementation. Totals below include parameterized cases; one acceptance case
can verify many transactions/assertions.

- Vitest: **159 tests passed across 10 files**.
- Backend with the optional real local EVM enabled: **200 tests passed**, no skips,
  in 98 seconds. One non-failing Starlette deprecation warning remains.
- Workspace TypeScript type checking and mobile ESLint: passed.
- Python Ruff check and format check: passed.
- Repository Prettier check: passed after formatting one login test file.
- iOS Metro/Hermes export: passed, 3,071 modules, one 6.9 MB iOS bundle.
- Expo iOS prebuild: succeeded without installing CocoaPods on Linux. Generated
  native files are ignored and regenerated on the Mac. Inspected the generated
  Info.plist, AppDelegate, SceneDelegate and project source references.

### What the chain acceptance actually exercises

`test_funding_local_evm.py` runs deployment/deposit and restart/idempotency checks
against actual Safe bytecode and a six-decimal ERC-20 test token.

`test_treasury_relay_local_evm.py` runs both the three-minute and **three-day**
Candide contracts. It deploys/protects/links/funds, sends USDC, replaces guardians,
starts/cancels/invalidates/restarts recovery, refuses early finalization,
time-travels through the contract deadline, finalizes, re-links the new owner and
funds/spends from the original Safe. It also submits independent backup+friend
recovery through an outside payer with the bank API/worker absent. The payer needs
gas; the client/Safe remain empty of native ETH.

`test_wallet_http_local_evm.py` starts a real Uvicorn process and a separate real
treasury worker process with a shared durable journal. The Node
`treasury-wallet-local-e2e.ts` runner uses the actual `createSafeWallet` treasury
adapter over HTTP for the full deployment/protection/link/deposit/send/guardian
replacement/cancel/recovery/relink/deposit/send sequence. Confirmation uses the
wallet-core receipt checks. The API process has no treasury private key. Local
protected-key reads are mocked; this cannot prove native Face ID behavior.

`test_high_value_guard_local_evm.py` compiles the changed Solidity contract and
installs it on an actual Safe. Tests cover native/token threshold boundaries,
forged/wrong/stale/tampered signatures, approval/arbitrary-call/MultiSend attempts
and guard removal. It does not imply the guard is enabled in mobile.

The worker fault suite signs real outer transactions while injecting network,
chain and receipt faults. Unit/API/mobile-core suites additionally cover auth,
KYC/link privacy, input validation, secure-storage failures, lifecycle cancellation,
pending-operation recovery and signature/ABI policy.

## Reproduce the automated checks

From the repository root with Node 24 and Python 3.11+:

```bash
npm ci
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
npm run typecheck
npm run lint
npm test
npm run format:check
backend/.venv/bin/ruff check backend
backend/.venv/bin/ruff format --check backend
backend/.venv/bin/python -m pytest backend/tests -q
```

The ordinary backend run skips local-EVM acceptance when no fixture is configured.
Enable it in two terminals (localhost/network access is required):

```bash
npm install --prefix /tmp/swissquote-funding-evm --no-audit --no-fund ganache@7.9.2 solc@0.8.30 @openzeppelin/contracts@5.4.0
node scripts/funding-evm-fixture.cjs
```

```bash
FUNDING_EVM_FIXTURE=/tmp/swissquote-funding-evm/fixture.json backend/.venv/bin/python -m pytest backend/tests -q --tb=short
```

The fixture fetches pinned public Safe/Candide deployment bytecode from Sepolia,
uses an isolated local chain and writes ephemeral test keys to a mode-0600 file.
It does not spend Sepolia funds. Do not publish that file. Restart it if test USDC
runs low; stop it after the run. The HTTP acceptance can take over a minute.

For the iOS JavaScript export:

```bash
cd apps/mobile
npx expo export --platform ios --output-dir /tmp/swissquote-ios-export
```

## Remaining issues and proof limits

- **Xcode/phones are pending.** Linux cannot compile/sign the iOS app or exercise
  native biometrics, SecureStore enrollment changes, QR camera access, OS inactive
  transitions and LAN permissions. Use the handoff checklist on physical devices.
- **Funded Sepolia acceptance is pending.** No backend/mobile `.env` or funded
  treasury was supplied. Real contract execution was verified on the local EVM
  using public deployment bytecode; it does not prove live RPC/faucet/fee behavior.
- **Identity is mocked.** The fixed disposable API token and demo login are not
  production bank authentication, and the Swissquote guardian approval policy is
  mocked. Public mobile configuration must never contain private keys.
- **Guard integration is optional/incomplete at the product level.** It has no
  mobile enable/co-sign route, and Safe module calls bypass this transaction guard.
  It is not a universal compliance policy. See [its limits](../contracts/README.md).
- **Worker availability and treasury solvency are required online.** There is no
  automatic fee replacement, emergency cancellation gas reserve, daily sponsorship
  budget or distributed worker coordination. A stuck treasury nonce can delay
  later work. One active operation per Safe must finish before another is accepted.
- **Signed Safe authorizations have no cryptographic expiry.** UI preview expiry
  does not revoke already-submitted authorizations. Operation tracking/journal must
  be retained across restarts.
- **Offline gas needs an outside payer.** Backup+friend recovery remains possible
  without the bank; an independent payer or the recovering phone needs native ETH.
  Online failures no longer silently charge the phone.
- **Background push alerts are not wired into mobile.** Current recovery alerts
  are shown in-app. The backend notification/watch scaffolding is not proof of
  production push delivery.
- **Legacy fork tooling is historical.** `recovery-backend-fork-e2e.ts` predates
  strong linking and queued treasury jobs. Use the current optional pytest
  acceptance for this architecture; the old script is not the handoff procedure.
- Non-failing tooling warnings remain: Starlette's deprecated httpx TestClient
  integration and Metro's `@noble/hashes/crypto.js` export fallback. They do not
  invalidate the passes, but the native device run should still verify signing.
