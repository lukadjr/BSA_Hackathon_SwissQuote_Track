# Wallet recovery

Social recovery for the client Safe, with three guardians, any two of which can
move the Safe to a new phone key after a **3-day** waiting period. The current
owner gets an alert and can cancel during that period.

## Configuration on the Safe

| Item            | Value                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner           | the phone's EOA (SecureStore + Face ID), threshold 1, unchanged                                                                                                                                                      |
| Recovery module | Candide `SocialRecoveryModule`, `0x38275826E1933303E508433dD5f289315Da2541c` (3 days, Sepolia). Demo: `0x949d01d424bE050D09C16025dd007CB59b3A8c66` (3 minutes) with `EXPO_PUBLIC_RECOVERY_PERIOD=demoThreeMinutes`   |
| Guardians       | **backup**: key derived from a 12-word phrase written on paper (`m/44'/60'/0'/0/0`), never stored; **Swissquote**: backend test signer; **friend**: a guardian key created in the friend's own Swissquote Wallet app |
| Threshold       | flat 2 of 3 (Swissquote is not required)                                                                                                                                                                             |

"Protect wallet" sends ONE owner-signed UserOperation (Face ID) that batches
`enableModule` + three `addGuardianWithThreshold` calls (thresholds 1, 1, 2). If
the Safe is not deployed yet, the same operation deploys it. The module is not
part of the Safe init code, so the counterfactual Safe address never changes.

`verifySafe()` accepts the 4337 module plus at most one of the two pinned
recovery modules. After a recovery, the phone stores a public binding
`{safe, owner}` (`swissquote.safe.recovered.v1`) because the Safe address is no
longer derivable from the new owner key.

## How a recovery works

1. The new phone creates its owner key and a recovery request (Safe, new owner,
   module nonce read on-chain).
2. Guardians sign the module's EIP-712 `ExecuteRecovery` data. The hash is checked
   against the deployed module (`getRecoveryHash`), in TS and Python tests.
3. With 2 approvals anyone sends `multiConfirmRecovery(..., execute=true)`: the
   backend relayer, or the new phone itself if it holds Sepolia ETH. The module
   stores `executeAfter = now + 3 days` and increments its nonce (old approvals
   become void).
4. The owner phone shows a red banner (read from the chain every 30 s and on
   foreground) with the new key's 4 words and a **Cancel** button (Face ID →
   `cancelRecovery()` executed by the Safe). The backend also records alerts and
   can send Expo pushes.
5. After the deadline anyone calls `finalizeRecovery(safe)`. The new key is the
   only owner; the Safe address and funds are unchanged. The new phone then
   re-links the wallet with Swissquote.

## Friend invite (QR, no email)

1. Owner phone: `POST /guardians/invites` → QR `{t: sqw-guardian-invite, safe, invite, from}`.
2. Friend app: "Be a guardian" → scan → Face ID → its guardian key signs
   "I agree to be a recovery guardian … Safe … Guardian key … Invite …" →
   `POST /guardians/invites/{id}/accept` with the **public address** and the signature.
3. Owner phone polls `GET /guardians/invites/{id}` and shows the friend's address
   as **4 words** (derived from the address). The friend's phone shows the same 4
   words. The owner confirms only if they match: a backend that swaps the address
   cannot make the words match on the friend's phone.

Recovery approvals use the same idea: the friend's app shows the new key's 4
words, and the friend calls the owner to compare before approving. Without the
backend, the friend's app shows the signed approval as a QR code that the
recovering phone scans.

## Cases

| Case                                                   | Who approves                                                | Result                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Lost phone key only                                    | backup phrase + Swissquote (or + friend)                    | new phone owns the Safe after 3 days                                          |
| Lost key and backup phrase                             | Swissquote + friend                                         | same; then create a new backup phrase (replace guardian)                      |
| Swissquote lost its key                                | —                                                           | owner replaces the Swissquote guardian immediately (no delay)                 |
| Friend lost their key                                  | —                                                           | owner replaces the friend immediately                                         |
| Malicious recovery (2 guardians collude or are stolen) | —                                                           | owner gets the alert and cancels within 3 days, then replaces those guardians |
| Swissquote backend offline                             | backup + friend, approval via QR, gas paid by the new phone | works without any Swissquote service                                          |
| Owner key stolen                                       | —                                                           | limit: the thief can spend and cancel recoveries; the delay does not protect  |
| Owner key + 2 guardians lost                           | —                                                           | unrecoverable: replace a lost guardian as soon as you notice                  |

Guardian changes are refused while a recovery is pending (cancel first). When
Swissquote reports a recovery _request_ that has not started on-chain yet, the
owner phone shows it and can void every approval already signed for it
(`invalidateNonce()` executed by the Safe).

## Tests

- `npm test`: unit tests, including the EIP-712 vector of the deployed module.
- `python -m pytest backend`: backend unit tests with a fake chain.
- On a local Sepolia fork (real Safe, EntryPoint and Candide bytecode; time is
  fast-forwarded):
  ```bash
  anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111
  # (or a Hardhat fork with chainId 11155111 and blockGasLimit 16777216)
  FORK_RPC_URL=http://127.0.0.1:8545 npm run recovery:fork-e2e
  ```
  covers protect, malicious recovery + cancel, every case above, replay and
  non-guardian rejection. `npm run recovery:backend-fork-e2e` runs the same flow
  through the backend (invite, approvals, Swissquote signer, relayer, alerts).
- `npm run fork:bundler` serves a minimal bundler for the fork so the app itself
  can run against it (`EXPO_PUBLIC_RPC_PUBLIC_URL`, `EXPO_PUBLIC_BUNDLER_URL`).

## Running on Sepolia

```bash
cd backend && python -m app.guardian_policy.signer init   # creates backend/data/*.key
export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
export RECOVERY_WATCHER_SECONDS=30                        # optional alerts watcher
```

Fund the printed relayer address with Sepolia ETH (it pays for starting and
finalizing recoveries). The Safe pays for its own "Protect" and "Cancel"
operations, like transfers. Rebuild the app after pulling (`expo-camera` is a new
native module): `cd apps/mobile && npx expo prebuild --platform ios && npx expo run:ios`.

## Limits of the prototype

- Swissquote's identity check is a mock (logged-in demo session + confirmation).
- The Swissquote guardian key is a file on the backend host, not an HSM.
- Phone push notifications need `expo-notifications` and an Apple push
  certificate; the backend already sends Expo pushes to registered tokens, the app
  shows the alert in-app.
