# signing

`messages.ts` implémente la signature EIP-191 et la vérification publique EOA via viem pour le premier milestone. Messages UTF-8 non vides, maximum 4096 octets ; lecture protégée fraîche à chaque signature, validation de la clé et contrôle de l'adresse avant/après authentification. Aucune clé ni signer conservé entre les appels.

L'UI confirme le message exact avant l'appel et l'adaptateur natif gère l'authentification et l'annulation lors de la mise en arrière-plan. La vérification ne lit aucun secret ; une signature ou entrée invalide retourne `false`.

À implémenter séparément : validation du payload et signature des opérations Safe/ERC-4337. La signature d'un message de test n'est pas une signature de transaction Safe.

Voir les sections 5–9 et 15 du [README](../../../README.md). Tests : `tests/wallet-core/messages.test.ts`. La protection SecureStore reste à intégrer et tester sur appareil réel.
