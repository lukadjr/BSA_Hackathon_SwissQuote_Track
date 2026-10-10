import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOwnerWallet,
  type OwnerKeyStorage,
} from '@swissquote/wallet-core';
import { verifyMessage } from 'viem';

// Real wallet-core signing with in-memory storage instead of SecureStore.
const memory = vi.hoisted(() => ({
  address: null as string | null,
  key: null as string | null,
}));
const markWalletLinked = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../apps/mobile/src/lib/linkStatus', () => ({ markWalletLinked }));
vi.mock('../../apps/mobile/src/lib/wallet', async () => {
  const storage: OwnerKeyStorage = {
    readAddress: async () => memory.address as `0x${string}` | null,
    saveNewWallet: async ({ address, privateKey }) => {
      memory.address = address;
      memory.key = privateKey;
    },
    readPrivateKeyForSigning: async () => memory.key as `0x${string}`,
  };
  const wallet = createOwnerWallet({ storage });
  return {
    getAddress: wallet.getAddress,
    createWallet: wallet.createWallet,
    signMessage: wallet.signMessage,
    describeWalletError: () => 'wallet error',
  };
});

import { createWallet } from '../../apps/mobile/src/lib/wallet';
import { ApiError } from '../../apps/mobile/src/lib/api';
import {
  confirmWalletLink,
  describeLinkError,
  startWalletLink,
} from '../../apps/mobile/src/lib/walletlink';

const E2E_URL = process.env.LINK_E2E_API_BASE_URL;
const E2E_TOKEN = process.env.LINK_E2E_TOKEN;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(async () => {
  markWalletLinked.mockClear();
  memory.address = null;
  memory.key = null;
  await createWallet();
});

describe('wallet linking (mocked backend)', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://backend.test/');
    vi.stubEnv('EXPO_PUBLIC_DEMO_ACCESS_TOKEN', 'demo-token');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function challengeFor(owner: string) {
    return {
      challenge_id: 'c'.repeat(32),
      message: `Link\nOwner key: ${owner.toLowerCase()}`,
      owner_address: owner.toLowerCase(),
      expires_at: '2026-10-10T13:00:00Z',
    };
  }

  it('signs exactly the backend challenge and completes the link', async () => {
    const owner = memory.address!;
    fetchMock.mockResolvedValueOnce(json(200, challengeFor(owner)));
    const challenge = await startWalletLink();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://backend.test/wallets/link/challenge');
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer demo-token',
    );
    expect(JSON.parse(init!.body as string)).toEqual({ owner_address: owner });

    fetchMock.mockResolvedValueOnce(
      json(200, {
        owner_key_verified: true,
        data: { user_id: 'demo-user', owner_address: owner.toLowerCase() },
      }),
    );
    const result = await confirmWalletLink(challenge);
    expect(result).toEqual({
      userId: 'demo-user',
      ownerAddress: owner.toLowerCase(),
      ownerKeyVerified: true,
    });
    expect(markWalletLinked).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
    expect(sent.challenge_id).toBe('c'.repeat(32));
    expect(
      await verifyMessage({
        address: owner as `0x${string}`,
        message: challenge.message,
        signature: sent.signature,
      }),
    ).toBe(true);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      memory.key!.slice(2),
    );
  });

  it('refuses a challenge about another key without signing', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, challengeFor(`0x${'4'.repeat(40)}`)),
    );
    await expect(startWalletLink()).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not mark the wallet linked when the backend rejects the signature', async () => {
    const owner = memory.address!;
    fetchMock.mockResolvedValueOnce(json(200, challengeFor(owner)));
    const challenge = await startWalletLink();
    fetchMock.mockResolvedValueOnce(json(401, { detail: 'bad signature' }));
    await expect(confirmWalletLink(challenge)).rejects.toMatchObject({
      status: 401,
    });
    expect(markWalletLinked).not.toHaveBeenCalled();
  });

  it('maps backend failures to safe messages', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { detail: 'raw server text' }));
    const error = await startWalletLink().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect(describeLinkError(error)).not.toContain('raw server text');

    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    expect(
      describeLinkError(await startWalletLink().catch((e: unknown) => e)),
    ).toBe('Cannot reach the server.');
  });

  it('fails clearly when the backend is not configured', async () => {
    vi.stubEnv('EXPO_PUBLIC_DEMO_ACCESS_TOKEN', '');
    await expect(startWalletLink()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Run with a local backend: LINK_E2E_API_BASE_URL=http://127.0.0.1:8000 LINK_E2E_TOKEN=...
describe.runIf(E2E_URL && E2E_TOKEN)('wallet linking (local backend)', () => {
  beforeEach(() => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', E2E_URL!);
    vi.stubEnv('EXPO_PUBLIC_DEMO_ACCESS_TOKEN', E2E_TOKEN!);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('links the owner key end to end', async () => {
    const challenge = await startWalletLink();
    expect(challenge.message).toContain(memory.address!.toLowerCase());
    const result = await confirmWalletLink(challenge);
    expect(result.ownerKeyVerified).toBe(true);
    expect(result.ownerAddress).toBe(memory.address!.toLowerCase());
    // The challenge is single use.
    await expect(confirmWalletLink(challenge)).rejects.toMatchObject({
      status: 409,
    });
  });
});
