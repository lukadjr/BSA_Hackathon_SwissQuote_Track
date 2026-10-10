# Modèle de custody — point de départ

Référence : sections 5–6 et 10 du [README](../README.md).

- La clé EOA de dépense doit être générée et conservée sur le téléphone. Le backend n'en reçoit jamais une copie.
- Les actifs résident dans ClientSafe ; l'EOA client est son owner ordinaire `1/1`.
- Recovery cible : SwissquoteGuardianSafe `2/3` ET BackupGuardianSafe `1/2`, deux guardians contractuels avec seuil Candide `2/2`.
- SecureStore protège le secret au repos ; la signature peut exposer temporairement la clé en mémoire JavaScript.

À compléter après les POCs : versions, permissions effectives des modules, protections natives testées et preuves de signatures. Le starter ne crée aucune clé ni Safe.
