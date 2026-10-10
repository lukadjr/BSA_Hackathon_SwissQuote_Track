// Backend + chain end-to-end test on a LOCAL Sepolia fork: friend invite by
// signature, recovery request, backup and Swissquote approvals, relayer,
// alerts, 3-day period and finalization. Run the backend against the fork:
//
//   SEPOLIA_RPC_URL=http://127.0.0.1:8545 MOCK_ACCESS_TOKEN=... \
//     python -m uvicorn app.main:app --app-dir backend --port 8000
//   FORK_RPC_URL=http://127.0.0.1:8545 API_URL=http://127.0.0.1:8000 \
//     API_TOKEN=... npm run recovery:backend-fork-e2e
import assert from 'node:assert/strict';
import {
  createTestClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import {
  generatePrivateKey,
  privateKeyToAccount,
  privateKeyToAddress,
} from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  createBackupPhrase,
  createRecoveryClient,
  createSafeWallet,
  guardianInviteMessage,
  predictSafeAddress,
  RECOVERY_MODULES,
  RECOVERY_PERIOD_SECONDS,
  signApprovalWithPhrase,
  type TransferActivityStore,
} from '../packages/wallet-core';
import { startForkBundler } from './lib/forkBundler';

const rpcUrl = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';
const api = process.env.API_URL ?? 'http://127.0.0.1:8000';
const token = process.env.API_TOKEN ?? '';
const test = createTestClient({
  chain: sepolia,
  mode: 'hardhat',
  transport: http(rpcUrl),
});
const recovery = createRecoveryClient({ rpcUrl });
const ok = (text: string) => console.log(`  ✓ ${text}`);

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T;
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${JSON.stringify(json)}`,
  );
  return json;
}

async function main() {
  const executorKey = generatePrivateKey();
  await test.setBalance({
    address: privateKeyToAddress(executorKey),
    value: parseEther('100'),
  });
  const bundler = await startForkBundler({ rpcUrl, executorKey, port: 8547 });

  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const safe = predictSafeAddress(owner.address);
  const friendKey = generatePrivateKey();
  const friend = privateKeyToAccount(friendKey);
  const backup = createBackupPhrase();

  // 1. Owner links the wallet (same message flow as the phone).
  const challenge = await call<{ challenge_id: string; message: string }>(
    'POST',
    '/wallets/link/challenge',
    { owner_address: owner.address, safe_address: safe },
  );
  await call('POST', '/wallets/link/complete', {
    challenge_id: challenge.challenge_id,
    signature: await owner.signMessage({ message: challenge.message }),
  });
  ok('Wallet linked');

  // 2. Friend accepts the invite with their own guardian key.
  const sq = await call<{ address: Address; relayer_address: Address }>(
    'GET',
    '/guardians/swissquote',
  );
  await test.setBalance({
    address: sq.relayer_address,
    value: parseEther('10'),
  });
  const invite = await call<{ invite_id: string }>(
    'POST',
    '/guardians/invites',
    {
      safe_address: safe,
    },
  );
  const message = guardianInviteMessage({
    safe,
    invite: invite.invite_id,
    guardian: friend.address,
  });
  await call('POST', `/guardians/invites/${invite.invite_id}/accept`, {
    guardian_address: friend.address,
    signature: await friend.signMessage({ message }),
  });
  const accepted = await call<{ guardian_address: string }>(
    'GET',
    `/guardians/invites/${invite.invite_id}`,
  );
  assert.equal(accepted.guardian_address, friend.address.toLowerCase());
  ok(
    'Friend guardian address received through the invite (TS message = Python message)',
  );

  // 3. Owner protects the Safe with backup + Swissquote + friend.
  await test.setBalance({ address: safe, value: parseEther('1') });
  const activity: TransferActivityStore = {
    readPending: async () => null,
    writePending: async () => {},
    writeConfirmed: async () => {},
  };
  const wallet = createSafeWallet({
    config: {
      rpcUrl,
      bundlerUrl: bundler.url,
      tokenAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    },
    storage: {
      readAddress: async () => owner.address,
      readPrivateKeyForSigning: async () => ownerKey,
      saveNewWallet: async () => {},
    },
    activity,
  });
  const preview = await wallet.prepareSecurityOperation({
    kind: 'protect',
    module: RECOVERY_MODULES.threeDays,
    guardians: {
      backup: backup.address,
      swissquote: sq.address,
      friend: friend.address,
    },
  });
  const sent = await wallet.submitSecurityOperation(preview);
  assert.ok(
    (await wallet.checkSecurityOperation(sent.userOperationHash))?.success,
  );
  let status = await call<{ protected: boolean; guardians: string[] }>(
    'GET',
    `/wallets/${safe}/recovery-status`,
  );
  assert.ok(status.protected && status.guardians.length === 3);
  ok('Backend reads the protected Safe from the chain');

  // 4. New phone: request, backup phrase + Swissquote approvals, relayer.
  const newOwner = privateKeyToAddress(generatePrivateKey());
  const created = await call<{ case_id: string; nonce: string }>(
    'POST',
    '/recovery/requests',
    {
      safe_address: safe,
      new_owner_address: newOwner,
    },
  );
  const friendView = await call<{ requests: { case_id: string }[] }>(
    'GET',
    `/guardians/${friend.address}/requests`,
  );
  assert.equal(friendView.requests[0].case_id, created.case_id);
  ok('Friend app sees the request');
  const path = `/recovery/requests/${created.case_id}`;
  const approval = await signApprovalWithPhrase(backup.phrase, {
    safe,
    module: RECOVERY_MODULES.threeDays,
    newOwner,
    nonce: BigInt(created.nonce),
  });
  await call('POST', `${path}/approvals`, {
    guardian_address: approval.guardian,
    signature: approval.signature as Hex,
  });
  const detail = await call<{ approvals: unknown[] }>(
    'POST',
    `${path}/swissquote-approve`,
    {
      identity_confirmed: true,
    },
  );
  assert.equal(detail.approvals.length, 2);
  ok('Backup (phone, TS) and Swissquote (backend, Python) approvals accepted');
  const submitted = await call<{ tx_hash: Hex }>('POST', `${path}/submit`);
  assert.ok(await recovery.waitForTransaction(submitted.tx_hash));
  const started = await call<{ status: string; execute_after: number }>(
    'GET',
    path,
  );
  assert.equal(started.status, 'started');
  status = await call('GET', `/wallets/${safe}/recovery-status`);
  const alerts = (
    status as unknown as { alerts: { kind: string }[] }
  ).alerts.map((a) => a.kind);
  assert.deepEqual(alerts.slice(0, 2), [
    'recovery_started',
    'recovery_requested',
  ]);
  ok('Relayer started the 3-day period; owner alerts recorded');
  await call('POST', `${path}/finalize`, undefined, 409);
  await test.increaseTime({ seconds: RECOVERY_PERIOD_SECONDS.threeDays + 1 });
  await test.mine({ blocks: 1 });
  const finalized = await call<{ tx_hash: Hex }>('POST', `${path}/finalize`);
  assert.ok(await recovery.waitForTransaction(finalized.tx_hash));
  assert.deepEqual(await recovery.readOwners(safe), [newOwner]);
  assert.equal(
    (await call<{ status: string }>('GET', path)).status,
    'finalized',
  );
  ok('Relayer finalized: the new phone key owns the Safe');

  bundler.server.close();
  console.log('\nBackend recovery flow passed on the Sepolia fork.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
