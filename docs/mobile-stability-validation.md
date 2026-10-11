# Validation mobile — 11 octobre 2026

## Sauvegarde initiale

La version stable avant les modifications a été commitée et poussée sur `main` :
`a5f1ef4` (`chore: snapshot stable mobile configuration and orange theme`).

## Comportements vérifiés

- Déconnexion : session fermée, clé propriétaire et suivi du Safe supprimés du téléphone. Les clés et engagements du rôle guardian indépendant sont conservés. Une reconnexion permet le choix création / récupération.
- Guardians obligatoires : plus de « Set up later ». Les liens directs vers le portefeuille sans protection renvoient au setup.
- Après récupération : vérification du propriétaire on-chain avant d’enregistrer le Safe récupéré. L’ancien téléphone vérifie son accès toutes les 5 secondes au premier plan et à chaque retour dans l’app. Les écrans privés restent masqués pendant la vérification ou une panne réseau. Une rotation vérifiée ferme la session et retire la clé locale.
- Transactions : état Pending, confirmation automatique toutes les 3 secondes sur l’écran actif, erreurs réseau temporaires conservées en Pending, succès et échec terminal distincts. Aucun bouton Check status.
- Profil : suppression de la fonctionnalité Sign test message et de sa route.
- Marque : titres autonomes « Swissquote Wallet ». Cadenas orange avec emblème blanc Swissquote, sans portefeuille, dans l’app ; fond transparent et aucun contour noir visible. Support blanc rond sur l’accueil orange pour le contraste. Les logos complets fournis restent les icônes natives claire / sombre.
- Soldes et historique vidés visuellement lors du rechargement d’un écran pour éviter l’affichage de valeurs mises en cache d’un autre portefeuille.

## Tests automatisés

- Vitest : **195 tests passés**, 15 fichiers.
- ESLint et TypeScript : succès.
- Backend pytest : **203 passés, 5 ignorés** (fixtures EVM optionnelles), un avertissement Starlette existant.
- Récupération sur fork local Sepolia, avec les vrais contrats Safe et module de récupération : **8,5 USDC conservés**, même adresse Safe, solde ETH conservé (0,995257485966025335 ETH dans ce scénario), ancien propriétaire refusé. Tests du seuil, annulation et guardian retiré également passés.

## Contrôles visuels Xcode

Sur iPhone 18 Pro et iPhone 17, iOS 27 :

- App native reconstruite et installée ; accueil réel à 8,5 USDC et profil sans Sign test.
- Scénarios isolés : Pending sans erreur, passage automatique à Transfer confirmed (solde 7,5 USDC), échec terminal, logout puis choix création / récupération, obligation de configurer les guardians, ancien propriétaire renvoyé à l’accueil.
- Nouveau cadenas et nom lisibles sur l’accueil orange et l’accueil du portefeuille, sans bord noir.
- Icône native claire et sombre vérifiée sur l’écran d’accueil iOS. L’option iOS Sombre → Automatique permet de suivre le mode jour / nuit.

Les scénarios visuels de transaction et révocation utilisent un serveur de test et un SecureStore en mémoire séparés, sans modifier les clés réelles du simulateur. La récupération on-chain a été testée séparément sur le fork. Aucune transaction réelle ni récupération réelle n’a été effectuée depuis ces scénarios visuels.

## Asset interne

`apps/mobile/assets/padlock-logo.png`, dérivé de l’image claire fournie via **ImageGen** avec fond transparent. Consigne : isoler le cadenas orange existant, préserver le symbole Swissquote blanc au centre, retirer le portefeuille et le fond, conserver le trou de l’anse transparent et supprimer tout contour noir. Les fichiers Library fournis sont intacts.

## Réparation de la base locale — conflit d’enregistrement

Le 11 octobre, `POST /wallets/register` retournait 409 parce que l’ancienne table `wallets` exigeait `owner_verified_at NOT NULL`, un champ absent du modèle actuel. La table locale a été reconstruite depuis le modèle SQLAlchemy actuel après sauvegarde SQLite dans `backend/data/backups/`. Les quatre champs actuels et les enregistrements existants ont été conservés. Une insertion avec le modèle actuel a réussi puis a été annulée, sans conserver le portefeuille de test. Le serveur et le worker ont repris. Le nettoyage des demandes seul ne corrigeait pas cette ancienne structure.

## Comptes et réinitialisation

Les connexions de démonstration créent ou retrouvent une identité par username normalisé (espaces supprimés aux extrémités, minuscules), au lieu de partager la même identité bancaire sur tous les téléphones. Le serveur conserve seulement le hash des jetons de session. Les demandes non signées d'un ancien portefeuille sont expirées lors d'un changement de portefeuille ; les opérations déjà en traitement restent protégées.

Le reset de base est activé seulement avec `ENABLE_DEV_DATABASE_RESET=true`. Il sauvegarde la base puis efface les comptes, sessions et demandes. Il refuse d'effacer une opération déjà en traitement et conserve la treasury, sa clé et son journal de signatures. L'application efface ensuite toutes ses données locales sur le téléphone qui a lancé l'action.

`Reset wallet` est aussi disponible sur le profil en mode normal. Il fonctionne localement, sans serveur : session, clé propriétaire, clé guardian, engagements guardian, lien bancaire, suivi Safe, demandes et historique sont supprimés. Retour à l'accueil après réussite. La confirmation décrit la perte des clés et le besoin de récupération. La blockchain et les comptes serveur ne sont pas effacés par cette action locale.

L'accueil de développement propose aussi le reset, accessible après invalidation d'une session par un autre téléphone. `Reset this phone` permet de nettoyer seulement ce téléphone sans refaire le reset serveur. Chaque téléphone conserve un stockage indépendant.

Quatre tests supplémentaires exécutent les vrais helpers de suppression avec un SecureStore simulé, dont un scénario `__DEV__ = false` : toutes les entrées de l'app disparaissent et un nouveau portefeuille peut être créé. Un échec de Keychain remonte une erreur, les autres catégories sont nettoyées et la réinitialisation peut être retentée. La confirmation du reset de base a été contrôlée visuellement sur iPhone 18 Pro sans effacer ses clés existantes.

## Pause du flow de connexion

Les écrans Login, choix création/récupération, KYC, setup, guardians pendant l'onboarding et récupération proposent un bouton de retour à l'accueil. Le retour ajoute l'accueil au-dessus de l'écran existant ; Login y revient avec `dismissTo` au lieu de reconstruire le formulaire. On peut donc visiter Guardian puis reprendre l'écran et son état. Le checkpoint de navigation est en mémoire et lié au username courant ; il n'écrit ni mot de passe ni phrase de secours dans le stockage. Un reset ou logout propriétaire le supprime. Après fermeture complète du processus, la reprise repose sur l'état persistant et on-chain existant ; la phrase de secours temporaire n'est jamais sauvegardée.

Sept tests couvrent la reprise de chaque étape, l'absence de session, le changement de compte et la suppression du checkpoint. Contrôle visuel iPhone 18 Pro : champ Login renseigné, retour à l'accueil, ouverture de Guardian, retour à l'accueil, reprise Login avec la valeur initiale conservée. Les tests existants vérifient que les guardians restent obligatoires pour accéder au portefeuille. Une opération setup interrompue remet son indicateur d'attente à zéro même pendant la pause.
