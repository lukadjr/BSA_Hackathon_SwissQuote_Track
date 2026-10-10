# Démarrage — Personne 1 (Mobile, `apps/mobile/`)

Ce fichier explique, en français simple, ce que la Personne 1 doit construire, avec qui elle doit se coordonner et par où commencer. Les détails complets sont dans le [README](README.md) (sections 3, 5, 9, 15 et 17) et dans [docs/getting-started.md](docs/getting-started.md).

---

## 1. Le projet en une minute : trois rôles

| Rôle                    | Qui / quoi                                                               | Ce qu'il fait                                                                                  | Ce qu'il ne peut PAS faire                                        |
| ----------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Clé owner (EOA)**     | Une clé privée Ethereum `secp256k1` créée **sur le téléphone** du client | Signe les opérations, après Face ID / biométrie                                                | Ne quitte jamais le téléphone (ni backend, ni logs, ni Git)       |
| **Safe (`ClientSafe`)** | Un smart contract sur Sepolia                                            | **Détient les fonds** (USDC/ETH de test). C'est l'adresse de réception                         | Ne bouge rien sans une signature valide de son owner              |
| **Guardians**           | Swissquote + Contact A + Contact B (seuil 2 sur 3)                       | Peuvent **remplacer la clé owner** via la recovery (délai de 7 jours, annulable par le client) | Ne peuvent pas dépenser les fonds ; un guardian seul ne peut rien |

Deux adresses à ne pas confondre :

- **Adresse EOA** : celle de la clé du téléphone (le « signataire »).
- **Adresse Safe** : celle où arrivent les fonds. Elle **ne change pas** si la clé owner est remplacée.

---

## 2. Ce que la Personne 1 doit implémenter, étape par étape

Le parcours natif de création, réouverture et signature de message est maintenant implémenté ; il reste à valider sur téléphone réel. `/` choisit `/create-wallet` ou `/wallet`, et `/sign-test` utilise wallet-core + SecureStore. Solde, Send et Recovery restent mockés ; le navigateur refuse le stockage sécurisé sans fallback.

Structure à connaître :

```
apps/mobile/src/
  app/          routes Expo Router (index, wallet, send, recovery)
  features/     écrans par domaine (onboarding, wallet, transfer, recovery)
  components/   Button, Screen…
  hooks/        vide, à remplir (ex. useWallet)
  theme/        couleurs
```

### Étape 0 — Lancer le mock (déjà vérifié)

```bash
npm ci
npm run mobile:web      # ouvre http://localhost:8081
```

### Étape 1 — Se mettre d'accord avec la Personne 2 (voir section 4)

Avant d'écrire du code de clé : fixer ensemble les noms de fonctions, les formats et les erreurs.

### Étape 2 — Passer sur un vrai téléphone (Development Build)

SecureStore avec `requireAuthentication` et Face ID ne se testent **pas** correctement dans le navigateur ni dans Expo Go. Il faut un **Development Build** installé sur un vrai téléphone (doc : https://docs.expo.dev/versions/latest/sdk/securestore/).

```bash
npm run mobile:ios       # Mac + Xcode, iPhone branché en USB
# ou
npm run mobile:android   # Android SDK + téléphone USB
# ensuite, pour relancer le serveur JS :
npm run mobile
```

Les plugins `expo-secure-store` et `expo-local-authentication` (avec le texte Face ID) sont déjà déclarés dans `apps/mobile/app.config.ts`.

### Étape 3 — Écran « Créer mon wallet » (onboarding)

1. Bouton « Create wallet » sur `WelcomeScreen`.
2. Appeler la fonction de création de clé fournie par `wallet-core` (Personne 2).
3. Afficher l'**adresse EOA** retournée (jamais la clé privée).
4. Gérer les erreurs : pas de code de verrouillage sur le téléphone, biométrie refusée, création interrompue, etc. Ne jamais remplacer automatiquement une clé après une erreur de stockage.

### Étape 4 — Réouverture de l'app

Au démarrage : vérifier si une clé existe déjà (fonction `hasKey` / `getAddress`). Si oui, aller directement à l'écran wallet avec l'adresse. Si non, afficher l'onboarding.

### Étape 5 — Signer un message de test

1. Un écran (ou un bouton dans Security) « Sign test message ».
2. Afficher **ce qui va être signé** avant de demander Face ID.
3. Appeler la fonction de signature de `wallet-core` → Face ID s'affiche (lecture SecureStore protégée) → signature.
4. Afficher la signature et vérifier qu'elle correspond bien à l'adresse (fonction `verify`).
5. Chaque nouvelle signature = nouvelle lecture protégée. La clé n'est **jamais** gardée dans un state React, un cache ou un log.

### Étape 6 — Plus tard

- Brancher l'écran `Send` sur un vrai transfert USDC via la Safe (avec la Personne 2).
- Afficher l'adresse **Safe** dans `Receive`.
- Enregistrer les adresses publiques auprès du backend (Personne 3).
- Écrans de recovery et bouton « Cancel recovery ».

---

## 3. Comment ça se connecte aux autres

```
Personne 1 (apps/mobile)  ──appelle──▶  Personne 2 (packages/wallet-core)
         │                                   clé, adresse, signature, stockage
         │
         └──HTTP (adresses publiques seulement)──▶  Personne 3 (backend FastAPI)
```

### Personne 2 — `packages/wallet-core`

Fournit les fonctions « crypto » que l'app appelle :

- **création de clé** (entropie sûre via `expo-crypto`, jamais `Math.random`) ;
- **dérivation de l'adresse** Ethereum à partir de la clé ;
- **signature / vérification** d'un message (puis plus tard d'une opération Safe) ;
- **stockage protégé** (adaptateur SecureStore avec `requireAuthentication: true`).

Le mobile importe déjà `@swissquote/wallet-core` (workspace npm), donc ces fonctions seront disponibles directement dans l'app.

### Personne 3 — `backend/` (FastAPI)

- `GET /health` : existe déjà, renvoie `{ "status": "ok", "service": "swissquote-demo" }`.
- `/docs` : page OpenAPI générée automatiquement.
- Prochaine étape : un endpoint mock d'**enregistrement de wallet** (ex. `POST /wallets/register`) qui accepte **uniquement des adresses publiques** (EOA, Safe). Jamais de clé privée.

Lancer le backend :

```bash
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements-dev.txt
python -m uvicorn app.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

Sur un vrai téléphone, remplacer `localhost` par l'IP locale du Mac dans `apps/mobile/.env` (copier depuis `.env.example`).

---

## 4. Pourquoi Personne 1 et 2 doivent d'abord se mettre d'accord

L'app (P1) et `wallet-core` (P2) se rencontrent sur **une seule frontière** : les fonctions de stockage et de signature. Si elle n'est pas fixée tôt, chacun code de son côté et rien ne s'emboîte au moment d'assembler.

À décider ensemble, par écrit (par exemple dans `packages/wallet-core/index.ts` comme types TypeScript vides) :

| Sujet                     | Exemple de proposition (à valider ensemble)                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Noms des fonctions**    | `createKey()`, `hasKey()`, `getAddress()`, `signMessage(message)`, `verifyMessage(address, message, signature)`, `deleteKey()`  |
| **Entrées / sorties**     | `createKey(): Promise<{ address: Address }>` ; `signMessage(message: string): Promise<Hex>`                                     |
| **Format d'adresse**      | `0x` + 40 caractères hex, en checksum EIP-55 (format `viem`)                                                                    |
| **Format de signature**   | `0x` + 130 caractères hex (65 octets), signature EIP-191 `personal_sign`                                                        |
| **Cas d'erreur**          | `NO_DEVICE_PASSCODE`, `AUTH_CANCELLED`, `AUTH_FAILED`, `KEY_NOT_FOUND`, `KEY_INVALIDATED` (biométrie changée), `ALREADY_EXISTS` |
| **Ce qui ne sort jamais** | La clé privée : aucune fonction ne la retourne à l'UI                                                                           |

Une fois ce contrat fixé, P1 peut avancer avec une **fausse implémentation** (stub) qui respecte les mêmes signatures, pendant que P2 écrit la vraie.

---

## 5. Premier jalon recommandé

> **L'app, sur un vrai téléphone, sait créer une clé, être fermée puis rouverte, et signer un message de test.**

Critères de réussite :

- [ ] Development Build installé sur un téléphone réel (iOS ou Android).
- [ ] « Create wallet » crée la clé et affiche l'adresse EOA.
- [ ] Après avoir tué l'app et l'avoir rouverte, la même adresse s'affiche.
- [ ] « Sign test message » déclenche Face ID / biométrie, puis affiche une signature.
- [ ] La signature est vérifiée comme venant de cette adresse.
- [ ] Annuler Face ID → aucune signature, message d'erreur clair.
- [ ] Aucune clé privée dans les logs, le state React, le réseau ou Git.

Ce jalon correspond au **POC A** du README (section 15.1). Tant qu'il ne passe pas, inutile de travailler sur le design.

Astuce : pour ce jalon, un petit **écran de développement** (ex. `src/app/dev.tsx`) avec trois boutons (créer la clé, afficher l'adresse, signer et vérifier) suffit. Pas besoin de design. La tâche de la Personne 1 est terminée après validation sur téléphone de tous les critères ci-dessus, dont restart et annulation. Les tests Node et exports Hermes ne suffisent pas.

Référence SecureStore : https://docs.expo.dev/versions/latest/sdk/securestore/

## 6. Jalons suivants (à démontrer les uns aux autres)

1. Créer une Safe dont l'owner est l'adresse publique du téléphone.
2. Afficher son solde depuis Sepolia.
3. Envoyer un transfert de token de test depuis le téléphone et afficher le hash de la transaction.
4. Configurer trois guardians avec un seuil de deux, puis tester la recovery et son annulation, y compris A+B avec le backend Swissquote arrêté.
