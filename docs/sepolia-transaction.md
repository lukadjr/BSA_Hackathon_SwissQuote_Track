# One Safe transfer on Sepolia

This milestone implements a single-owner Safe and a self-funded ERC-4337 ERC-20
transfer. Recovery and paymaster sponsorship are not configured. The Safe receives
assets; the phone's EOA signs. The first UserOperation deploys the prefunded Safe
and performs the transfer together.

## Pinned stack and verification status

- AbstractionKit **0.4.0**, `SafeAccountV0_3_0` (explicit v0.7 compatibility class).
- Safe L2 **1.4.1**, Safe4337Module **0.3.0**, EntryPoint **0.7**.
- Sepolia **11155111**, one owner, threshold **1**, CREATE2 salt **0**.
- Addresses in `packages/wallet-core/safe/account.ts`; no factory/salt overrides.
- Example token: [Circle Sepolia test USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses),
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, six decimals verified by RPC.

On 2026-10-10 the public example RPC/bundler passed the read-only Sepolia,
EntryPoint-support, contract-code and token-decimal checks. This proves endpoint
compatibility and contract presence, not bytecode auditing or a successful transfer.
A funded on-chain transfer and native biometric signing remain to be demonstrated.
Local tests use mocked RPC responses with real SDK construction/signatures.
Android/iOS Hermes and web exports passed; device execution is a separate gate.
Metro reports an upstream `@noble/hashes/crypto.js` export-resolution warning,
falling back to the existing file; no dependency patch was applied.

## Command-line smoke test

Run from the repository root using Node 24 and installed dependencies:

```bash
cp config/sepolia.env.example .env.sepolia
npm run sepolia:smoke -- init
npm run sepolia:smoke -- address
```

`init` creates an exclusive, mode-0600 `.sepolia-owner.key` with a disposable CLI
owner. It never prints the key. It refuses to overwrite an existing key. `address`
checks the live configuration and prints the Safe address and actual balances.
This CLI owner is independent of the phone's owner; their Safe addresses differ.

Fund the printed **Safe address** with Sepolia ETH and at least the requested
amount of the configured ERC-20. For deployment, start with approximately
**0.01 Sepolia ETH** and adjust to the displayed gas estimate. Obtain test USDC
from [Circle's faucet](https://faucet.circle.com/) or transfer existing test tokens;
obtain Sepolia ETH from a testnet faucet. Funding transactions are separate from
this application's outgoing transfer. The owner EOA need not pay gas.

Set `SEPOLIA_RECIPIENT` in `.env.sepolia` to an independent address, then:

```bash
npm run sepolia:smoke -- send
# If confirmation times out or the connection drops:
npm run sepolia:smoke -- status
```

`send` explicitly authorizes the CLI to sign/send the configured test transfer.
It prints the preview, operation hash and, after two confirmations, the transaction
hash/explorer URL, verified Transfer event, Safe configuration, and balances before
and after the transaction's block. Use an isolated recipient for exact balance
comparison: other activity in the same block can alter the block deltas. The
smoke command reports a nonzero exit code if those deltas differ.

Tracking is written atomically before broadcasting. After an ambiguous network
failure, use `status`, not another `send`. The operation signature expires after
10 minutes. Tracking can be released when the chain is more than a minute past
expiry and the same block still shows the nonce unused; otherwise it stays pending.
Known on-chain reverts clear pending tracking and never produce a success result.
The CLI locks its state file while running. After a process crash, inspect pending
status before removing a stale `.sepolia-smoke.json.lock` file. Do not delete state
to force a retry. Keys, local environment and default tracking files are gitignored.

## Phone flow

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

The template contains the same public Sepolia RPC/bundler/token examples. These
endpoints have availability/rate limits; a replacement bundler must support
EntryPoint v0.7. All `EXPO_PUBLIC_*` values ship in the app: use only public or
restricted testnet endpoints. No private keys or privileged provider credentials.

Keep the existing wallet-link onboarding and backend setup from
`docs/getting-started.md`. Start a Development Build and create/use the existing
protected owner. On Wallet, read the Safe address and actual balances, fund that
address with test ETH/tokens, then refresh. On Send:

1. Enter recipient and token amount; preview the exact token, Safe, recipient,
   amount and maximum gas cost (including deployment if necessary).
2. Select **Authenticate & send**. A fresh protected SecureStore read unlocks the
   EOA for the SDK's Safe EIP-712 signature. No key is returned to the UI or network.
3. Select **Check status** until confirmed. The transaction hash links to Sepolia.

Previews expire after two minutes. Payload edits, navigation and real background
transitions invalidate an attempt before submission. Once a request has been sent,
cancellation cannot undo blockchain inclusion; tracking survives restart. Test
native authentication cancellation, repeated signing, invalidated keys and
background/navigation on real devices. Development reset permanently deletes the
owner key and tracking; assets in its old Safe become inaccessible without an
independent backup.

## Acceptance evidence

Capture the owner/Safe addresses, operation hash and transaction hash. The core
requires the matching EntryPoint `UserOperationEvent` with success, the exact
ERC-20 `Transfer` within that operation's receipt segment, and the pinned Safe
owner/threshold/modules/handler/singleton/version. It reads balances at the preceding
block and inclusion block and reports whether both deltas match. A successful
outer EntryPoint transaction alone is insufficient.

```bash
npm run typecheck
npm run lint
npm test
npm run format:check
```

References: [Safe ERC-4337](https://docs.safe.global/advanced/erc-4337/4337-safe),
[Candide v0.7 account](https://docs.candide.dev/wallet/abstractionkit/safe-account-v3/).
