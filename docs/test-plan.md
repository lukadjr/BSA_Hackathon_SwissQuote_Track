# Plan de tests — ordre de travail

Référence : section 15 du [README](../README.md). Aucun POC n'est encore validé.

1. A : clé, stockage, réouverture, authentification et signature sur appareil réel.
2. B : ClientSafe et transfert ERC-20 Sepolia.
3. C : UserOperation valide, frais et sponsoring explicite.
4. D : deux signatures contractuelles ERC-1271 acceptées par Candide.
5. E : timelock et changement d'owner vérifiés sur la même Safe.

Ajouter ensuite les cas adversariaux et scénarios iOS/Android de perte de clé. Les checks actuels sont uniquement ceux du [guide de démarrage](getting-started.md).
