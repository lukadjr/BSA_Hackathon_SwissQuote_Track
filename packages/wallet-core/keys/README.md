# keys

`generateOwnerKey.ts` génère une EOA avec `generatePrivateKey()` et dérive son adresse avec `privateKeyToAddress()` de viem. `keyManager.ts` sérialise la création pour un même adaptateur, refuse une adresse existante et attend la persistance avant de retourner uniquement l'adresse publique.

`storage.ts` définit la frontière native injectée : pas d'écrasement, écritures protégées et lecture authentifiée fraîche pour chaque signature. L'adaptateur SecureStore, la validation de l'entropie sur appareil et le Recovery Kit BIP-39 restent à implémenter et tester. Aucun secret dans les logs ou requêtes.

Voir les sections 5–9 et 15 du [README](../../../README.md) et `tests/wallet-core/createWallet.test.ts`.
