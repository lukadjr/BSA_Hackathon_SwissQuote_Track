# Sepolia Safe transaction: complete implementation handoff

This is a self-contained technical handoff for the team and for ChatGPT. It explains the implementation, its boundaries, every changed file, configuration, testing, and the remaining device/on-chain acceptance work. The final appendix contains the **complete implementation diff, including new files and the dependency lockfile**, so another reader can inspect the exact code without access to the repository.

Implementation commit: [`2ac6912 — test: add Sepolia Safe transaction flow`](https://github.com/lukadjr/BSA_Hackathon_SwissQuote_Track/commit/2ac6912), pushed to `main` on 2026-10-10. Base commit: `2b3042c`, the existing phone-owner/backend linking milestone. Implementation size: 28 files, 2,674 insertions, 77 deletions. This document is added afterward in a separate test documentation commit.

## 1. What the milestone implements

The app can prepare, authenticate, submit and verify one self-funded ERC-20 transfer from a single-owner Safe on Ethereum Sepolia. For a new wallet, the first UserOperation deploys the previously predicted Safe and executes the transfer together. For an already deployed Safe, the transfer omits deployment data.

“One transaction” means one outgoing token call in one UserOperation. The bundler submits an outer EntryPoint transaction and may include other users' operations in it. Funding the Safe with ETH and test tokens is done separately. The app can perform subsequent transfers after the previous one is resolved; this milestone is not a permanent one-transfer limit.

Recovery is not configured. There is one EOA owner and a threshold of one. The ERC-4337 module is enabled because it provides account-abstraction execution; it is not a recovery module. No guardian, owner rotation, recovery kit, recovery execution, paymaster, or sponsored gas is implemented here. Existing recovery screens remain previews. No new Solidity contract source or custom contract deployment was added: this uses existing Safe/EntryPoint infrastructure.

**Verification status:** local automated checks, SDK signing tests, and JavaScript/Hermes exports pass. Public Sepolia endpoints and required contract presence were checked read-only. A funded on-chain deployment/transfer and native phone authentication have **not** yet been demonstrated. There is no real transaction hash in this handoff. The first phone test must supply that evidence.

## 2. The architecture and trust boundaries

```text
Existing phone owner key (EOA)
  └─ Protected SecureStore read for each signing attempt
       └─ wallet-core prepares and signs a Safe operation
            ├─ Sepolia RPC: chain, code, owners, nonce, balances, receipt
            └─ ERC-4337 bundler: estimation, submission, operation receipt
                 └─ EntryPoint v0.7
                      └─ Safe4337Module
                           └─ Safe executes ERC-20 transfer(recipient, units)
```

The Safe address holds the assets. The EOA proves authority by signing; its address is displayed separately. Fund the **Safe**, not the EOA. Gas is paid from the Safe's Sepolia ETH or its EntryPoint deposit. The bundler is not given the private key. RPC and bundler URLs are public build configuration, not privileged credentials.

The existing backend still handles demo authentication and wallet linking during onboarding. Safe preparation, signing, submission and verification call RPC/bundler directly from the client. No backend signing, sponsorship or recovery service was changed. Linking a public EOA to the demo backend is separate from proving on-chain Safe ownership.

`packages/wallet-core` is platform-neutral TypeScript. It receives a key-storage adapter and an activity-storage adapter. The phone supplies SecureStore; the smoke runner supplies a disposable local key file and JSON tracking file. This makes the transaction algorithm identical across the two environments, while their keys, authentication and addresses remain separate.

## 3. Exactly pinned chain and Safe stack

| Setting                     | Value                                                             |
| --------------------------- | ----------------------------------------------------------------- |
| Network                     | Ethereum Sepolia                                                  |
| Chain ID                    | `11155111`                                                        |
| Safe implementation         | Safe L2 `1.4.1`                                                   |
| SDK                         | `abstractionkit` exactly `0.4.0`                                  |
| SDK account class           | `SafeAccountV0_3_0`, explicit EntryPoint v0.7 compatibility class |
| Safe4337 module             | `0.3.0`                                                           |
| EntryPoint                  | `0.7`                                                             |
| Owners / threshold          | One existing EOA / `1`                                            |
| CREATE2 salt (`c2Nonce`)    | `0`                                                               |
| Recovery module / paymaster | None                                                              |
| Example ERC-20              | Circle Sepolia test USDC, six decimals                            |

| Contract                             | Address                                      |
| ------------------------------------ | -------------------------------------------- |
| Safe singleton                       | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| Safe proxy factory                   | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| Safe4337 module and fallback handler | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` |
| Module setup helper                  | `0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47` |
| EntryPoint                           | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Example token                        | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

`safe/account.ts` is authoritative for runtime configuration. Module/helper/EntryPoint addresses come from the pinned SDK compatibility class. `config/deployments.example.json` documents the matching values; the app does not load this JSON as runtime configuration. Factory and salt overrides were removed from the mobile template to avoid accidentally deriving a different address after funding.

The SDK derives a counterfactual Safe address from the owner and initialization parameters. A counterfactual address is valid before code exists there. ETH and ERC-20 balances can be sent there before deployment. The first operation contains factory data that deploys precisely that Safe. Changing the owner, initialization stack or salt may change the address and strand assets in an earlier one; the phone stores a binding and refuses a silent mismatch.

## 4. Core account initialization and verification

`initializeSafe(owner)` validates a nonzero address, normalizes its checksum and calls the pinned SDK initializer with one owner, threshold one, salt zero, and explicit factory/module/setup/EntryPoint parameters. `predictSafeAddress(owner)` returns the checksummed account address produced by this initializer.

`validateConfig` accepts only HTTP/HTTPS RPC and bundler URLs without URL username/password fields, and a valid nonzero token address. It freezes normalized configuration. It does not strip API keys in URL paths or query strings; never place privileged credentials in app environment variables.

The viem client uses the Sepolia chain definition, a 15-second HTTP timeout and no automatic transport retries. SDK requests also have a 15-second timeout. Provider/SDK errors are converted into safe wallet errors instead of exposing raw URLs or responses.

Before account use, `checkNetwork` checks both providers' chain IDs, requires bundler support for the pinned EntryPoint, and requires nonempty bytecode at the singleton, factory, module, module-setup helper, EntryPoint and token. This is a contract-presence check, not a bytecode audit.

`verifySafe` returns `false` if the predicted address is undeployed. Otherwise it reads and requires:

1. `getOwners()` contains exactly the expected owner.
2. `getThreshold()` is `1`.
3. `VERSION()` is `1.4.1`.
4. `getModulesPaginated(0x...01, 10)` returns exactly the pinned module and ends at the sentinel.
5. Proxy storage slot zero contains the expected singleton.
6. The SDK's fallback-handler storage slot contains the pinned Safe4337 module.

The reads can be pinned to the inclusion block when verifying a receipt. A mismatch raises `SAFE_CONFIG_INVALID`. This deliberately rejects a different owner/module arrangement, including adding a future recovery module without adapting the verifier. It does not establish complete bytecode integrity or check every possible Safe setting such as a guard.

`getAccount()` returns public owner/Safe/token identity, deployment status, token decimals, and real formatted token/ETH balances. The UI no longer invents a token balance or assumes the owner address is the receiving Safe.

## 5. Transfer encoding and amount rules

`transactions/erc20.ts` defines the ABI for `decimals`, `balanceOf`, `transfer`, and the `Transfer` event. It encodes exactly one `transfer(recipient, units)` call with native ETH value zero.

Amounts are decimal strings, not floating-point numbers. The accepted syntax is digits with an optional fractional part. The encoder checks that decimals are an integer between 0 and 255, the recipient is a valid nonzero address, the input fits the token precision, and units are positive and fit `uint256`. It rejects exponent notation, negatives, zero, malformed values and excessive fractional digits. This explicitly prevents viem's `parseUnits` rounding a too-precise amount.

For a six-decimal token, `1.25` means exactly `1250000` units. BigInts are used during computation. Public persistence fields use decimal strings so `JSON.stringify` never receives a BigInt.

The service additionally rejects sending to its own Safe and requires enough token balance. It supports one configured ERC-20, not arbitrary token selection or an outgoing native ETH transfer.

## 6. Prepare: immutable preview and gas checks

`prepareTransfer({ recipient, amount }, signal?)` performs these steps:

1. Refuse a cancelled attempt or an existing pending transfer.
2. Load/verify the account and configuration.
3. Validate and encode the amount/recipient; check the Safe's token balance.
4. Select an initialized undeployed SDK account or an existing deployed account.
5. Ask the SDK to create a UserOperation for the single token call, with the expected owner signer.
6. Require the constructed sender and calldata to match that exact transfer, require no paymaster/data, and validate gas/fee fields.
7. Require positive gas limits and max fee, priority fee no greater than max fee, and max fee no greater than `1000 gwei`.
8. Calculate maximum operation gas cost; require Safe ETH plus EntryPoint deposit to cover it.
9. Create a frozen preview and store the actual operation privately in a WeakMap keyed by that exact preview object.

The preview includes owner, Safe, token, recipient, formatted amount, raw units, decimals, maximum gas in ETH, whether deployment is needed and the local expiry time. The UI can display these fields but cannot supply a modified operation for signing.

A copied, forged or JSON-reconstructed preview does not have the WeakMap identity and is rejected. The underlying operation is never exposed to UI code. The preview expires after **two minutes of local time**. The signature's on-chain validity ends **ten minutes after the block timestamp read during preparation**. These are separate limits: one controls human review, the other controls delayed bundler inclusion.

The fee preview is a maximum computed from estimated limits and fees; it is not the final charge or a complete execution-security audit. Estimates and balances can change before inclusion.

## 7. Submit: protected read, signing and durable tracking

`submitTransfer(preview, signal?)` serializes submissions within the service. It checks cancellation, preview identity/age, absence of a previous pending record, network configuration, deployed Safe configuration and the current EntryPoint nonce (nonce key zero). A stale nonce requires a fresh preview.

The service rereads the public owner and calls `storage.readPrivateKeyForSigning()` for this signing attempt. On the phone this is the existing authentication-protected SecureStore read. After that read it checks cancellation/expiry again, derives the address from the key and checks it against the expected owner, and checks that the public owner has not changed.

The SDK signs the operation using the Safe-specific EIP-712 format, the Sepolia chain ID and the signature validity window. This is different from the existing message-signing screen's EIP-191 signature. The SDK encodes the Safe module's required signature format; the tests recover the signer independently.

The key stays inside the signing closure and is not returned to the screen, logged, persisted in tracking, or sent to RPC/bundler. Its local variable is cleared in `finally`. JavaScript garbage collection does not guarantee that all memory copies are erased. This is an EOA private key protected at rest, not a non-exportable hardware signing implementation.

After signing, the service consumes the preview and computes the expected EntryPoint UserOperation hash. That submission hash differs from the Safe signature digest. It writes a public pending record **before** asking the bundler to send. If cancellation occurs after persistence but before sending, it clears that record and aborts. After broadcasting begins, cancellation cannot reverse inclusion.

The bundler must return the same operation hash. Timeouts, transport errors or a wrong returned hash leave pending tracking in place because a failed response does not prove that submission failed. A new send is blocked until status resolves. No blind resend is performed.

## 8. Confirm: evidence from the actual transaction

`confirmTransfer(submitted)` first checks chain configuration and that the stored owner/Safe/token belongs to this service. It queries the bundler for the operation receipt, then uses the regular RPC to load the actual outer transaction receipt.

If no receipt is available, it returns `null`. Tracking is released only when a chain block is more than 60 seconds past `validUntil` and the EntryPoint nonce read at that same block is still the submitted nonce. That proves the expired operation did not consume its nonce. If the nonce has changed without a known receipt, tracking remains unresolved; the current implementation has no independent log-search recovery path.

For a receipt, confirmation waits until the latest block is at least inclusion block + 1: two confirmations counting the inclusion block. This is a testnet confirmation policy, not finalized-chain assurance.

The verifier scans logs emitted by the pinned EntryPoint and locates the `UserOperationEvent` with the exact hash, Safe sender and nonce. Both the outer transaction status and this event's `success` flag must indicate success. A successful outer bundle can contain a failed operation; that case is rejected and pending tracking is cleared with `TRANSFER_FAILED`.

The verifier then requires the expected token's exact `Transfer` event: Safe as sender, chosen recipient, exact amount units. Its search is limited to the receipt-log segment after the preceding UserOperationEvent and before this operation's event, so another operation's transfer cannot satisfy the check.

It verifies the deployed Safe at the inclusion block and reads sender/recipient token balances at inclusion block - 1 and inclusion block. It reports whether the sender decrease and recipient increase each exactly equal the transfer amount. Other transactions in the same block can change these deltas. In that case the exact Transfer event can still establish the transfer, but `balanceChangesMatch` is false and the UI displays a note; the smoke command exits nonzero for strict acceptance.

The confirmed record includes operation hash, transaction hash, trusted Sepolia explorer URL, inclusion block, identity/amount/nonce/validity, before/after balances and the delta result. It writes the confirmed record before clearing pending tracking. Only the last confirmed transfer is stored; this is not a transaction-history indexer.

## 9. Phone storage and service assembly

`apps/mobile/src/lib/safeWallet.ts` imports existing polyfills before wallet-core, builds a lazy service singleton, supplies the existing `secureStoreAdapter`, and implements public activity storage.

| SecureStore key                | Meaning                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `swissquote.owner.privateKey`  | Existing protected EOA key; reused, not a new Safe secret         |
| `swissquote.safe.account.v1`   | Public binding: owner, Safe, chain ID and pinned stack identifier |
| `swissquote.safe.pending.v1`   | Public operation identity, amount, nonce, expiry and hash         |
| `swissquote.safe.confirmed.v1` | Last public confirmation proof                                    |

The Safe metadata uses passcode-set, device-only accessibility and does not request biometric authentication for every metadata read. The existing private-key storage does require authentication. Public account reads and status checks therefore do not unlock the private key.

Tracking readers validate addresses, hash shape, numeric strings and decimal range; the confirmed reader also checks transaction-hash shape. Malformed JSON/native errors become `STORAGE_FAILED`. This is validation of local tracking shape, not a cryptographic attestation of metadata. An existing binding mismatch refuses replacement instead of silently switching a funded address.

`getSafeWallet()` uses static references to Expo public environment variables and rejects an explicitly configured chain ID other than Sepolia. `getSafeAccount()` loads the verified account and records/checks the binding. Development-only reset deletes the Safe binding, pending record and last confirmation in addition to the existing owner/link reset.

Resetting a funded wallet deletes the only implemented owner key. There is no recovery path in this milestone. The revised reset text makes that consequence explicit; do not reset a funded test wallet casually.

## 10. Screen behavior

### Wallet

`WalletScreen.tsx` reads actual Safe/token/ETH balances on focus and refresh, cleans up stale asynchronous responses, distinguishes a reserved counterfactual Safe from a deployed verified Safe, and shows the owner EOA separately. The receiving/funding instructions point to the Safe. Recovery is explicitly not configured.

### Send

`SendScreen.tsx` replaces the mock transfer with recipient/amount inputs, prepare, review, authenticate/send, pending status and confirmation evidence. It loads pending/last-confirmed tracking on focus. While an operation is pending, it disables new transfer input/submission and offers **Check status**.

The action wrapper checks screen focus/app activity and prevents concurrent actions. Focus/navigation/background handling invalidates the review attempt and aborts before submission where possible. The exact preview object is passed back to core; form edits do not directly mutate a signed payload. Device authentication interruption/background semantics still need a real phone test.

The success display includes transaction hash, two-confirmation evidence, before/after balances and a same-block activity note when deltas differ. The explorer link is built from a fixed Sepolia URL and a validated transaction hash. Polling is manual on mobile; the smoke runner polls automatically.

### Shared components

`Button.tsx` gains a disabled prop, disabled styling and accessibility state, used to block invalid/concurrent send actions. `Screen.tsx` changes the global badge from `UI MOCK` to `TESTNET`. That badge does not mean all screens are implemented: recovery still remains a preview.

## 11. Configuration and dependency changes

`packages/wallet-core/package.json` adds the pinned AbstractionKit dependency. Root `package.json` adds `tsx` exactly `4.21.0` and a `sepolia:smoke` script using `node --import tsx`. `package-lock.json` captures the resulting SDK/tool/transitive dependency changes. Existing viem remains in use. No new native module/plugin or backend dependency was introduced by this milestone.

The smoke runner uses Node's built-in `loadEnvFile`. The repository targets Node 24 via `.nvmrc`; root engines require at least 22.13. The local verification tool environment was Node 26.11.1, which produced a tsx/module registration deprecation notice. Team development should use the repository's Node target.

Mobile template:

```dotenv
EXPO_PUBLIC_CHAIN_ID=11155111
EXPO_PUBLIC_API_BASE_URL=http://localhost:8000
EXPO_PUBLIC_DEMO_ACCESS_TOKEN=
EXPO_PUBLIC_RPC_PUBLIC_URL=https://ethereum-sepolia-rpc.publicnode.com
EXPO_PUBLIC_BUNDLER_URL=https://api.candide.dev/public/v3/11155111
EXPO_PUBLIC_ERC20_TEST_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
```

All `EXPO_PUBLIC_*` values ship in the application bundle. Use only public/restricted testnet provider endpoints and a disposable local demo access token. Public endpoint availability/rate limits are outside the app's control. A replacement bundler must support EntryPoint v0.7. Restart Metro after changing environment values.

CLI template `config/sepolia.env.example`, copied to root `.env.sepolia`:

```dotenv
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
SEPOLIA_BUNDLER_URL=https://api.candide.dev/public/v3/11155111
SEPOLIA_TOKEN_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
SEPOLIA_RECIPIENT=
SEPOLIA_AMOUNT=1
SEPOLIA_SMOKE_KEY_FILE=.sepolia-owner.key
SEPOLIA_SMOKE_STATE_FILE=.sepolia-smoke.json
```

`.gitignore` adds default smoke JSON, temporary JSON and lock paths. Existing key/env ignore rules protect the default secret key and local env files. **Custom key/state paths are your responsibility:** ensure they are outside the repository or explicitly ignored. No real private key or local credential is included in this document or implementation commit.

`config/deployments.example.json` now describes the pinned Safe infrastructure, module setup, salt and token, leaves recovery/guardian fields null, and labels status `contract-presence-checked-transfer-unverified`. Legacy guardian fields describe future work; they are not enabled runtime functionality.

## 12. Every changed implementation file

| File                                                 | Detailed responsibility/change                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.gitignore`                                         | Ignore default pending/confirmed smoke state, its atomic-write temporary file and process lock.                                                      |
| `README.md`                                          | Update architecture/implementation status to distinguish integrated Safe transfers from pending funded/native acceptance.                            |
| `apps/mobile/.env.example`                           | Add usable public Sepolia RPC/bundler/test-token examples, document public configuration, remove Safe factory override.                              |
| `apps/mobile/src/components/Button.tsx`              | Add disabled interactions, visual opacity and accessibility disabled state.                                                                          |
| `apps/mobile/src/components/Screen.tsx`              | Label shared screen chrome `TESTNET`.                                                                                                                |
| `apps/mobile/src/features/transfer/SendScreen.tsx`   | Replace mock send with exact preview, protected signing, persistent pending status, manual confirmation checks, evidence and lifecycle cancellation. |
| `apps/mobile/src/features/wallet/WalletScreen.tsx`   | Show actual Safe address/deployment/balances, funding instructions, owner separately, refresh/focus loading and unconfigured recovery.               |
| `apps/mobile/src/lib/devReset.ts`                    | Extend existing development reset to clear Safe binding and transfer tracking.                                                                       |
| `apps/mobile/src/lib/wallet.ts`                      | Map the new configuration, funds, pending, expiry and verification errors to safe mobile messages.                                                   |
| `apps/mobile/src/lib/safeWallet.ts`                  | New service assembly, public SecureStore tracking, persisted account binding, tracking validation, last-confirmation reader and dev cleanup.         |
| `config/deployments.example.json`                    | Document pinned versions/addresses, helper/salt, six-decimal token and honest deployment verification status.                                        |
| `config/sepolia.env.example`                         | New disposable CLI configuration template.                                                                                                           |
| `docs/demo-script.md`                                | Update the demonstration to fund and send from the Safe, inspect actual proof and keep recovery as preview.                                          |
| `docs/getting-started.md`                            | Explain the integrated Safe/SDK stack, link the runbook and distinguish JS export from native/funded proof.                                          |
| `docs/sepolia-transaction.md`                        | New operational runbook: stack, funding, phone/CLI setup, status/retry handling, verification and acceptance limits.                                 |
| `package-lock.json`                                  | Reproducible dependency tree changes for AbstractionKit/tsx and their dependencies.                                                                  |
| `package.json`                                       | Add pinned tsx tool and `sepolia:smoke` command.                                                                                                     |
| `packages/wallet-core/README.md`                     | Explain the public owner/Safe APIs and milestone status.                                                                                             |
| `packages/wallet-core/errors.ts`                     | Add typed chain/network/Safe/transfer/funds/expiry/pending/verification errors.                                                                      |
| `packages/wallet-core/index.ts`                      | Export Safe predictor/constants/service and its public configuration/account/transfer/activity types.                                                |
| `packages/wallet-core/package.json`                  | Add AbstractionKit exactly 0.4.0.                                                                                                                    |
| `packages/wallet-core/safe/README.md`                | Explain deterministic pinned Safe construction and verification.                                                                                     |
| `packages/wallet-core/safe/account.ts`               | New pinned stack, config validation, Safe initialization/prediction, bounded RPC client and deployed Safe verification.                              |
| `packages/wallet-core/transactions/README.md`        | Explain the one-token-call service, signing/receipts and evidence requirements.                                                                      |
| `packages/wallet-core/transactions/erc20.ts`         | New ABI and exact decimal-to-unit transfer encoder.                                                                                                  |
| `packages/wallet-core/transactions/userOperation.ts` | New account/prepare/submit/confirm service, private prepared-operation map, gas/nonce checks, signature/pending handling and on-chain proof.         |
| `scripts/sepolia-smoke.ts`                           | New disposable CLI owner, atomic tracking, process lock and init/address/send/status commands.                                                       |
| `tests/wallet-core/safeTransfer.test.ts`             | New mocked-RPC/real-SDK coverage of deployment/transfer/signing, validation, cancellation, ambiguity, confirmation, expiry and failed proof.         |

The workspace navigation map `../docs/REPO_MAP.md` was also updated to describe these entry points, commands and implemented-versus-unverified status. It lives **outside this Git repository**, so it is a local workspace change rather than part of the pushed implementation commit. A full current copy is included in the final appendix for handoff completeness.

## 13. Public core API and records

```ts
const wallet = createSafeWallet({ config, storage, activity });
const account = await wallet.getAccount();
const preview = await wallet.prepareTransfer({ recipient, amount }, signal);
const submitted = await wallet.submitTransfer(preview, signal);
const confirmedOrNull = await wallet.confirmTransfer(submitted);
```

`config` supplies RPC URL, bundler URL and token address. `storage` supplies existing public-address access and a fresh protected private-key read; no UI dependency enters the core. `activity` supplies `readPending`, `writePending` and `writeConfirmed`.

`SafeAccountInfo` contains public addresses, deployment state, decimals and formatted balances. `TransferPreview` contains read-only identity/payload/fee/deployment/expiry fields. `SubmittedTransfer` contains public identity, raw amount/nonce/expiry strings and the UserOperation hash. `ConfirmedTransfer` adds transaction/explorer/block/balance proof and the delta comparison. Full exact interfaces appear in the source appendix.

## 14. New error codes and how to respond

| Code                   | Meaning / next action                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_CONFIG_INVALID` | Missing/invalid endpoint/token, wrong chain, unsupported EntryPoint or absent contract; correct configuration.                                 |
| `NETWORK_FAILED`       | Sanitized RPC/bundler failure; check network/endpoints. If tracking exists, check status before another send.                                  |
| `SAFE_CONFIG_INVALID`  | Saved/deployed Safe does not match expected owner/pinned configuration; investigate identity/stack, do not reset a funded wallet to bypass it. |
| `INVALID_TRANSFER`     | Invalid amount/recipient or constructed operation mismatch; fix input or investigate construction.                                             |
| `INSUFFICIENT_FUNDS`   | Insufficient Safe tokens or gas funding; fund the Safe and prepare again.                                                                      |
| `TRANSFER_EXPIRED`     | Expired/unknown preview, stale nonce, or a signed operation expired with unused nonce; obtain a fresh preview when pending is resolved.        |
| `TRANSFER_PENDING`     | A submit is in progress or prior pending tracking exists; use status instead of another transfer.                                              |
| `TRANSFER_FAILED`      | Matching on-chain operation reverted; no success is reported.                                                                                  |
| `VERIFICATION_FAILED`  | Hash, tracking identity, operation event, transfer event or Safe proof does not match; preserve evidence and investigate.                      |

Existing owner/authentication/storage/signing error codes are reused. Native authentication cancellation, unavailable/invalidated keys and storage failures remain distinct from chain errors. Raw provider exceptions are deliberately not displayed; debugging should check configuration and public transaction evidence rather than exposing secrets in logs.

## 15. Automated and live validation performed

| Check                                                            | Result / what it proves                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                              | Passed for the workspaces.                                                                                       |
| `npm run lint`                                                   | Passed for mobile.                                                                                               |
| `npm run format:check`                                           | Passed; repository Prettier ignore rules apply, including README/lockfile exclusions.                            |
| `git diff --check`                                               | Passed.                                                                                                          |
| `npm test -- --reporter=dot`                                     | Six test files passed; 61 tests passed, one skipped, 62 total.                                                   |
| Standalone strict TypeScript check for smoke script + Safe tests | Passed; complements workspace typecheck.                                                                         |
| Expo export for all platforms                                    | Android/iOS Hermes and web exports passed.                                                                       |
| Live `address` on public Sepolia                                 | RPC/bundler chain and EntryPoint support, required code presence, token decimals and unfunded balances verified. |
| Live `send` with unfunded disposable Safe                        | Correctly refused `INSUFFICIENT_FUNDS` before signing/broadcast.                                                 |

Commands used for the extra checks:

```bash
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --types node scripts/sepolia-smoke.ts tests/wallet-core/safeTransfer.test.ts
# From apps/mobile:
CI=1 node ../../node_modules/expo/bin/cli export --platform all --output-dir /tmp/sq-safe-export
```

Metro reported the upstream `@noble/hashes/crypto.js` export-resolution warning and used its file fallback. No dependency patch was applied. Exporting bundles does not install/run the app, exercise biometrics, prove a deployed Safe or execute a live ERC-20 call.

The read-only disposable CLI owner was `0xd6e1d951735213823CA16Cb316289A6a6d3A773E`; its predicted Safe was `0x9366615Dc43ecb3624d3536C82B5e0AEcD591009`. That Safe was undeployed with zero ETH and token balance; token decimals were six. These are public test addresses, not the phone's addresses. No funds are required at those old test addresses to test a newly created phone wallet.

The new Safe test file expands to 17 cases including parameterized invalid amounts. It uses mock RPC/bundler responses with actual SDK operation/signature construction and independent signer recovery. It covers first-deployment data versus an existing Safe, wrong chain/configuration, insufficient funds, exact amount encoding, zero recipient, authentication abort, owner/key mismatch, stale nonce/preview, forged preview identity, pending persistence after ambiguous timeout and service recreation, two-confirmation waiting, unused-nonce expiry versus unresolved used nonce, inner operation failure despite outer transaction success, and missing transfer evidence.

This is not an EVM integration test: mocked bytecode/storage/receipts cannot prove real factory deployment or token execution. Existing backend tests were not needed for the transaction-only change because no backend code changed.

## 16. Phone test: exact starting procedure

From the repository root on the developer machine:

```bash
git pull --ff-only origin main
nvm use
npm ci
cp apps/mobile/.env.example apps/mobile/.env
```

Keep an existing local `.env` instead of overwriting it; compare it with the new template. Configure the public Sepolia RPC/bundler/token values above. For new owner onboarding, use the existing backend wallet-link flow: set `EXPO_PUBLIC_API_BASE_URL` to the computer's reachable LAN address on a physical phone, and set the Expo demo token to match the backend's disposable `MOCK_ACCESS_TOKEN`.

If the backend is not running, its existing setup is:

```bash
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements-dev.txt
export MOCK_USER_ID=demo-user
export MOCK_ACCESS_TOKEN='<one-disposable-demo-token-at-least-32-characters>'
python -m uvicorn app.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

Use the same actual disposable token in the local mobile environment; the placeholder above is not a real credential. The backend does not automatically load `.env` files. `localhost` on a phone refers to the phone, not the computer. An already linked wallet's direct RPC transfer flow does not require the backend to sign or broadcast.

Build/install the existing development app with the appropriate native toolchain:

```bash
npm run mobile:android
# Or, on macOS with Xcode:
npm run mobile:ios
# Start Metro for the installed development client:
npm run mobile
```

The change adds no native dependency/plugin, but the protected-key acceptance test must use a development build on a real device with its device authentication configured. Expo Go/web exports are not evidence that the protected phone flow works. Restart Metro after environment changes.

On the phone:

1. Create/use the existing owner and complete existing linking if requested.
2. Open Wallet and record the owner and **Safe address**. Check that a new Safe is described as reserved/undeployed.
3. Fund that Safe with the configured Sepolia test token and Sepolia ETH. Approximately 0.01 test ETH is a starting amount for deployment; the actual prepare gas estimate controls sufficiency. Funding is independent of the outgoing transfer.
4. Refresh and verify actual balances appear. Use an independent recipient with no concurrent token activity for clean balance evidence.
5. Enter `1` token and the recipient, then prepare. Inspect Safe, token address, recipient, exact amount, maximum gas and deployment notice.
6. Select **Authenticate & send** and complete native authentication.
7. Use **Check status** until the matching operation has two confirmations. Do not resend after a timeout or an unknown response.
8. Record the UserOperation hash, transaction hash/explorer link, deployed Safe configuration and before/after balances. The sender should decrease by one token and the recipient should increase by one for an isolated block comparison.
9. Restart the app: the same owner/Safe and last proof must persist. If still pending, it must resume status tracking rather than offer a duplicate send.

## 17. CLI smoke procedure and internals

The CLI is an additional chain test with a **separate disposable owner**, not a way to export the phone's key:

```bash
cp config/sepolia.env.example .env.sepolia
npm run sepolia:smoke -- init
npm run sepolia:smoke -- address
# Fund the printed Safe and set SEPOLIA_RECIPIENT, then:
npm run sepolia:smoke -- send
# After a timeout/disconnection:
npm run sepolia:smoke -- status
```

`init` creates a fresh key with exclusive creation and mode 0600 and refuses overwrite. It prints only public addresses. `address` checks live configuration and balances. `send` prepares, signs and broadcasts the configured transfer. `status` resumes the existing operation instead of creating another one.

State persists through a temporary file plus atomic rename, with mode 0600. The entire command holds an exclusive `${stateFile}.lock` file to prevent multiple CLI processes racing. A crash can leave a stale lock; inspect tracking before manually removing that lock. Do not delete pending state to force a retry.

The runner polls every three seconds for up to 180 seconds. Timeout leaves tracking intact and exits nonzero. Confirmed mismatching block deltas also exit nonzero. Exceptions display safe wallet errors or a generic diagnostic, never raw key/provider contents. Its file key does not provide phone biometrics; that remains a separate test.

## 18. Acceptance matrix and remaining limits

| Scenario                                                  | Expected result                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Fresh Safe, sufficient ETH/tokens                         | First UserOperation deploys Safe and transfers exact units; core verifies configuration/events. |
| Existing verified Safe                                    | No new deployment, exact token transfer with current nonce.                                     |
| Authentication cancelled                                  | No send before broadcast; private key not exposed; prepare can be retried.                      |
| Preview older than two minutes                            | Rejected; new preview required.                                                                 |
| Input edited / navigation / actual background before send | Review invalidated/cancelled; no stale operation intentionally sent.                            |
| RPC/bundler wrong chain or no v0.7 support                | Reject configuration before signing.                                                            |
| Insufficient tokens or gas                                | Refuse prepare with funding guidance.                                                           |
| Submit response times out                                 | Keep expected-hash tracking; status, not resend.                                                |
| Restart during pending                                    | Recover public tracking and continue status checks.                                             |
| Matching inner operation fails                            | Never show success despite successful outer bundle.                                             |
| Missing/mismatched transfer or Safe proof                 | Verification error; investigate evidence.                                                       |
| Signature expired and nonce unused                        | Release tracking only after on-chain expiry plus buffer.                                        |
| Nonce used but receipt unavailable                        | Keep pending; manual investigation needed.                                                      |
| Key invalidated or different owner                        | Fail protected signing; never silently switch funded Safe.                                      |
| Reset funded wallet                                       | Deletes implemented access to assets; no recovery in this milestone.                            |

The implementation is a test milestone, not production wallet hardening. Remaining concrete limits are native authentication behavior, live execution, public-provider uptime, reliance on bundler receipt discovery, no complete reorg/finality handling, no full bytecode/configuration audit, no recovery/paymaster, one configured ERC-20, only last-confirmed storage, and no full transaction-history synchronization. Balance proof uses block snapshots, which can include unrelated same-block activity. Key references are cleared but JS memory is not guaranteed zeroized.

After the first funded phone transfer, record its public evidence and update status documentation. Do not mark funded/device acceptance complete based only on the mock tests or exports.

## 19. Reference documents

The repository's short operating runbook is `docs/sepolia-transaction.md`; setup is `docs/getting-started.md`; demo is `docs/demo-script.md`. The README describes target architecture, including later recovery, while this handoff describes only the implemented transfer milestone. Older supporting recovery designs and null guardian fields are future work.

External references used for stack/token selection: [Safe ERC-4337](https://docs.safe.global/advanced/erc-4337/4337-safe), [Candide Safe v0.7 account](https://docs.candide.dev/wallet/abstractionkit/safe-account-v3/), [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), and [Circle test faucet](https://faucet.circle.com/). Provider/examples can change; the runtime compatibility checks remain the operational gate.

## Appendix A. Complete implementation diff

The following contains the complete patch from the base commit to `2ac6912`. Markdown formatting removes the context marker on otherwise blank diff lines; all source changes remain intact. To obtain an apply-ready patch, run `git diff 2ac6912^ 2ac6912`. It includes every one of the 28 changed files, full new-file contents, and lockfile changes. Existing-file hunks show changed context; unchanged infrastructure (protected-key adapter, crypto bootstrap, backend linking) is explained above and remains in the base repository. This document is excluded from its own appendix to avoid recursion.

````diff
diff --git a/.gitignore b/.gitignore
index 2489f72..ac227a6 100644
--- a/.gitignore
+++ b/.gitignore
@@ -73,3 +73,8 @@ Desktop.ini
 .agents/
 .codex/
 .aws/
+
+# Local Sepolia smoke evidence and tracking
+.sepolia-smoke.json
+.sepolia-smoke.json.tmp
+.sepolia-smoke.json.lock
diff --git a/README.md b/README.md
index d75f6ef..dabed00 100644
--- a/README.md
+++ b/README.md
@@ -1051,10 +1051,10 @@ Le brief demande de **déclarer les outils d'IA utilisés et leur rôle**. La li

 ## Statut du projet

-**Prototype Milestone 1 livré ; acceptation sur appareil réel et blockchain encore à prouver.**
+**Milestone 1 livré ; flux transaction Safe/ERC-4337 implémenté, acceptation financée sur Sepolia et appareil réel encore à prouver.**

-- **Implémenté :** création EOA et signature/vérification EIP-191 via viem ; adaptateur SecureStore protégé, startup et écran de signature ; annulation sur background/navigation ; API de métadonnées SQLite avec token de démonstration configuré côté serveur et validation stricte. Soldes/transferts restent mockés ; le mobile n'appelle pas encore FastAPI. Voir [getting-started](docs/getting-started.md) et [backend](backend/README.md).
-- **Non implémenté :** preuve de contrôle on-chain, Recovery Kit hors ligne, déploiement Safe, signatures guardian et recovery. Les endpoints backend recovery refusent de procéder (`501`) au lieu de produire une fausse approval.
+- **Implémenté :** création EOA et signature/vérification EIP-191 via viem ; adaptateur SecureStore protégé, startup et écran de signature ; annulation sur background/navigation ; API de métadonnées SQLite avec token de démonstration configuré côté serveur et validation stricte. Wallet/Send lisent les soldes Safe et construisent/signent/soumettent les transferts ERC-20 Sepolia via RPC/bundler configurés ; voir [runbook transaction](docs/sepolia-transaction.md). Voir [getting-started](docs/getting-started.md) et [backend](backend/README.md).
+- **Non implémenté :** preuve de contrôle on-chain, Recovery Kit hors ligne, signatures guardian et recovery. Le code de déploiement Safe et de transfert est implémenté mais pas encore démontré avec une Safe financée sur Sepolia. Les endpoints backend recovery refusent de procéder (`501`) au lieu de produire une fausse approval.

 - **Décidé :** Expo/React Native, EOA client locale avec Face ID/biométrie à la signature, ClientSafe, **3 guardians directs SQ/A/B, recovery 2/3**, contestation **7 jours on-chain**, FastAPI, Sepolia.
 - **Proposé :** watcher des événements de recovery + alertes push/email/SMS/in-app ; signer Swissquote testnet isolé ; Safe institutionnelle ERC-1271 facultative.
diff --git a/apps/mobile/.env.example b/apps/mobile/.env.example
index 7a6c481..af26a65 100644
--- a/apps/mobile/.env.example
+++ b/apps/mobile/.env.example
@@ -5,7 +5,9 @@ EXPO_PUBLIC_API_BASE_URL=http://localhost:8000
 # Disposable demo token = the backend's MOCK_ACCESS_TOKEN. It is bundled into the
 # app and readable by anyone with the build: local demo builds only, never a real credential.
 EXPO_PUBLIC_DEMO_ACCESS_TOKEN=
-EXPO_PUBLIC_RPC_PUBLIC_URL=
-EXPO_PUBLIC_ERC20_TEST_ADDRESS=
-EXPO_PUBLIC_CLIENT_SAFE_FACTORY=
+EXPO_PUBLIC_RPC_PUBLIC_URL=https://ethereum-sepolia-rpc.publicnode.com
+# Public/restricted testnet endpoint only; privileged provider credentials stay off-device.
+EXPO_PUBLIC_BUNDLER_URL=https://api.candide.dev/public/v3/11155111
+EXPO_PUBLIC_ERC20_TEST_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
+# Safe contracts and salt are pinned in wallet-core; no factory override.
 # Never place private keys or privileged API credentials in EXPO_PUBLIC_*.
diff --git a/apps/mobile/src/components/Button.tsx b/apps/mobile/src/components/Button.tsx
index 66120de..6e7835c 100644
--- a/apps/mobile/src/components/Button.tsx
+++ b/apps/mobile/src/components/Button.tsx
@@ -1,11 +1,24 @@
 import { Pressable, Text } from 'react-native';

-type Props = { label: string; onPress: () => void; secondary?: boolean };
+type Props = {
+  label: string;
+  onPress: () => void;
+  secondary?: boolean;
+  disabled?: boolean;
+};

-export function Button({ label, onPress, secondary = false }: Props) {
+export function Button({
+  label,
+  onPress,
+  secondary = false,
+  disabled = false,
+}: Props) {
   return (
     <Pressable
       accessibilityRole="button"
+      accessibilityState={{ disabled }}
+      disabled={disabled}
+      style={disabled ? { opacity: 0.5 } : undefined}
       onPress={onPress}
       className={`rounded-2xl px-5 py-4 border active:opacity-70 ${
         secondary ? 'bg-white border-line' : 'bg-accent border-accent'
diff --git a/apps/mobile/src/components/Screen.tsx b/apps/mobile/src/components/Screen.tsx
index 8ab5abe..f162c2b 100644
--- a/apps/mobile/src/components/Screen.tsx
+++ b/apps/mobile/src/components/Screen.tsx
@@ -11,7 +11,7 @@ export function Screen({ children }: PropsWithChildren) {
       <ScrollView contentContainerClassName="grow p-6 gap-6">
         <View className="self-start rounded-full bg-white px-3 py-2 border border-line">
           <Text className="text-xs font-semibold text-muted">
-            UI MOCK · SEPOLIA
+            TESTNET · SEPOLIA
           </Text>
         </View>
         {children}
diff --git a/apps/mobile/src/features/transfer/SendScreen.tsx b/apps/mobile/src/features/transfer/SendScreen.tsx
index 0c4213e..2923d2f 100644
--- a/apps/mobile/src/features/transfer/SendScreen.tsx
+++ b/apps/mobile/src/features/transfer/SendScreen.tsx
@@ -1,67 +1,274 @@
-import { useState } from 'react';
-import { Text, TextInput, View } from 'react-native';
+import type {
+  ConfirmedTransfer,
+  SubmittedTransfer,
+  TransferPreview,
+  Address,
+} from '@swissquote/wallet-core';
+import * as Linking from 'expo-linking';
+import { useFocusEffect } from 'expo-router';
+import { useCallback, useRef, useState } from 'react';
+import { AppState, Text, TextInput, View } from 'react-native';
 import { Button } from '../../components/Button';
 import { Screen } from '../../components/Screen';
+import {
+  getSafeAccount,
+  getSafeWallet,
+  readLastTransfer,
+  transferActivity,
+} from '../../lib/safeWallet';
+import { describeWalletError } from '../../lib/wallet';

 export default function SendScreen() {
   const [recipient, setRecipient] = useState('');
   const [amount, setAmount] = useState('');
-  const [preview, setPreview] = useState(false);
+  const [preview, setPreview] = useState<TransferPreview | null>(null);
+  const [pendingTransfer, setPendingTransfer] =
+    useState<SubmittedTransfer | null>(null);
+  const [result, setResult] = useState<ConfirmedTransfer | null>(null);
+  const [busy, setBusy] = useState(false);
+  const [error, setError] = useState<string | null>(null);
+  const focused = useRef(false);
+  const request = useRef<AbortController | null>(null);
+
+  useFocusEffect(
+    useCallback(() => {
+      focused.current = true;
+      setBusy(request.current !== null);
+      setPreview(null);
+      void Promise.all([transferActivity.readPending(), readLastTransfer()])
+        .then(([pending, last]) => {
+          if (focused.current) {
+            setPendingTransfer(pending);
+            setResult(last);
+          }
+        })
+        .catch((e: unknown) => {
+          if (focused.current) setError(describeWalletError(e));
+        });
+      const subscription = AppState.addEventListener('change', (state) => {
+        if (state === 'background') {
+          request.current?.abort();
+          setPreview(null);
+        }
+      });
+      return () => {
+        focused.current = false;
+        request.current?.abort();
+        subscription.remove();
+      };
+    }, []),
+  );
+
+  async function run(action: (signal: AbortSignal) => Promise<void>) {
+    if (
+      request.current ||
+      !focused.current ||
+      AppState.currentState !== 'active'
+    )
+      return;
+    const controller = new AbortController();
+    request.current = controller;
+    setBusy(true);
+    setError(null);
+    try {
+      await action(controller.signal);
+    } catch (e) {
+      if (focused.current) setError(describeWalletError(e));
+    } finally {
+      try {
+        const pending = await transferActivity.readPending();
+        if (focused.current) setPendingTransfer(pending);
+      } catch (e) {
+        if (focused.current) setError(describeWalletError(e));
+      }
+      request.current = null;
+      if (focused.current) setBusy(false);
+    }
+  }
+  async function checkStatus(submitted: SubmittedTransfer) {
+    const confirmed = await getSafeWallet().confirmTransfer(submitted);
+    if (!focused.current) return;
+    if (confirmed) {
+      setResult(confirmed);
+      setPreview(null);
+      setPendingTransfer(null);
+    } else setError('Not confirmed yet. Check again shortly; do not resend.');
+  }
+  function edit(set: (value: string) => void, value: string) {
+    request.current?.abort();
+    set(value);
+    setPreview(null);
+    setError(null);
+  }

   return (
     <Screen>
-      <Text className="text-2xl font-bold text-ink">Send demo USDC</Text>
+      <Text className="text-2xl font-bold text-ink">Send test tokens</Text>
+      <Text className="text-sm text-muted">
+        Sepolia only · Gas paid with your Safe’s test ETH
+      </Text>
       <View className="gap-3">
         <Text className="text-base text-ink">Recipient</Text>
         <TextInput
           accessibilityLabel="Recipient address"
-          placeholder="Recipient address"
+          placeholder="0x…"
           placeholderTextColor="#596574"
           autoCapitalize="none"
           autoCorrect={false}
+          editable={!busy && !pendingTransfer}
           value={recipient}
-          onChangeText={(value) => {
-            setRecipient(value);
-            setPreview(false);
-          }}
+          onChangeText={(value) => edit(setRecipient, value)}
           className="bg-white rounded-2xl border border-line p-4 text-base text-ink"
         />
         <Text className="text-base text-ink">Amount</Text>
         <TextInput
-          accessibilityLabel="Amount in demo USDC"
+          accessibilityLabel="Amount in test tokens"
           placeholder="0.00"
           placeholderTextColor="#596574"
           keyboardType="decimal-pad"
+          editable={!busy && !pendingTransfer}
           value={amount}
-          onChangeText={(value) => {
-            setAmount(value);
-            setPreview(false);
-          }}
+          onChangeText={(value) => edit(setAmount, value)}
           className="bg-white rounded-2xl border border-line p-4 text-base text-ink"
         />
       </View>
-      <Button label="Preview mock transfer" onPress={() => setPreview(true)} />
-      {preview && (
+      {!pendingTransfer && (
+        <Button
+          label={busy ? 'Working…' : 'Preview transfer'}
+          disabled={busy}
+          onPress={() =>
+            void run(async (signal) => {
+              setPreview(null);
+              await getSafeAccount();
+              const next = await getSafeWallet().prepareTransfer(
+                {
+                  recipient: recipient.trim() as Address,
+                  amount: amount.trim(),
+                },
+                signal,
+              );
+              if (focused.current && !signal.aborted) {
+                setPreview(next);
+                setResult(null);
+              }
+            })
+          }
+        />
+      )}
+      {preview && !pendingTransfer && (
         <View
           accessibilityLiveRegion="polite"
           className="bg-white border border-line rounded-3xl p-6 gap-3"
         >
-          <Text className="text-lg font-semibold text-ink">Preview only</Text>
+          <Text className="text-lg font-semibold text-ink">
+            Review transfer
+          </Text>
           <Text className="text-base text-muted">
-            Amount: {amount || '—'} demo USDC
+            Amount: {preview.amount} test tokens
           </Text>
-          <Text selectable className="text-base text-muted">
-            Recipient: {recipient || '—'}
+          <Text selectable className="text-sm text-muted">
+            Recipient: {preview.recipient}
           </Text>
-          <Text className="text-base text-muted">
-            Network: Sepolia · Fees: not estimated
+          <Text selectable className="text-sm text-muted">
+            Token: {preview.tokenAddress}
           </Text>
+          <Text selectable className="text-sm text-muted">
+            From Safe: {preview.safeAddress}
+          </Text>
+          <Text className="text-sm text-muted">
+            Maximum gas: {preview.maxGasEth} Sepolia ETH
+          </Text>
+          <Text className="text-sm text-muted">
+            Gas estimated by bundler.{' '}
+            {preview.deploysSafe
+              ? 'This also deploys your Safe.'
+              : 'Your Safe is deployed.'}
+          </Text>
+          <Button
+            label={busy ? 'Signing / submitting…' : 'Authenticate & send'}
+            disabled={busy}
+            onPress={() =>
+              void run(async (signal) => {
+                const submitted = await getSafeWallet().submitTransfer(
+                  preview,
+                  signal,
+                );
+                if (focused.current) {
+                  setPendingTransfer(submitted);
+                  setPreview(null);
+                }
+                await checkStatus(submitted);
+              })
+            }
+          />
+        </View>
+      )}
+      {pendingTransfer && (
+        <View className="bg-white border border-line rounded-3xl p-6 gap-3">
+          <Text className="text-lg font-semibold text-ink">
+            Awaiting confirmation
+          </Text>
+          <Text className="text-sm text-muted">
+            Submission may have succeeded even if the connection dropped. Check
+            this operation before sending again.
+          </Text>
+          <Text selectable className="text-xs text-ink">
+            {pendingTransfer.userOperationHash}
+          </Text>
+          <Button
+            label={busy ? 'Checking…' : 'Check status'}
+            disabled={busy}
+            onPress={() => void run(async () => checkStatus(pendingTransfer))}
+          />
+        </View>
+      )}
+      {error && (
+        <Text
+          accessibilityLiveRegion="polite"
+          className="text-base text-accent"
+        >
+          {error}
+        </Text>
+      )}
+      {result && (
+        <View
+          accessibilityLiveRegion="polite"
+          className="bg-white border border-line rounded-3xl p-6 gap-3"
+        >
+          <Text className="text-lg font-semibold text-ink">
+            Transfer confirmed on Sepolia
+          </Text>
+          <Text className="text-sm text-muted">
+            Two confirmations · Safe configuration and Transfer event verified
+          </Text>
+          <Text selectable className="text-xs text-ink">
+            {result.transactionHash}
+          </Text>
+          <Text className="text-sm text-muted">
+            Safe balance: {result.senderBalanceBefore} →{' '}
+            {result.senderBalanceAfter}
+          </Text>
+          <Text className="text-sm text-muted">
+            Recipient balance: {result.recipientBalanceBefore} →{' '}
+            {result.recipientBalanceAfter}
+          </Text>
+          {!result.balanceChangesMatch && (
+            <Text className="text-sm text-muted">
+              Block balance changes differ from this transfer; other activity
+              may have occurred in the same block.
+            </Text>
+          )}
+          <Button
+            label="View on Sepolia explorer"
+            secondary
+            onPress={() => {
+              void Linking.openURL(
+                `https://sepolia.etherscan.io/tx/${result.transactionHash}`,
+              ).catch(() => setError('Could not open the explorer.'));
+            }}
+          />
         </View>
       )}
-      <Text className="text-sm leading-5 text-muted">
-        Form preview only. Validation, simulation and local signing are not
-        connected. Nothing is sent.
-      </Text>
     </Screen>
   );
 }
diff --git a/apps/mobile/src/features/wallet/WalletScreen.tsx b/apps/mobile/src/features/wallet/WalletScreen.tsx
index fd2ecae..ec640e4 100644
--- a/apps/mobile/src/features/wallet/WalletScreen.tsx
+++ b/apps/mobile/src/features/wallet/WalletScreen.tsx
@@ -1,17 +1,19 @@
 import { SEPOLIA } from '@swissquote/wallet-core';
-import { router } from 'expo-router';
+import { router, useFocusEffect } from 'expo-router';
+import { useCallback, useEffect, useState } from 'react';
+import type { SafeAccountInfo } from '@swissquote/wallet-core';
 import { Alert, Text, View } from 'react-native';
 import { Button } from '../../components/Button';
 import { Screen } from '../../components/Screen';
 import { useOwnerAddress } from '../../hooks/useOwnerAddress';
 import { resetWalletForDev } from '../../lib/devReset';
 import { describeWalletError } from '../../lib/wallet';
-import { mockWallet } from './mock';
+import { getSafeAccount } from '../../lib/safeWallet';

 function confirmDevReset() {
   Alert.alert(
     'Reset wallet?',
-    'Development only. This deletes the key on this phone for good. You will create and link a new wallet.',
+    'Development only. This permanently deletes the key and Safe tracking on this phone. Any assets in the old Safe become inaccessible. You will create and link a new wallet.',
     [
       { text: 'Cancel', style: 'cancel' },
       {
@@ -31,24 +33,79 @@ function confirmDevReset() {

 export default function WalletScreen() {
   const { address, error } = useOwnerAddress();
+  const [account, setAccount] = useState<SafeAccountInfo | null>(null);
+  const [chainError, setChainError] = useState<string | null>(null);
+  const [attempt, setAttempt] = useState(0);
+  useFocusEffect(
+    useCallback(() => {
+      setAttempt((value) => value + 1);
+    }, []),
+  );
+  useEffect(() => {
+    let active = true;
+    void getSafeAccount()
+      .then((info) => {
+        if (active) {
+          setAccount(info);
+          setChainError(null);
+        }
+      })
+      .catch((e: unknown) => {
+        if (active) {
+          setAccount(null);
+          setChainError(describeWalletError(e));
+        }
+      });
+    return () => {
+      active = false;
+    };
+  }, [attempt]);
   return (
     <Screen>
       <View className="rounded-3xl bg-ink p-6 gap-3">
-        <Text className="text-white text-sm">Sample balance</Text>
+        <Text className="text-white text-sm">Safe test-token balance</Text>
         <Text className="text-white text-4xl font-bold">
-          {mockWallet.balance}
+          {account?.tokenBalance ?? '—'}
         </Text>
         <Text className="text-white text-base">
-          {mockWallet.token} · {SEPOLIA.name}
+          Test tokens · {SEPOLIA.name}
         </Text>
       </View>
       <Button label="Send" onPress={() => router.push('/send')} />
       <View className="bg-white border border-line rounded-3xl p-6 gap-3">
         <Text className="text-lg font-semibold text-ink">Receive</Text>
         <Text className="text-base leading-6 text-muted">
-          No receiving address yet. Your wallet must be created and verified
-          before you can receive test tokens.
+          {account
+            ? account.deployed
+              ? 'Safe deployed and configuration verified.'
+              : 'Safe address reserved. Your first transfer deploys it.'
+            : 'Configure the Sepolia connection to load your Safe.'}
         </Text>
+        {account && (
+          <>
+            <Text selectable className="text-sm text-ink">
+              {account.safeAddress}
+            </Text>
+            <Text className="text-sm text-muted">
+              Gas balance: {account.ethBalance} Sepolia ETH
+            </Text>
+            <Text selectable className="text-xs text-muted">
+              Test-token contract: {account.tokenAddress}
+            </Text>
+            <Text className="text-sm text-muted">
+              Fund this Safe address with Sepolia ETH and the configured test
+              token.
+            </Text>
+          </>
+        )}
+        {chainError && (
+          <Text className="text-sm text-accent">{chainError}</Text>
+        )}
+        <Button
+          label="Refresh balances"
+          secondary
+          onPress={() => setAttempt((value) => value + 1)}
+        />
       </View>
       <View className="bg-white border border-line rounded-3xl p-6 gap-3">
         <Text className="text-lg font-semibold text-ink">Owner address</Text>
@@ -77,7 +134,7 @@ export default function WalletScreen() {
         />
       )}
       <Text className="text-sm text-muted">
-        No activity yet. This balance is sample data.
+        Sepolia testnet only. Recovery is not configured for this milestone.
       </Text>
     </Screen>
   );
diff --git a/apps/mobile/src/lib/devReset.ts b/apps/mobile/src/lib/devReset.ts
index 94f7a0d..adab06c 100644
--- a/apps/mobile/src/lib/devReset.ts
+++ b/apps/mobile/src/lib/devReset.ts
@@ -1,8 +1,10 @@
 // Development builds only: wipes this phone's wallet to replay onboarding.
 import { clearWalletLinked } from './linkStatus';
 import { deleteOwnerWalletForDev } from './secureStoreAdapter';
+import { clearSafeForDev } from './safeWallet';

 export async function resetWalletForDev(): Promise<void> {
   await clearWalletLinked();
   await deleteOwnerWalletForDev();
+  await clearSafeForDev();
 }
diff --git a/apps/mobile/src/lib/safeWallet.ts b/apps/mobile/src/lib/safeWallet.ts
new file mode 100644
index 0000000..6820d90
--- /dev/null
+++ b/apps/mobile/src/lib/safeWallet.ts
@@ -0,0 +1,151 @@
+import './polyfills';
+import {
+  createSafeWallet,
+  SAFE_DEPLOYMENT,
+  WalletError,
+  type SafeAccountInfo,
+  type SubmittedTransfer,
+  type ConfirmedTransfer,
+  type TransferActivityStore,
+  type Address,
+} from '@swissquote/wallet-core';
+import * as SecureStore from 'expo-secure-store';
+import { isAddress, isAddressEqual } from 'viem';
+import { secureStoreAdapter } from './secureStoreAdapter';
+
+const OPTIONS: SecureStore.SecureStoreOptions = {
+  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
+};
+const ACCOUNT_KEY = 'swissquote.safe.account.v1';
+const PENDING_KEY = 'swissquote.safe.pending.v1';
+const CONFIRMED_KEY = 'swissquote.safe.confirmed.v1';
+
+function validSubmission(value: SubmittedTransfer): boolean {
+  return (
+    value !== null &&
+    typeof value === 'object' &&
+    [
+      value.ownerAddress,
+      value.safeAddress,
+      value.tokenAddress,
+      value.recipient,
+    ].every(
+      (address) =>
+        typeof address === 'string' && isAddress(address, { strict: false }),
+    ) &&
+    /^0x[\da-fA-F]{64}$/.test(value.userOperationHash) &&
+    /^\d+$/.test(value.amountUnits) &&
+    /^\d+$/.test(value.nonce) &&
+    /^\d+$/.test(value.validUntil) &&
+    Number.isInteger(value.decimals) &&
+    value.decimals >= 0 &&
+    value.decimals <= 255
+  );
+}
+async function readTracking<T extends SubmittedTransfer>(
+  key: string,
+): Promise<T | null> {
+  try {
+    const json = await SecureStore.getItemAsync(key, OPTIONS);
+    if (json === null) return null;
+    const value = JSON.parse(json) as T;
+    if (!validSubmission(value)) throw new Error();
+    return value;
+  } catch {
+    throw new WalletError(
+      'STORAGE_FAILED',
+      'Could not read transfer tracking.',
+    );
+  }
+}
+async function writeTracking(key: string, value: SubmittedTransfer | null) {
+  try {
+    if (value === null) await SecureStore.deleteItemAsync(key, OPTIONS);
+    else await SecureStore.setItemAsync(key, JSON.stringify(value), OPTIONS);
+  } catch {
+    throw new WalletError(
+      'STORAGE_FAILED',
+      'Could not save transfer tracking.',
+    );
+  }
+}
+export const transferActivity: TransferActivityStore = {
+  readPending: () => readTracking(PENDING_KEY),
+  writePending: (value) => writeTracking(PENDING_KEY, value),
+  writeConfirmed: (value) => writeTracking(CONFIRMED_KEY, value),
+};
+export async function readLastTransfer(): Promise<ConfirmedTransfer | null> {
+  const result = await readTracking<ConfirmedTransfer>(CONFIRMED_KEY);
+  if (result && !/^0x[\da-fA-F]{64}$/.test(result.transactionHash))
+    throw new WalletError('STORAGE_FAILED', 'Invalid transaction tracking.');
+  return result;
+}
+
+let service: ReturnType<typeof createSafeWallet> | undefined;
+export function getSafeWallet() {
+  if (
+    process.env.EXPO_PUBLIC_CHAIN_ID !== undefined &&
+    process.env.EXPO_PUBLIC_CHAIN_ID !== '11155111'
+  )
+    throw new WalletError(
+      'CHAIN_CONFIG_INVALID',
+      'This build only supports Sepolia.',
+    );
+  service ??= createSafeWallet({
+    config: {
+      rpcUrl: process.env.EXPO_PUBLIC_RPC_PUBLIC_URL ?? '',
+      bundlerUrl: process.env.EXPO_PUBLIC_BUNDLER_URL ?? '',
+      tokenAddress: (process.env.EXPO_PUBLIC_ERC20_TEST_ADDRESS ??
+        '') as Address,
+    },
+    storage: secureStoreAdapter,
+    activity: transferActivity,
+  });
+  return service;
+}
+
+/** Persist public account identity; fail instead of silently changing a funded Safe. */
+export async function getSafeAccount(): Promise<SafeAccountInfo> {
+  const info = await getSafeWallet().getAccount();
+  const binding = {
+    ownerAddress: info.ownerAddress,
+    safeAddress: info.safeAddress,
+    chainId: SAFE_DEPLOYMENT.chainId,
+    stack: 'safe-1.4.1-module-0.3.0-entrypoint-0.7-salt-0',
+  };
+  try {
+    const json = await SecureStore.getItemAsync(ACCOUNT_KEY, OPTIONS);
+    if (json !== null) {
+      const saved = JSON.parse(json) as typeof binding;
+      if (
+        !isAddressEqual(saved.ownerAddress, binding.ownerAddress) ||
+        !isAddressEqual(saved.safeAddress, binding.safeAddress) ||
+        saved.chainId !== binding.chainId ||
+        saved.stack !== binding.stack
+      )
+        throw new WalletError(
+          'SAFE_CONFIG_INVALID',
+          'The saved Safe belongs to another owner or configuration.',
+        );
+    } else
+      await SecureStore.setItemAsync(
+        ACCOUNT_KEY,
+        JSON.stringify(binding),
+        OPTIONS,
+      );
+  } catch (e) {
+    if (e instanceof WalletError) throw e;
+    throw new WalletError(
+      'STORAGE_FAILED',
+      'Could not persist the Safe address.',
+    );
+  }
+  return info;
+}
+
+export async function clearSafeForDev() {
+  if (!__DEV__)
+    throw new WalletError('NOT_IMPLEMENTED', 'Reset is for development only.');
+  for (const key of [ACCOUNT_KEY, PENDING_KEY, CONFIRMED_KEY])
+    await SecureStore.deleteItemAsync(key, OPTIONS);
+}
diff --git a/apps/mobile/src/lib/wallet.ts b/apps/mobile/src/lib/wallet.ts
index cd799b4..4bad372 100644
--- a/apps/mobile/src/lib/wallet.ts
+++ b/apps/mobile/src/lib/wallet.ts
@@ -41,6 +41,16 @@ export function describeWalletError(e: unknown): string {
         return 'The message cannot be signed.';
       case 'SIGNING_FAILED':
         return 'Signing failed. Nothing was returned.';
+      case 'CHAIN_CONFIG_INVALID':
+      case 'NETWORK_FAILED':
+      case 'SAFE_CONFIG_INVALID':
+      case 'INVALID_TRANSFER':
+      case 'INSUFFICIENT_FUNDS':
+      case 'TRANSFER_EXPIRED':
+      case 'TRANSFER_PENDING':
+      case 'TRANSFER_FAILED':
+      case 'VERIFICATION_FAILED':
+        return e.message;
       default:
         return 'Storage error. Please try again.';
     }
diff --git a/config/deployments.example.json b/config/deployments.example.json
index 5fdb20f..d07b2c2 100644
--- a/config/deployments.example.json
+++ b/config/deployments.example.json
@@ -1,21 +1,24 @@
 {
   "chainId": 11155111,
-  "status": "unconfigured",
-  "safeVersion": null,
-  "entryPointVersion": null,
-  "abstractionkitVersion": null,
+  "status": "contract-presence-checked-transfer-unverified",
+  "safeVersion": "1.4.1",
+  "entryPointVersion": "0.7",
+  "abstractionkitVersion": "0.4.0",
   "contracts": {
-    "safeSingleton": null,
-    "safeProxyFactory": null,
-    "safe4337Module": null,
-    "fallbackHandler": null,
+    "safeSingleton": "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
+    "safeProxyFactory": "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
+    "safe4337Module": "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226",
+    "fallbackHandler": "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226",
     "socialRecoveryModule": null,
-    "entryPoint": null,
-    "testToken": null
+    "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
+    "testToken": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
+    "safeModuleSetup": "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47"
   },
-  "testTokenDecimals": null,
+  "testTokenDecimals": 6,
   "guardians": {
     "swissquoteGuardianSafe": null,
     "backupGuardianSafe": null
-  }
+  },
+  "safe4337ModuleVersion": "0.3.0",
+  "create2Salt": "0"
 }
diff --git a/config/sepolia.env.example b/config/sepolia.env.example
new file mode 100644
index 0000000..6a297ab
--- /dev/null
+++ b/config/sepolia.env.example
@@ -0,0 +1,10 @@
+# Copy to .env.sepolia in the repository root. Public testnet values only.
+SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
+SEPOLIA_BUNDLER_URL=https://api.candide.dev/public/v3/11155111
+SEPOLIA_TOKEN_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
+# Set an independent Sepolia recipient before running send.
+SEPOLIA_RECIPIENT=
+SEPOLIA_AMOUNT=1
+# Local disposable CLI owner and tracking. Never use the phone's private key.
+SEPOLIA_SMOKE_KEY_FILE=.sepolia-owner.key
+SEPOLIA_SMOKE_STATE_FILE=.sepolia-smoke.json
diff --git a/docs/demo-script.md b/docs/demo-script.md
index 5ef1fec..f81bb69 100644
--- a/docs/demo-script.md
+++ b/docs/demo-script.md
@@ -1,10 +1,11 @@
-# Démo du starter
+# Démo transaction Sepolia

-Lancer `npm run mobile:web` ou un Development Build, puis :
+Suivre le [runbook Sepolia](sepolia-transaction.md) pour configurer RPC/bundler/token et financer la Safe.

-1. Ouvrir la wallet depuis l'accueil.
-2. Lire le solde fictif de demo USDC.
-3. Ouvrir Send, saisir quelques champs et afficher l'aperçu. Aucun envoi.
-4. Revenir et ouvrir Security & recovery pour voir les étapes prévues.
+1. Créer/utiliser l'EOA protégée dans un Development Build et terminer le lien existant à Swissquote.
+2. Lire l'adresse Safe et ses soldes réels sur Wallet ; financer cette adresse avec ETH et tokens Sepolia.
+3. Ouvrir Send, saisir destinataire/montant, vérifier l'aperçu et authentifier la signature locale.
+4. Vérifier le statut jusqu'à deux confirmations et ouvrir le hash sur l'explorateur.
+5. Montrer l'événement Transfer, les soldes et la configuration Safe owner 1/1.

-Le scénario final `Create → Protect → Fund → Sign & Send → Lose Access → Recover → Sign again` reste à implémenter selon les sections 9 et 15 du README. Le mock ne valide pas ce scénario.
+Recovery reste un aperçu ; aucune récupération ni sponsoring gas n'est configuré. Tests locaux et exports ne remplacent pas la preuve de transaction financée sur Sepolia ou de biométrie sur appareil.
diff --git a/docs/getting-started.md b/docs/getting-started.md
index 9910947..4cad99f 100644
--- a/docs/getting-started.md
+++ b/docs/getting-started.md
@@ -11,7 +11,7 @@ npm ci
 npm run mobile:web
 ```

-Le parcours de création et signature de clé est maintenant natif : le navigateur affiche une erreur de stockage indisponible, sans fallback de clé en mémoire. Sur téléphone, le startup ouvre `/create-wallet` ou `/wallet` selon l’adresse publique enregistrée ; `/sign-test` signe et vérifie un message EIP-191. Soldes, Send et Recovery restent des aperçus, sans appel API ou blockchain. Aucun dépôt ne doit être effectué.
+Le parcours de création et signature de clé est maintenant natif : le navigateur affiche une erreur de stockage indisponible, sans fallback de clé en mémoire. Sur téléphone, le startup ouvre `/create-wallet` ou `/wallet` selon l’adresse publique enregistrée ; `/sign-test` signe et vérifie un message EIP-191. Wallet/Send disposent désormais du flux Safe/ERC-4337 Sepolia décrit dans [le runbook transaction](sepolia-transaction.md), à configurer et financer avant envoi. Recovery reste un aperçu.

 Pour un téléphone, le parcours de référence est un **Development Build** :

@@ -80,6 +80,6 @@ la gestion de secrets. Aucune commande `npm audit fix --force` n'a été appliqu
 | Blockchain | `packages/wallet-core` et `config/deployments.example.json`          | POC B/C puis recovery direct SQ/A/B 2/3, dont A+B sans banque                    |
 | Backend    | `backend/app` et `backend/tests`                                     | Preuve de contrôle on-chain, identité renforcée et signer isolé                  |

-`wallet-core` expose Sepolia et l’API de clé/signature viem, consommées par l’adaptateur natif SecureStore. `apps/mobile/index.ts` installe l’entropie native avant de charger Expo Router et les routes. `abstractionkit` et les contrats restent à intégrer après les POCs ; les champs de déploiement restent `null` jusqu’à vérification sur Sepolia.
+`wallet-core` expose Sepolia et l’API de clé/signature viem, consommées par l’adaptateur natif SecureStore. `apps/mobile/index.ts` installe l’entropie native avant de charger Expo Router et les routes. `abstractionkit` 0.4.0 et la configuration Safe 1.4.1 / EntryPoint 0.7 sont intégrés. La présence des contrats et les endpoints publics ont été vérifiés en lecture ; le transfert financé et la signature native restent à démontrer. Voir [sepolia-transaction](sepolia-transaction.md).

 Sources de configuration : [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [monorepos Expo](https://docs.expo.dev/guides/monorepos/), [installation Expo Router](https://docs.expo.dev/router/installation/), [NativeWind v4](https://www.nativewind.dev/docs/getting-started/installation).
diff --git a/docs/sepolia-transaction.md b/docs/sepolia-transaction.md
new file mode 100644
index 0000000..a057cc4
--- /dev/null
+++ b/docs/sepolia-transaction.md
@@ -0,0 +1,119 @@
+# One Safe transfer on Sepolia
+
+This milestone implements a single-owner Safe and a self-funded ERC-4337 ERC-20
+transfer. Recovery and paymaster sponsorship are not configured. The Safe receives
+assets; the phone's EOA signs. The first UserOperation deploys the prefunded Safe
+and performs the transfer together.
+
+## Pinned stack and verification status
+
+- AbstractionKit **0.4.0**, `SafeAccountV0_3_0` (explicit v0.7 compatibility class).
+- Safe L2 **1.4.1**, Safe4337Module **0.3.0**, EntryPoint **0.7**.
+- Sepolia **11155111**, one owner, threshold **1**, CREATE2 salt **0**.
+- Addresses in `packages/wallet-core/safe/account.ts`; no factory/salt overrides.
+- Example token: [Circle Sepolia test USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses),
+  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, six decimals verified by RPC.
+
+On 2026-10-10 the public example RPC/bundler passed the read-only Sepolia,
+EntryPoint-support, contract-code and token-decimal checks. This proves endpoint
+compatibility and contract presence, not bytecode auditing or a successful transfer.
+A funded on-chain transfer and native biometric signing remain to be demonstrated.
+Local tests use mocked RPC responses with real SDK construction/signatures.
+Android/iOS Hermes and web exports passed; device execution is a separate gate.
+Metro reports an upstream `@noble/hashes/crypto.js` export-resolution warning,
+falling back to the existing file; no dependency patch was applied.
+
+## Command-line smoke test
+
+Run from the repository root using Node 24 and installed dependencies:
+
+```bash
+cp config/sepolia.env.example .env.sepolia
+npm run sepolia:smoke -- init
+npm run sepolia:smoke -- address
+```
+
+`init` creates an exclusive, mode-0600 `.sepolia-owner.key` with a disposable CLI
+owner. It never prints the key. It refuses to overwrite an existing key. `address`
+checks the live configuration and prints the Safe address and actual balances.
+This CLI owner is independent of the phone's owner; their Safe addresses differ.
+
+Fund the printed **Safe address** with Sepolia ETH and at least the requested
+amount of the configured ERC-20. For deployment, start with approximately
+**0.01 Sepolia ETH** and adjust to the displayed gas estimate. Obtain test USDC
+from [Circle's faucet](https://faucet.circle.com/) or transfer existing test tokens;
+obtain Sepolia ETH from a testnet faucet. Funding transactions are separate from
+this application's outgoing transfer. The owner EOA need not pay gas.
+
+Set `SEPOLIA_RECIPIENT` in `.env.sepolia` to an independent address, then:
+
+```bash
+npm run sepolia:smoke -- send
+# If confirmation times out or the connection drops:
+npm run sepolia:smoke -- status
+```
+
+`send` explicitly authorizes the CLI to sign/send the configured test transfer.
+It prints the preview, operation hash and, after two confirmations, the transaction
+hash/explorer URL, verified Transfer event, Safe configuration, and balances before
+and after the transaction's block. Use an isolated recipient for exact balance
+comparison: other activity in the same block can alter the block deltas. The
+smoke command reports a nonzero exit code if those deltas differ.
+
+Tracking is written atomically before broadcasting. After an ambiguous network
+failure, use `status`, not another `send`. The operation signature expires after
+10 minutes. Tracking can be released when the chain is more than a minute past
+expiry and the same block still shows the nonce unused; otherwise it stays pending.
+Known on-chain reverts clear pending tracking and never produce a success result.
+The CLI locks its state file while running. After a process crash, inspect pending
+status before removing a stale `.sepolia-smoke.json.lock` file. Do not delete state
+to force a retry. Keys, local environment and default tracking files are gitignored.
+
+## Phone flow
+
+```bash
+cp apps/mobile/.env.example apps/mobile/.env
+```
+
+The template contains the same public Sepolia RPC/bundler/token examples. These
+endpoints have availability/rate limits; a replacement bundler must support
+EntryPoint v0.7. All `EXPO_PUBLIC_*` values ship in the app: use only public or
+restricted testnet endpoints. No private keys or privileged provider credentials.
+
+Keep the existing wallet-link onboarding and backend setup from
+`docs/getting-started.md`. Start a Development Build and create/use the existing
+protected owner. On Wallet, read the Safe address and actual balances, fund that
+address with test ETH/tokens, then refresh. On Send:
+
+1. Enter recipient and token amount; preview the exact token, Safe, recipient,
+   amount and maximum gas cost (including deployment if necessary).
+2. Select **Authenticate & send**. A fresh protected SecureStore read unlocks the
+   EOA for the SDK's Safe EIP-712 signature. No key is returned to the UI or network.
+3. Select **Check status** until confirmed. The transaction hash links to Sepolia.
+
+Previews expire after two minutes. Payload edits, navigation and real background
+transitions invalidate an attempt before submission. Once a request has been sent,
+cancellation cannot undo blockchain inclusion; tracking survives restart. Test
+native authentication cancellation, repeated signing, invalidated keys and
+background/navigation on real devices. Development reset permanently deletes the
+owner key and tracking; assets in its old Safe become inaccessible without an
+independent backup.
+
+## Acceptance evidence
+
+Capture the owner/Safe addresses, operation hash and transaction hash. The core
+requires the matching EntryPoint `UserOperationEvent` with success, the exact
+ERC-20 `Transfer` within that operation's receipt segment, and the pinned Safe
+owner/threshold/modules/handler/singleton/version. It reads balances at the preceding
+block and inclusion block and reports whether both deltas match. A successful
+outer EntryPoint transaction alone is insufficient.
+
+```bash
+npm run typecheck
+npm run lint
+npm test
+npm run format:check
+```
+
+References: [Safe ERC-4337](https://docs.safe.global/advanced/erc-4337/4337-safe),
+[Candide v0.7 account](https://docs.candide.dev/wallet/abstractionkit/safe-account-v3/).
diff --git a/package-lock.json b/package-lock.json
index 5451dfd..e5d9aa1 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -13,6 +13,7 @@
       ],
       "devDependencies": {
         "prettier": "3.9.10",
+        "tsx": "4.21.0",
         "typescript": "6.0.3",
         "vitest": "5.0.3"
       },
@@ -1244,6 +1245,422 @@
         "tslib": "^2.4.0"
       }
     },
+    "node_modules/@esbuild/aix-ppc64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/aix-ppc64/-/aix-ppc64-0.27.7.tgz",
+      "integrity": "sha512-EKX3Qwmhz1eMdEJokhALr0YiD0lhQNwDqkPYyPhiSwKrh7/4KRjQc04sZ8db+5DVVnZ1LmbNDI1uAMPEUBnQPg==",
+      "cpu": [
+        "ppc64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "aix"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/android-arm": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/android-arm/-/android-arm-0.27.7.tgz",
+      "integrity": "sha512-jbPXvB4Yj2yBV7HUfE2KHe4GJX51QplCN1pGbYjvsyCZbQmies29EoJbkEc+vYuU5o45AfQn37vZlyXy4YJ8RQ==",
+      "cpu": [
+        "arm"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "android"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/android-arm64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/android-arm64/-/android-arm64-0.27.7.tgz",
+      "integrity": "sha512-62dPZHpIXzvChfvfLJow3q5dDtiNMkwiRzPylSCfriLvZeq0a1bWChrGx/BbUbPwOrsWKMn8idSllklzBy+dgQ==",
+      "cpu": [
+        "arm64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "android"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/android-x64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/android-x64/-/android-x64-0.27.7.tgz",
+      "integrity": "sha512-x5VpMODneVDb70PYV2VQOmIUUiBtY3D3mPBG8NxVk5CogneYhkR7MmM3yR/uMdITLrC1ml/NV1rj4bMJuy9MCg==",
+      "cpu": [
+        "x64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "android"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/darwin-arm64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/darwin-arm64/-/darwin-arm64-0.27.7.tgz",
+      "integrity": "sha512-5lckdqeuBPlKUwvoCXIgI2D9/ABmPq3Rdp7IfL70393YgaASt7tbju3Ac+ePVi3KDH6N2RqePfHnXkaDtY9fkw==",
+      "cpu": [
+        "arm64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "darwin"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/darwin-x64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/darwin-x64/-/darwin-x64-0.27.7.tgz",
+      "integrity": "sha512-rYnXrKcXuT7Z+WL5K980jVFdvVKhCHhUwid+dDYQpH+qu+TefcomiMAJpIiC2EM3Rjtq0sO3StMV/+3w3MyyqQ==",
+      "cpu": [
+        "x64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "darwin"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/freebsd-arm64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/freebsd-arm64/-/freebsd-arm64-0.27.7.tgz",
+      "integrity": "sha512-B48PqeCsEgOtzME2GbNM2roU29AMTuOIN91dsMO30t+Ydis3z/3Ngoj5hhnsOSSwNzS+6JppqWsuhTp6E82l2w==",
+      "cpu": [
+        "arm64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "freebsd"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/freebsd-x64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/freebsd-x64/-/freebsd-x64-0.27.7.tgz",
+      "integrity": "sha512-jOBDK5XEjA4m5IJK3bpAQF9/Lelu/Z9ZcdhTRLf4cajlB+8VEhFFRjWgfy3M1O4rO2GQ/b2dLwCUGpiF/eATNQ==",
+      "cpu": [
+        "x64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "freebsd"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/linux-arm": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/linux-arm/-/linux-arm-0.27.7.tgz",
+      "integrity": "sha512-RkT/YXYBTSULo3+af8Ib0ykH8u2MBh57o7q/DAs3lTJlyVQkgQvlrPTnjIzzRPQyavxtPtfg0EopvDyIt0j1rA==",
+      "cpu": [
+        "arm"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "linux"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/linux-arm64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/linux-arm64/-/linux-arm64-0.27.7.tgz",
+      "integrity": "sha512-RZPHBoxXuNnPQO9rvjh5jdkRmVizktkT7TCDkDmQ0W2SwHInKCAV95GRuvdSvA7w4VMwfCjUiPwDi0ZO6Nfe9A==",
+      "cpu": [
+        "arm64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "linux"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/linux-ia32": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/linux-ia32/-/linux-ia32-0.27.7.tgz",
+      "integrity": "sha512-GA48aKNkyQDbd3KtkplYWT102C5sn/EZTY4XROkxONgruHPU72l+gW+FfF8tf2cFjeHaRbWpOYa/uRBz/Xq1Pg==",
+      "cpu": [
+        "ia32"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "linux"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/linux-loong64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/linux-loong64/-/linux-loong64-0.27.7.tgz",
+      "integrity": "sha512-a4POruNM2oWsD4WKvBSEKGIiWQF8fZOAsycHOt6JBpZ+JN2n2JH9WAv56SOyu9X5IqAjqSIPTaJkqN8F7XOQ5Q==",
+      "cpu": [
+        "loong64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "linux"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/linux-mips64el": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/linux-mips64el/-/linux-mips64el-0.27.7.tgz",
+      "integrity": "sha512-KabT5I6StirGfIz0FMgl1I+R1H73Gp0ofL9A3nG3i/cYFJzKHhouBV5VWK1CSgKvVaG4q1RNpCTR2LuTVB3fIw==",
+      "cpu": [
+        "mips64el"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "linux"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/linux-ppc64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/linux-ppc64/-/linux-ppc64-0.27.7.tgz",
+      "integrity": "sha512-gRsL4x6wsGHGRqhtI+ifpN/vpOFTQtnbsupUF5R5YTAg+y/lKelYR1hXbnBdzDjGbMYjVJLJTd2OFmMewAgwlQ==",
+      "cpu": [
+        "ppc64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "linux"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/linux-riscv64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/linux-riscv64/-/linux-riscv64-0.27.7.tgz",
+      "integrity": "sha512-hL25LbxO1QOngGzu2U5xeXtxXcW+/GvMN3ejANqXkxZ/opySAZMrc+9LY/WyjAan41unrR3YrmtTsUpwT66InQ==",
+      "cpu": [
+        "riscv64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "linux"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/linux-s390x": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/linux-s390x/-/linux-s390x-0.27.7.tgz",
+      "integrity": "sha512-2k8go8Ycu1Kb46vEelhu1vqEP+UeRVj2zY1pSuPdgvbd5ykAw82Lrro28vXUrRmzEsUV0NzCf54yARIK8r0fdw==",
+      "cpu": [
+        "s390x"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "linux"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/linux-x64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.27.7.tgz",
+      "integrity": "sha512-hzznmADPt+OmsYzw1EE33ccA+HPdIqiCRq7cQeL1Jlq2gb1+OyWBkMCrYGBJ+sxVzve2ZJEVeePbLM2iEIZSxA==",
+      "cpu": [
+        "x64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "linux"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/netbsd-arm64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/netbsd-arm64/-/netbsd-arm64-0.27.7.tgz",
+      "integrity": "sha512-b6pqtrQdigZBwZxAn1UpazEisvwaIDvdbMbmrly7cDTMFnw/+3lVxxCTGOrkPVnsYIosJJXAsILG9XcQS+Yu6w==",
+      "cpu": [
+        "arm64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "netbsd"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/netbsd-x64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/netbsd-x64/-/netbsd-x64-0.27.7.tgz",
+      "integrity": "sha512-OfatkLojr6U+WN5EDYuoQhtM+1xco+/6FSzJJnuWiUw5eVcicbyK3dq5EeV/QHT1uy6GoDhGbFpprUiHUYggrw==",
+      "cpu": [
+        "x64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "netbsd"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/openbsd-arm64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/openbsd-arm64/-/openbsd-arm64-0.27.7.tgz",
+      "integrity": "sha512-AFuojMQTxAz75Fo8idVcqoQWEHIXFRbOc1TrVcFSgCZtQfSdc1RXgB3tjOn/krRHENUB4j00bfGjyl2mJrU37A==",
+      "cpu": [
+        "arm64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "openbsd"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/openbsd-x64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/openbsd-x64/-/openbsd-x64-0.27.7.tgz",
+      "integrity": "sha512-+A1NJmfM8WNDv5CLVQYJ5PshuRm/4cI6WMZRg1by1GwPIQPCTs1GLEUHwiiQGT5zDdyLiRM/l1G0Pv54gvtKIg==",
+      "cpu": [
+        "x64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "openbsd"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/openharmony-arm64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/openharmony-arm64/-/openharmony-arm64-0.27.7.tgz",
+      "integrity": "sha512-+KrvYb/C8zA9CU/g0sR6w2RBw7IGc5J2BPnc3dYc5VJxHCSF1yNMxTV5LQ7GuKteQXZtspjFbiuW5/dOj7H4Yw==",
+      "cpu": [
+        "arm64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "openharmony"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/sunos-x64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/sunos-x64/-/sunos-x64-0.27.7.tgz",
+      "integrity": "sha512-ikktIhFBzQNt/QDyOL580ti9+5mL/YZeUPKU2ivGtGjdTYoqz6jObj6nOMfhASpS4GU4Q/Clh1QtxWAvcYKamA==",
+      "cpu": [
+        "x64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "sunos"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/win32-arm64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/win32-arm64/-/win32-arm64-0.27.7.tgz",
+      "integrity": "sha512-7yRhbHvPqSpRUV7Q20VuDwbjW5kIMwTHpptuUzV+AA46kiPze5Z7qgt6CLCK3pWFrHeNfDd1VKgyP4O+ng17CA==",
+      "cpu": [
+        "arm64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "win32"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/win32-ia32": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/win32-ia32/-/win32-ia32-0.27.7.tgz",
+      "integrity": "sha512-SmwKXe6VHIyZYbBLJrhOoCJRB/Z1tckzmgTLfFYOfpMAx63BJEaL9ExI8x7v0oAO3Zh6D/Oi1gVxEYr5oUCFhw==",
+      "cpu": [
+        "ia32"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "win32"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@esbuild/win32-x64": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/@esbuild/win32-x64/-/win32-x64-0.27.7.tgz",
+      "integrity": "sha512-56hiAJPhwQ1R4i+21FVF7V8kSD5zZTdHcVuRFMW0hn753vVfQN8xlx4uOPT4xoGH0Z/oVATuR82AiqSTDIpaHg==",
+      "cpu": [
+        "x64"
+      ],
+      "license": "MIT",
+      "optional": true,
+      "os": [
+        "win32"
+      ],
+      "engines": {
+        "node": ">=18"
+      }
+    },
     "node_modules/@eslint-community/eslint-utils": {
       "version": "4.10.1",
       "resolved": "https://registry.npmjs.org/@eslint-community/eslint-utils/-/eslint-utils-4.10.1.tgz",
@@ -4226,6 +4643,19 @@
         "node": ">=6.5"
       }
     },
+    "node_modules/abstractionkit": {
+      "version": "0.4.0",
+      "resolved": "https://registry.npmjs.org/abstractionkit/-/abstractionkit-0.4.0.tgz",
+      "integrity": "sha512-eOVHBEDHEMTxyLUzxfTJtxrIEnhbhCMlESZw+FW+0Wo1HlwfTIf+S8gxlRF8vMk9K/jiYxEmxeDFObfVtZsYFA==",
+      "license": "MIT",
+      "dependencies": {
+        "@noble/curves": "^1.2.0",
+        "@noble/hashes": "^1.3.2"
+      },
+      "engines": {
+        "node": ">=18"
+      }
+    },
     "node_modules/accepts": {
       "version": "1.3.8",
       "resolved": "https://registry.npmjs.org/accepts/-/accepts-1.3.8.tgz",
@@ -5914,6 +6344,48 @@
         "url": "https://github.com/sponsors/ljharb"
       }
     },
+    "node_modules/esbuild": {
+      "version": "0.27.7",
+      "resolved": "https://registry.npmjs.org/esbuild/-/esbuild-0.27.7.tgz",
+      "integrity": "sha512-IxpibTjyVnmrIQo5aqNpCgoACA/dTKLTlhMHihVHhdkxKyPO1uBBthumT0rdHmcsk9uMonIWS0m4FljWzILh3w==",
+      "devOptional": true,
+      "hasInstallScript": true,
+      "license": "MIT",
+      "bin": {
+        "esbuild": "bin/esbuild"
+      },
+      "engines": {
+        "node": ">=18"
+      },
+      "optionalDependencies": {
+        "@esbuild/aix-ppc64": "0.27.7",
+        "@esbuild/android-arm": "0.27.7",
+        "@esbuild/android-arm64": "0.27.7",
+        "@esbuild/android-x64": "0.27.7",
+        "@esbuild/darwin-arm64": "0.27.7",
+        "@esbuild/darwin-x64": "0.27.7",
+        "@esbuild/freebsd-arm64": "0.27.7",
+        "@esbuild/freebsd-x64": "0.27.7",
+        "@esbuild/linux-arm": "0.27.7",
+        "@esbuild/linux-arm64": "0.27.7",
+        "@esbuild/linux-ia32": "0.27.7",
+        "@esbuild/linux-loong64": "0.27.7",
+        "@esbuild/linux-mips64el": "0.27.7",
+        "@esbuild/linux-ppc64": "0.27.7",
+        "@esbuild/linux-riscv64": "0.27.7",
+        "@esbuild/linux-s390x": "0.27.7",
+        "@esbuild/linux-x64": "0.27.7",
+        "@esbuild/netbsd-arm64": "0.27.7",
+        "@esbuild/netbsd-x64": "0.27.7",
+        "@esbuild/openbsd-arm64": "0.27.7",
+        "@esbuild/openbsd-x64": "0.27.7",
+        "@esbuild/openharmony-arm64": "0.27.7",
+        "@esbuild/sunos-x64": "0.27.7",
+        "@esbuild/win32-arm64": "0.27.7",
+        "@esbuild/win32-ia32": "0.27.7",
+        "@esbuild/win32-x64": "0.27.7"
+      }
+    },
     "node_modules/escalade": {
       "version": "3.2.0",
       "resolved": "https://registry.npmjs.org/escalade/-/escalade-3.2.0.tgz",
@@ -7429,7 +7901,7 @@
       "version": "4.14.3",
       "resolved": "https://registry.npmjs.org/get-tsconfig/-/get-tsconfig-4.14.3.tgz",
       "integrity": "sha512-++QEw4DIY7WGoukz+/+A/8dGYPT9l9yIadnmSgZ8Rjr3YVSVDipQSO9CdnJo9ePqFqUUqh+wk9uIaoiAwsiPkA==",
-      "dev": true,
+      "devOptional": true,
       "license": "MIT",
       "dependencies": {
         "resolve-pkg-maps": "^1.0.0"
@@ -11466,7 +11938,7 @@
       "version": "1.0.0",
       "resolved": "https://registry.npmjs.org/resolve-pkg-maps/-/resolve-pkg-maps-1.0.0.tgz",
       "integrity": "sha512-seS2Tj26TBVOC2NIc2rOe2y2ZO7efxITtLZcGSOnHHNOQ7CkiUBfw0Iw2ck6xkIhPwLhKNLS8BO+hEpngQlqzw==",
-      "dev": true,
+      "devOptional": true,
       "license": "MIT",
       "funding": {
         "url": "https://github.com/privatenumber/resolve-pkg-maps?sponsor=1"
@@ -12623,6 +13095,26 @@
       "integrity": "sha512-oJFu94HQb+KVduSUQL7wnpmqnfmLsOA/nAh6b6EH0wCEoK0/mPeXU6c3wKDV83MkOuHPRHtSXKKU99IBazS/2w==",
       "license": "0BSD"
     },
+    "node_modules/tsx": {
+      "version": "4.21.0",
+      "resolved": "https://registry.npmjs.org/tsx/-/tsx-4.21.0.tgz",
+      "integrity": "sha512-5C1sg4USs1lfG0GFb2RLXsdpXqBSEhAaA/0kPL01wxzpMqLILNxIxIOKiILz+cdg/pLnOUxFYOR5yhHU666wbw==",
+      "devOptional": true,
+      "license": "MIT",
+      "dependencies": {
+        "esbuild": "~0.27.0",
+        "get-tsconfig": "^4.7.5"
+      },
+      "bin": {
+        "tsx": "dist/cli.mjs"
+      },
+      "engines": {
+        "node": ">=18.0.0"
+      },
+      "optionalDependencies": {
+        "fsevents": "~2.3.3"
+      }
+    },
     "node_modules/type-check": {
       "version": "0.4.0",
       "resolved": "https://registry.npmjs.org/type-check/-/type-check-0.4.0.tgz",
@@ -13610,6 +14102,7 @@
       "name": "@swissquote/wallet-core",
       "version": "0.1.0",
       "dependencies": {
+        "abstractionkit": "0.4.0",
         "viem": "2.57.4"
       }
     }
diff --git a/package.json b/package.json
index 131fce6..d2026f6 100644
--- a/package.json
+++ b/package.json
@@ -19,10 +19,12 @@
     "lint": "npm run lint --workspace @swissquote/mobile",
     "test": "vitest run --passWithNoTests",
     "format": "prettier --write .",
-    "format:check": "prettier --check ."
+    "format:check": "prettier --check .",
+    "sepolia:smoke": "node --import tsx scripts/sepolia-smoke.ts"
   },
   "devDependencies": {
     "prettier": "3.9.10",
+    "tsx": "4.21.0",
     "typescript": "6.0.3",
     "vitest": "5.0.3"
   }
diff --git a/packages/wallet-core/README.md b/packages/wallet-core/README.md
index b9b8344..dba996b 100644
--- a/packages/wallet-core/README.md
+++ b/packages/wallet-core/README.md
@@ -1,6 +1,6 @@
 # wallet-core

-Package TypeScript indépendant des écrans. Exporte `SEPOLIA`, le contrat `OwnerWallet`, la factory `createOwnerWallet`, le contrat de stockage `OwnerKeyStorage` et les erreurs typées. Création EOA, signature et vérification de messages via viem ; aucun signer Safe ou client RPC n'est connecté.
+Package TypeScript indépendant des écrans. Exporte `SEPOLIA`, le contrat `OwnerWallet`, la factory `createOwnerWallet`, le contrat de stockage `OwnerKeyStorage` et les erreurs typées. Création EOA, signature et vérification de messages via viem ; Safe/ERC-4337 est également intégré via `createSafeWallet` et les RPC Sepolia configurés.

 Les dossiers `keys`, `signing`, `safe`, `transactions`, `guardians` et `recovery` réservent les responsabilités de la section 13 du README. Ajouter ici la logique testable ; garder l'adaptateur natif SecureStore au bord du module, sans dépendance UI.

@@ -50,6 +50,16 @@ function setupWallet(storage: OwnerKeyStorage) {

 The phone demo must create an owner, preserve its address after reopening, sign a
 confirmed test message, and verify the signature. Test cancellation and unavailable
-keys on a real device. Safe deployment, recovery kits and transaction signing remain
-separate implementation tasks; the SecureStore adapter is integrated, with real-device
+keys on a real device. Safe deployment and transaction signing are implemented by the second API below;
+recovery kits and recovery remain separate tasks; the SecureStore adapter is integrated, with real-device
 validation still required for the phone milestone.
+
+## Safe transfer API
+
+`createSafeWallet({ config, storage, activity })` provides `getAccount`,
+`prepareTransfer`, `submitTransfer`, and `confirmTransfer`. Operations are held
+privately behind immutable previews; signing uses a fresh protected key read.
+`activity` persists public pending/confirmed tracking before broadcast. The first
+operation deploys a prefunded, deterministic Safe. Confirmation independently
+checks RPC receipt events, Safe configuration and block balances. Recovery and
+sponsorship are absent. See [Sepolia runbook](../../docs/sepolia-transaction.md).
diff --git a/packages/wallet-core/errors.ts b/packages/wallet-core/errors.ts
index c7adb7d..1506bf4 100644
--- a/packages/wallet-core/errors.ts
+++ b/packages/wallet-core/errors.ts
@@ -8,6 +8,15 @@ export type WalletErrorCode =
   | 'KEY_GENERATION_FAILED'
   | 'INVALID_MESSAGE'
   | 'SIGNING_FAILED'
+  | 'CHAIN_CONFIG_INVALID'
+  | 'NETWORK_FAILED'
+  | 'SAFE_CONFIG_INVALID'
+  | 'INVALID_TRANSFER'
+  | 'INSUFFICIENT_FUNDS'
+  | 'TRANSFER_EXPIRED'
+  | 'TRANSFER_PENDING'
+  | 'TRANSFER_FAILED'
+  | 'VERIFICATION_FAILED'
   | 'NOT_IMPLEMENTED';

 /** Use safe messages only: never attach keys or raw native errors. */
diff --git a/packages/wallet-core/index.ts b/packages/wallet-core/index.ts
index 4cc0ff5..4855319 100644
--- a/packages/wallet-core/index.ts
+++ b/packages/wallet-core/index.ts
@@ -1,4 +1,14 @@
 export { SEPOLIA } from './config/chains';
+export { SAFE_DEPLOYMENT, predictSafeAddress } from './safe/account';
+export type { SepoliaConfig } from './safe/account';
+export { createSafeWallet } from './transactions/userOperation';
+export type {
+  SafeAccountInfo,
+  TransferPreview,
+  SubmittedTransfer,
+  ConfirmedTransfer,
+  TransferActivityStore,
+} from './transactions/userOperation';
 export { WalletError } from './errors';
 export type { WalletErrorCode } from './errors';
 export { createOwnerWallet } from './keys/keyManager';
diff --git a/packages/wallet-core/package.json b/packages/wallet-core/package.json
index fa65ef6..5c4f46b 100644
--- a/packages/wallet-core/package.json
+++ b/packages/wallet-core/package.json
@@ -8,6 +8,7 @@
     "typecheck": "tsc --noEmit"
   },
   "dependencies": {
+    "abstractionkit": "0.4.0",
     "viem": "2.57.4"
   }
 }
diff --git a/packages/wallet-core/safe/README.md b/packages/wallet-core/safe/README.md
index e62416b..0e4c98c 100644
--- a/packages/wallet-core/safe/README.md
+++ b/packages/wallet-core/safe/README.md
@@ -1,5 +1,5 @@
-# safe
+# Safe

-À implémenter : POC B : création ClientSafe (owner client 1/1), owners, modules et handlers vérifiés sur Sepolia.
+`account.ts` pins Safe 1.4.1, Safe4337Module 0.3.0, EntryPoint 0.7 and salt 0. It predicts the single-owner ClientSafe and verifies deployed owners, threshold, modules, fallback handler, singleton and version. Addresses cannot be overridden from environment variables.

-Voir les sections 5–9 et 15 du [README](../../../README.md). Aucun comportement livré ici.
+See [Sepolia runbook](../../../docs/sepolia-transaction.md). Live funded deployment remains to be demonstrated. Recovery is not enabled.
diff --git a/packages/wallet-core/safe/account.ts b/packages/wallet-core/safe/account.ts
new file mode 100644
index 0000000..c27d902
--- /dev/null
+++ b/packages/wallet-core/safe/account.ts
@@ -0,0 +1,166 @@
+import {
+  SafeAccountV0_3_0,
+  SAFE_FALLBACK_HANDLER_STORAGE_SLOT,
+} from 'abstractionkit';
+import {
+  createPublicClient,
+  getAddress,
+  http,
+  isAddress,
+  isAddressEqual,
+  parseAbi,
+  zeroAddress,
+  type Address,
+} from 'viem';
+import { sepolia } from 'viem/chains';
+import { WalletError } from '../errors';
+
+// Versioned together with abstractionkit 0.4.0. No environment overrides for
+// contracts/salt: changing any of them could strand a prefunded account.
+export const SAFE_DEPLOYMENT = Object.freeze({
+  chainId: 11155111,
+  safeVersion: '1.4.1',
+  entryPointVersion: '0.7',
+  abstractionkitVersion: '0.4.0',
+  salt: '0',
+  singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as Address,
+  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as Address,
+  module: SafeAccountV0_3_0.DEFAULT_SAFE_4337_MODULE_ADDRESS as Address,
+  moduleSetup: SafeAccountV0_3_0.DEFAULT_SAFE_MODULE_SETUP_ADDRESS as Address,
+  entryPoint: SafeAccountV0_3_0.DEFAULT_ENTRYPOINT_ADDRESS as Address,
+});
+
+export interface SepoliaConfig {
+  rpcUrl: string;
+  bundlerUrl: string;
+  tokenAddress: Address;
+}
+
+export const safeAbi = parseAbi([
+  'function getOwners() view returns (address[])',
+  'function getThreshold() view returns (uint256)',
+  'function VERSION() view returns (string)',
+  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
+]);
+const SENTINEL = '0x0000000000000000000000000000000000000001';
+
+export function validateConfig(config: SepoliaConfig): SepoliaConfig {
+  for (const value of [config.rpcUrl, config.bundlerUrl]) {
+    try {
+      const url = new URL(value);
+      if (
+        !['http:', 'https:'].includes(url.protocol) ||
+        url.username ||
+        url.password
+      )
+        throw new Error();
+    } catch {
+      throw new WalletError(
+        'CHAIN_CONFIG_INVALID',
+        'Configure a Sepolia RPC and bundler URL.',
+      );
+    }
+  }
+  if (
+    !isAddress(config.tokenAddress, { strict: false }) ||
+    isAddressEqual(config.tokenAddress, zeroAddress)
+  )
+    throw new WalletError(
+      'CHAIN_CONFIG_INVALID',
+      'Configure a Sepolia test ERC-20 address.',
+    );
+  return Object.freeze({
+    ...config,
+    tokenAddress: getAddress(config.tokenAddress),
+  });
+}
+
+export function initializeSafe(owner: Address) {
+  if (
+    !isAddress(owner, { strict: false }) ||
+    isAddressEqual(owner, zeroAddress)
+  )
+    throw new WalletError('SAFE_CONFIG_INVALID', 'Invalid owner address.');
+  return SafeAccountV0_3_0.initializeNewAccount([getAddress(owner)], {
+    threshold: 1,
+    c2Nonce: 0n,
+    safeAccountFactoryAddress: SAFE_DEPLOYMENT.factory,
+    safe4337ModuleAddress: SAFE_DEPLOYMENT.module,
+    safeModuleSetupAddress: SAFE_DEPLOYMENT.moduleSetup,
+    entrypointAddress: SAFE_DEPLOYMENT.entryPoint,
+  });
+}
+
+export function predictSafeAddress(owner: Address): Address {
+  return getAddress(initializeSafe(owner).accountAddress);
+}
+
+export function sepoliaClient(config: SepoliaConfig) {
+  return createPublicClient({
+    chain: sepolia,
+    transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 0 }),
+  });
+}
+export type SepoliaClient = ReturnType<typeof sepoliaClient>;
+
+export async function verifySafe(
+  client: SepoliaClient,
+  safe: Address,
+  owner: Address,
+  blockNumber?: bigint,
+): Promise<boolean> {
+  const code = await client.getCode({ address: safe, blockNumber });
+  if (!code || code === '0x') return false;
+  const [owners, threshold, version, modules, singleton, handler] =
+    await Promise.all([
+      client.readContract({
+        address: safe,
+        abi: safeAbi,
+        functionName: 'getOwners',
+        blockNumber,
+      }),
+      client.readContract({
+        address: safe,
+        abi: safeAbi,
+        functionName: 'getThreshold',
+        blockNumber,
+      }),
+      client.readContract({
+        address: safe,
+        abi: safeAbi,
+        functionName: 'VERSION',
+        blockNumber,
+      }),
+      client.readContract({
+        address: safe,
+        abi: safeAbi,
+        functionName: 'getModulesPaginated',
+        args: [SENTINEL, 10n],
+        blockNumber,
+      }),
+      client.getStorageAt({ address: safe, slot: '0x0', blockNumber }),
+      client.getStorageAt({
+        address: safe,
+        slot: SAFE_FALLBACK_HANDLER_STORAGE_SLOT,
+        blockNumber,
+      }),
+    ]);
+  const storedAddress = (value: string | undefined) =>
+    value ? (`0x${value.slice(-40)}` as Address) : zeroAddress;
+  if (
+    owners.length !== 1 ||
+    !isAddressEqual(owners[0], owner) ||
+    threshold !== 1n ||
+    version !== SAFE_DEPLOYMENT.safeVersion ||
+    modules[0].length !== 1 ||
+    !isAddressEqual(modules[0][0], SAFE_DEPLOYMENT.module) ||
+    !isAddressEqual(modules[1], SENTINEL) ||
+    !isAddressEqual(storedAddress(singleton), SAFE_DEPLOYMENT.singleton) ||
+    !isAddressEqual(storedAddress(handler), SAFE_DEPLOYMENT.module)
+  )
+    throw new WalletError(
+      'SAFE_CONFIG_INVALID',
+      'The deployed Safe configuration does not match this wallet.',
+    );
+  return true;
+}
diff --git a/packages/wallet-core/transactions/README.md b/packages/wallet-core/transactions/README.md
index f017123..2a6f12b 100644
--- a/packages/wallet-core/transactions/README.md
+++ b/packages/wallet-core/transactions/README.md
@@ -1,5 +1,5 @@
-# transactions
+# Transactions

-À implémenter : POC B/C : encodage ERC-20, UserOperations ERC-4337, reçus et sponsoring explicite.
+`erc20.ts` validates exact token units and encodes transfers. `userOperation.ts` builds and estimates ERC-4337 operations, authenticates/signs locally, tracks submission durably and verifies events/configuration/balances after two confirmations. Uses self-funded Safe ETH; no paymaster.

-Voir les sections 5–9 et 15 du [README](../../../README.md). Aucun comportement livré ici.
+See [Sepolia runbook](../../../docs/sepolia-transaction.md). RPC-mocked tests use real SDK signing; they do not prove a funded Sepolia transfer or native authentication.
diff --git a/packages/wallet-core/transactions/erc20.ts b/packages/wallet-core/transactions/erc20.ts
new file mode 100644
index 0000000..ae92982
--- /dev/null
+++ b/packages/wallet-core/transactions/erc20.ts
@@ -0,0 +1,58 @@
+import {
+  encodeFunctionData,
+  isAddress,
+  isAddressEqual,
+  parseAbi,
+  parseUnits,
+  zeroAddress,
+  type Address,
+} from 'viem';
+import { WalletError } from '../errors';
+
+export const erc20Abi = parseAbi([
+  'function decimals() view returns (uint8)',
+  'function balanceOf(address account) view returns (uint256)',
+  'function transfer(address to, uint256 amount) returns (bool)',
+  'event Transfer(address indexed from, address indexed to, uint256 value)',
+]);
+
+export function encodeTransfer(
+  recipient: Address,
+  amount: string,
+  decimals: number,
+) {
+  if (
+    !isAddress(recipient, { strict: false }) ||
+    isAddressEqual(recipient, zeroAddress)
+  )
+    throw new WalletError(
+      'INVALID_TRANSFER',
+      'Enter a valid, nonzero recipient address.',
+    );
+  // viem parseUnits rounds excess precision: reject it explicitly before parsing.
+  if (
+    !/^\d+(?:\.\d+)?$/.test(amount) ||
+    !Number.isInteger(decimals) ||
+    decimals < 0 ||
+    decimals > 255 ||
+    (amount.split('.')[1]?.length ?? 0) > decimals
+  )
+    throw new WalletError(
+      'INVALID_TRANSFER',
+      'Enter a positive amount within the token precision.',
+    );
+  const units = parseUnits(amount, decimals);
+  if (units <= 0n || units >= 2n ** 256n)
+    throw new WalletError(
+      'INVALID_TRANSFER',
+      'The token amount is out of range.',
+    );
+  return {
+    units,
+    data: encodeFunctionData({
+      abi: erc20Abi,
+      functionName: 'transfer',
+      args: [recipient, units],
+    }),
+  };
+}
diff --git a/packages/wallet-core/transactions/userOperation.ts b/packages/wallet-core/transactions/userOperation.ts
new file mode 100644
index 0000000..f4e66c9
--- /dev/null
+++ b/packages/wallet-core/transactions/userOperation.ts
@@ -0,0 +1,599 @@
+import {
+  Bundler,
+  HttpTransport,
+  SafeAccountV0_3_0,
+  calculateUserOperationMaxGasCost,
+  createUserOperationHash,
+  type UserOperationV7,
+} from 'abstractionkit';
+import {
+  decodeEventLog,
+  formatUnits,
+  getAddress,
+  isAddressEqual,
+  parseAbi,
+  type Address,
+  type Hash,
+} from 'viem';
+import { privateKeyToAddress } from 'viem/accounts';
+import { WalletError } from '../errors';
+import type { OwnerKeyStorage } from '../keys/storage';
+import {
+  initializeSafe,
+  predictSafeAddress,
+  SAFE_DEPLOYMENT,
+  sepoliaClient,
+  validateConfig,
+  verifySafe,
+  type SepoliaConfig,
+} from '../safe/account';
+import { encodeTransfer, erc20Abi } from './erc20';
+
+export interface SafeAccountInfo {
+  ownerAddress: Address;
+  safeAddress: Address;
+  deployed: boolean;
+  tokenAddress: Address;
+  decimals: number;
+  tokenBalance: string;
+  ethBalance: string;
+}
+export interface TransferPreview {
+  readonly ownerAddress: Address;
+  readonly safeAddress: Address;
+  readonly tokenAddress: Address;
+  readonly recipient: Address;
+  readonly amount: string;
+  readonly amountUnits: string;
+  readonly decimals: number;
+  readonly maxGasEth: string;
+  readonly deploysSafe: boolean;
+  readonly expiresAt: number;
+}
+export interface SubmittedTransfer {
+  ownerAddress: Address;
+  safeAddress: Address;
+  tokenAddress: Address;
+  recipient: Address;
+  amountUnits: string;
+  decimals: number;
+  nonce: string;
+  validUntil: string;
+  userOperationHash: Hash;
+}
+export interface ConfirmedTransfer extends SubmittedTransfer {
+  transactionHash: Hash;
+  explorerUrl: string;
+  blockNumber: string;
+  senderBalanceBefore: string;
+  senderBalanceAfter: string;
+  recipientBalanceBefore: string;
+  recipientBalanceAfter: string;
+  balanceChangesMatch: boolean;
+}
+/** Public tracking only. Persist before submission to handle an ambiguous timeout. */
+export interface TransferActivityStore {
+  readPending(): Promise<SubmittedTransfer | null>;
+  writePending(value: SubmittedTransfer | null): Promise<void>;
+  writeConfirmed(value: ConfirmedTransfer): Promise<void>;
+}
+const entryPointAbi = parseAbi([
+  'function getNonce(address sender, uint192 key) view returns (uint256)',
+  'function balanceOf(address account) view returns (uint256)',
+  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
+]);
+
+function assertActive(signal?: AbortSignal) {
+  if (signal?.aborted)
+    throw new WalletError(
+      'AUTH_CANCELLED',
+      'Transfer cancelled before submission.',
+    );
+}
+async function network<T>(action: () => Promise<T>): Promise<T> {
+  try {
+    return await action();
+  } catch (e) {
+    if (e instanceof WalletError) throw e;
+    throw new WalletError(
+      'NETWORK_FAILED',
+      'Sepolia request failed. Check connectivity and configuration.',
+    );
+  }
+}
+
+export function createSafeWallet({
+  config: inputConfig,
+  storage,
+  activity,
+}: {
+  config: SepoliaConfig;
+  storage: OwnerKeyStorage;
+  activity: TransferActivityStore;
+}) {
+  const config = validateConfig(inputConfig);
+  const client = sepoliaClient(config);
+  // Bounded requests; never forward provider errors (URLs may contain credentials).
+  const sdkFetch: typeof fetch = async (input, init) => {
+    const controller = new AbortController();
+    const timeout = setTimeout(() => controller.abort(), 15_000);
+    try {
+      return await fetch(input, { ...init, signal: controller.signal });
+    } finally {
+      clearTimeout(timeout);
+    }
+  };
+  const rpc = new HttpTransport(config.rpcUrl, { fetch: sdkFetch });
+  const bundler = new Bundler(
+    new HttpTransport(config.bundlerUrl, { fetch: sdkFetch }),
+  );
+  // Prepared operations never leave this closure. Changing UI preview fields
+  // cannot change the operation signed after authentication.
+  const prepared = new WeakMap<
+    TransferPreview,
+    {
+      operation: UserOperationV7;
+      account: SafeAccountV0_3_0;
+      preparedAt: number;
+      validUntil: bigint;
+    }
+  >();
+  let submitting = false;
+
+  async function ownerAddress(): Promise<Address> {
+    const owner = await storage.readAddress();
+    if (!owner)
+      throw new WalletError(
+        'WALLET_NOT_FOUND',
+        'Create an owner wallet first.',
+      );
+    return getAddress(owner);
+  }
+  async function checkNetwork() {
+    const [rpcChain, bundlerChain, supported] = await Promise.all([
+      client.getChainId(),
+      bundler.chainId(),
+      bundler.supportedEntryPoints(),
+    ]);
+    if (
+      rpcChain !== SAFE_DEPLOYMENT.chainId ||
+      BigInt(bundlerChain) !== BigInt(SAFE_DEPLOYMENT.chainId) ||
+      !supported.some((value) =>
+        isAddressEqual(getAddress(value), SAFE_DEPLOYMENT.entryPoint),
+      )
+    )
+      throw new WalletError(
+        'CHAIN_CONFIG_INVALID',
+        'RPC and bundler must support Sepolia and EntryPoint v0.7.',
+      );
+    const addresses = [
+      SAFE_DEPLOYMENT.singleton,
+      SAFE_DEPLOYMENT.factory,
+      SAFE_DEPLOYMENT.module,
+      SAFE_DEPLOYMENT.moduleSetup,
+      SAFE_DEPLOYMENT.entryPoint,
+      config.tokenAddress,
+    ];
+    const codes = await Promise.all(
+      addresses.map((address) => client.getCode({ address })),
+    );
+    if (codes.some((code) => !code || code === '0x'))
+      throw new WalletError(
+        'CHAIN_CONFIG_INVALID',
+        'A required Safe or token contract is missing on Sepolia.',
+      );
+  }
+  async function getAccount(): Promise<SafeAccountInfo> {
+    return network(async () => {
+      await checkNetwork();
+      const owner = await ownerAddress();
+      const safe = predictSafeAddress(owner);
+      const [deployed, decimals, balance, eth] = await Promise.all([
+        verifySafe(client, safe, owner),
+        client.readContract({
+          address: config.tokenAddress,
+          abi: erc20Abi,
+          functionName: 'decimals',
+        }),
+        client.readContract({
+          address: config.tokenAddress,
+          abi: erc20Abi,
+          functionName: 'balanceOf',
+          args: [safe],
+        }),
+        client.getBalance({ address: safe }),
+      ]);
+      return {
+        ownerAddress: owner,
+        safeAddress: safe,
+        deployed,
+        tokenAddress: config.tokenAddress,
+        decimals,
+        tokenBalance: formatUnits(balance, decimals),
+        ethBalance: formatUnits(eth, 18),
+      };
+    });
+  }
+  async function prepareTransfer(
+    input: { recipient: Address; amount: string },
+    signal?: AbortSignal,
+  ): Promise<TransferPreview> {
+    return network(async () => {
+      assertActive(signal);
+      if (await activity.readPending())
+        throw new WalletError(
+          'TRANSFER_PENDING',
+          'Check the previous operation before sending another transfer.',
+        );
+      const info = await getAccount();
+      const { units, data } = encodeTransfer(
+        input.recipient,
+        input.amount,
+        info.decimals,
+      );
+      const recipient = getAddress(input.recipient);
+      if (isAddressEqual(recipient, info.safeAddress))
+        throw new WalletError(
+          'INVALID_TRANSFER',
+          'Choose a recipient different from your Safe.',
+        );
+      const balance = await client.readContract({
+        address: config.tokenAddress,
+        abi: erc20Abi,
+        functionName: 'balanceOf',
+        args: [info.safeAddress],
+      });
+      if (balance < units)
+        throw new WalletError(
+          'INSUFFICIENT_FUNDS',
+          'Fund the Safe with enough test tokens first.',
+        );
+      const account = info.deployed
+        ? new SafeAccountV0_3_0(info.safeAddress)
+        : initializeSafe(info.ownerAddress);
+      const transaction = { to: config.tokenAddress, value: 0n, data };
+      const operation = await account.createUserOperation(
+        [transaction],
+        rpc,
+        bundler,
+        {
+          expectedSigners: [info.ownerAddress],
+        },
+      );
+      if (
+        !isAddressEqual(getAddress(operation.sender), info.safeAddress) ||
+        operation.callData !==
+          SafeAccountV0_3_0.createAccountCallDataSingleTransaction(
+            transaction,
+          ) ||
+        operation.paymaster !== null ||
+        operation.paymasterData !== null ||
+        operation.maxFeePerGas <= 0n ||
+        operation.maxFeePerGas > 1_000_000_000_000n ||
+        operation.maxPriorityFeePerGas < 0n ||
+        operation.maxPriorityFeePerGas > operation.maxFeePerGas ||
+        operation.callGasLimit <= 0n ||
+        operation.verificationGasLimit <= 0n ||
+        operation.preVerificationGas <= 0n
+      )
+        throw new WalletError(
+          'INVALID_TRANSFER',
+          'The constructed operation does not match the transfer.',
+        );
+      const maxGas = calculateUserOperationMaxGasCost(operation);
+      const [eth, deposit, block] = await Promise.all([
+        client.getBalance({ address: info.safeAddress }),
+        client.readContract({
+          address: SAFE_DEPLOYMENT.entryPoint,
+          abi: entryPointAbi,
+          functionName: 'balanceOf',
+          args: [info.safeAddress],
+        }),
+        client.getBlock(),
+      ]);
+      if (eth + deposit < maxGas)
+        throw new WalletError(
+          'INSUFFICIENT_FUNDS',
+          'Fund the Safe with Sepolia ETH to cover the maximum gas fee.',
+        );
+      assertActive(signal);
+      const preview: TransferPreview = Object.freeze({
+        ownerAddress: info.ownerAddress,
+        safeAddress: info.safeAddress,
+        tokenAddress: config.tokenAddress,
+        recipient,
+        amount: formatUnits(units, info.decimals),
+        amountUnits: units.toString(),
+        decimals: info.decimals,
+        maxGasEth: formatUnits(maxGas, 18),
+        deploysSafe: !info.deployed,
+        expiresAt: Date.now() + 120_000,
+      });
+      prepared.set(preview, {
+        operation: { ...operation },
+        account,
+        preparedAt: Date.now(),
+        validUntil: block.timestamp + 600n,
+      });
+      return preview;
+    });
+  }
+  async function submitTransfer(
+    preview: TransferPreview,
+    signal?: AbortSignal,
+  ): Promise<SubmittedTransfer> {
+    if (submitting)
+      throw new WalletError(
+        'TRANSFER_PENDING',
+        'A transfer is already in progress.',
+      );
+    submitting = true;
+    try {
+      return await network(async () => {
+        assertActive(signal);
+        const record = prepared.get(preview);
+        const assertFresh = () => {
+          assertActive(signal);
+          if (!record || Date.now() - record.preparedAt > 120_000)
+            throw new WalletError(
+              'TRANSFER_EXPIRED',
+              'Prepare a fresh preview before signing.',
+            );
+        };
+        assertFresh();
+        if (!record)
+          throw new WalletError(
+            'TRANSFER_EXPIRED',
+            'Prepare the transfer first.',
+          );
+        if (await activity.readPending())
+          throw new WalletError(
+            'TRANSFER_PENDING',
+            'Check the previous operation first.',
+          );
+        await checkNetwork();
+        await verifySafe(client, preview.safeAddress, preview.ownerAddress);
+        const nonce = await client.readContract({
+          address: SAFE_DEPLOYMENT.entryPoint,
+          abi: entryPointAbi,
+          functionName: 'getNonce',
+          args: [preview.safeAddress, 0n],
+        });
+        if (nonce !== record.operation.nonce)
+          throw new WalletError(
+            'TRANSFER_EXPIRED',
+            'The Safe nonce changed. Prepare a fresh preview.',
+          );
+        if (!isAddressEqual(await ownerAddress(), preview.ownerAddress))
+          throw new WalletError('KEY_UNAVAILABLE', 'The owner changed.');
+        assertFresh();
+        let key;
+        let signature: string;
+        try {
+          key = await storage.readPrivateKeyForSigning();
+          assertFresh();
+          if (
+            !isAddressEqual(privateKeyToAddress(key), preview.ownerAddress) ||
+            !isAddressEqual(await ownerAddress(), preview.ownerAddress)
+          )
+            throw new WalletError(
+              'KEY_UNAVAILABLE',
+              'The signing key does not match the owner.',
+            );
+          assertFresh();
+          signature = record.account.signUserOperation(
+            record.operation,
+            [key],
+            BigInt(SAFE_DEPLOYMENT.chainId),
+            { validUntil: record.validUntil },
+          );
+        } catch (e) {
+          if (e instanceof WalletError) throw e;
+          throw new WalletError(
+            'SIGNING_FAILED',
+            'Safe operation signing failed.',
+          );
+        } finally {
+          key = undefined;
+        }
+        assertFresh();
+        prepared.delete(preview);
+        const operation = { ...record.operation, signature };
+        const submitted: SubmittedTransfer = {
+          ownerAddress: preview.ownerAddress,
+          safeAddress: preview.safeAddress,
+          tokenAddress: preview.tokenAddress,
+          recipient: preview.recipient,
+          amountUnits: preview.amountUnits,
+          decimals: preview.decimals,
+          nonce: operation.nonce.toString(),
+          validUntil: record.validUntil.toString(),
+          userOperationHash: createUserOperationHash(
+            operation,
+            SAFE_DEPLOYMENT.entryPoint,
+            BigInt(SAFE_DEPLOYMENT.chainId),
+          ) as Hash,
+        };
+        // Store the expected hash before the request: a timeout does not prove
+        // rejection, and blindly retrying can send a second transfer.
+        await activity.writePending(submitted);
+        if (signal?.aborted) {
+          await activity.writePending(null);
+          assertActive(signal);
+        }
+        const returnedHash = await bundler.sendUserOperation(
+          operation,
+          SAFE_DEPLOYMENT.entryPoint,
+        );
+        if (
+          returnedHash.toLowerCase() !==
+          submitted.userOperationHash.toLowerCase()
+        )
+          throw new WalletError(
+            'VERIFICATION_FAILED',
+            'Bundler returned an unexpected operation hash. Check pending status.',
+          );
+        return submitted;
+      });
+    } finally {
+      submitting = false;
+    }
+  }
+  async function confirmTransfer(
+    submitted: SubmittedTransfer,
+  ): Promise<ConfirmedTransfer | null> {
+    return network(async () => {
+      await checkNetwork();
+      const owner = await ownerAddress();
+      if (
+        !isAddressEqual(submitted.ownerAddress, owner) ||
+        !isAddressEqual(submitted.safeAddress, predictSafeAddress(owner)) ||
+        !isAddressEqual(submitted.tokenAddress, config.tokenAddress)
+      )
+        throw new WalletError(
+          'VERIFICATION_FAILED',
+          'Tracking data does not belong to this wallet.',
+        );
+      const inclusion = await bundler.getUserOperationReceipt(
+        submitted.userOperationHash,
+      );
+      if (!inclusion) {
+        // Only release ambiguous tracking once the signed validity window is
+        // over on-chain AND the nonce is demonstrably unused. No blind retry.
+        const block = await client.getBlock();
+        if (block.timestamp > BigInt(submitted.validUntil) + 60n) {
+          const nonce = await client.readContract({
+            address: SAFE_DEPLOYMENT.entryPoint,
+            abi: entryPointAbi,
+            functionName: 'getNonce',
+            args: [submitted.safeAddress, 0n],
+            blockNumber: block.number,
+          });
+          if (nonce === BigInt(submitted.nonce)) {
+            await activity.writePending(null);
+            throw new WalletError(
+              'TRANSFER_EXPIRED',
+              'The operation expired with an unused nonce. You can prepare a new transfer.',
+            );
+          }
+        }
+        return null;
+      }
+      const receipt = await client.getTransactionReceipt({
+        hash: inclusion.receipt.transactionHash as Hash,
+      });
+      if (
+        (await client.getBlockNumber({ cacheTime: 0 })) <
+        receipt.blockNumber + 1n
+      )
+        return null;
+      let start = 0;
+      let end = -1;
+      let successful = false;
+      for (let i = 0; i < receipt.logs.length; i++) {
+        const log = receipt.logs[i];
+        if (!isAddressEqual(log.address, SAFE_DEPLOYMENT.entryPoint)) continue;
+        try {
+          const event = decodeEventLog({
+            abi: entryPointAbi,
+            data: log.data,
+            topics: log.topics,
+          });
+          if (event.eventName !== 'UserOperationEvent') continue;
+          if (
+            event.args.userOpHash.toLowerCase() ===
+              submitted.userOperationHash.toLowerCase() &&
+            isAddressEqual(event.args.sender, submitted.safeAddress) &&
+            event.args.nonce === BigInt(submitted.nonce)
+          ) {
+            end = i;
+            successful = event.args.success;
+            break;
+          }
+          start = i + 1;
+        } catch {
+          /* Other EntryPoint events. */
+        }
+      }
+      if (end < 0)
+        throw new WalletError(
+          'VERIFICATION_FAILED',
+          'The operation was not found in the on-chain receipt.',
+        );
+      if (receipt.status !== 'success' || !successful) {
+        await activity.writePending(null);
+        throw new WalletError(
+          'TRANSFER_FAILED',
+          'The operation reverted on Sepolia. No successful transfer was confirmed.',
+        );
+      }
+      const transferred = receipt.logs.slice(start, end).some((log) => {
+        if (!isAddressEqual(log.address, submitted.tokenAddress)) return false;
+        try {
+          const event = decodeEventLog({
+            abi: erc20Abi,
+            data: log.data,
+            topics: log.topics,
+          });
+          return (
+            event.eventName === 'Transfer' &&
+            isAddressEqual(event.args.from, submitted.safeAddress) &&
+            isAddressEqual(event.args.to, submitted.recipient) &&
+            event.args.value === BigInt(submitted.amountUnits)
+          );
+        } catch {
+          return false;
+        }
+      });
+      if (
+        !transferred ||
+        !(await verifySafe(
+          client,
+          submitted.safeAddress,
+          owner,
+          receipt.blockNumber,
+        ))
+      )
+        throw new WalletError(
+          'VERIFICATION_FAILED',
+          'The expected token transfer or Safe configuration could not be verified.',
+        );
+      const balances = await Promise.all(
+        [receipt.blockNumber - 1n, receipt.blockNumber].flatMap((blockNumber) =>
+          [submitted.safeAddress, submitted.recipient].map((address) =>
+            client.readContract({
+              address: submitted.tokenAddress,
+              abi: erc20Abi,
+              functionName: 'balanceOf',
+              args: [address],
+              blockNumber,
+            }),
+          ),
+        ),
+      );
+      const [senderBefore, recipientBefore, senderAfter, recipientAfter] =
+        balances;
+      const amount = BigInt(submitted.amountUnits);
+      const result: ConfirmedTransfer = {
+        ...submitted,
+        transactionHash: receipt.transactionHash,
+        explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.transactionHash}`,
+        blockNumber: receipt.blockNumber.toString(),
+        senderBalanceBefore: formatUnits(senderBefore, submitted.decimals),
+        senderBalanceAfter: formatUnits(senderAfter, submitted.decimals),
+        recipientBalanceBefore: formatUnits(
+          recipientBefore,
+          submitted.decimals,
+        ),
+        recipientBalanceAfter: formatUnits(recipientAfter, submitted.decimals),
+        balanceChangesMatch:
+          senderBefore - senderAfter === amount &&
+          recipientAfter - recipientBefore === amount,
+      };
+      await activity.writeConfirmed(result);
+      await activity.writePending(null);
+      return result;
+    });
+  }
+  return { getAccount, prepareTransfer, submitTransfer, confirmTransfer };
+}
diff --git a/scripts/sepolia-smoke.ts b/scripts/sepolia-smoke.ts
new file mode 100644
index 0000000..5d81ef2
--- /dev/null
+++ b/scripts/sepolia-smoke.ts
@@ -0,0 +1,163 @@
+import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
+import { resolve } from 'node:path';
+import { loadEnvFile } from 'node:process';
+import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
+import {
+  createSafeWallet,
+  predictSafeAddress,
+  WalletError,
+  type Address,
+  type ConfirmedTransfer,
+  type SubmittedTransfer,
+  type TransferActivityStore,
+} from '../packages/wallet-core';
+
+// This CLI uses its own disposable owner. Never export the phone's key here.
+try {
+  loadEnvFile('.env.sepolia');
+} catch (e) {
+  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
+}
+const keyFile = resolve(
+  process.env.SEPOLIA_SMOKE_KEY_FILE ?? '.sepolia-owner.key',
+);
+const stateFile = resolve(
+  process.env.SEPOLIA_SMOKE_STATE_FILE ?? '.sepolia-smoke.json',
+);
+
+async function main() {
+  const mode = process.argv[2] ?? 'address';
+  if (!['init', 'address', 'send', 'status'].includes(mode))
+    throw new Error('Use init, address, send, or status.');
+  if (mode === 'init') {
+    const key = generatePrivateKey();
+    await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 });
+    const owner = privateKeyToAddress(key);
+    console.log(
+      JSON.stringify(
+        {
+          ownerAddress: owner,
+          safeAddress: predictSafeAddress(owner),
+          note: 'Disposable test owner created. Run address to check Sepolia before funding.',
+        },
+        null,
+        2,
+      ),
+    );
+    return;
+  }
+  const readKey = async () => {
+    const key = (await readFile(keyFile, 'utf8')).trim();
+    if (!/^0x[\da-fA-F]{64}$/.test(key))
+      throw new Error('Invalid test owner key file.');
+    return key as `0x${string}`;
+  };
+  const owner = privateKeyToAddress(await readKey());
+  type State = {
+    pending: SubmittedTransfer | null;
+    confirmed: ConfirmedTransfer | null;
+  };
+  let state: State;
+  try {
+    state = JSON.parse(await readFile(stateFile, 'utf8')) as State;
+  } catch (e) {
+    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
+      throw new Error('Cannot read smoke tracking state.');
+    state = { pending: null, confirmed: null };
+  }
+  const persist = async () => {
+    await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2), {
+      mode: 0o600,
+    });
+    await rename(`${stateFile}.tmp`, stateFile);
+  };
+  const activity: TransferActivityStore = {
+    readPending: async () => state.pending,
+    writePending: async (value) => {
+      state.pending = value;
+      await persist();
+    },
+    writeConfirmed: async (value) => {
+      state.confirmed = value;
+      await persist();
+    },
+  };
+  const wallet = createSafeWallet({
+    config: {
+      rpcUrl: process.env.SEPOLIA_RPC_URL ?? '',
+      bundlerUrl: process.env.SEPOLIA_BUNDLER_URL ?? '',
+      tokenAddress: (process.env.SEPOLIA_TOKEN_ADDRESS ?? '') as Address,
+    },
+    storage: {
+      readAddress: async () => owner,
+      readPrivateKeyForSigning: readKey,
+      saveNewWallet: async () => {
+        throw new Error('Use init to create the test owner.');
+      },
+    },
+    activity,
+  });
+  if (mode === 'address') {
+    console.log(JSON.stringify(await wallet.getAccount(), null, 2));
+    return;
+  }
+  if (mode === 'send') {
+    if (state.pending)
+      throw new Error(
+        'An operation is pending. Run status instead of sending again.',
+      );
+    const preview = await wallet.prepareTransfer({
+      recipient: (process.env.SEPOLIA_RECIPIENT ?? '') as Address,
+      amount: process.env.SEPOLIA_AMOUNT ?? '1',
+    });
+    console.log('Transfer preview:', JSON.stringify(preview, null, 2));
+    const submitted = await wallet.submitTransfer(preview);
+    console.log('Submitted UserOperation:', submitted.userOperationHash);
+  }
+  if (!state.pending) {
+    console.log(
+      state.confirmed
+        ? JSON.stringify(state.confirmed, null, 2)
+        : 'No pending operation.',
+    );
+    return;
+  }
+  const pending = state.pending;
+  const deadline = Date.now() + 180_000;
+  while (Date.now() < deadline) {
+    const result = await wallet.confirmTransfer(pending);
+    if (result) {
+      console.log('Verified transfer:', JSON.stringify(result, null, 2));
+      if (!result.balanceChangesMatch) {
+        console.error(
+          'Transfer event verified; block balance deltas differ. Use an isolated recipient/token for the smoke test.',
+        );
+        process.exitCode = 1;
+      }
+      return;
+    }
+    await new Promise((done) => setTimeout(done, 3000));
+  }
+  console.error('Still pending. Run status later; do not resend.');
+  process.exitCode = 1;
+}
+async function runExclusively() {
+  const lockFile = `${stateFile}.lock`;
+  const lock = await open(lockFile, 'wx', 0o600);
+  try {
+    await main();
+  } finally {
+    await lock.close();
+    await unlink(lockFile);
+  }
+}
+runExclusively().catch((error: unknown) => {
+  // Never print provider/SDK errors, URLs, or private key file contents.
+  if (error instanceof WalletError)
+    console.error(`${error.code}: ${error.message}`);
+  else
+    console.error(
+      'Smoke run failed. Check configuration, funding, key/state files, and pending status.',
+    );
+  process.exitCode = 1;
+});
diff --git a/tests/wallet-core/safeTransfer.test.ts b/tests/wallet-core/safeTransfer.test.ts
new file mode 100644
index 0000000..c93ea67
--- /dev/null
+++ b/tests/wallet-core/safeTransfer.test.ts
@@ -0,0 +1,506 @@
+import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
+import {
+  createUserOperationHash,
+  SafeAccountV0_3_0,
+  type UserOperationV7,
+} from 'abstractionkit';
+import {
+  encodeAbiParameters,
+  encodeEventTopics,
+  encodeFunctionResult,
+  parseAbi,
+  recoverAddress,
+  type Address,
+  type Hex,
+} from 'viem';
+import { privateKeyToAddress } from 'viem/accounts';
+import {
+  createSafeWallet,
+  predictSafeAddress,
+  SAFE_DEPLOYMENT,
+  type OwnerKeyStorage,
+  type SubmittedTransfer,
+  type ConfirmedTransfer,
+  type TransferActivityStore,
+} from '../../packages/wallet-core';
+import { safeAbi } from '../../packages/wallet-core/safe/account';
+import {
+  encodeTransfer,
+  erc20Abi,
+} from '../../packages/wallet-core/transactions/erc20';
+
+// Public test vectors, used only with the mocked chain.
+const key = `0x${'0'.repeat(63)}1` as const;
+const owner = privateKeyToAddress(key);
+const safe = predictSafeAddress(owner);
+const token = '0x1111111111111111111111111111111111111111';
+const recipient = '0x2222222222222222222222222222222222222222';
+const txHash = `0x${'3'.repeat(64)}`;
+const blockHash = `0x${'4'.repeat(64)}`;
+const eventAbi = parseAbi([
+  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
+]);
+let chainId: string;
+let deployed: boolean;
+let tokenBalance: bigint;
+let ethBalance: bigint;
+let nonce: bigint;
+let threshold: bigint;
+let success: boolean;
+let includeTransfer: boolean;
+let inclusion: boolean;
+let pending: SubmittedTransfer | null;
+let confirmed: ConfirmedTransfer | null;
+let sent: UserOperationV7 | null;
+let sendTimeout: boolean;
+let receiptStatus: string;
+let nextBlock: bigint;
+let trace: string[];
+const storage: OwnerKeyStorage = {
+  readAddress: vi.fn(async () => owner),
+  readPrivateKeyForSigning: vi.fn(async () => key),
+  saveNewWallet: vi.fn(),
+};
+const activity: TransferActivityStore = {
+  readPending: async () => pending,
+  writePending: async (value) => {
+    trace.push('persist');
+    pending = value;
+  },
+  writeConfirmed: async (value) => {
+    confirmed = value;
+  },
+};
+const wallet = () =>
+  createSafeWallet({
+    config: {
+      rpcUrl: 'https://rpc.test',
+      bundlerUrl: 'https://bundler.test',
+      tokenAddress: token,
+    },
+    storage,
+    activity,
+  });
+const hex = (n: bigint) => `0x${n.toString(16)}`;
+const result = (
+  abi: typeof erc20Abi | typeof safeAbi,
+  functionName: string,
+  value: unknown,
+) =>
+  encodeFunctionResult({ abi, functionName, result: value } as Parameters<
+    typeof encodeFunctionResult
+  >[0]);
+
+function logs() {
+  if (!pending) throw new Error('No pending op');
+  const base = {
+    blockNumber: '0x64',
+    blockHash,
+    transactionHash: txHash,
+    transactionIndex: '0x0',
+    removed: false,
+  };
+  const transfer = {
+    ...base,
+    address: token,
+    logIndex: '0x0',
+    topics: encodeEventTopics({
+      abi: erc20Abi,
+      eventName: 'Transfer',
+      args: { from: safe, to: recipient },
+    }),
+    data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]),
+  };
+  const operation = {
+    ...base,
+    address: SAFE_DEPLOYMENT.entryPoint,
+    logIndex: '0x1',
+    topics: encodeEventTopics({
+      abi: eventAbi,
+      eventName: 'UserOperationEvent',
+      args: {
+        userOpHash: pending.userOperationHash,
+        sender: safe,
+        paymaster: '0x0000000000000000000000000000000000000000',
+      },
+    }),
+    data: encodeAbiParameters(
+      [
+        { type: 'uint256' },
+        { type: 'bool' },
+        { type: 'uint256' },
+        { type: 'uint256' },
+      ],
+      [0n, success, 1n, 1n],
+    ),
+  };
+  return includeTransfer ? [transfer, operation] : [operation];
+}
+function receipt() {
+  return {
+    transactionHash: txHash,
+    transactionIndex: '0x0',
+    blockNumber: '0x64',
+    blockHash,
+    from: recipient,
+    to: SAFE_DEPLOYMENT.entryPoint,
+    cumulativeGasUsed: '0x1',
+    gasUsed: '0x1',
+    effectiveGasPrice: '0x1',
+    logs: logs(),
+    logsBloom: `0x${'0'.repeat(512)}`,
+    status: receiptStatus,
+    type: '0x2',
+  };
+}
+async function rpc(method: string, params: unknown[] = []) {
+  switch (method) {
+    case 'eth_chainId':
+      return chainId;
+    case 'eth_supportedEntryPoints':
+      return [SAFE_DEPLOYMENT.entryPoint];
+    case 'eth_getCode':
+      return String(params[0]).toLowerCase() === safe.toLowerCase() && !deployed
+        ? '0x'
+        : '0x6000';
+    case 'eth_getBalance':
+      return hex(ethBalance);
+    case 'eth_gasPrice':
+      return '0x3b9aca00';
+    case 'eth_maxPriorityFeePerGas':
+      return '0x3b9aca00';
+    case 'eth_getBlockByNumber':
+      return {
+        number: '0x63',
+        timestamp: hex(BigInt(Math.floor(Date.now() / 1000))),
+        hash: blockHash,
+        transactions: [],
+      };
+    case 'eth_blockNumber':
+      return hex(nextBlock);
+    case 'eth_getStorageAt': {
+      const value =
+        params[1] === '0x0'
+          ? SAFE_DEPLOYMENT.singleton
+          : SAFE_DEPLOYMENT.module;
+      return `0x${'0'.repeat(24)}${value.slice(2)}`;
+    }
+    case 'eth_call': {
+      const { to, data } = params[0] as { to: string; data: string };
+      const selector = data.slice(0, 10);
+      if (selector === '0x35567e1a')
+        return encodeAbiParameters([{ type: 'uint256' }], [nonce]); // EntryPoint.getNonce
+      if (to.toLowerCase() === token.toLowerCase()) {
+        if (selector === '0x313ce567') return result(erc20Abi, 'decimals', 6);
+        const isSafe =
+          data.slice(-40).toLowerCase() === safe.slice(2).toLowerCase();
+        const after = params[1] === '0x64';
+        return result(
+          erc20Abi,
+          'balanceOf',
+          isSafe
+            ? after
+              ? 9_000_000n
+              : tokenBalance
+            : after
+              ? 1_000_000n
+              : 0n,
+        );
+      }
+      if (to.toLowerCase() === SAFE_DEPLOYMENT.entryPoint.toLowerCase())
+        return encodeAbiParameters([{ type: 'uint256' }], [0n]);
+      if (selector === '0xa0e67e2b')
+        return result(safeAbi, 'getOwners', [owner]);
+      if (selector === '0xe75235b8')
+        return result(safeAbi, 'getThreshold', threshold);
+      if (selector === '0xffa1ad74') return result(safeAbi, 'VERSION', '1.4.1');
+      if (selector === '0xcc2f8452')
+        return result(safeAbi, 'getModulesPaginated', [
+          [SAFE_DEPLOYMENT.module],
+          '0x0000000000000000000000000000000000000001',
+        ]);
+      throw new Error(`Unexpected call ${selector}`);
+    }
+    case 'eth_estimateUserOperationGas':
+      return {
+        callGasLimit: '0x186a0',
+        verificationGasLimit: '0x493e0',
+        preVerificationGas: '0xc350',
+      };
+    case 'eth_sendUserOperation': {
+      trace.push('send');
+      const raw = params[0] as Record<string, unknown>;
+      sent = Object.fromEntries(
+        Object.entries(raw).map(([k, v]) => [
+          k,
+          [
+            'nonce',
+            'callGasLimit',
+            'verificationGasLimit',
+            'preVerificationGas',
+            'maxFeePerGas',
+            'maxPriorityFeePerGas',
+          ].includes(k)
+            ? BigInt(v as string)
+            : v,
+        ]),
+      ) as unknown as UserOperationV7;
+      deployed = true;
+      if (sendTimeout) throw new Error('secret URL and key must never surface');
+      return createUserOperationHash(
+        sent,
+        SAFE_DEPLOYMENT.entryPoint,
+        11155111n,
+      );
+    }
+    case 'eth_getUserOperationReceipt':
+      return inclusion
+        ? {
+            userOpHash: pending!.userOperationHash,
+            entryPoint: SAFE_DEPLOYMENT.entryPoint,
+            sender: safe,
+            nonce: '0x0',
+            paymaster: '0x0000000000000000000000000000000000000000',
+            actualGasCost: '0x1',
+            actualGasUsed: '0x1',
+            success,
+            logs: logs(),
+            receipt: receipt(),
+          }
+        : null;
+    case 'eth_getTransactionReceipt':
+      return receipt();
+    default:
+      throw new Error(`Unhandled RPC ${method}`);
+  }
+}
+
+beforeEach(() => {
+  vi.clearAllMocks();
+  chainId = '0xaa36a7';
+  deployed = false;
+  tokenBalance = 10_000_000n;
+  ethBalance = 10n ** 18n;
+  nonce = 0n;
+  threshold = 1n;
+  success = true;
+  includeTransfer = true;
+  inclusion = true;
+  pending = null;
+  confirmed = null;
+  sent = null;
+  sendTimeout = false;
+  receiptStatus = '0x1';
+  nextBlock = 101n;
+  trace = [];
+  vi.mocked(storage.readAddress).mockResolvedValue(owner);
+  vi.mocked(storage.readPrivateKeyForSigning).mockResolvedValue(key);
+  vi.stubGlobal(
+    'fetch',
+    vi.fn(async (_input: unknown, init: RequestInit) => {
+      const request = JSON.parse(init.body as string) as {
+        id: number;
+        method: string;
+        params: unknown[];
+      };
+      const value = await rpc(request.method, request.params);
+      return new Response(
+        JSON.stringify({ id: request.id, jsonrpc: '2.0', result: value }),
+        { headers: { 'Content-Type': 'application/json' } },
+      );
+    }),
+  );
+});
+afterEach(() => vi.unstubAllGlobals());
+
+describe('Sepolia Safe transfer', () => {
+  it('builds, signs, deploys and independently verifies a token transfer', async () => {
+    const service = wallet();
+    const preview = await service.prepareTransfer({ recipient, amount: '1' });
+    expect(preview.deploysSafe).toBe(true);
+    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
+    const submission = await service.submitTransfer(preview);
+    expect(trace).toEqual(['persist', 'send']);
+    expect(sent!.factory).toBe(SAFE_DEPLOYMENT.factory);
+    const signature = sent!.signature as Hex;
+    const validUntil = BigInt(`0x${signature.slice(14, 26)}`);
+    const hash = SafeAccountV0_3_0.getUserOperationEip712Hash(
+      sent!,
+      11155111n,
+      { validUntil },
+    );
+    expect(
+      await recoverAddress({
+        hash: hash as Hex,
+        signature: `0x${signature.slice(26)}`,
+      }),
+    ).toBe(owner);
+    const proof = await service.confirmTransfer(submission);
+    expect(proof).toMatchObject({
+      transactionHash: txHash,
+      balanceChangesMatch: true,
+      senderBalanceAfter: '9',
+      recipientBalanceAfter: '1',
+    });
+    expect(pending).toBeNull();
+    expect(confirmed).toEqual(proof);
+  });
+  it('reuses a deployed Safe without factory data', async () => {
+    deployed = true;
+    const service = wallet();
+    const preview = await service.prepareTransfer({ recipient, amount: '1' });
+    expect(preview.deploysSafe).toBe(false);
+    await service.submitTransfer(preview);
+    expect(sent!.factory).toBeNull();
+  });
+  it('rejects the wrong chain and an unexpected Safe threshold before authentication', async () => {
+    chainId = '0x1';
+    await expect(wallet().getAccount()).rejects.toMatchObject({
+      code: 'CHAIN_CONFIG_INVALID',
+    });
+    chainId = '0xaa36a7';
+    deployed = true;
+    threshold = 2n;
+    await expect(wallet().getAccount()).rejects.toMatchObject({
+      code: 'SAFE_CONFIG_INVALID',
+    });
+    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
+  });
+  it('rejects insufficient tokens and gas before authentication', async () => {
+    tokenBalance = 0n;
+    await expect(
+      wallet().prepareTransfer({ recipient, amount: '1' }),
+    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
+    tokenBalance = 10_000_000n;
+    ethBalance = 0n;
+    await expect(
+      wallet().prepareTransfer({ recipient, amount: '1' }),
+    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
+    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
+  });
+  it('cancels during authentication without persisting or broadcasting', async () => {
+    const service = wallet();
+    const controller = new AbortController();
+    const preview = await service.prepareTransfer({ recipient, amount: '1' });
+    vi.mocked(storage.readPrivateKeyForSigning).mockImplementationOnce(
+      async () => {
+        controller.abort();
+        return key;
+      },
+    );
+    await expect(
+      service.submitTransfer(preview, controller.signal),
+    ).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
+    expect(sent).toBeNull();
+    expect(pending).toBeNull();
+  });
+  it('rejects mismatched keys, stale nonces, expired previews and forged previews', async () => {
+    const service = wallet();
+    const preview = await service.prepareTransfer({ recipient, amount: '1' });
+    vi.mocked(storage.readPrivateKeyForSigning).mockResolvedValueOnce(
+      `0x${'0'.repeat(63)}2`,
+    );
+    await expect(service.submitTransfer(preview)).rejects.toMatchObject({
+      code: 'KEY_UNAVAILABLE',
+    });
+    nonce = 1n;
+    await expect(service.submitTransfer(preview)).rejects.toMatchObject({
+      code: 'TRANSFER_EXPIRED',
+    });
+    await expect(
+      service.submitTransfer({ ...preview, amount: '1000' }),
+    ).rejects.toMatchObject({ code: 'TRANSFER_EXPIRED' });
+    vi.spyOn(Date, 'now').mockReturnValue(preview.expiresAt + 1);
+    await expect(service.submitTransfer(preview)).rejects.toMatchObject({
+      code: 'TRANSFER_EXPIRED',
+    });
+    vi.restoreAllMocks();
+    expect(sent).toBeNull();
+  });
+  it('keeps tracking after an ambiguous send failure and blocks duplicate sending', async () => {
+    const service = wallet();
+    const preview = await service.prepareTransfer({ recipient, amount: '1' });
+    sendTimeout = true;
+    await expect(service.submitTransfer(preview)).rejects.toMatchObject({
+      code: 'NETWORK_FAILED',
+      message: 'Sepolia request failed. Check connectivity and configuration.',
+    });
+    expect(pending).not.toBeNull();
+    await expect(
+      service.prepareTransfer({ recipient, amount: '1' }),
+    ).rejects.toMatchObject({ code: 'TRANSFER_PENDING' });
+    expect(await wallet().confirmTransfer(pending!)).toMatchObject({
+      transactionHash: txHash,
+    });
+  });
+  it('waits for inclusion and two confirmations', async () => {
+    const service = wallet();
+    const submission = await service.submitTransfer(
+      await service.prepareTransfer({ recipient, amount: '1' }),
+    );
+    inclusion = false;
+    expect(await service.confirmTransfer(submission)).toBeNull();
+    inclusion = true;
+    nextBlock = 100n;
+    expect(await service.confirmTransfer(submission)).toBeNull();
+    expect(pending).not.toBeNull();
+  });
+  it('releases an expired ambiguous operation only when its nonce is unused', async () => {
+    const service = wallet();
+    const submission = await service.submitTransfer(
+      await service.prepareTransfer({ recipient, amount: '1' }),
+    );
+    inclusion = false;
+    vi.spyOn(Date, 'now').mockReturnValue(
+      (Number(submission.validUntil) + 120) * 1000,
+    );
+    try {
+      nonce = 1n;
+      expect(await service.confirmTransfer(submission)).toBeNull();
+      expect(pending).not.toBeNull();
+      nonce = 0n;
+      await expect(service.confirmTransfer(submission)).rejects.toMatchObject({
+        code: 'TRANSFER_EXPIRED',
+      });
+      expect(pending).toBeNull();
+    } finally {
+      vi.restoreAllMocks();
+    }
+  });
+  it('does not mistake an EntryPoint transaction success for operation success', async () => {
+    const service = wallet();
+    const submission = await service.submitTransfer(
+      await service.prepareTransfer({ recipient, amount: '1' }),
+    );
+    success = false;
+    await expect(service.confirmTransfer(submission)).rejects.toMatchObject({
+      code: 'TRANSFER_FAILED',
+    });
+    expect(confirmed).toBeNull();
+    expect(pending).toBeNull();
+  });
+  it('requires the token Transfer event, not just a successful operation', async () => {
+    const service = wallet();
+    const submission = await service.submitTransfer(
+      await service.prepareTransfer({ recipient, amount: '1' }),
+    );
+    includeTransfer = false;
+    await expect(service.confirmTransfer(submission)).rejects.toMatchObject({
+      code: 'VERIFICATION_FAILED',
+    });
+    expect(confirmed).toBeNull();
+    expect(pending).not.toBeNull();
+  });
+  it.each(['1.0000001', '0', '-1', '1e6', 'NaN'])(
+    'rejects unsafe token amount %s',
+    (amount) => {
+      expect(() => encodeTransfer(recipient, amount, 6)).toThrow();
+    },
+  );
+  it('rejects a zero recipient and preserves exact token units', () => {
+    expect(() =>
+      encodeTransfer('0x0000000000000000000000000000000000000000', '1', 6),
+    ).toThrow();
+    expect(encodeTransfer(recipient, '1.000001', 6).units).toBe(1_000_001n);
+  });
+});
````

## Appendix B. Workspace navigation map

This map is outside the repository and is not pushed by this repository commit. Paths are relative to the repository unless indicated otherwise.

````markdown
# Carte du dépôt

Carte conservée dans le workspace `hackathons/` pour le dépôt
`BSA_Hackathon_SwissQuote_Track/`, vérifiée le
2026-10-10. Lire uniquement les entrées utiles à la tâche, puis vérifier le code
concerné. Mettre à jour les entrées affectées lorsque le dépôt évolue.

## Architecture et état actuel

- **Monorepo npm** : [`package.json`](../BSA_Hackathon_SwissQuote_Track/package.json) déclare `apps/mobile` et
  `packages/*`. Le backend Python reste indépendant des workspaces npm.
- **Mobile livré** : Expo 57, React Native, TypeScript, Expo Router et NativeWind.
  Création EOA, startup selon adresse persistée, signature/vérification EIP-191 avec
  adaptateur SecureStore ; soldes Safe et Send sont connectés à Sepolia/ERC-4337 ; Recovery reste mocké. Validation
  biométrique sur appareil réel et Recovery Kit hors ligne encore à faire.
- **Lien mobile → wallet-core** : `apps/mobile/index.ts` installe la randomness
  native avant Expo Router. `src/lib/wallet.ts` assemble `createOwnerWallet` et
  `secureStoreAdapter`. Le core expose Sepolia et l’API OwnerWallet ; `signMessage`
  accepte un AbortSignal, annulé par l’écran lors de background/navigation. `src/lib/safeWallet.ts` assemble `createSafeWallet`, persiste la Safe et le suivi pending/confirmed ; une signature Safe relit le secret protégé.
- **Backend livré** : `backend/app/main.py` fournit health, registre SQLite et
  screening mock authentifiés par token serveur (`MOCK_ACCESS_TOKEN`, 32 caractères
  minimum ; `MOCK_USER_ID`). Validation stricte ; isolation des utilisateurs.
  Recovery vérifie utilisateur/Safe puis retourne `501`, sans fausse signature.
  Aucun contrôle owner Safe on-chain : le flux Safe/ERC-4337 utilise directement RPC/bundler ; le lien EOA mobile existant reste distinct.
- **Architecture cible** : EOA générée et protégée sur le téléphone → signature
  locale → Safe/ERC-4337 → Sepolia. ClientSafe détient les actifs ; FastAPI gère
  les métadonnées et services bancaires simulés, sans recevoir la clé client.
  Recovery Candide : trois guardians directs SQ/A/B, n'importe quels **2/3**,
  contestation **7 jours on-chain**, annulation signée par l'owner actuel.
  viem est intégré pour la création EOA et les messages EIP-191 ; les erreurs inattendues de lecture/écriture/signature sont masquées. SecureStore est intégré mais reste à valider sur appareil ; Safe/abstractionkit/ERC-4337 sont intégrés (1.4.1 / SDK 0.4.0 / EntryPoint 0.7) ; endpoints publics et présence des contrats vérifiés en lecture. Transfert financé Sepolia, appareil réel, Recovery Kit et paymaster restent à valider/livrer.

## Fonctionnalités → fichiers

Les chemins mobile ci-dessous sont relatifs à `apps/mobile/` ; les autres partent
de la racine du dépôt `BSA_Hackathon_SwissQuote_Track/` (pas du workspace).
Les routes délèguent aux écrans dans `src/features/`.

| Sujet                            | Point d'entrée / fichiers                                                                                                                                                 | État ou responsabilité                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Démarrage et navigation mobile   | `apps/mobile/index.ts`, `package.json`, `src/app/_layout.tsx`                                                                                                             | Bootstrap crypto avant routes ; Stack, titres, StatusBar et providers                                                                                                                     |
| Accueil / onboarding `/`         | `src/app/index.tsx`, `src/app/create-wallet.tsx` → `src/features/onboarding/CreateWalletScreen.tsx`                                                                       | Startup vers wallet existant ou création EOA native ; pas de remplacement après stockage incertain                                                                                        |
| Wallet `/wallet`                 | `src/app/wallet.tsx` → `src/features/wallet/WalletScreen.tsx`, `src/hooks/useOwnerAddress.ts`                                                                             | Adresse Safe déterministe persistée, owners/modules/handler vérifiés si déployée ; soldes token/ETH RPC, funding testnet                                                                  |
| Transfert `/send`                | `src/app/send.tsx` → `src/features/transfer/SendScreen.tsx`                                                                                                               | Validation ERC-20, aperçu immutable + gas, SecureStore/signature Safe, bundler, suivi après restart, reçu/événements/soldes vérifiés après 2 confirmations                                |
| Recovery `/recovery`             | `src/app/recovery.tsx` → `src/features/recovery/RecoveryScreen.tsx`                                                                                                       | Aperçu du modèle SQ/A/B direct 2/3, A+B sans banque, sept jours ; aucun recovery exécuté                                                                                                  |
| Composants et thème              | `src/components/{Screen,Button}.tsx`, `src/theme/colors.js`, `global.css`, `tailwind.config.js`                                                                           | Mise en page, boutons, couleurs partagées avec la navigation                                                                                                                              |
| Configuration native et bundling | `app.config.ts`, `metro.config.js`, `babel.config.js`, `tsconfig.json`, `.env.example`                                                                                    | Identifiants/plugins Expo, NativeWind, TypeScript ; RPC/bundler/token Sepolia publics configurables, contrats Safe pinnés                                                                 |
| Réseau et exports partagés       | `packages/wallet-core/index.ts`, `packages/wallet-core/config/chains.ts`                                                                                                  | Sepolia `11155111`, exports OwnerWallet et createSafeWallet, stockage/suivi/erreurs ; entrée TypeScript consommée par Metro                                                               |
| Clés et signature                | `packages/wallet-core/keys/`, `packages/wallet-core/signing/`, `apps/mobile/src/lib/{wallet,secureStoreAdapter,polyfills}.ts`, `src/features/security/SignTestScreen.tsx` | EOA viem + SecureStore protégé ; rollback vérifié, lecture fraîche, contrôle owner et AbortSignal pour background/navigation ; tests natifs requis                                        |
| Safe, ERC-20 et ERC-4337         | `packages/wallet-core/safe/account.ts`, `packages/wallet-core/transactions/{erc20,userOperation}.ts`, `apps/mobile/src/lib/safeWallet.ts`                                 | Safe owner 1/1 et sel 0 ; premier UserOperation déploie + transfère ; pas de recovery/paymaster ; preuve financée Sepolia encore requise                                                  |
| Guardians et recovery on-chain   | `packages/wallet-core/guardians/`, `packages/wallet-core/recovery/`                                                                                                       | Dossiers réservés ; décisions actuelles dans README §§6–8, 15                                                                                                                             |
| API et tests backend             | `backend/app/main.py`, `backend/tests/test_health.py`, `backend/requirements*.txt`, `backend/.env.example`                                                                | Health, registre et screening mock ; token serveur, validation stricte et tests isolés ; recovery retourne 501                                                                            |
| Services backend futurs          | `backend/app/{auth,wallet_registry,transactions,guardian_policy,recovery,sponsorship,compliance}/__init__.py`                                                             | Docstrings de responsabilités uniquement                                                                                                                                                  |
| Déploiements                     | `config/deployments.example.json`, `config/sepolia.env.example`, `backend/.env.example`                                                                                   | Safe 1.4.1/module 0.3.0/EntryPoint 0.7/SDK 0.4.0 et USDC test documentés ; recovery à null ; paramètres backend non chargés                                                               |
| Interface bancaire optionnelle   | `apps/swissquote-demo/README.md`                                                                                                                                          | Emplacement réservé, aucun package/serveur                                                                                                                                                |
| Tests TypeScript / Sepolia       | `vitest.config.mts`, `tests/wallet-core/safeTransfer.test.ts`, `tests/mobile/`, `scripts/sepolia-smoke.ts`, `docs/sepolia-transaction.md`                                 | Tests RPC mock + SDK réel : format signature Safe, annulation, fonds, nonce, reçu/events/config ; smoke CLI init/address/send/status, owner test séparé ; transfert on-chain non démontré |
| CI et qualité                    | `.github/workflows/ci.yml`, `.prettierrc.json`, `.prettierignore`, `apps/mobile/eslint.config.js`                                                                         | Jobs JavaScript et Python ; scripts ci-dessous                                                                                                                                            |

## Commandes de développement

Depuis la racine du dépôt, sauf indication contraire. Depuis le workspace,
commencer par `cd BSA_Hackathon_SwissQuote_Track`. Node 24 est fixé par `.nvmrc` ;
Python 3.11+ est indiqué dans le guide de démarrage.

```bash
cd BSA_Hackathon_SwissQuote_Track # depuis le workspace hackathons/
npm ci
npm run mobile:web       # démo navigateur
npm run mobile:android   # build natif local ; SDK Android requis
npm run mobile:ios       # build natif local ; macOS/Xcode requis
npm run mobile           # serveur pour development build installé
npm run mobile:go        # mock sous Expo Go compatible
```

```bash
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements-dev.txt
python -m uvicorn app.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

Le flux Safe exige RPC/bundler/token via `.env` ; le parcours de lien existant utilise FastAPI. Configuration :
`apps/mobile/.env.example` et `backend/.env.example`. Instructions détaillées :
[`getting-started.md`](../BSA_Hackathon_SwissQuote_Track/docs/getting-started.md).

```bash
npm run typecheck        # tous les workspaces
npm run lint             # mobile
npm run format:check
npm test                 # core, Safe/RPC mock et frontières mobiles
npm run sepolia:smoke -- init    # owner CLI jetable, sans afficher la clé
npm run sepolia:smoke -- address # vérifications RPC, adresse Safe à financer
npm run sepolia:smoke -- send    # envoi testnet explicite ; .env.sepolia requis
npm run sepolia:smoke -- status  # suivi ; ne pas renvoyer après un timeout
python -m pytest backend # venv actif, comme pour les commandes Ruff
python -m ruff check backend
python -m ruff format --check backend
```

Pour cibler TypeScript : `npm run typecheck --workspace @swissquote/mobile` ou
`npm run typecheck --workspace @swissquote/wallet-core`. Depuis le workspace,
formater uniquement les fichiers de navigation avec
`./BSA_Hackathon_SwissQuote_Track/node_modules/.bin/prettier --write AGENTS.md docs/REPO_MAP.md`.
Les consignes mobiles supplémentaires sont dans
[`apps/mobile/AGENTS.md`](../BSA_Hackathon_SwissQuote_Track/apps/mobile/AGENTS.md).

## Documentation et écarts connus

- [`README.md`](../BSA_Hackathon_SwissQuote_Track/README.md) : architecture cible (§§2–4), clés/guardians/recovery
  (§§5–8), flux/API (§§9–10), sécurité (§11), POCs et acceptation (§15), statut final.
  Ce document décrit des exigences, pas une preuve de réalisation.
- [`sepolia-transaction.md`](../BSA_Hackathon_SwissQuote_Track/docs/sepolia-transaction.md) : stack pinnée, funding, smoke CLI, parcours mobile, vérifications et limites de preuve.
- [`sepolia-test-handoff.md`](../BSA_Hackathon_SwissQuote_Track/docs/sepolia-test-handoff.md) : explication complète du milestone test, inventaire des fichiers, patch intégral, configuration et acceptance sur téléphone.
- [`demo-script.md`](../BSA_Hackathon_SwissQuote_Track/docs/demo-script.md) décrit la démo transaction Safe ; Recovery reste mocké ;
  [`threat-model.md`](../BSA_Hackathon_SwissQuote_Track/docs/threat-model.md) réserve l'analyse des menaces.
- **Ancien recovery à ne pas recopier comme décision actuelle** :
  `docs/custody-model.md`, `docs/recovery-runbook.md`,
  `docs/test-plan.md`,
  `packages/wallet-core/guardians/README.md`, `tests/wallet-core/README.md` et
  les champs guardians de `config/deployments.example.json` conservent des
  références à Swissquote obligatoire, des Safes imbriquées ou l'ancien POC
  ERC-1271. Le README racine retient désormais SQ/A/B directs, seuil 2/3 et A+B
  sans banque ; il contient aussi quelques références héritées à ERC-1271.
  Réconcilier les fichiers concernés lors d'une tâche recovery.
- Vérifier sur appareil réel les protections natives ; une preview web ou un
  export JS ne valide pas la biométrie/signature. Ne jamais placer de clé client
  dans l'API, les logs ou les variables `EXPO_PUBLIC_*`.
````
