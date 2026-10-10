# Recovery runbook — squelette

Référence : sections 7–8 du [README](../README.md).

À détailler après validation Candide/ERC-1271 : identité renforcée simulée, nouvelle EOA locale, demande exacte du module, approbations Swissquote + A/B, timelock, finalisation et vérification des owners.

Prévoir séparément perte, compromission, indisponibilité et annulation. A+B sans Swissquote et Swissquote seule doivent échouer on-chain. Conserver la même adresse ClientSafe et prouver la révocation de l'ancien owner. Aucun parcours réel n'est livré dans le starter.
