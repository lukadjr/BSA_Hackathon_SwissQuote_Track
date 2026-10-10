import {
  createWalletClient,
  getAddress,
  http,
  isAddressEqual,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import {
  english,
  generateMnemonic,
  mnemonicToAccount,
  privateKeyToAccount,
} from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { WalletError } from '../errors';
import type { PrivateKey } from '../keys/storage';
import {
  readRecoveryModule,
  SAFE_DEPLOYMENT,
  sepoliaClient,
  type SepoliaClient,
} from '../safe/account';
import {
  readRecoveryState,
  recoverApprovalSigner,
  recoveryTypedData,
  type Call,
  type GuardianApproval,
  type RecoveryState,
} from './module';

export interface RecoveryTarget {
  safe: Address;
  module: Address;
  newOwner: Address;
  nonce: bigint;
}

function typedInput(target: RecoveryTarget) {
  return { ...target, chainId: SAFE_DEPLOYMENT.chainId };
}

/** Sign an approval with any guardian key (friend app, Swissquote signer). */
export async function signRecoveryApproval(
  key: PrivateKey,
  target: RecoveryTarget,
): Promise<GuardianApproval> {
  try {
    const account = privateKeyToAccount(key);
    const signature = await account.signTypedData(
      recoveryTypedData(typedInput(target)),
    );
    return { guardian: account.address, signature };
  } catch {
    throw new WalletError('SIGNING_FAILED', 'Approval signing failed.');
  }
}

export async function verifyRecoveryApproval(
  target: RecoveryTarget,
  approval: GuardianApproval,
): Promise<boolean> {
  const signer = await recoverApprovalSigner(
    typedInput(target),
    approval.signature,
  );
  return signer !== null && isAddressEqual(signer, approval.guardian);
}

// ---- Backup guardian: a key derived from a 12-word phrase kept offline ----
const BACKUP_PATH = "m/44'/60'/0'/0/0";

export function createBackupPhrase(): { phrase: string; address: Address } {
  try {
    const phrase = generateMnemonic(english, 128);
    return {
      phrase,
      address: mnemonicToAccount(phrase, { path: BACKUP_PATH }).address,
    };
  } catch {
    throw new WalletError(
      'KEY_GENERATION_FAILED',
      'Secure backup phrase generation failed.',
    );
  }
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

export function backupAddressFromPhrase(phrase: string): Address {
  try {
    return mnemonicToAccount(normalizePhrase(phrase), { path: BACKUP_PATH })
      .address;
  } catch {
    throw new WalletError(
      'INVALID_MESSAGE',
      'These words are not a valid recovery phrase.',
    );
  }
}

export async function signApprovalWithPhrase(
  phrase: string,
  target: RecoveryTarget,
): Promise<GuardianApproval> {
  let account;
  try {
    account = mnemonicToAccount(normalizePhrase(phrase), { path: BACKUP_PATH });
  } catch {
    throw new WalletError(
      'INVALID_MESSAGE',
      'These words are not a valid recovery phrase.',
    );
  }
  const signature = await account.signTypedData(
    recoveryTypedData(typedInput(target)),
  );
  return { guardian: account.address, signature };
}

/**
 * Reads and public transactions for a Safe this phone may not own yet (the
 * recovering phone) or only guards (the friend's phone).
 */
export function createRecoveryClient({ rpcUrl }: { rpcUrl: string }) {
  try {
    const url = new URL(rpcUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new WalletError(
      'CHAIN_CONFIG_INVALID',
      'Configure a Sepolia RPC URL.',
    );
  }
  const client: SepoliaClient = sepoliaClient({
    rpcUrl,
    bundlerUrl: rpcUrl,
    tokenAddress: SAFE_DEPLOYMENT.entryPoint,
  });
  async function network<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (e) {
      if (e instanceof WalletError) throw e;
      throw new WalletError(
        'NETWORK_FAILED',
        'Sepolia request failed. Check connectivity and configuration.',
      );
    }
  }
  async function checkChain() {
    if ((await client.getChainId()) !== SAFE_DEPLOYMENT.chainId)
      throw new WalletError('CHAIN_CONFIG_INVALID', 'The RPC is not Sepolia.');
  }

  /** null when the Safe has no recovery module. */
  async function readState(safe: Address): Promise<RecoveryState | null> {
    return network(async () => {
      await checkChain();
      const module = await readRecoveryModule(client, getAddress(safe));
      return module
        ? readRecoveryState(client, module, getAddress(safe))
        : null;
    });
  }

  async function readOwners(safe: Address): Promise<Address[]> {
    return network(async () => {
      const owners = await client.readContract({
        address: getAddress(safe),
        abi: [
          {
            name: 'getOwners',
            type: 'function',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ type: 'address[]' }],
          },
        ],
        functionName: 'getOwners',
      });
      return owners.map((o) => getAddress(o));
    });
  }

  async function chainTime(): Promise<number> {
    return network(async () => Number((await client.getBlock()).timestamp));
  }

  /** Send a public module call paid by a local key (needs Sepolia ETH). */
  async function sendCall(key: PrivateKey, call: Call): Promise<Hash> {
    return network(async () => {
      await checkChain();
      const account = privateKeyToAccount(key);
      const wallet = createWalletClient({
        account,
        chain: sepolia,
        transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
      });
      // Simulate first so a revert never costs gas or looks like success.
      await client.call({
        account: account.address,
        to: call.to,
        data: call.data,
      });
      return wallet.sendTransaction({
        to: call.to,
        data: call.data,
        value: call.value,
      });
    });
  }

  async function waitForTransaction(hash: Hash, timeoutMs = 120_000) {
    return network(async () => {
      const receipt = await client.waitForTransactionReceipt({
        hash,
        timeout: timeoutMs,
      });
      return receipt.status === 'success';
    });
  }

  async function balanceOf(address: Address): Promise<bigint> {
    return network(() => client.getBalance({ address }));
  }

  return {
    readState,
    readOwners,
    chainTime,
    sendCall,
    waitForTransaction,
    balanceOf,
  };
}
export type RecoveryClient = ReturnType<typeof createRecoveryClient>;
export type { Hex };
