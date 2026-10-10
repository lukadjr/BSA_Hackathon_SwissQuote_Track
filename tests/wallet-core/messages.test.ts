import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signMessage as viemSignMessage } from 'viem/accounts';
import {
  createOwnerWallet,
  WalletError,
  type Address,
  type OwnerKeyStorage,
} from '../../packages/wallet-core';

vi.mock('viem/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem/accounts')>();
  return { ...actual, signMessage: vi.fn(actual.signMessage) };
});

// Public test vectors only; never use these keys with real funds.
const TEST_KEY = `0x${'0'.repeat(63)}1` as const;
const OTHER_KEY = `0x${'0'.repeat(63)}2` as const;
const ADDRESS: Address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const OTHER_ADDRESS: Address = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';

function setup() {
  const storage: OwnerKeyStorage = {
    readAddress: vi.fn(async () => ADDRESS),
    saveNewWallet: vi.fn(),
    readPrivateKeyForSigning: vi.fn(async () => TEST_KEY),
  };
  return { storage, wallet: createOwnerWallet({ storage }) };
}

describe('owner messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not unlock an already cancelled attempt', async () => {
    const { wallet, storage } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      wallet.signMessage('Test', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
    expect(viemSignMessage).not.toHaveBeenCalled();
  });

  it('does not sign when navigation or background cancels during authentication', async () => {
    const { wallet, storage } = setup();
    const controller = new AbortController();
    vi.mocked(storage.readPrivateKeyForSigning).mockImplementationOnce(
      async () => {
        controller.abort();
        return TEST_KEY;
      },
    );
    await expect(
      wallet.signMessage('Test', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
    expect(viemSignMessage).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after owner metadata is read again', async () => {
    const { wallet, storage } = setup();
    const controller = new AbortController();
    vi.mocked(storage.readAddress)
      .mockResolvedValueOnce(ADDRESS)
      .mockImplementationOnce(async () => {
        controller.abort();
        return ADDRESS;
      });
    await expect(
      wallet.signMessage('Test', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
    expect(viemSignMessage).not.toHaveBeenCalled();
  });

  it('does not return a result cancelled while the signer was completing', async () => {
    const { wallet } = setup();
    const controller = new AbortController();
    vi.mocked(viemSignMessage).mockImplementationOnce(async () => {
      controller.abort();
      return `0x${'0'.repeat(130)}`;
    });
    await expect(
      wallet.signMessage('Test', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
  });

  it('signs and verifies the exact UTF-8 message through the public API', async () => {
    const { wallet, storage } = setup();
    const message = 'Swissquote test: café 🏦';
    const signed = await wallet.signMessage(message);
    expect(signed.address).toBe(ADDRESS);
    expect(Object.keys(signed).sort()).toEqual(['address', 'signature']);
    expect(await wallet.verifyMessage({ ...signed, message })).toBe(true);
    expect(
      await wallet.verifyMessage({ ...signed, message: `${message}!` }),
    ).toBe(false);
    expect(
      await wallet.verifyMessage({
        ...signed,
        message,
        address: OTHER_ADDRESS,
      }),
    ).toBe(false);
    expect(storage.readPrivateKeyForSigning).toHaveBeenCalledTimes(1);
    expect(storage.saveNewWallet).not.toHaveBeenCalled();
  });

  it('requires a fresh protected read on each signing attempt', async () => {
    const { wallet, storage } = setup();
    await wallet.signMessage('First');
    vi.mocked(storage.readPrivateKeyForSigning).mockRejectedValueOnce(
      new WalletError('AUTH_CANCELLED', 'Cancelled.'),
    );
    await expect(wallet.signMessage('Second')).rejects.toMatchObject({
      code: 'AUTH_CANCELLED',
    });
    expect(storage.readPrivateKeyForSigning).toHaveBeenCalledTimes(2);
    expect(viemSignMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['AUTH_CANCELLED', 'AUTH_UNAVAILABLE', 'KEY_UNAVAILABLE'] as const)(
    'does not sign when protected storage rejects with %s',
    async (code) => {
      const { wallet, storage } = setup();
      vi.mocked(storage.readPrivateKeyForSigning).mockRejectedValueOnce(
        new WalletError(code, 'Access refused.'),
      );
      await expect(wallet.signMessage('Confirmed test')).rejects.toMatchObject({
        code,
      });
      expect(viemSignMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['', '  ', 'a'.repeat(4097), '🏦'.repeat(1025)])(
    'rejects invalid messages before unlocking',
    async (message) => {
      const { wallet, storage } = setup();
      await expect(wallet.signMessage(message)).rejects.toMatchObject({
        code: 'INVALID_MESSAGE',
      });
      expect(storage.readAddress).not.toHaveBeenCalled();
      expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
      expect(viemSignMessage).not.toHaveBeenCalled();
    },
  );

  it('accepts the 4096 UTF-8 byte boundary', async () => {
    const { wallet } = setup();
    const message = '🏦'.repeat(1024);
    const signed = await wallet.signMessage(message);
    expect(await wallet.verifyMessage({ ...signed, message })).toBe(true);
  });

  it('refuses missing wallets before requesting protected storage', async () => {
    const { wallet, storage } = setup();
    vi.mocked(storage.readAddress).mockResolvedValue(null);
    await expect(wallet.signMessage('Test')).rejects.toMatchObject({
      code: 'WALLET_NOT_FOUND',
    });
    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
  });

  it.each([OTHER_KEY, `0x${'0'.repeat(64)}`, '0x1234', null])(
    'rejects unavailable, invalid or mismatched keys',
    async (key) => {
      const { wallet, storage } = setup();
      vi.mocked(storage.readPrivateKeyForSigning).mockResolvedValue(
        key as typeof TEST_KEY,
      );
      await expect(wallet.signMessage('Test')).rejects.toMatchObject({
        code: 'KEY_UNAVAILABLE',
      });
      expect(viemSignMessage).not.toHaveBeenCalled();
    },
  );

  it('refuses an owner change during authentication', async () => {
    const { wallet, storage } = setup();
    vi.mocked(storage.readAddress)
      .mockResolvedValueOnce(ADDRESS)
      .mockResolvedValueOnce(OTHER_ADDRESS);
    await expect(wallet.signMessage('Test')).rejects.toMatchObject({
      code: 'KEY_UNAVAILABLE',
    });
    expect(viemSignMessage).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected native storage errors', async () => {
    const { wallet, storage } = setup();
    vi.mocked(storage.readPrivateKeyForSigning).mockRejectedValueOnce(
      new Error(`Sensitive: ${TEST_KEY}`),
    );
    await expect(wallet.signMessage('Test')).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
      message: 'Owner wallet storage failed.',
    });
    expect(viemSignMessage).not.toHaveBeenCalled();
  });

  it('sanitizes signing library errors', async () => {
    const { wallet } = setup();
    vi.mocked(viemSignMessage).mockRejectedValueOnce(
      new Error(`Sensitive: ${TEST_KEY}`),
    );
    await expect(wallet.signMessage('Test')).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
      message: 'Owner message signing failed.',
    });
  });

  it('verifies without storage access and returns false for malformed inputs', async () => {
    const signed = await setup().wallet.signMessage('Public verification');
    const { wallet, storage } = setup();
    expect(
      await wallet.verifyMessage({ ...signed, message: 'Public verification' }),
    ).toBe(true);
    expect(await wallet.verifyMessage({ ...signed, message: '' })).toBe(false);
    expect(
      await wallet.verifyMessage({
        ...signed,
        message: 'Test',
        address: '0x1234',
      }),
    ).toBe(false);
    expect(
      await wallet.verifyMessage({
        ...signed,
        message: 'Test',
        signature: '0x1234',
      }),
    ).toBe(false);
    expect(
      await wallet.verifyMessage({
        ...signed,
        message: 'Test',
        signature: `0x${'0'.repeat(130)}`,
      }),
    ).toBe(false);
    expect(storage.readAddress).not.toHaveBeenCalled();
    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
  });
});
