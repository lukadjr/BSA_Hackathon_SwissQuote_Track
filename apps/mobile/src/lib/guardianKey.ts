// The friend's side: a dedicated guardian key, separate from any owner key on
// this phone. It never leaves SecureStore except for a Face ID-protected read
// right before signing an invite acceptance or a recovery approval.
import './polyfills';
import {
  generateOwnerKey,
  guardianInviteMessage,
  signRecoveryApproval,
  WalletError,
  type Address,
  type GuardianApproval,
  type Hex,
  type PrivateKey,
  type RecoveryTarget,
} from '@swissquote/wallet-core';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { isAddressEqual } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ADDRESS_KEY = 'swissquote.guardian.address';
const PRIVATE_KEY = 'swissquote.guardian.privateKey';
const GUARDING_KEY = 'swissquote.guardian.of.v1';
const PUBLIC_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};
const SECRET_OPTIONS: SecureStore.SecureStoreOptions = {
  ...PUBLIC_OPTIONS,
  requireAuthentication: true,
  authenticationPrompt: 'Confirm with your guardian key',
};

function native() {
  if (Platform.OS === 'web')
    throw new WalletError(
      'AUTH_UNAVAILABLE',
      'Guardian keys need a real phone (development build).',
    );
}

export async function getGuardianAddress(): Promise<Address | null> {
  native();
  return (await SecureStore.getItemAsync(
    ADDRESS_KEY,
    PUBLIC_OPTIONS,
  )) as Address | null;
}

/** Creates the guardian key once; later calls return the same address. */
export async function ensureGuardianKey(): Promise<Address> {
  const existing = await getGuardianAddress();
  if (existing) return existing;
  if (!SecureStore.canUseBiometricAuthentication())
    throw new WalletError(
      'AUTH_UNAVAILABLE',
      'Set up Face ID / fingerprint on this phone first.',
    );
  const { address, privateKey } = generateOwnerKey();
  try {
    await SecureStore.setItemAsync(PRIVATE_KEY, privateKey, SECRET_OPTIONS);
    await SecureStore.setItemAsync(ADDRESS_KEY, address, PUBLIC_OPTIONS);
  } catch {
    throw new WalletError('STORAGE_FAILED', 'Could not save the guardian key.');
  }
  return address;
}

async function readGuardianKey(): Promise<PrivateKey> {
  native();
  let key: string | null;
  try {
    key = await SecureStore.getItemAsync(PRIVATE_KEY, SECRET_OPTIONS);
  } catch (e) {
    const text = String((e as { message?: string })?.message ?? '');
    if (/cancel/i.test(text))
      throw new WalletError('AUTH_CANCELLED', 'Authentication cancelled.');
    throw new WalletError(
      'KEY_UNAVAILABLE',
      'The guardian key cannot be read.',
    );
  }
  const address = await getGuardianAddress();
  if (
    !key ||
    !address ||
    !isAddressEqual(privateKeyToAccount(key as PrivateKey).address, address)
  )
    throw new WalletError('KEY_UNAVAILABLE', 'The guardian key is missing.');
  return key as PrivateKey;
}

/** Face ID, then sign the invite acceptance shown on screen. */
export async function signInviteAcceptance(input: {
  safe: Address;
  invite: string;
}): Promise<{ guardian: Address; signature: Hex }> {
  const guardian = await ensureGuardianKey();
  let key: PrivateKey | undefined = await readGuardianKey();
  try {
    const signature = await privateKeyToAccount(key).signMessage({
      message: guardianInviteMessage({ ...input, guardian }),
    });
    return { guardian, signature };
  } finally {
    key = undefined;
  }
}

/** Face ID, then sign the recovery approval shown on screen. */
export async function signApprovalAsGuardian(
  target: RecoveryTarget,
): Promise<GuardianApproval> {
  let key: PrivateKey | undefined = await readGuardianKey();
  try {
    return await signRecoveryApproval(key, target);
  } finally {
    key = undefined;
  }
}

export interface GuardedWallet {
  safe: Address;
  from: string;
  acceptedAt: string;
}

export async function listGuardedWallets(): Promise<GuardedWallet[]> {
  native();
  try {
    const json = await SecureStore.getItemAsync(GUARDING_KEY, PUBLIC_OPTIONS);
    return json ? (JSON.parse(json) as GuardedWallet[]) : [];
  } catch {
    return [];
  }
}

export async function rememberGuardedWallet(entry: GuardedWallet) {
  const list = (await listGuardedWallets()).filter(
    (w) => !isAddressEqual(w.safe, entry.safe),
  );
  await SecureStore.setItemAsync(
    GUARDING_KEY,
    JSON.stringify([entry, ...list]),
    PUBLIC_OPTIONS,
  );
}

export async function deleteGuardianKeyForDev() {
  if (!__DEV__) throw new WalletError('NOT_IMPLEMENTED', 'Development only.');
  await clearGuardianStorage();
}

/** Explicit full-phone reset, including this phone's guardian commitments. */
export async function clearGuardianStorage() {
  for (const key of [PRIVATE_KEY, ADDRESS_KEY, GUARDING_KEY])
    await SecureStore.deleteItemAsync(
      key,
      key === PRIVATE_KEY ? SECRET_OPTIONS : PUBLIC_OPTIONS,
    );
}
