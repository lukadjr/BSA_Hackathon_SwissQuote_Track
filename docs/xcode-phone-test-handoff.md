# Xcode and physical-phone acceptance handoff

Use this guide for the integrated `main` checkout. It combines
KYC/linking, add-money, three-day recovery, gasless treasury execution and mock
login. The optional high-value contract is tested separately and is not enabled
in mobile. See [the merge/test report](feature-integration-report.md) for fixes,
proof boundaries and remaining issues.

## 1. What to give the Mac developer

- The final `main` repository checkout. No dependency folders or generated native
  projects need to be copied. Local commits are not automatically pushed to GitHub.
- A **disposable** demo API token and the backend host's LAN address. The operator
  configures these below; the repository intentionally contains no `.env` or keys.
- The public treasury address and token address; the treasury is funded by the
  operator with Sepolia ETH and test USDC. Client phones/Safe need **zero ETH**.
- Two physical iPhones with passcodes and Face ID/Touch ID. A third device is ideal:
  **A** current owner, **B** friend guardian, **C** replacement owner. With two,
  B can hold its separate guardian key and later create a replacement owner key;
  this tests flows, not physical separation of recovery factors.
- Paper for the generated 12-word backup and a disposable receiving address.

On the Mac, use a copy of this final checkout or the updated remote `main` after
these commits are pushed. Run `git checkout main` and verify the commit matches
this handoff before installing dependencies. The repository intentionally contains
no `.env`, private keys or worker journal.

## 2. Mac/iPhone prerequisites

The project pins Node 24 (`.nvmrc`), Expo 57, React Native 0.86.3 and React 19.2.3.
Use Node 24, Python 3.11+, Xcode **26.4 or newer**, and iOS **16.4 or newer**.
These minimums are from [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/).
Install Xcode command-line tools, select the installed Xcode, and install a usable
CocoaPods toolchain. A signed development build is required for the biometric
acceptance tests; Expo Go/web does not prove them. See
[Expo local builds](https://docs.expo.dev/guides/local-app-development/) and
[iOS Developer Mode](https://docs.expo.dev/guides/ios-developer-mode/).

On each phone: enable Developer Mode, trust the Mac/developer, enroll biometrics,
set a passcode, and join the same LAN as the Mac/backend. Accept local-network and
camera permission when requested. The generated app config already includes
Face ID/camera descriptions and local-network development support.

```bash
npm ci
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements-dev.txt
```

## 3. Backend and one treasury worker

From the repository root, initialize persistent testnet keys once:

```bash
PYTHONPATH=backend python -m app.funding.setup
PYTHONPATH=backend python -m app.guardian_policy.signer init
```

Treasury setup writes `backend/.env` and prints only its public address. Guardian
setup creates a **separate** guardian approval key under `backend/data/`. Do not
fund the guardian key; the treasury pays recovery gas too. Keep existing keys,
database and journal when restarting.

Edit the generated `backend/.env`:

```dotenv
MOCK_USER_ID=demo-user
MOCK_DISPLAY_NAME=Swissquote demo client
MOCK_KYC_STATUS=verified
WALLET_LINK_DOMAIN=swissquote-wallet.demo
RECOVERY_WATCHER_SECONDS=0
FUNDING_ALLOW_UNPROTECTED_DEMO=false
RECOVERY_ALLOW_DEMO=false
```

Keep the generated `MOCK_ACCESS_TOKEN`, treasury settings, absolute SQLite/journal
paths, RPC URL and token address. Fund the printed **treasury** with Sepolia ETH
and Circle Sepolia test USDC. The default token is
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, six decimals. At least 50 test USDC
covers the example deposits; ETH usage depends on network fees. Faucet funding
is manual. There is no funded Sepolia treasury configured in this checkout.

Run these in two terminals with the venv active:

```bash
python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

```bash
PYTHONPATH=backend python -m app.funding.worker
```

Use **one worker, one treasury key and one journal**. Recovery has no second gas
payer. The worker has a process lock and persists signed bytes before broadcast.
Check `http://<backend-LAN-IP>:8000/health` from phone Safari. Health is public;
protected routes require the disposable token. A queued request will stay queued
if the worker is stopped or the treasury has no gas.

For a short complete demo on a **fresh Safe**, set backend
`RECOVERY_ALLOW_DEMO=true` and mobile period `demoOneMinute` below. Recovery
protection still requires all three guardians and threshold two. Switching env
values does not change an already-installed contract's waiting period; use a
fresh disposable Safe to switch policy. Normal configuration remains three days.

## 4. Mobile config and Xcode installation

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

Fill public settings in `apps/mobile/.env`:

```dotenv
EXPO_PUBLIC_CHAIN_ID=11155111
EXPO_PUBLIC_API_BASE_URL=http://<backend-LAN-IP>:8000
EXPO_PUBLIC_DEMO_ACCESS_TOKEN=<same disposable token as backend>
EXPO_PUBLIC_WALLET_LINK_DOMAIN=swissquote-wallet.demo
EXPO_PUBLIC_RPC_PUBLIC_URL=https://ethereum-sepolia-rpc.publicnode.com
EXPO_PUBLIC_ERC20_TEST_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
EXPO_PUBLIC_RECOVERY_PERIOD=threeDays
```

For accelerated acceptance use `EXPO_PUBLIC_RECOVERY_PERIOD=demoOneMinute`
together with the backend demo flag. No bundler/paymaster endpoint is needed for
the normal flow. `localhost` on a phone refers to that phone, so use the LAN IP.
Restart Metro after env changes; rebuild after native app-config/plugin changes.
Never put treasury or client private keys in mobile environment variables.

```bash
cd apps/mobile
npx expo run:ios --device
```

This generates the native project and installs pods. Select the connected phone.
For manual signing/debugging, open the generated
`apps/mobile/ios/SwissquoteWallet.xcworkspace` in Xcode, select the
`SwissquoteWallet` target, choose your development Team, enable automatic signing
and select the physical phone. The bundle identifier is
`com.bsa.swissquotewallet.demo`; if your Team needs another identifier, change
`app.config.ts` and regenerate rather than editing generated configuration.
Build and run on A, B and C. Keep Metro available on the LAN:

```bash
# From the repository root
npm run mobile -- --lan
```

An existing native folder can be regenerated through Expo CNG after config changes;
keep native modifications in config plugins. See
[Expo native generation](https://docs.expo.dev/workflow/continuous-native-generation/).

## 5. Verify the happy path in order

Record the Safe, owner, guardian addresses and every operation's transaction hash.
The example amounts make balance changes easy to verify.

| #   | Interaction                                                                                      | Expected result                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A: launch fresh build → Log in; use `demo-user` and any non-empty **demo** password              | Server identity is checked; login is explicitly mocked. No real banking password is stored/sent.                                             |
| 2   | Try empty credentials and another client ID                                                      | Refused; no fake login/token.                                                                                                                |
| 3   | A: Create wallet                                                                                 | Native protection/enrollment requirements apply; one persistent owner address. App opens Link to Swissquote.                                 |
| 4   | Before deployment, attempt linking                                                               | No verified badge; pending-deployment explanation.                                                                                           |
| 5   | Tap **Set up wallet / add money** → **Review wallet setup**                                      | Review shows deployment consent for this owner/Safe, chain, client, nonce and expiry.                                                        |
| 6   | **Authenticate & confirm**                                                                       | Fresh native protected-key prompt; worker deploys the Safe, receipt confirms after two blocks. No client ETH requested.                      |
| 7   | **Protect wallet before adding money** → Start                                                   | Backup / Swissquote / friend protection flow; normal label 3 days or explicit 3-minute demo.                                                 |
| 8   | Write the 12 words on paper → **I wrote them down**                                              | Wrong requested words fail; correct words advance. Phrase is not saved by the app.                                                           |
| 9   | B: **Help a friend: be a guardian** → **Scan a code**, scan A's invite → **Accept with Face ID** | B creates a separate guardian key; acceptance is signed. Do not create/register a client wallet on B just to be a guardian.                  |
| 10  | Compare the four address words on A and B → A **The words match**                                | Guardian address matches B; mismatch/start-again path works.                                                                                 |
| 11  | A: Review protection → **Confirm with Face ID**                                                  | Fee says covered by Swissquote. On-chain guardians are distinct backup/SQ/friend, threshold 2; Safe stays zero ETH.                          |
| 12  | A: Add money → **Verify bank connection** → review → **Confirm with Face ID**                    | Signed control challenge succeeds against deployed Safe; correct identity/Safe/owner/domain/expiry. No funds moved by linking.               |
| 13  | A: Add money, enter `20`, **Review transfer** → **Authenticate & confirm**                       | Treasury loses exactly 20 USDC plus ETH gas; Safe gains exactly 20 USDC, zero ETH.                                                           |
| 14  | A: Wallet → Send; enter recipient and `2` → **Preview transfer**                                 | Correct recipient/amount; fee covered by Swissquote; no owner key read until confirmation.                                                   |
| 15  | **Authenticate & send**, then **Check status** if needed                                         | Exactly one USDC transfer; Safe 18, recipient +2, `ExecutionSuccess` with zero reimbursement, matching Transfer event and two confirmations. |
| 16  | Open explorer / refresh / kill and reopen app                                                    | Same Safe and balance persist. Confirmed transfer/history is retained. Owner and Safe ETH remain zero.                                       |
| 17  | Sign a test message → change text → **Confirm with Face ID**                                     | Verified signature belongs to the phone owner; each signing attempt rereads its protected key.                                               |
| 18  | A: Log out, restart, then **Open wallet without bank login**                                     | Keys/Safe/pending operations survive logout; existing wallet remains accessible. Login again does not force a new Safe.                      |

## 6. Recovery, cancellation, rotation and relinking

Keep A available for cancellation. Use C for the replacement key and record the
original Safe before starting. The same demo client identity locates that Safe.

| #   | Interaction                                                                                                                     | Expected result                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 19  | C: **Recover my wallet** / **I lost my phone: recover my wallet**, request recovery                                             | A new protected owner key is created on C; request targets original Safe. It does not deploy a new Safe or move assets.                                      |
| 20  | Approve with the paper phrase, leaving only one approval                                                                        | Recovery cannot start; insufficient threshold.                                                                                                               |
| 21  | Use Swissquote mock approval or show C's friend request QR; B scans and compares the four new-key words before Face ID approval | Two distinct guardian signatures match Safe/module/new owner/current recovery nonce. Wrong/outdated QR is refused.                                           |
| 22  | C: **Start (fee paid by Swissquote)**                                                                                           | Treasury queues/mines recovery; countdown uses the module deadline. C and Safe need zero ETH.                                                                |
| 23  | A: refresh Wallet / Security & recovery                                                                                         | In-app alert appears, showing the proposed owner and remaining time. Background push notification is not a completed mobile feature.                         |
| 24  | Attempt finishing before deadline                                                                                               | Cannot finalize; original owner remains. For three days, return after the real deadline; local automated tests time-travel, Sepolia cannot.                  |
| 25  | A: **It wasn't me: cancel** → **Cancel with Face ID**                                                                           | Owner-signed Safe cancellation is treasury-paid; pending request clears; A remains owner and funds are unchanged. C's old request/approvals cannot finalize. |
| 26  | A: void a collecting request before it starts, via request alert → **Void with Face ID**                                        | Module nonce increments; already-signed approvals become stale.                                                                                              |
| 27  | A: Security & recovery → replace a friend or backup guardian, review and confirm                                                | Guardian list updates, stays 3 distinct / threshold 2. Old guardian is rejected for new recovery approvals. New backup phrase must be written down.          |
| 28  | C: start a fresh request with two currently valid guardians; wait; **Finish recovery**                                          | Treasury pays finalization. Original Safe and USDC balance stay unchanged; C becomes sole owner. A can no longer authorize spending.                         |
| 29  | C: **Continue**, re-confirm Swissquote link, then Add `1` USDC and Send `1` USDC                                                | Previous bank attestation is invalidated; fresh owner proof succeeds. Transactions use original Safe; final example balance remains 18 USDC.                 |
| 30  | Restart C during collection, waiting and after finalization                                                                     | Pending recovery resumes; recovered binding is retained, never replaced by a prediction for C's new key.                                                     |

Test all guardian pairs across fresh requests: backup+Swissquote,
Swissquote+friend, and backup+friend. The offline backup+friend scenario below is
separate from the online treasury-funded flow.

## 7. Interruptions and negative cases

| Interaction                                                                                                                 | Expected result / recovery action                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cancel Face ID in linking, sending, protection, cancellation and guardian approval                                          | No new submission, false success or replacement key. Review again.                                                                                                                                                 |
| Background/lock/navigate away before signing or during protected-key prompt                                                 | Pre-submission action aborts. Returning does not silently authorize a transfer. Native inactive transitions during system prompts must also be checked.                                                            |
| Background after the network request starts / kill app while queued                                                         | Submission may exist. Use **Check status**, Add money request refresh, or Security & recovery → **Check pending security operation**. Do not sign another transfer to resolve a timeout.                           |
| Double tap signing/confirming buttons                                                                                       | At most one operation; public authorization/API intent and signed outer bytes deduplicate.                                                                                                                         |
| Stop worker, submit, restart worker                                                                                         | Queued operation resumes and executes once with its journal. Keep database and journal intact.                                                                                                                     |
| Stop API or disconnect phone after submission                                                                               | Honest error/pending state. Restore connectivity and check the same operation; no invented success and no automatic phone-gas fallback.                                                                            |
| Treasury ETH absent                                                                                                         | Owner relay remains queued with `treasury_eth_unavailable`; refill treasury and resume. Never asks client to fund its Safe. Bank funding instructions can fail pre-signing and may need a new intent after refill. |
| Treasury USDC absent / amount exceeds available                                                                             | Deposit refused; client spending balances are unchanged.                                                                                                                                                           |
| Enter zero, negative, too many decimals, scientific notation, invalid/zero/self recipient, amount above balance or demo cap | Rejected before signing/submission.                                                                                                                                                                                |
| Operator sets KYC pending/rejected and restarts API                                                                         | Onboarding/bank funding refuse approval; existing wallet access and cryptographically authorized cancellation are not gated by bank KYC. Restore verified for normal demo.                                         |
| Log out during a pending request                                                                                            | Stored keys and transaction/recovery tracking survive; log in or open the existing wallet and check status.                                                                                                        |
| Camera permission denied / invalid or wrong-type QR                                                                         | Clear error; retry permission/scan or use supported QR handoff. No guardian/recovery silently added.                                                                                                               |
| Remove/change enrolled biometrics on a disposable test phone                                                                | Protected key may become unreadable; never replace it automatically. Complete recovery from other factors. Do this only after the recovery setup is verified.                                                      |
| Enter wrong backup phrase / approve unrelated or stale recovery                                                             | Invalid signature/nonce/guardian is refused. A second approval from the same guardian does not count twice.                                                                                                        |
| Sign an old-owner request after finalized recovery                                                                          | Live owner checks reject it; C continues using the unchanged Safe.                                                                                                                                                 |

A signed Safe authorization has no cryptographic expiry. UI preview expiry and
closing the app do not revoke a request that already reached the server.
A currently active operation on the same Safe must be resolved before another
can be signed. A stuck treasury nonce can delay cancellation; automatic fee
replacement and an emergency gas reserve are not implemented.

## 8. Bank-offline recovery and optional guard

Stop the API; leave the public RPC available. Use backup phrase + friend's QR
approval. The recovering phone can prepare/start/finalize independently, but this
**explicit offline path requires Sepolia ETH on its new owner EOA**. The Safe can
remain zero ETH. Do not present this as treasury-funded while the treasury is
unavailable. An outside payer can also submit the public recovery calls; this is
covered by local-EVM acceptance. If an online case cannot finalize because the API
is down, the current UI reports the error; it no longer silently falls back to
charging the phone. The explicit offline workflow is chosen separately.

HighValueGuard has no phone enable switch or compliance co-signing screen. Run
its isolated real-Safe test instead; see [contract instructions](../contracts/README.md).
A high-value mobile send is subject to the relay demo cap, not this optional guard.

## 9. Evidence to collect and issue report

For each case save: test ID, build commit, iOS/Xcode version, phone model, result,
Safe and owner public addresses, transaction hash/receipt, expected/actual token
balances and who paid gas. Capture a failure screenshot and redacted Xcode/worker
error if needed. Never record private keys, phrases, tokens or password inputs.

A happy-path pass requires genuine on-chain receipts, exact balances, zero client
ETH for online operations, original Safe after recovery and no duplicated
transactions after restart. A loading indicator or `200` alone is not a pass.

The Linux checks generated the iOS project, verified Face ID/camera/scene config,
and exported an iOS JS bundle. They did not compile/sign in Xcode or exercise
real Face ID/camera. The physical device run above supplies that missing evidence.
