# Swissquote Wallet (mobile)

Expo / React Native app for the self-custody wallet demo on Sepolia. The UI
follows a Revolut-style layout (rounded cards, quick actions, bottom tab bar)
in Swissquote colors. Colors live in `src/theme/colors.js`; change `brand` to
retint the whole app.

## User flow

```
Welcome ─┬─ Log in with Swissquote ─┬─ Recover my wallet ── 2 of 3 guardians ── Setup (re-link) ── Wallet
         │   (demo: any username     └─ Create a new wallet ── KYC ── Setup ── Trusted guardians ── Wallet
         │    and password)
         └─ Be a guardian ── scan a friend's code (or paste it as text) ── back to Welcome
```

- **Welcome** (`/welcome`): first screen. Once this phone holds a guardian key,
  a "People I protect" card shows the wallets it protects and any recovery
  request waiting for approval.
- **Login** (`/login`): demo only. Any username and password are accepted; the
  username is shown in the app and to guardians.
- **Start** (`/start`): logged in without a key on this phone: create a wallet
  or recover the old one.
- **KYC** (`/kyc`): reuses the (simulated) bank identity from `GET /auth/me`.
- **Setup** (`/setup`): creates the owner key (Face ID), lets Swissquote deploy
  the Safe (bank-sponsored `deploy` funding intent), then signs the Swissquote
  link challenge. Every step is resumable; it is also used to re-link a Safe
  after a recovery.
- **Trusted guardians** (`/protect`): backup phrase, Swissquote and a friend,
  written to the Safe in one operation. Any 2 of 3 can recover after the
  waiting period. Can be postponed ("Set up later").
- **Recover** (`/recover`): new phone key, then 2 approvals among backup
  phrase, Swissquote and the friend. For the demo, Swissquote approves as soon
  as the request is created (the Swissquote login is the identity check).

### Wallet tabs

| Tab | Content |
| --- | --- |
| Home | Total balance in USD (test USDC counts 1:1, Sepolia ETH is gas only), quick actions, assets, recovery alerts, setup reminders. Avatar opens the profile (link status, addresses, logout). |
| Payments | Add money (from the Swissquote demo account), Send, Receive (QR code of the Safe address) and recent transactions (bank deposits from the backend, sent transfers from this phone). |
| Guardians | *My guardians*: the on-chain guardians, replace one, cancel a recovery. *I protect*: scan an invite or a recovery request, approve it, list the wallets this phone protects. |

QR codes can always be shared as text ("Share as text") and pasted on the
other phone when a camera is not available (simulators).

## Run it

From the repository root, in three terminals:

```bash
# 1. Backend API
backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000

# 2. Treasury worker (deploys Safes, sends deposits, relays transfers and recovery)
PYTHONPATH=backend backend/.venv/bin/python -m app.funding.worker

# 3. Metro
cd apps/mobile && npx expo start --dev-client
```

The backend reads `backend/.env`; the app reads `apps/mobile/.env`
(`EXPO_PUBLIC_DEMO_ACCESS_TOKEN` must equal the backend `MOCK_ACCESS_TOKEN`).
In the iOS simulator, enroll Face ID (Features → Face ID → Enrolled) before
creating a wallet.

## Checks

```bash
npm run typecheck && npm run lint && npm test
backend/.venv/bin/python -m pytest backend/tests -q
```
