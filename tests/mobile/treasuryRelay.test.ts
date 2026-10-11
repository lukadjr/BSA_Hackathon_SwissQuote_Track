import { beforeEach, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
}));
vi.mock('expo-secure-store', () => store);
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-crypto', () => ({ getRandomValues: vi.fn() }));

import { hashTypedData } from 'viem';
import {
  safeTransactionTypedData,
  type SafeRelayRequest,
} from '@swissquote/wallet-core';
import { treasuryRelay } from '../../apps/mobile/src/lib/treasuryRelay';
import { transferActivity } from '../../apps/mobile/src/lib/safeWallet';

const safe = `0x${'5'.repeat(40)}` as const;
const request: SafeRelayRequest = {
  chain_id: 11155111,
  safe_address: safe,
  owner_address: `0x${'1'.repeat(40)}`,
  kind: 'transfer',
  transaction: {
    to: `0x${'7'.repeat(40)}`,
    value: '0',
    data: '0x',
    operation: 0,
    nonce: '3',
  },
  signature: `0x${'a'.repeat(130)}`,
};
const hash = hashTypedData(safeTransactionTypedData(safe, request.transaction));

function respond(status: number) {
  vi.mocked(fetch).mockResolvedValue({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ detail: 'Invalid Safe transaction' }),
  } as unknown as Response);
}

beforeEach(async () => {
  vi.resetAllMocks();
  store.values.clear();
  vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://demo.test');
  vi.stubEnv('EXPO_PUBLIC_DEMO_ACCESS_TOKEN', 'disposable-demo-token');
  store.getItemAsync.mockImplementation(
    async (key: string) => store.values.get(key) ?? null,
  );
  store.setItemAsync.mockImplementation(async (key: string, value: string) => {
    store.values.set(key, value);
  });
  store.deleteItemAsync.mockImplementation(async (key: string) => {
    store.values.delete(key);
  });
  vi.stubGlobal('fetch', vi.fn());
  await treasuryRelay.writePending(request);
  await transferActivity.writePending({
    ownerAddress: request.owner_address,
    safeAddress: safe,
    tokenAddress: `0x${'7'.repeat(40)}`,
    recipient: `0x${'8'.repeat(40)}`,
    amountUnits: '1',
    decimals: 6,
    nonce: '3',
    validUntil: '0',
    userOperationHash: hash,
    execution: 'treasury',
  });
});

it('forgets an authorization the relay refused, so later operations are not blocked', async () => {
  respond(422);
  await expect(treasuryRelay.submit(request)).rejects.toMatchObject({
    status: 422,
  });
  expect(await treasuryRelay.readPending()).toBeNull();
  expect(await transferActivity.readPending()).toBeNull();
});

it.each([401, 429, 500, 503])(
  'keeps tracking after an ambiguous %i answer',
  async (status) => {
    respond(status);
    await expect(treasuryRelay.submit(request)).rejects.toBeTruthy();
    expect(await treasuryRelay.readPending()).not.toBeNull();
    expect(await transferActivity.readPending()).not.toBeNull();
  },
);

it('keeps tracking when the network fails', async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
  await expect(treasuryRelay.submit(request)).rejects.toMatchObject({
    code: 'NETWORK',
  });
  expect(await treasuryRelay.readPending()).not.toBeNull();
});

it('does not touch tracking of a different authorization', async () => {
  respond(409);
  await expect(
    treasuryRelay.submit({
      ...request,
      transaction: { ...request.transaction, nonce: '4' },
    }),
  ).rejects.toBeTruthy();
  expect(await treasuryRelay.readPending()).not.toBeNull();
  expect(await transferActivity.readPending()).not.toBeNull();
});
