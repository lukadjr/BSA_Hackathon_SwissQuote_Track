# Démarrer le starter

## Mobile

Prérequis : Node.js 24 LTS (`nvm use` si disponible), npm, et un téléphone ou émulateur pour le test natif. Les versions JS exactes sont dans `package-lock.json`.

Depuis la racine :

```bash
npm ci
npm run mobile:web
```

Le navigateur permet de vérifier rapidement les quatre écrans : accueil → wallet → aperçu Send et Recovery. Tous les soldes sont fictifs ; aucun secret, adresse de réception, appel API ou appel blockchain n'est utilisé. `Send` affiche uniquement les champs saisis, sans validation ni signature.

Pour un téléphone, le parcours de référence est un **Development Build** :

```bash
npm run mobile:android  # Android SDK + appareil USB ou émulateur
# Sur macOS avec Xcode :
npm run mobile:ios
# Après installation du development build :
npm run mobile
```

Les dossiers natifs sont générés par Expo et ignorés par Git. Les identifiants `com.bsa.swissquotewallet.demo` sont des valeurs de développement à adapter. Le mock peut aussi être essayé avec `npm run mobile:go` dans une version d'Expo Go compatible avec le SDK installé. La validation de SecureStore/Face ID et du cycle de vie des clés devra se faire en Development Build sur appareil réel.

Le mock fonctionne sans fichier `.env`. Pour les intégrations futures :

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
python -m uvicorn app.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

`GET http://localhost:8000/health` répond avec l'état du service ; `http://localhost:8000/docs` affiche OpenAPI. C'est le seul endpoint métier livré. Le mobile ne dépend pas de ce service pour l'instant. Aucun modèle SQLite, session, signer ou workflow de recovery n'est implémenté. `backend/.env.example` réserve les futurs paramètres ; le starter ne les charge pas encore.

Pour installer uniquement le runtime : `python -m pip install -r backend/requirements.txt`. Les deux fichiers fixent aussi les dépendances transitives.

## Vérifications

```bash
npm run typecheck
npm run lint
npm run format:check
# Depuis le venv actif :
python -m pytest backend
python -m ruff check backend
python -m ruff format --check backend
```

`npm test` prépare Vitest pour `tests/wallet-core/*.test.ts`. Aucun test blockchain n'existe encore ; une sortie « no test files » est normale. Les deux tests backend vérifient le health endpoint et l'absence d'endpoints métier accidentels.

Validation du starter : installation propre avec `npm ci`, TypeScript, ESLint,
Prettier, Ruff, deux tests API, 21 checks Expo Doctor, démarrage du serveur Expo
et exports JavaScript/Hermes web + Android + iOS. Ces exports ne remplacent pas
un build natif installé sur téléphone ; l'interface n'a pas été vérifiée visuellement.

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
| Blockchain | `packages/wallet-core` et `config/deployments.example.json`          | POC B/C puis signatures ERC-1271 imbriquées (POC D)                              |
| Backend    | `backend/app` et `backend/tests`                                     | Définir les métadonnées publiques et contrats d'API de la section 10             |

`wallet-core` expose uniquement les métadonnées Sepolia et garde une entrée TypeScript consommable par Metro. Les dossiers spécialisés indiquent leurs responsabilités. `viem`, `abstractionkit` et les contrats restent à choisir, installer et verrouiller après les POCs ; aucune compatibilité n'est revendiquée. Tous les champs de déploiement sont `null` jusqu'à vérification sur Sepolia.

Sources de configuration : [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/), [monorepos Expo](https://docs.expo.dev/guides/monorepos/), [installation Expo Router](https://docs.expo.dev/router/installation/), [NativeWind v4](https://www.nativewind.dev/docs/getting-started/installation).
