# wallet-core

Package TypeScript indépendant des écrans. Le starter exporte uniquement `SEPOLIA` depuis `config/chains.ts`. Aucun SDK, signer ou client RPC n'est connecté.

Les dossiers `keys`, `signing`, `safe`, `transactions`, `guardians` et `recovery` réservent les responsabilités de la section 13 du README. Ajouter ici la logique testable ; garder l'adaptateur natif SecureStore au bord du module, sans dépendance UI.

Suivre les POCs A → E du README, puis verrouiller les versions de `viem`/`abstractionkit` et les contrats réellement vérifiés. Les tests futurs vont dans `tests/wallet-core`. Aucune cryptographie maison.
