// Full wallet-core treasury adapter -> HTTP API -> actual shared worker -> real EVM.
// Inputs on stdin are disposable local-test settings; never logs secrets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  createSafeWallet,
  predictSafeAddress,
  RECOVERY_MODULES,
  recoveryTypedData,
  type SafeRelayRequest,
  type TreasuryRelay,
  type RelayStatus,
  type SubmittedTransfer,
  type SafeAccountInfo,
} from '../packages/wallet-core';

async function main() {
  const settings = JSON.parse(readFileSync(0, 'utf8'));
  const fixture = JSON.parse(readFileSync(settings.fixture, 'utf8'));
  assert.match(fixture.rpc_url, /^http:\/\/127\.0\.0\.1:/); // Never time-travel a public chain.
  const chain = createPublicClient({
    chain: sepolia,
    transport: http(fixture.rpc_url),
  });
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${settings.api}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${settings.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `API refused ${path}: ${response.status}`);
    return response.json() as Promise<T>;
  };
  async function until<T>(check: () => Promise<T | null>): Promise<T> {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      await chain.request({ method: 'evm_mine' as never, params: [] as never });
      const value = await check();
      if (value !== null) return value;
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error('Local acceptance timed out');
  }
  let biometricReads = 0;
  function wallet(key: Hex, restoredSafe?: Address) {
    const account = privateKeyToAccount(key);
    let authorization: SafeRelayRequest | null = null;
    let tracked: SubmittedTransfer | null = null;
    const relay: TreasuryRelay = {
      submit: (request) => api('/transactions/relay', request),
      status: (hash) => api(`/transactions/${hash}`),
      readPending: async () => authorization,
      writePending: async (value) => {
        authorization = value;
      },
    };
    return createSafeWallet({
      config: {
        rpcUrl: fixture.rpc_url,
        bundlerUrl: fixture.rpc_url,
        tokenAddress: fixture.token,
      },
      storage: {
        readAddress: async () => account.address,
        readPrivateKeyForSigning: async () => {
          biometricReads++;
          return key;
        },
        saveNewWallet: async () => {},
      },
      activity: {
        readPending: async () => tracked,
        writePending: async (value) => {
          tracked = value;
        },
        writeConfirmed: async () => {},
      },
      relay,
      safeAddress: restoredSafe
        ? { read: async () => restoredSafe }
        : undefined,
    });
  }
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const safe = predictSafeAddress(owner.address);
  const backup = privateKeyToAccount(generatePrivateKey());
  const friend = privateKeyToAccount(generatePrivateKey());
  const replacement = privateKeyToAccount(generatePrivateKey());
  const sq = privateKeyToAccount(generatePrivateKey());
  const nextKey = generatePrivateKey();
  const next = privateKeyToAccount(nextKey);
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const service = wallet(ownerKey);
  async function register(account: typeof owner) {
    await api('/wallets/register', {
      user_id: 'alice',
      safe_address: safe,
      owner_address: account.address,
    });
  }
  async function funding(
    account: typeof owner,
    kind: 'deploy' | 'deposit',
    amount: string,
  ) {
    const intent = await api<{ id: string; message: string }>(
      '/bank/funding/intents',
      {
        kind,
        safe_address: safe,
        owner_address: account.address,
        chain_id: 11155111,
        amount,
        idempotency_key: crypto.randomUUID(),
      },
    );
    await api(`/bank/funding/intents/${intent.id}/confirm`, {
      signature: await account.signMessage({ message: intent.message }),
    });
    await until(async () => {
      const status = await api<{ status: string }>(
        `/bank/funding/intents/${intent.id}`,
      );
      assert.notEqual(status.status, 'failed');
      return status.status === 'confirmed' ? status : null;
    });
  }
  async function link(account: typeof owner) {
    await register(account);
    const challenge = await api<{ challenge_id: string; message: string }>(
      '/wallets/link/challenge',
      {
        safe_address: safe,
        owner_address: account.address,
        chain_id: 11155111,
      },
    );
    await api('/wallets/link/complete', {
      challenge_id: challenge.challenge_id,
      signature: await account.signMessage({ message: challenge.message }),
    });
  }
  async function confirmSecurity(active: typeof service, hash: Hex) {
    const result = await until(() => active.checkSecurityOperation(hash));
    assert.ok(result.success);
  }
  await register(owner);
  await funding(owner, 'deploy', '0');
  const protect = await service.prepareSecurityOperation({
    kind: 'protect',
    module: RECOVERY_MODULES.demoThreeMinutes,
    guardians: {
      backup: backup.address,
      friend: friend.address,
      swissquote: sq.address,
    },
  });
  assert.equal(protect.maxGasEth, '0');
  await confirmSecurity(
    service,
    (await service.submitSecurityOperation(protect)).userOperationHash,
  );
  await link(owner);
  await funding(owner, 'deposit', '20');
  async function send(active: typeof service, amount: string) {
    const preview = await active.prepareTransfer({ recipient, amount });
    assert.equal(preview.gasPayer, 'swissquote_treasury');
    const submitted = await active.submitTransfer(preview);
    const confirmed = await until(() => active.confirmTransfer(submitted));
    assert.ok(confirmed.balanceChangesMatch);
  }
  await send(service, '2');
  await confirmSecurity(
    service,
    (
      await service.submitSecurityOperation(
        await service.prepareSecurityOperation({
          kind: 'replace-guardian',
          oldGuardian: friend.address,
          newGuardian: replacement.address,
        }),
      )
    ).userOperationHash,
  );
  async function caseStart() {
    const created = await api<{ case_id: string; nonce: string }>(
      '/recovery/requests',
      { safe_address: safe, new_owner_address: next.address },
    );
    const path = `/recovery/requests/${created.case_id}`;
    for (const guardian of [backup, replacement]) {
      const signature = await guardian.signTypedData(
        recoveryTypedData({
          safe,
          module: RECOVERY_MODULES.demoThreeMinutes,
          newOwner: next.address,
          nonce: BigInt(created.nonce),
          chainId: 11155111,
        }),
      );
      await api(`${path}/approvals`, {
        guardian_address: guardian.address,
        signature,
      });
    }
    const job = await api<RelayStatus>(`${path}/submit`, {});
    await until(async () => {
      const status = await api<RelayStatus>(`/transactions/${job.id}`);
      assert.notEqual(status.status, 'failed');
      return status.status === 'confirmed' ? status : null;
    });
    return path;
  }
  await caseStart();
  await confirmSecurity(
    service,
    (
      await service.submitSecurityOperation(
        await service.prepareSecurityOperation({ kind: 'cancel-recovery' }),
      )
    ).userOperationHash,
  );
  assert.equal((await service.getSecurityState()).recovery?.pending, null);
  const path = await caseStart();
  await chain.request({
    method: 'evm_increaseTime' as never,
    params: [181] as never,
  });
  await chain.request({ method: 'evm_mine' as never, params: [] as never });
  const job = await api<RelayStatus>(`${path}/finalize`, {});
  await until(async () => {
    const status = await api<RelayStatus>(`/transactions/${job.id}`);
    assert.notEqual(status.status, 'failed');
    return status.status === 'confirmed' ? status : null;
  });
  const recovered = wallet(nextKey, safe);
  const info: SafeAccountInfo = await recovered.getAccount();
  assert.equal(info.safeAddress.toLowerCase(), safe.toLowerCase());
  assert.equal(info.tokenBalance, '18');
  await link(next);
  await funding(next, 'deposit', '1');
  await send(recovered, '1');
  for (const address of [
    owner.address,
    next.address,
    safe,
    backup.address,
    friend.address,
    replacement.address,
  ])
    assert.equal(await chain.getBalance({ address }), 0n);
  assert.equal((await recovered.getAccount()).tokenBalance, '18');
  assert.equal(biometricReads, 5); // protect, send, replace, cancel, recovered send
  console.log(
    'Full wallet-core HTTP/worker acceptance passed; client Safe and owners remain at zero ETH.',
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Local wallet acceptance failed',
  );
  process.exit(1);
});
