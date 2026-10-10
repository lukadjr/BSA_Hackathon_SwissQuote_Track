import {
  WalletError,
  type Address,
  type OwnerKeyStorage,
} from '@swissquote/wallet-core';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// Public data (address) is stored unprotected; the private key is stored with
// requireAuthentication. Actual prompt presentation is controlled by the OS.
const ADDRESS_KEY = 'swissquote.owner.address';
const PRIVATE_KEY = 'swissquote.owner.privateKey';
// Written before the private key. If it exists but the address does not, a
// previous creation was interrupted: we refuse to overwrite a possible key.
const PENDING_KEY = 'swissquote.owner.creating';

const PUBLIC_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};
const SECRET_OPTIONS: SecureStore.SecureStoreOptions = {
  ...PUBLIC_OPTIONS,
  requireAuthentication: true,
  authenticationPrompt: 'Confirm to sign with your Swissquote Wallet key',
};

function fail(code: ConstructorParameters<typeof WalletError>[0], msg: string) {
  return new WalletError(code, msg);
}

/** Turns a native error into a safe WalletError (never forwards raw text). */
function mapNativeError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const text = `${(e as { code?: string })?.code ?? ''} ${
    (e as { message?: string })?.message ?? ''
  }`;
  if (/cancel|user_cancel|ERR_SECURESTORE_AUTH.*CANCEL/i.test(text))
    return fail('AUTH_CANCELLED', 'Authentication cancelled.');
  if (/not.?configured|passcode|no.?biometric|not.?enrolled/i.test(text))
    return fail('AUTH_UNAVAILABLE', 'No device passcode or biometrics set.');
  if (/invalidat|permanently|not.?found/i.test(text))
    return fail('KEY_UNAVAILABLE', 'The owner key is no longer available.');
  return fail('STORAGE_FAILED', 'Owner wallet storage failed.');
}

function assertNative() {
  if (Platform.OS === 'web') {
    throw fail(
      'AUTH_UNAVAILABLE',
      'Secure key storage needs a real phone (iOS/Android development build). It does not work in the browser.',
    );
  }
}

export const secureStoreAdapter: OwnerKeyStorage = {
  async readAddress() {
    assertNative();
    try {
      const value = await SecureStore.getItemAsync(ADDRESS_KEY, PUBLIC_OPTIONS);
      if (
        value === null &&
        (await SecureStore.getItemAsync(PENDING_KEY, PUBLIC_OPTIONS)) !== null
      ) {
        throw fail(
          'STORAGE_FAILED',
          'Wallet creation was interrupted. Do not create a replacement key.',
        );
      }
      return value === null ? null : (value as Address);
    } catch (e) {
      throw mapNativeError(e);
    }
  },

  async saveNewWallet({ address, privateKey }) {
    assertNative();
    try {
      const hasAddress = await SecureStore.getItemAsync(
        ADDRESS_KEY,
        PUBLIC_OPTIONS,
      );
      const pending = await SecureStore.getItemAsync(
        PENDING_KEY,
        PUBLIC_OPTIONS,
      );
      if (hasAddress !== null) {
        throw fail('WALLET_ALREADY_EXISTS', 'An owner wallet already exists.');
      }
      if (pending !== null) {
        throw fail(
          'STORAGE_FAILED',
          'A previous wallet creation was interrupted. Refusing to overwrite.',
        );
      }
      if (
        (await SecureStore.getItemAsync(PRIVATE_KEY, SECRET_OPTIONS)) !== null
      ) {
        throw fail('WALLET_ALREADY_EXISTS', 'An owner key already exists.');
      }
      if (!SecureStore.canUseBiometricAuthentication()) {
        throw fail(
          'AUTH_UNAVAILABLE',
          'Set up Face ID / fingerprint on this phone first.',
        );
      }
      await SecureStore.setItemAsync(PENDING_KEY, '1', PUBLIC_OPTIONS);
      try {
        await SecureStore.setItemAsync(PRIVATE_KEY, privateKey, SECRET_OPTIONS);
        await SecureStore.setItemAsync(ADDRESS_KEY, address, PUBLIC_OPTIONS);
      } catch (e) {
        // Keep the marker unless both values are confirmed absent. Native
        // deletion can fail or silently leave a key behind; never overwrite it.
        try {
          await SecureStore.deleteItemAsync(PRIVATE_KEY, SECRET_OPTIONS);
          await SecureStore.deleteItemAsync(ADDRESS_KEY, PUBLIC_OPTIONS);
          const remainingKey = await SecureStore.getItemAsync(
            PRIVATE_KEY,
            SECRET_OPTIONS,
          );
          const remainingAddress = await SecureStore.getItemAsync(
            ADDRESS_KEY,
            PUBLIC_OPTIONS,
          );
          if (remainingKey === null && remainingAddress === null) {
            await SecureStore.deleteItemAsync(PENDING_KEY, PUBLIC_OPTIONS);
          }
        } catch {
          // A retry remains blocked by the marker after uncertain cleanup.
        }
        throw e;
      }
    } catch (e) {
      throw mapNativeError(e);
    }
  },

  async readPrivateKeyForSigning() {
    assertNative();
    try {
      // Fresh protected read each time: this is what triggers Face ID.
      const key = await SecureStore.getItemAsync(PRIVATE_KEY, SECRET_OPTIONS);
      if (key === null)
        throw fail('KEY_UNAVAILABLE', 'The owner key is missing.');
      return key as `0x${string}`;
    } catch (e) {
      throw mapNativeError(e);
    }
  },
};
