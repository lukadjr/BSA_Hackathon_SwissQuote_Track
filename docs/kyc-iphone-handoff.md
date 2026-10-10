# KYC / Safe linking — iPhone handoff

Branch: `feature/kyc-wallet-link`. Identity is an existing Swissquote **demo**
profile. No passport/selfie collection or real KYC provider is implemented. Safe
signatures and the deployed-account checks are real when connected to Sepolia.
Bank actions are authorization previews and never move funds.

## Setup on the Mac

1. Check out this branch. Use Node 22.13+ and Python 3.11+. Run `npm ci` at the root.
2. Follow [backend setup](../backend/README.md). Set `MOCK_KYC_STATUS=verified` and
   `SEPOLIA_RPC_URL` to a working Sepolia endpoint supporting JSON-RPC batches.
   Start the backend from the same working directory on each restart so the SQLite
   registry stays consistent. Reuse the disposable demo token across those restarts.
3. Copy `apps/mobile/.env.example` to `apps/mobile/.env`. Put that disposable token
   in `EXPO_PUBLIC_DEMO_ACCESS_TOKEN`. Use `http://localhost:8000` if the simulator
   and backend run on the same Mac; use the backend computer's LAN IP if remote.
   Set the app RPC, bundler and test-token address per [transaction runbook](sepolia-transaction.md).
4. Run `npm run mobile:ios` from the root to create/run the development build.
   Native directories are generated; do not commit manual native changes.
5. Enable simulated Face ID enrollment in the Simulator's Features menu. Test both
   matching and nonmatching biometric responses. If SecureStore's configured
   passcode/access-control policy cannot be represented by the simulator, report
   that limitation and repeat on a real iPhone; do not weaken protection to pass.

Use a development build for Face ID, not Expo Go, as required by the
[Expo SDK 57 LocalAuthentication documentation](https://docs.expo.dev/versions/v57.0.0/sdk/local-authentication/).
Changing public environment values requires restarting Metro/reloading the app.

## Acceptance scenarios

| Scenario                                          | Steps                                                                                                                                                                                                    | Expected                                                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Verified demo account                             | Open Create wallet                                                                                                                                                                                       | Name, verified identity and simulated-KYC label; creation enabled                                                                         |
| Pending/rejected identity                         | Set backend `MOCK_KYC_STATUS=pending` / `rejected`, restart, refresh identity                                                                                                                            | Creation/bank linking unavailable; status visible; mobile cannot approve identity                                                         |
| New undeployed Safe                               | Create a wallet, open Link                                                                                                                                                                               | Pending-deployment explanation; no verified badge; Open testnet wallet remains available                                                  |
| Deploy on Sepolia                                 | Fund the demo treasury through faucets, start its worker, then use Add money → Review wallet setup → authenticate/confirm; see [treasury setup](../backend/README.md#add-money-persistent-demo-treasury) | Real explorer receipt and deployed Safe; client owner verified; bank pays setup fees and gains no ownership                               |
| Link deployed Safe                                | Wallet → Swissquote account (demo) → review → Confirm with Face ID                                                                                                                                       | Correct Safe, owner, account, domain, chain, expiry and purpose; native protected-key prompt; verified Safe link after completion         |
| Biometric cancellation                            | Cancel/mismatch at confirmation                                                                                                                                                                          | No successful link; fresh confirmation available; no cached key reused                                                                    |
| Background/navigation                             | Background or leave while a confirmation is pending                                                                                                                                                      | Signing attempt aborted; no success result shown from cancelled work                                                                      |
| Challenge expiry                                  | Leave confirmation open for over five minutes then confirm                                                                                                                                               | Refused; refresh generates a new challenge                                                                                                |
| Relaunch                                          | Close/reopen after linking                                                                                                                                                                               | Existing wallet opens; opening Swissquote account retrieves fresh backend/chain status; no permanent local linked flag grants eligibility |
| Small mock bank operation                         | Linked → Test bank connection → amount 10, each direction                                                                                                                                                | Approved demo preview, explicitly no funds moved                                                                                          |
| High-value mock operation                         | Amount 10000.000001                                                                                                                                                                                      | Additional review required; no funds moved                                                                                                |
| Invalid amount                                    | Zero, negative, over six decimals or malformed input                                                                                                                                                     | Rejected; no approval shown                                                                                                               |
| KYC downgrade after linking                       | Set backend identity to rejected, restart, refresh bank status                                                                                                                                           | Bank preview disabled/refused; independent wallet remains accessible                                                                      |
| Backend/RPC unavailable                           | Stop backend or use a nonworking backend RPC; refresh                                                                                                                                                    | Unavailable/error status; no bank approval or false verified result                                                                       |
| Restore service                                   | Restore backend/RPC with the original DB and settings, refresh                                                                                                                                           | Previous valid proof can be rechecked; temporary outage alone does not destroy it                                                         |
| Owner rotation (after recovery integration)       | Recover same Safe to new owner, query status, register same Safe/new owner and relink                                                                                                                    | Old proof invalidated; bank preview blocked until fresh new-owner signature; same Safe retains funds                                      |
| Attacker phone+email (after recovery integration) | Request SQ guardian approval without independent identity review                                                                                                                                         | Refused; onboarding KYC/session alone does not authorize recovery                                                                         |

Record device/simulator + iOS version, backend settings (without tokens), Safe
address, owner, explorer transaction hash, and screenshots of simulated identity,
confirmation, success/refusal and bank preview. Never record a private key or seed.
A simulator pass is not real-device validation of SecureStore, biometrics,
background lifecycle, key invalidation or backup behavior.

## Recovery developer integration

The contract is [RecoveryIdentityReview](../backend/app/guardian_policy/identity_review.py).
Trusted bank-side code must store and authenticate review decisions and require an
independent check. It must bind request ID, client ID, Safe, chain, proposed owner,
reviewer and expiry. Before signing, also bind the current on-chain recovery nonce
and consume the decision. The client cannot send an `approved` object. The helper
alone is not a complete recovery authorization service, and existing recovery API
stubs still return `501`.

Keep the guardian threshold/delay and A+B offline-bank route independent of this
KYC layer. After finalized rotation, preserve the **original recovered Safe** in
the mobile resolver/storage. The existing `getSafeAccount()` derives a Safe from
the local owner, so adapting it for recovered accounts is part of recovery work.
Then use `/wallets/register` with the recovered Safe/new owner and the linking
challenge/complete flow. Bank authorization rechecks current owners each time.
The KYC verifier checks the enabled 4337 module; it does not certify the complete
recovery/security configuration or prohibit other modules.

## Automated validation from Linux

```bash
backend/.venv/bin/python -m pytest backend
backend/.venv/bin/python -m ruff check backend
backend/.venv/bin/python -m ruff format --check backend
npm test
npm run typecheck
npm run lint
```

At handoff: 96 backend tests and 90 TypeScript tests pass. Tests cover authenticated
profiles, strict payloads, expired/replayed/tampered challenges, wrong Safe/owner/
chain/client, registration races, concurrent endpoint completion (one winner),
identity downgrade, owner rotation, RPC failures and ABI decoding. A real viem
signature is verified by Python through API + local HTTP RPC fixtures; those
fixtures explicitly mock the chain. These tests do not execute recovery or bank
transfers and do not substitute for the real Sepolia/iPhone acceptance story.

The iOS and Android production JavaScript/Hermes bundles export successfully on Linux. Each
reports the existing `@noble/hashes/crypto.js` package-export fallback warning;
check actual native runtime/signing on the Mac. This is not an Xcode native build.
Live public Sepolia RPC requests from this environment were unsuccessful; a
positive live Safe-control verification is still required on the Mac/phone.
