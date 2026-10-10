# Démo transaction Sepolia

Suivre le [runbook Sepolia](sepolia-transaction.md) pour configurer RPC/bundler/token et financer la Safe.

1. Créer/utiliser l'EOA protégée dans un Development Build et terminer le lien existant à Swissquote.
2. Lire l'adresse Safe et ses soldes réels sur Wallet ; financer cette adresse avec ETH et tokens Sepolia.
3. Ouvrir Send, saisir destinataire/montant, vérifier l'aperçu et authentifier la signature locale.
4. Vérifier le statut jusqu'à deux confirmations et ouvrir le hash sur l'explorateur.
5. Montrer l'événement Transfer, les soldes et la configuration Safe owner 1/1.

Recovery reste un aperçu ; aucune récupération ni sponsoring gas n'est configuré. Tests locaux et exports ne remplacent pas la preuve de transaction financée sur Sepolia ou de biométrie sur appareil.
