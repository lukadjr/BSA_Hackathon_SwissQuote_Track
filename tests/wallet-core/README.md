# Tests wallet-core à écrire

Vitest est prêt : fichiers `*.test.ts`, puis `npm test` à la racine. Aucun test de signature ou de policy n'est encore implémenté.

Commencer par les POCs et les cas négatifs de la section 15 : clé/signature locale, paramètres de transaction, nonces, chain ID et règle Swissquote ET (A OU B). Ne pas tester uniquement une policy API pour conclure que la contrainte est appliquée on-chain.
