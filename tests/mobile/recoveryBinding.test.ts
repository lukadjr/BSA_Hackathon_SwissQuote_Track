import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  owners: vi.fn(),
  address: vi.fn(),
}));
vi.mock('../../apps/mobile/src/lib/polyfills', () => ({}));
vi.mock('expo-secure-store', () => ({
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
  getItemAsync: async (key: string) => mocks.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mocks.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mocks.values.delete(key);
  },
}));
vi.mock('@swissquote/wallet-core', async (original) => ({
  ...(await original<typeof import('@swissquote/wallet-core')>()),
  createRecoveryClient: () => ({ readOwners: mocks.owners }),
}));
vi.mock('../../apps/mobile/src/lib/secureStoreAdapter', () => ({
  secureStoreAdapter: { readAddress: mocks.address },
}));
vi.mock('../../apps/mobile/src/lib/safeWallet', () => ({
  getSafeWallet: vi.fn(),
}));
vi.mock('../../apps/mobile/src/lib/wallet', () => ({
  describeWalletError: vi.fn(),
}));
import {
  readRecoveredSafe,
  saveRecoveredSafe,
} from '../../apps/mobile/src/lib/recovery';
const safe = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.values.clear();
  mocks.address.mockResolvedValue(owner);
  mocks.owners.mockResolvedValue([owner]);
});
it('binds the new key to the original Safe only after finalized ownership', async () => {
  await saveRecoveredSafe(safe, owner);
  expect(await readRecoveredSafe()).toBe(safe);
  expect(mocks.owners).toHaveBeenCalledWith(safe);
});
it('refuses a recovery that is still waiting on-chain', async () => {
  mocks.owners.mockResolvedValue([other]);
  await expect(saveRecoveredSafe(safe, owner)).rejects.toMatchObject({
    code: 'SAFE_CONFIG_INVALID',
  });
  expect(mocks.values.size).toBe(0);
});
it('refuses to bind a different phone key', async () => {
  mocks.address.mockResolvedValue(other);
  await expect(saveRecoveredSafe(safe, owner)).rejects.toMatchObject({
    code: 'SAFE_CONFIG_INVALID',
  });
});
it('does not reuse a recovered binding after changing the wallet on this phone', async () => {
  await saveRecoveredSafe(safe, owner);
  mocks.address.mockResolvedValue(other);
  expect(await readRecoveredSafe()).toBeNull();
});
it('does not overwrite the recovered Safe when the chain is unavailable', async () => {
  await saveRecoveredSafe(safe, owner);
  mocks.owners.mockRejectedValue(new Error('offline'));
  await expect(saveRecoveredSafe(other, owner)).rejects.toThrow('offline');
  expect(await readRecoveredSafe()).toBe(safe);
});
