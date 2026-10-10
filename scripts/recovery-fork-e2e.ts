// End-to-end recovery test on a LOCAL fork of Sepolia (real Safe, EntryPoint
// and Candide 3-day recovery module bytecode; time is fast-forwarded).
//
//   1. Start a fork with chain id 11155111, e.g.
//      anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111
//   2. FORK_RPC_URL=http://127.0.0.1:8545 npm run recovery:fork-e2e
//
// Every key here is generated for this run and only ever funded on the fork.
import assert from 'node:assert/strict';
import {
  createPublicClient,
  createTestClient,
  http,
  isAddressEqual,
  parseEther,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  backupAddressFromPhrase,
  createBackupPhrase,
  createRecoveryClient,
  createSafeWallet,
  executeRecoveryCall,
  finalizeRecoveryCall,
  predictSafeAddress,
  RECOVERY_MODULES,
  RECOVERY_PERIOD_SECONDS,
  signApprovalWithPhrase,
  signRecoveryApproval,
  verifyRecoveryApproval,
  type GuardianApproval,
  type OwnerKeyStorage,
  type SecurityAction,
  type TransferActivityStore,
} from '../packages/wallet-core';
import { startForkBundler } from './lib/forkBundler';

const rpcUrl = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';
const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
const module = RECOVERY_MODULES.threeDays;
const test = createTestClient({
  chain: sepolia,
  mode: 'hardhat',
  transport: http(rpcUrl),
});
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(rpcUrl),
});
const recovery = createRecoveryClient({ rpcUrl });

const fund = (address: Address, eth = '10') =>
  test.setBalance({ address, value: parseEther(eth) });
const warp = async (seconds: number) => {
  await test.increaseTime({ seconds });
  await test.mine({ blocks: 1 });
};
const step = (text: string) => console.log(`\n▶ ${text}`);
const ok = (text: string) => console.log(`  ✓ ${text}`);

let bundlerUrl = '';
function phoneWallet(key: Hex, recoveredSafe?: Address) {
  const owner = privateKeyToAddress(key);
  const storage: OwnerKeyStorage = {
    readAddress: async () => owner,
    readPrivateKeyForSigning: async () => key,
    saveNewWallet: async () => {
      throw new Error('not used');
    },
  };
  let pending = null;
  const activity: TransferActivityStore = {
    readPending: async () => pending,
    writePending: async (v) => {
      pending = v as never;
    },
    writeConfirmed: async () => {},
  };
  return createSafeWallet({
    config: { rpcUrl, bundlerUrl, tokenAddress: TOKEN },
    storage,
    activity,
    safeAddress: { read: async () => recoveredSafe ?? null },
  });
}

async function securityOp(key: Hex, action: SecurityAction, safe?: Address) {
  const wallet = phoneWallet(key, safe);
  const preview = await wallet.prepareSecurityOperation(action);
  const { userOperationHash } = await wallet.submitSecurityOperation(preview);
  const result = await wallet.checkSecurityOperation(userOperationHash);
  assert.ok(result?.success, `${action.kind} operation failed on-chain`);
  return wallet.getSecurityState();
}

async function expectRevert(promise: Promise<unknown>, what: string) {
  await assert.rejects(promise, undefined, `${what} should have failed`);
  ok(`${what} is rejected`);
}

async function startRecovery(
  safe: Address,
  newOwner: Address,
  sign: (
    target: Parameters<typeof signRecoveryApproval>[1],
  ) => Promise<GuardianApproval>[],
  payerKey: Hex,
) {
  const state = await recovery.readState(safe);
  assert.ok(state, 'recovery module missing');
  const target = { safe, module, newOwner, nonce: state.nonce };
  const approvals = await Promise.all(sign(target));
  for (const approval of approvals)
    assert.ok(await verifyRecoveryApproval(target, approval));
  const hash = await recovery.sendCall(
    payerKey,
    executeRecoveryCall(module, safe, newOwner, approvals),
  );
  assert.ok(await recovery.waitForTransaction(hash));
  return { target, approvals };
}

async function finalize(safe: Address, payerKey: Hex): Promise<Hash> {
  const hash = await recovery.sendCall(
    payerKey,
    finalizeRecoveryCall(module, safe),
  );
  assert.ok(await recovery.waitForTransaction(hash));
  return hash;
}

async function main() {
  assert.equal(
    await publicClient.getChainId(),
    11155111,
    'fork must use chain id 11155111',
  );
  const executorKey = generatePrivateKey();
  await fund(privateKeyToAddress(executorKey), '100');
  const bundler = await startForkBundler({ rpcUrl, executorKey, port: 8548 });
  bundlerUrl = bundler.url;
  const relayerKey = generatePrivateKey(); // stands in for the backend relayer
  await fund(privateKeyToAddress(relayerKey));

  // Actors.
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAddress(ownerKey);
  const safe = predictSafeAddress(owner);
  let backup = createBackupPhrase();
  let swissquoteKey = generatePrivateKey();
  let friendKey = generatePrivateKey();
  assert.ok(
    isAddressEqual(backupAddressFromPhrase(backup.phrase), backup.address),
  );

  step(
    'Owner protects a NEW Safe: deploy + module + 3 guardians in one operation',
  );
  await fund(safe, '1');
  let state = await securityOp(ownerKey, {
    kind: 'protect',
    module,
    guardians: {
      backup: backup.address,
      swissquote: privateKeyToAddress(swissquoteKey),
      friend: privateKeyToAddress(friendKey),
    },
  });
  assert.ok(state.deployed && state.recovery);
  assert.equal(state.recovery.guardians.length, 3);
  assert.equal(state.recovery.threshold, 2);
  assert.equal(state.recovery.pending, null);
  ok(`Safe ${safe} deployed, guardians=3, threshold=2, module=3 days`);
  const account = await phoneWallet(ownerKey).getAccount();
  assert.ok(
    account.deployed,
    'transfer path still verifies the protected Safe',
  );
  ok('Transfer path still accepts the protected Safe');
  await expectRevert(
    phoneWallet(ownerKey).prepareSecurityOperation({
      kind: 'protect',
      module,
      guardians: {
        backup: backup.address,
        swissquote: privateKeyToAddress(swissquoteKey),
        friend: privateKeyToAddress(friendKey),
      },
    }),
    'Protecting twice',
  );

  step(
    'Malicious recovery (Swissquote + friend collude), owner cancels within 3 days',
  );
  const attacker = privateKeyToAddress(generatePrivateKey());
  const before = await publicClient.getBlock();
  const malicious = await startRecovery(
    safe,
    attacker,
    (t) => [
      signRecoveryApproval(swissquoteKey, t),
      signRecoveryApproval(friendKey, t),
    ],
    relayerKey,
  );
  state = await phoneWallet(ownerKey).getSecurityState();
  assert.ok(state.recovery?.pending);
  const delay = state.recovery.pending.executeAfter - Number(before.timestamp);
  assert.ok(
    delay >= RECOVERY_PERIOD_SECONDS.threeDays &&
      delay <= RECOVERY_PERIOD_SECONDS.threeDays + 60,
    `grace period is ${delay}s`,
  );
  ok(
    `Pending recovery seen by the owner app, deadline in ${(delay / 3600).toFixed(1)} h`,
  );
  await expectRevert(finalize(safe, relayerKey), 'Finalizing before 3 days');
  await warp(RECOVERY_PERIOD_SECONDS.threeDays - 3600);
  state = await securityOp(ownerKey, { kind: 'cancel-recovery' });
  assert.equal(state.recovery?.pending, null);
  assert.ok(isAddressEqual((await recovery.readOwners(safe))[0], owner));
  ok(
    'Owner cancelled with a Face ID-signed Safe operation, 1 h before the deadline',
  );
  await expectRevert(
    recovery.sendCall(
      relayerKey,
      executeRecoveryCall(module, safe, attacker, malicious.approvals),
    ),
    'Replaying the cancelled approvals',
  );

  step('Case 1: lost phone key only → backup phrase + Swissquote');
  const owner1Key = generatePrivateKey();
  const owner1 = privateKeyToAddress(owner1Key);
  await expectRevert(
    startRecovery(
      safe,
      owner1,
      (t) => [signApprovalWithPhrase(backup.phrase, t)],
      relayerKey,
    ),
    'A single guardian approval',
  );
  await expectRevert(
    startRecovery(
      safe,
      owner1,
      (t) => [
        signApprovalWithPhrase(backup.phrase, t),
        signRecoveryApproval(generatePrivateKey(), t),
      ],
      relayerKey,
    ),
    'An approval from a non-guardian',
  );
  await startRecovery(
    safe,
    owner1,
    (t) => [
      signApprovalWithPhrase(backup.phrase, t),
      signRecoveryApproval(swissquoteKey, t),
    ],
    relayerKey,
  );
  await warp(RECOVERY_PERIOD_SECONDS.threeDays + 1);
  await finalize(safe, relayerKey);
  assert.deepEqual(await recovery.readOwners(safe), [owner1]);
  state = await phoneWallet(owner1Key, safe).getSecurityState();
  assert.ok(state.deployed && isAddressEqual(state.safeAddress, safe));
  ok('New phone owns the same Safe after 3 days');
  await expectRevert(
    phoneWallet(ownerKey).getAccount(),
    'The old phone key using the Safe',
  );

  step('Case 2: lost key AND backup → Swissquote + friend, then a new backup');
  const owner2Key = generatePrivateKey();
  const owner2 = privateKeyToAddress(owner2Key);
  await startRecovery(
    safe,
    owner2,
    (t) => [
      signRecoveryApproval(swissquoteKey, t),
      signRecoveryApproval(friendKey, t),
    ],
    relayerKey,
  );
  await warp(RECOVERY_PERIOD_SECONDS.threeDays + 1);
  await finalize(safe, relayerKey);
  assert.deepEqual(await recovery.readOwners(safe), [owner2]);
  const newBackup = createBackupPhrase();
  state = await securityOp(
    owner2Key,
    {
      kind: 'replace-guardian',
      oldGuardian: backup.address,
      newGuardian: newBackup.address,
    },
    safe,
  );
  backup = newBackup;
  assert.ok(
    state.recovery?.guardians.some((g) => isAddressEqual(g, backup.address)),
  );
  assert.equal(state.recovery?.threshold, 2);
  ok('Recovered, and the lost backup was replaced by a new phrase');

  step('Case 3: Swissquote lost its key → owner replaces it, no waiting');
  const newSwissquoteKey = generatePrivateKey();
  state = await securityOp(
    owner2Key,
    {
      kind: 'replace-guardian',
      oldGuardian: privateKeyToAddress(swissquoteKey),
      newGuardian: privateKeyToAddress(newSwissquoteKey),
    },
    safe,
  );
  const oldSwissquoteKey = swissquoteKey;
  swissquoteKey = newSwissquoteKey;
  assert.equal(state.recovery?.guardians.length, 3);
  ok('Swissquote guardian rotated');

  step('Case 4: friend lost their key → owner replaces the friend');
  const newFriendKey = generatePrivateKey();
  state = await securityOp(
    owner2Key,
    {
      kind: 'replace-guardian',
      oldGuardian: privateKeyToAddress(friendKey),
      newGuardian: privateKeyToAddress(newFriendKey),
    },
    safe,
  );
  const oldFriendKey = friendKey;
  friendKey = newFriendKey;
  ok('Friend guardian rotated');
  await expectRevert(
    startRecovery(
      safe,
      attacker,
      (t) => [
        signRecoveryApproval(oldSwissquoteKey, t),
        signRecoveryApproval(oldFriendKey, t),
      ],
      relayerKey,
    ),
    'Recovery with the two removed guardian keys',
  );

  step(
    'Case 5: Swissquote offline → backup + friend, gas paid by the new phone key',
  );
  const owner3Key = generatePrivateKey();
  const owner3 = privateKeyToAddress(owner3Key);
  await fund(owner3, '0.1');
  await startRecovery(
    safe,
    owner3,
    (t) => [
      signApprovalWithPhrase(backup.phrase, t),
      signRecoveryApproval(friendKey, t),
    ],
    owner3Key,
  );
  await warp(RECOVERY_PERIOD_SECONDS.threeDays + 1);
  await finalize(safe, owner3Key);
  assert.deepEqual(await recovery.readOwners(safe), [owner3]);
  ok('Recovered without any Swissquote involvement');

  step('Approvals collected but not started: owner voids them');
  {
    const state = await recovery.readState(safe);
    const target = { safe, module, newOwner: attacker, nonce: state!.nonce };
    const early = await Promise.all([
      signRecoveryApproval(swissquoteKey, target),
      signRecoveryApproval(friendKey, target),
    ]);
    await securityOp(owner3Key, { kind: 'invalidate-approvals' }, safe);
    assert.equal((await recovery.readState(safe))!.nonce, state!.nonce + 1n);
    await expectRevert(
      recovery.sendCall(
        relayerKey,
        executeRecoveryCall(module, safe, attacker, early),
      ),
      'Starting with approvals voided by the owner',
    );
  }

  step('Guardian change refused while a recovery is pending');
  await startRecovery(
    safe,
    attacker,
    (t) => [
      signRecoveryApproval(swissquoteKey, t),
      signRecoveryApproval(friendKey, t),
    ],
    relayerKey,
  );
  await expectRevert(
    phoneWallet(owner3Key, safe).prepareSecurityOperation({
      kind: 'replace-guardian',
      oldGuardian: privateKeyToAddress(friendKey),
      newGuardian: privateKeyToAddress(generatePrivateKey()),
    }),
    'Replacing a guardian during a pending recovery',
  );
  await securityOp(owner3Key, { kind: 'cancel-recovery' }, safe);
  ok('Owner cancelled it again');

  bundler.server.close();
  console.log('\nAll recovery scenarios passed on the Sepolia fork.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
