import { beforeEach, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  canUseBiometricAuthentication: () => true,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
}));
vi.mock('expo-secure-store', () => store);
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-crypto', () => ({ getRandomValues: vi.fn() }));

import { resetWallet } from '../../apps/mobile/src/lib/walletSession';
import { resetWalletForDev } from '../../apps/mobile/src/lib/devReset';
import { secureStoreAdapter } from '../../apps/mobile/src/lib/secureStoreAdapter';
import { getSession } from '../../apps/mobile/src/lib/auth';
import {
  getGuardianAddress,
  listGuardedWallets,
} from '../../apps/mobile/src/lib/guardianKey';

const keys = [
  'sq_session_token',
  'sq_session_user',
  'sq_wallet_user',
  'swissquote.owner.address',
  'swissquote.owner.privateKey',
  'swissquote.owner.creating',
  'swissquote.owner.linked',
  'swissquote.safe.account.v1',
  'swissquote.safe.pending.v1',
  'swissquote.safe.confirmed.v1',
  'swissquote.treasury.pending.v1',
  'swissquote.recovery.labels.v1',
  'swissquote.recovery.pending.v1',
  'swissquote.safe.recovered.v1',
  'swissquote.activity.sent.v1',
  'swissquote.guardian.address',
  'swissquote.guardian.privateKey',
  'swissquote.guardian.of.v1',
];

beforeEach(() => {
  vi.resetAllMocks();
  store.values.clear();
  keys.forEach((key) => store.values.set(key, 'previous-phone-state'));
  store.getItemAsync.mockImplementation(
    async (key: string) => store.values.get(key) ?? null,
  );
  store.setItemAsync.mockImplementation(async (key: string, value: string) => {
    store.values.set(key, value);
  });
  store.deleteItemAsync.mockImplementation(async (key: string) => {
    store.values.delete(key);
  });
  vi.stubGlobal('__DEV__', false);
});

it('clears every app storage entry in a release build and allows a new wallet', async () => {
  await resetWallet();
  expect(store.values.size).toBe(0);
  expect(await getSession()).toBeNull();
  expect(await secureStoreAdapter.readAddress()).toBeNull();
  expect(await getGuardianAddress()).toBeNull();
  expect(await listGuardedWallets()).toEqual([]);
  await secureStoreAdapter.saveNewWallet({
    address: `0x${'2'.repeat(40)}`,
    privateKey: `0x${'2'.repeat(64)}`,
  });
  expect(await secureStoreAdapter.readAddress()).toBe(`0x${'2'.repeat(40)}`);
});

it('uses the same complete cleanup for the development wallet reset', async () => {
  vi.stubGlobal('__DEV__', true);
  await resetWalletForDev();
  expect(store.values.size).toBe(0);
});

it('reports partial cleanup, clears independent stores and permits retry', async () => {
  store.deleteItemAsync.mockImplementation(async (key: string) => {
    if (key === 'swissquote.owner.privateKey')
      throw new Error('Keychain locked');
    store.values.delete(key);
  });
  await expect(resetWallet()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  expect(await getSession()).toBeNull();
  expect(await getGuardianAddress()).toBeNull();
  expect(store.values.has('swissquote.recovery.pending.v1')).toBe(false);
  expect(store.values.has('swissquote.owner.privateKey')).toBe(true);
  store.deleteItemAsync.mockImplementation(async (key: string) => {
    store.values.delete(key);
  });
  await resetWallet();
  expect(store.values.size).toBe(0);
});

it('keeps the legacy development helper unavailable in release builds', async () => {
  await expect(resetWalletForDev()).rejects.toMatchObject({
    code: 'NOT_IMPLEMENTED',
  });
  expect(store.deleteItemAsync).not.toHaveBeenCalled();
});

it('clears recovery progress even when Safe tracking cleanup fails', async () => {
  store.deleteItemAsync.mockImplementation(async (key: string) => {
    if (key === 'swissquote.safe.account.v1')
      throw new Error('Keychain locked');
    store.values.delete(key);
  });
  await expect(resetWallet()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  expect(store.values.has('swissquote.recovery.pending.v1')).toBe(false);
  expect(store.values.has('swissquote.safe.recovered.v1')).toBe(false);
  expect(store.values.has('swissquote.recovery.labels.v1')).toBe(false);
  // The phone stays bound to its account until the wallet is really gone.
  expect(store.values.has('sq_wallet_user')).toBe(true);
});
