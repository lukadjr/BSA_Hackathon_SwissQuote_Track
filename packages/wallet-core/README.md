# wallet-core

Package TypeScript indépendant des écrans. Exporte `SEPOLIA`, le contrat `OwnerWallet`, la factory `createOwnerWallet`, le contrat de stockage `OwnerKeyStorage` et les erreurs typées. Création EOA, signature et vérification de messages via viem ; Safe/ERC-4337 est également intégré via `createSafeWallet` et les RPC Sepolia configurés.

Les dossiers `keys`, `signing`, `safe`, `transactions`, `guardians` et `recovery` réservent les responsabilités de la section 13 du README. Ajouter ici la logique testable ; garder l'adaptateur natif SecureStore au bord du module, sans dépendance UI.

Suivre les POCs A → E du README, puis verrouiller les versions de `viem`/`abstractionkit` et les contrats réellement vérifiés. Les tests futurs vont dans `tests/wallet-core`. Aucune cryptographie maison.

## First milestone: owner key API

```ts
import { createOwnerWallet } from '@swissquote/wallet-core';
import type { OwnerKeyStorage } from '@swissquote/wallet-core';

// Person 1 supplies the native storage adapter.
function setupWallet(storage: OwnerKeyStorage) {
  return createOwnerWallet({ storage });
}
```

- `getAddress()` reads public metadata through the injected adapter.
- `createWallet()` uses viem `generatePrivateKey()` and `privateKeyToAddress()`,
  refuses an existing address, waits for persistence, and returns only the address.
  Concurrent creation is serialized for instances sharing the same adapter object.
- `signMessage()` signs nonempty UTF-8 messages up to 4096 bytes using viem
  EIP-191 signing. It requests a fresh protected key read, validates the key against
  the owner address, and rechecks the owner after authentication. It returns only
  the registered address and signature; no key or signer is cached.
  `signMessage(message, { signal })` accepts an AbortSignal; aborting during
  authentication prevents signing, and a cancelled result is never returned.
- `verifyMessage()` performs public EOA verification with viem. Wrong owners,
  altered messages and malformed inputs return `false`; no storage is accessed.
  This API does not sign Safe transactions or verify contract-wallet signatures.
- Implement the native adapter in `apps/mobile/`: protect secret writes and every
  signing read, map cancellation/failures to the codes in `errors.ts`, and prevent
  overwrite or inconsistent metadata after interrupted writes.
- viem handles key generation and validation; there is no custom crypto or
  random-byte input. Its runtime must provide cryptographically secure randomness.
  The mobile team must verify native runtime support before using this on a phone;
  failures return `KEY_GENERATION_FAILED` without an insecure fallback.
- The UI must display and confirm the exact message before calling `signMessage()`.
  The mobile test screen aborts the attempt on background, navigation or unmount.
  The OS authentication dialog cannot be dismissed by this API; any unlocked key
  is discarded when the aborted read completes. Future editable previews must
  also abort when the confirmed payload changes.
  Raw storage/signing errors are sanitized;
  the trusted adapter must provide safe messages for its own `WalletError` values.
- Run `npm test` for creation and message-signing tests.
  Node tests do not validate native storage, biometrics or device randomness.

The phone demo must create an owner, preserve its address after reopening, sign a
confirmed test message, and verify the signature. Test cancellation and unavailable
keys on a real device. Safe deployment and transaction signing are implemented by the second API below;
recovery kits and recovery remain separate tasks; the SecureStore adapter is integrated, with real-device
validation still required for the phone milestone.

## Safe transfer API

`createSafeWallet({ config, storage, activity })` provides `getAccount`,
`prepareTransfer`, `submitTransfer`, and `confirmTransfer`. Operations are held
privately behind immutable previews; signing uses a fresh protected key read.
`activity` persists public pending/confirmed tracking before broadcast. The first
operation deploys a prefunded, deterministic Safe. Confirmation independently
checks RPC receipt events, Safe configuration and block balances. Recovery and
sponsorship are absent. See [Sepolia runbook](../../docs/sepolia-transaction.md).
