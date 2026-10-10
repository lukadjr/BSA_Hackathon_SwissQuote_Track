import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import {
  createSafeWallet,
  predictSafeAddress,
  WalletError,
  type Address,
  type ConfirmedTransfer,
  type SubmittedTransfer,
  type TransferActivityStore,
} from '../packages/wallet-core';

// This CLI uses its own disposable owner. Never export the phone's key here.
try {
  loadEnvFile('.env.sepolia');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const keyFile = resolve(
  process.env.SEPOLIA_SMOKE_KEY_FILE ?? '.sepolia-owner.key',
);
const stateFile = resolve(
  process.env.SEPOLIA_SMOKE_STATE_FILE ?? '.sepolia-smoke.json',
);

async function main() {
  const mode = process.argv[2] ?? 'address';
  if (!['init', 'address', 'send', 'status'].includes(mode))
    throw new Error('Use init, address, send, or status.');
  if (mode === 'init') {
    const key = generatePrivateKey();
    await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 });
    const owner = privateKeyToAddress(key);
    console.log(
      JSON.stringify(
        {
          ownerAddress: owner,
          safeAddress: predictSafeAddress(owner),
          note: 'Disposable test owner created. Run address to check Sepolia before funding.',
        },
        null,
        2,
      ),
    );
    return;
  }
  const readKey = async () => {
    const key = (await readFile(keyFile, 'utf8')).trim();
    if (!/^0x[\da-fA-F]{64}$/.test(key))
      throw new Error('Invalid test owner key file.');
    return key as `0x${string}`;
  };
  const owner = privateKeyToAddress(await readKey());
  type State = {
    pending: SubmittedTransfer | null;
    confirmed: ConfirmedTransfer | null;
  };
  let state: State;
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8')) as State;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Cannot read smoke tracking state.');
    state = { pending: null, confirmed: null };
  }
  const persist = async () => {
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
    await rename(`${stateFile}.tmp`, stateFile);
  };
  const activity: TransferActivityStore = {
    readPending: async () => state.pending,
    writePending: async (value) => {
      state.pending = value;
      await persist();
    },
    writeConfirmed: async (value) => {
      state.confirmed = value;
      await persist();
    },
  };
  const wallet = createSafeWallet({
    config: {
      rpcUrl: process.env.SEPOLIA_RPC_URL ?? '',
      bundlerUrl: process.env.SEPOLIA_BUNDLER_URL ?? '',
      tokenAddress: (process.env.SEPOLIA_TOKEN_ADDRESS ?? '') as Address,
    },
    storage: {
      readAddress: async () => owner,
      readPrivateKeyForSigning: readKey,
      saveNewWallet: async () => {
        throw new Error('Use init to create the test owner.');
      },
    },
    activity,
  });
  if (mode === 'address') {
    console.log(JSON.stringify(await wallet.getAccount(), null, 2));
    return;
  }
  if (mode === 'send') {
    if (state.pending)
      throw new Error(
        'An operation is pending. Run status instead of sending again.',
      );
    const preview = await wallet.prepareTransfer({
      recipient: (process.env.SEPOLIA_RECIPIENT ?? '') as Address,
      amount: process.env.SEPOLIA_AMOUNT ?? '1',
    });
    console.log('Transfer preview:', JSON.stringify(preview, null, 2));
    const submitted = await wallet.submitTransfer(preview);
    console.log('Submitted UserOperation:', submitted.userOperationHash);
  }
  if (!state.pending) {
    console.log(
      state.confirmed
        ? JSON.stringify(state.confirmed, null, 2)
        : 'No pending operation.',
    );
    return;
  }
  const pending = state.pending;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await wallet.confirmTransfer(pending);
    if (result) {
      console.log('Verified transfer:', JSON.stringify(result, null, 2));
      if (!result.balanceChangesMatch) {
        console.error(
          'Transfer event verified; block balance deltas differ. Use an isolated recipient/token for the smoke test.',
        );
        process.exitCode = 1;
      }
      return;
    }
    await new Promise((done) => setTimeout(done, 3000));
  }
  console.error('Still pending. Run status later; do not resend.');
  process.exitCode = 1;
}
async function runExclusively() {
  const lockFile = `${stateFile}.lock`;
  const lock = await open(lockFile, 'wx', 0o600);
  try {
    await main();
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}
runExclusively().catch((error: unknown) => {
  // Never print provider/SDK errors, URLs, or private key file contents.
  if (error instanceof WalletError)
    console.error(`${error.code}: ${error.message}`);
  else
    console.error(
      'Smoke run failed. Check configuration, funding, key/state files, and pending status.',
    );
  process.exitCode = 1;
});
