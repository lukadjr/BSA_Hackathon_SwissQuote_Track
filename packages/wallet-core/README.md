# wallet-core

Package TypeScript indépendant des écrans. Exporte `SEPOLIA`, le contrat `OwnerWallet`, la factory `createOwnerWallet`, le contrat de stockage `OwnerKeyStorage` et les erreurs typées. Création EOA, signature et vérification de messages via viem ; aucun signer Safe ou client RPC n'est connecté.

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
  The UI/native adapter must cancel pending access when the app backgrounds or the
  confirmed payload changes. The core cannot observe native lifecycle events.
  Raw storage/signing errors are sanitized;
  the trusted adapter must provide safe messages for its own `WalletError` values.
- Run `npm test` for creation and message-signing tests.
  Node tests do not validate native storage, biometrics or device randomness.

The phone demo must create an owner, preserve its address after reopening, sign a
confirmed test message, and verify the signature. Test cancellation and unavailable
keys on a real device. Safe deployment, recovery kits and transaction signing remain
separate implementation tasks; native integration is still required for the phone milestone.
