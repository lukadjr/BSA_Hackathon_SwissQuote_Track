import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';

vi.mock('viem/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem/accounts')>();
  return { ...actual, generatePrivateKey: vi.fn(actual.generatePrivateKey) };
});
import {
  createOwnerWallet,
  WalletError,
  type Address,
  type OwnerKeyStorage,
} from '../../packages/wallet-core';

// Public test vector only. Never use this key for a funded wallet.
const TEST_ADDRESS: Address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const TEST_KEY = `0x${'0'.repeat(63)}1` as const;

function setup() {
  let address: Address | null = null;
  const storage: OwnerKeyStorage = {
    readAddress: vi.fn(async () => address),
    saveNewWallet: vi.fn(async (input) => {
      if (address !== null)
        throw new WalletError('WALLET_ALREADY_EXISTS', 'Already exists.');
      address = input.address;
    }),
    readPrivateKeyForSigning: vi.fn(async () => {
      throw new Error('Creation must not unlock an existing key.');
    }),
  };
  const wallet = createOwnerWallet({ storage });
  return { storage, wallet, generateKey: vi.mocked(generatePrivateKey) };
}

describe('createWallet', () => {
  beforeEach(() => {
    vi.mocked(generatePrivateKey).mockReset().mockReturnValue(TEST_KEY);
  });
  it('creates distinct wallets using the real viem generator', async () => {
    const actual =
      await vi.importActual<typeof import('viem/accounts')>('viem/accounts');
    vi.mocked(generatePrivateKey).mockImplementation(actual.generatePrivateKey);
    const first = setup();
    const second = setup();
    const a = await first.wallet.createWallet();
    const b = await second.wallet.createWallet();
    expect(a.address).not.toBe(b.address);
    expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const saved = vi.mocked(first.storage.saveNewWallet).mock.calls[0][0];
    expect(actual.privateKeyToAddress(saved.privateKey)).toBe(a.address);
    expect(Object.keys(a)).toEqual(['address']);
  });
  it('derives the known Ethereum address, persists the key, and returns public data only', async () => {
    const { wallet, storage, generateKey } = setup();
    expect(await wallet.getAddress()).toBeNull();
    expect(generateKey).not.toHaveBeenCalled();
    expect(await wallet.createWallet()).toEqual({ address: TEST_ADDRESS });
    expect(storage.saveNewWallet).toHaveBeenCalledWith({
      address: TEST_ADDRESS,
      privateKey: TEST_KEY,
    });
    expect(storage.readPrivateKeyForSigning).not.toHaveBeenCalled();
    const reopened = createOwnerWallet({ storage });
    expect(await reopened.getAddress()).toBe(TEST_ADDRESS);
    await expect(reopened.createWallet()).rejects.toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
    });
    expect(generateKey).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent creation across instances using the same adapter', async () => {
    const { wallet, storage, generateKey } = setup();
    const other = createOwnerWallet({ storage });
    const results = await Promise.allSettled([
      wallet.createWallet(),
      other.createWallet(),
    ]);
    expect(results[0]).toEqual({
      status: 'fulfilled',
      value: { address: TEST_ADDRESS },
    });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'WALLET_ALREADY_EXISTS' },
    });
    expect(storage.saveNewWallet).toHaveBeenCalledTimes(1);
    expect(generateKey).toHaveBeenCalledTimes(1);
  });

  it('fails safely when viem generation fails and permits retry after failure', async () => {
    const { wallet, generateKey } = setup();
    generateKey.mockImplementationOnce(() => {
      throw new Error('Sensitive provider detail');
    });
    await expect(wallet.createWallet()).rejects.toMatchObject({
      code: 'KEY_GENERATION_FAILED',
      message: 'Secure owner key generation failed.',
    });
    await expect(wallet.createWallet()).resolves.toEqual({
      address: TEST_ADDRESS,
    });
  });

  it('does not generate a key when metadata cannot be read', async () => {
    const { wallet, storage, generateKey } = setup();
    vi.mocked(storage.readAddress).mockRejectedValueOnce(
      new Error('Native detail'),
    );
    await expect(wallet.createWallet()).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
    expect(generateKey).not.toHaveBeenCalled();
  });

  it('sanitizes public metadata read failures and preserves typed adapter errors', async () => {
    const { wallet, storage } = setup();
    vi.mocked(storage.readAddress)
      .mockRejectedValueOnce(new Error(`Secret: ${TEST_KEY}`))
      .mockRejectedValueOnce(
        new WalletError('KEY_UNAVAILABLE', 'Unavailable.'),
      );
    await expect(wallet.getAddress()).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
      message: 'Owner wallet storage failed.',
    });
    await expect(wallet.getAddress()).rejects.toMatchObject({
      code: 'KEY_UNAVAILABLE',
      message: 'Unavailable.',
    });
  });

  it('does not report success or expose raw errors when persistence fails', async () => {
    const { wallet, storage } = setup();
    vi.mocked(storage.saveNewWallet).mockRejectedValueOnce(
      new Error(`Secret: ${TEST_KEY}`),
    );
    await expect(wallet.createWallet()).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
      message: 'Owner wallet storage failed.',
    });
    await expect(wallet.getAddress()).resolves.toBeNull();
    await expect(wallet.createWallet()).resolves.toEqual({
      address: TEST_ADDRESS,
    });
  });

  it('preserves adapter cancellation and no-overwrite errors even with absent metadata', async () => {
    const { wallet, storage } = setup();
    vi.mocked(storage.saveNewWallet)
      .mockRejectedValueOnce(new WalletError('AUTH_CANCELLED', 'Cancelled.'))
      .mockRejectedValueOnce(
        new WalletError('WALLET_ALREADY_EXISTS', 'Existing secret.'),
      );
    await expect(wallet.createWallet()).rejects.toMatchObject({
      code: 'AUTH_CANCELLED',
    });
    await expect(wallet.createWallet()).rejects.toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
    });
  });

  it('does not resolve until persistence completes', async () => {
    const { wallet, storage } = setup();
    let completeWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    vi.mocked(storage.saveNewWallet).mockImplementation(async () => {
      writeStarted();
      await new Promise<void>((resolve) => {
        completeWrite = resolve;
      });
    });
    let returned = false;
    const creation = wallet.createWallet().then((result) => {
      returned = true;
      return result;
    });
    await started;
    expect(returned).toBe(false);
    completeWrite();
    await expect(creation).resolves.toEqual({ address: TEST_ADDRESS });
  });
});
