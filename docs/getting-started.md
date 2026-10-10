# Démarrer le starter

## Mobile

Prérequis : Node.js 24 LTS (`nvm use` si disponible), npm, et un téléphone ou émulateur pour le test natif. Les versions JS exactes sont dans `package-lock.json`.

Depuis la racine :

```bash
npm ci
npm run mobile:web
```

Le parcours de création et signature de clé est maintenant natif : le navigateur affiche une erreur de stockage indisponible, sans fallback de clé en mémoire. Sur téléphone, le startup ouvre `/create-wallet` ou `/wallet` selon l’adresse publique enregistrée ; `/sign-test` signe et vérifie un message EIP-191. Wallet/Send disposent désormais du flux Safe/ERC-4337 Sepolia décrit dans [le runbook transaction](sepolia-transaction.md), à configurer et financer avant envoi. Recovery reste un aperçu.

Pour un téléphone, le parcours de référence est un **Development Build** :

```bash
npm run mobile:android  # Android SDK + appareil USB ou émulateur
# Sur macOS avec Xcode :
npm run mobile:ios
# Après installation du development build :
npm run mobile
```

Les dossiers natifs sont générés par Expo et ignorés par Git. Les identifiants `com.bsa.swissquotewallet.demo` sont des valeurs de développement à adapter. Expo Go et le navigateur ne valident pas le parcours de clé protégée. La validation de SecureStore/Face ID et du cycle de vie des clés devra se faire en Development Build sur appareil réel.

Le parcours local de clé fonctionne sans fichier `.env`. Pour les intégrations futures :

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

Sur téléphone, remplacer `localhost` de l'URL API par l'IP LAN du PC. Android Emulator utilise généralement `10.0.2.2`. Aucune clé privée ou clé paymaster privilégiée dans les variables publiques Expo.

## Backend

Prérequis : Python 3.11+ (vérifié avec 3.11). Depuis la racine :

```bash
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements-dev.txt
export MOCK_USER_ID=demo-user
export MOCK_ACCESS_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
python -m uvicorn app.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

`GET http://localhost:8000/health` est public ; `/docs` affiche OpenAPI. Les endpoints métier exigent `Authorization: Bearer <MOCK_ACCESS_TOKEN>` pour l’unique identité de démonstration configurée par le serveur. Sans token configuré (32 caractères minimum), ils retournent `503`. SQLite conserve les adresses publiques, sans attestation de contrôle on-chain ; screening explicitement mocké. Les routes recovery valident l’utilisateur et la Safe enregistrée, puis retournent `501` tant que le workflow et le signer isolé ne sont pas implémentés. Voir [backend/README.md](../backend/README.md). Les variables doivent être exportées dans le shell : `.env` n’est pas chargé automatiquement.

Pour installer uniquement le runtime : `python -m pip install -r backend/requirements.txt`. Les deux fichiers fixent aussi les dépendances transitives.

## Vérifications

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
# Depuis le venv actif :
python -m pytest backend
python -m ruff check backend
python -m ruff format --check backend
```

Vitest couvre le core (création, signature, vérification et annulation), le bootstrap crypto et le rollback SecureStore simulé. Pytest couvre les routes API avec une base en mémoire isolée. Les tests et exports JavaScript/Hermes web + Android + iOS ne remplacent pas un build natif installé sur téléphone. Vérifier la même adresse après redémarrage, biométrie répétée, annulation, background/navigation et invalidation de clé ; le Recovery Kit hors ligne reste à implémenter.

Au bootstrap, `npm audit` rapporte 35 avis (14 modérés, 21 élevés) dans l'arbre
de dépendances Expo/NativeWind, notamment `braces`, `node-forge`, `uuid`,
`decode-uri-component` et `postcss-selector-parser`. Les remédiations automatiques
proposées changent de version majeure ou sortent de la combinaison SDK retenue.
Les versions compatibles sont conservées ; réévaluer ces avis avant d'ajouter
la gestion de secrets. Aucune commande `npm audit fix --force` n'a été appliquée.

## Où commencer

| Équipe     | Point d'entrée                                                       | Prochaine étape                                                                  |
| ---------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Mobile     | `apps/mobile/src/app`, `src/features`, `src/components`, `src/theme` | POC A sur appareil : entropie native, SecureStore, authentification et signature |
| Blockchain | `packages/wallet-core` et `config/deployments.example.json`          | POC B/C puis recovery direct SQ/A/B 2/3, dont A+B sans banque                    |
| Backend    | `backend/app` et `backend/tests`                                     | Preuve de contrôle on-chain, identité renforcée et signer isolé                  |

`wallet-core` expose Sepolia et l’API de clé/signature viem, consommées par l’adaptateur natif SecureStore. `apps/mobile/index.ts` installe l’entropie native avant de charger Expo Router et les routes. `abstractionkit` 0.4.0 et la configuration Safe 1.4.1 / EntryPoint 0.7 sont intégrés. La présence des contrats et les endpoints publics ont été vérifiés en lecture ; le transfert financé et la signature native restent à démontrer. Voir [sepolia-transaction](sepolia-transaction.md).

Sources de configuration : [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [monorepos Expo](https://docs.expo.dev/guides/monorepos/), [installation Expo Router](https://docs.expo.dev/router/installation/), [NativeWind v4](https://www.nativewind.dev/docs/getting-started/installation).
