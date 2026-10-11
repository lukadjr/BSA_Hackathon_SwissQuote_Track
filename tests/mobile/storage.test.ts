import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletError } from '@swissquote/wallet-core';

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  canUseBiometricAuthentication: vi.fn(),
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
}));
vi.mock('expo-secure-store', () => store);
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
import {
  disconnectOwnerWallet,
  secureStoreAdapter,
} from '../../apps/mobile/src/lib/secureStoreAdapter';

const ADDRESS = 'swissquote.owner.address';
const KEY = 'swissquote.owner.privateKey';
const PENDING = 'swissquote.owner.creating';
const wallet = {
  address: `0x${'1'.repeat(40)}` as const,
  privateKey: `0x${'1'.repeat(64)}` as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  store.values.clear();
  store.canUseBiometricAuthentication.mockReturnValue(true);
  store.getItemAsync.mockImplementation(
    async (key: string) => store.values.get(key) ?? null,
  );
  store.setItemAsync.mockImplementation(async (key: string, value: string) => {
    store.values.set(key, value);
  });
  store.deleteItemAsync.mockImplementation(async (key: string) => {
    store.values.delete(key);
  });
});

describe('native owner storage', () => {
  it('persists a protected key and reads the public address without unlocking it', async () => {
    await secureStoreAdapter.saveNewWallet(wallet);
    expect(store.setItemAsync).toHaveBeenCalledWith(
      KEY,
      wallet.privateKey,
      expect.objectContaining({ requireAuthentication: true }),
    );
    store.getItemAsync.mockClear();
    expect(await secureStoreAdapter.readAddress()).toBe(wallet.address);
    expect(store.getItemAsync).not.toHaveBeenCalledWith(KEY, expect.anything());
    await expect(
      secureStoreAdapter.saveNewWallet(wallet),
    ).rejects.toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
  });

  it.each(['reject', 'silent'] as const)(
    'blocks replacement when key deletion fails (%s)',
    async (failure) => {
      store.setItemAsync.mockImplementation(
        async (key: string, value: string) => {
          if (key === ADDRESS) throw new Error('Metadata write failed');
          store.values.set(key, value);
        },
      );
      store.deleteItemAsync.mockImplementation(async (key: string) => {
        if (key === KEY) {
          if (failure === 'reject') throw new Error('Deletion failed');
          return;
        }
        store.values.delete(key);
      });
      await expect(
        secureStoreAdapter.saveNewWallet(wallet),
      ).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
      expect(store.values.get(KEY)).toBe(wallet.privateKey);
      expect(store.values.has(PENDING)).toBe(true);
      await expect(secureStoreAdapter.readAddress()).rejects.toMatchObject({
        code: 'STORAGE_FAILED',
      });
      store.setItemAsync.mockClear();
      await expect(
        secureStoreAdapter.saveNewWallet(wallet),
      ).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
      expect(store.setItemAsync).not.toHaveBeenCalled();
    },
  );

  it('allows retry only after rollback confirms no secret or metadata remains', async () => {
    store.setItemAsync
      .mockImplementationOnce(async (key: string, value: string) => {
        store.values.set(key, value);
      })
      .mockRejectedValueOnce(new Error('Secret write failed'));
    await expect(
      secureStoreAdapter.saveNewWallet(wallet),
    ).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(store.values.size).toBe(0);
    await secureStoreAdapter.saveNewWallet(wallet);
  });

  it('refuses an existing secret even without metadata or a creation marker', async () => {
    store.values.set(KEY, wallet.privateKey);
    await expect(
      secureStoreAdapter.saveNewWallet(wallet),
    ).rejects.toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });

  it('requires a fresh protected read and preserves safe cancellation errors', async () => {
    store.values.set(KEY, wallet.privateKey);
    await secureStoreAdapter.readPrivateKeyForSigning();
    await secureStoreAdapter.readPrivateKeyForSigning();
    expect(store.getItemAsync).toHaveBeenCalledTimes(2);
    expect(store.getItemAsync).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ requireAuthentication: true }),
    );
    store.getItemAsync.mockRejectedValueOnce(
      new Error('User canceled the operation'),
    );
    await expect(secureStoreAdapter.readPrivateKeyForSigning()).rejects.toEqual(
      new WalletError('AUTH_CANCELLED', 'Authentication cancelled.'),
    );
  });
});

it('disconnects the current owner and lets a different wallet be created on this phone', async () => {
  await secureStoreAdapter.saveNewWallet(wallet);
  store.values.set(
    'swissquote.guardian.privateKey',
    'independent-guardian-key',
  );
  await disconnectOwnerWallet();
  expect(await secureStoreAdapter.readAddress()).toBeNull();
  expect(store.values.has(KEY)).toBe(false);
  expect(store.values.has(PENDING)).toBe(false);
  expect(store.values.get('swissquote.guardian.privateKey')).toBe(
    'independent-guardian-key',
  );
  const replacement = {
    address: `0x${'2'.repeat(40)}` as const,
    privateKey: `0x${'2'.repeat(64)}` as const,
  };
  await secureStoreAdapter.saveNewWallet(replacement);
  expect(await secureStoreAdapter.readAddress()).toBe(replacement.address);
});
