import { beforeEach, expect, it, vi } from 'vitest';
import { WalletError } from '@swissquote/wallet-core';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  clearSession: vi.fn(),
  clearPhoneAccount: vi.fn(),
  disconnect: vi.fn(),
  clearSafe: vi.fn(),
  clearLink: vi.fn(),
  clearActivity: vi.fn(),
  address: vi.fn(),
  account: vi.fn(),
  security: vi.fn(),
  owners: vi.fn(),
}));
vi.mock('../../apps/mobile/src/lib/auth', () => ({
  getSession: mocks.session,
  clearSession: mocks.clearSession,
  clearPhoneAccount: mocks.clearPhoneAccount,
}));
vi.mock('../../apps/mobile/src/lib/guardianKey', () => ({
  clearGuardianStorage: vi.fn(),
}));
vi.mock('../../apps/mobile/src/lib/secureStoreAdapter', () => ({
  disconnectOwnerWallet: mocks.disconnect,
}));
vi.mock('../../apps/mobile/src/lib/activity', () => ({
  clearActivityForDev: mocks.clearActivity,
}));
vi.mock('../../apps/mobile/src/lib/linkStatus', () => ({
  clearWalletLinked: mocks.clearLink,
}));
vi.mock('../../apps/mobile/src/lib/wallet', () => ({
  getAddress: mocks.address,
}));
vi.mock('../../apps/mobile/src/lib/safeWallet', () => ({
  clearSafeTracking: mocks.clearSafe,
  getSafeAccount: mocks.account,
  currentSafeAddress: async () => '0x1111111111111111111111111111111111111111',
  getSafeWallet: () => ({ getSecurityState: mocks.security }),
}));
vi.mock('../../apps/mobile/src/lib/recovery', () => ({
  getRecoveryClient: () => ({ readOwners: mocks.owners }),
  clearRecoveryForDev: vi.fn(),
}));
import {
  logoutWallet,
  walletAccess,
} from '../../apps/mobile/src/lib/walletSession';
const owner = '0x2222222222222222222222222222222222222222';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ username: 'demo', token: 'test' });
  mocks.address.mockResolvedValue(owner);
  mocks.account.mockResolvedValue({ tokenBalance: '8.5' });
  mocks.security.mockResolvedValue({
    recovery: { threshold: 2, guardians: ['a', 'b', 'c'] },
  });
  mocks.owners.mockResolvedValue([
    '0x3333333333333333333333333333333333333333',
  ]);
});

it('logout clears the owner, Safe, activity and bank link after closing the session', async () => {
  await logoutWallet();
  for (const fn of [
    mocks.clearSession,
    mocks.disconnect,
    mocks.clearSafe,
    mocks.clearLink,
    mocks.clearActivity,
    mocks.clearPhoneAccount,
  ])
    expect(fn).toHaveBeenCalledOnce();
  expect(mocks.clearSession.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.disconnect.mock.invocationCallOrder[0],
  );
  // The phone is released for another account only after the key is gone.
  expect(mocks.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.clearPhoneAccount.mock.invocationCallOrder[0],
  );
});
it('refuses private access without a session and does not read wallet balances', async () => {
  mocks.session.mockResolvedValue(null);
  expect(await walletAccess()).toBe('signed-out');
  expect(mocks.account).not.toHaveBeenCalled();
});
it('requires guardians even when logging back in or opening a direct wallet link', async () => {
  mocks.security.mockResolvedValue({ recovery: null });
  expect(await walletAccess()).toBe('setup-required');
  expect(await walletAccess(false)).toBe('active');
});
it('permits a wallet whose on-chain configuration and guardians are verified', async () => {
  expect(await walletAccess()).toBe('active');
  expect(mocks.disconnect).not.toHaveBeenCalled();
});
it('revokes the old phone after a verified owner rotation', async () => {
  mocks.account.mockRejectedValue(
    new WalletError('SAFE_CONFIG_INVALID', 'Owner changed'),
  );
  expect(await walletAccess()).toBe('revoked');
  expect(mocks.disconnect).toHaveBeenCalledOnce();
});
it('keeps the key on a network outage and blocks access', async () => {
  mocks.account.mockRejectedValue(new WalletError('NETWORK_FAILED', 'Offline'));
  await expect(walletAccess()).rejects.toMatchObject({
    code: 'NETWORK_FAILED',
  });
  expect(mocks.disconnect).not.toHaveBeenCalled();
});
it.each([{ owners: [] }, { owners: [owner] }])(
  'does not delete a key on an unrelated Safe configuration error: %j',
  async ({ owners }) => {
    mocks.account.mockRejectedValue(
      new WalletError('SAFE_CONFIG_INVALID', 'Wrong module'),
    );
    mocks.owners.mockResolvedValue(owners);
    await expect(walletAccess()).rejects.toMatchObject({
      code: 'SAFE_CONFIG_INVALID',
    });
    expect(mocks.disconnect).not.toHaveBeenCalled();
  },
);
it('cannot reopen the wallet when logout cleanup fails part way through', async () => {
  mocks.clearSession.mockImplementation(async () => {
    mocks.session.mockResolvedValue(null);
  });
  mocks.disconnect.mockRejectedValue(
    new WalletError('STORAGE_FAILED', 'Keychain locked'),
  );
  await expect(logoutWallet()).rejects.toMatchObject({
    code: 'STORAGE_FAILED',
  });
  expect(await walletAccess()).toBe('signed-out');
});

it('allows an authenticated new phone to create or recover a wallet', async () => {
  mocks.address.mockResolvedValue(null);
  expect(await walletAccess(false, true)).toBe('active');
  expect(await walletAccess()).toBe('signed-out');
  expect(mocks.account).not.toHaveBeenCalled();
});
it('still requires login before creating or recovering a wallet', async () => {
  mocks.session.mockResolvedValue(null);
  expect(await walletAccess(false, true)).toBe('signed-out');
  expect(mocks.address).not.toHaveBeenCalled();
});
