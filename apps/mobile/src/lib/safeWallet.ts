import './polyfills';
import {
  createSafeWallet,
  SAFE_DEPLOYMENT,
  WalletError,
  type SafeAccountInfo,
  type SubmittedTransfer,
  type ConfirmedTransfer,
  type TransferActivityStore,
  type Address,
} from '@swissquote/wallet-core';
import * as SecureStore from 'expo-secure-store';
import { isAddress, isAddressEqual } from 'viem';
import { secureStoreAdapter } from './secureStoreAdapter';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};
const ACCOUNT_KEY = 'swissquote.safe.account.v1';
const PENDING_KEY = 'swissquote.safe.pending.v1';
const CONFIRMED_KEY = 'swissquote.safe.confirmed.v1';

function validSubmission(value: SubmittedTransfer): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    [
      value.ownerAddress,
      value.safeAddress,
      value.tokenAddress,
      value.recipient,
    ].every(
      (address) =>
        typeof address === 'string' && isAddress(address, { strict: false }),
    ) &&
    /^0x[\da-fA-F]{64}$/.test(value.userOperationHash) &&
    /^\d+$/.test(value.amountUnits) &&
    /^\d+$/.test(value.nonce) &&
    /^\d+$/.test(value.validUntil) &&
    Number.isInteger(value.decimals) &&
    value.decimals >= 0 &&
    value.decimals <= 255
  );
}
async function readTracking<T extends SubmittedTransfer>(
  key: string,
): Promise<T | null> {
  try {
    const json = await SecureStore.getItemAsync(key, OPTIONS);
    if (json === null) return null;
    const value = JSON.parse(json) as T;
    if (!validSubmission(value)) throw new Error();
    return value;
  } catch {
    throw new WalletError(
      'STORAGE_FAILED',
      'Could not read transfer tracking.',
    );
  }
}
async function writeTracking(key: string, value: SubmittedTransfer | null) {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key, OPTIONS);
    else await SecureStore.setItemAsync(key, JSON.stringify(value), OPTIONS);
  } catch {
    throw new WalletError(
      'STORAGE_FAILED',
      'Could not save transfer tracking.',
    );
  }
}
export const transferActivity: TransferActivityStore = {
  readPending: () => readTracking(PENDING_KEY),
  writePending: (value) => writeTracking(PENDING_KEY, value),
  writeConfirmed: (value) => writeTracking(CONFIRMED_KEY, value),
};
export async function readLastTransfer(): Promise<ConfirmedTransfer | null> {
  const result = await readTracking<ConfirmedTransfer>(CONFIRMED_KEY);
  if (result && !/^0x[\da-fA-F]{64}$/.test(result.transactionHash))
    throw new WalletError('STORAGE_FAILED', 'Invalid transaction tracking.');
  return result;
}

let service: ReturnType<typeof createSafeWallet> | undefined;
export function getSafeWallet() {
  if (
    process.env.EXPO_PUBLIC_CHAIN_ID !== undefined &&
    process.env.EXPO_PUBLIC_CHAIN_ID !== '11155111'
  )
    throw new WalletError(
      'CHAIN_CONFIG_INVALID',
      'This build only supports Sepolia.',
    );
  service ??= createSafeWallet({
    config: {
      rpcUrl: process.env.EXPO_PUBLIC_RPC_PUBLIC_URL ?? '',
      bundlerUrl: process.env.EXPO_PUBLIC_BUNDLER_URL ?? '',
      tokenAddress: (process.env.EXPO_PUBLIC_ERC20_TEST_ADDRESS ??
        '') as Address,
    },
    storage: secureStoreAdapter,
    activity: transferActivity,
  });
  return service;
}

/** Persist public account identity; fail instead of silently changing a funded Safe. */
export async function getSafeAccount(): Promise<SafeAccountInfo> {
  const info = await getSafeWallet().getAccount();
  const binding = {
    ownerAddress: info.ownerAddress,
    safeAddress: info.safeAddress,
    chainId: SAFE_DEPLOYMENT.chainId,
    stack: 'safe-1.4.1-module-0.3.0-entrypoint-0.7-salt-0',
  };
  try {
    const json = await SecureStore.getItemAsync(ACCOUNT_KEY, OPTIONS);
    if (json !== null) {
      const saved = JSON.parse(json) as typeof binding;
      if (
        !isAddressEqual(saved.ownerAddress, binding.ownerAddress) ||
        !isAddressEqual(saved.safeAddress, binding.safeAddress) ||
        saved.chainId !== binding.chainId ||
        saved.stack !== binding.stack
      )
        throw new WalletError(
          'SAFE_CONFIG_INVALID',
          'The saved Safe belongs to another owner or configuration.',
        );
    } else
      await SecureStore.setItemAsync(
        ACCOUNT_KEY,
        JSON.stringify(binding),
        OPTIONS,
      );
  } catch (e) {
    if (e instanceof WalletError) throw e;
    throw new WalletError(
      'STORAGE_FAILED',
      'Could not persist the Safe address.',
    );
  }
  return info;
}

export async function clearSafeForDev() {
  if (!__DEV__)
    throw new WalletError('NOT_IMPLEMENTED', 'Reset is for development only.');
  for (const key of [ACCOUNT_KEY, PENDING_KEY, CONFIRMED_KEY])
    await SecureStore.deleteItemAsync(key, OPTIONS);
}
