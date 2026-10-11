vi.mock('../../apps/mobile/src/lib/auth', () => ({
  getSessionToken: async () => null,
}));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOwnerWallet,
  type OwnerKeyStorage,
} from '@swissquote/wallet-core';
import { verifyMessage } from 'viem';

const memory = vi.hoisted(() => ({
  address: null as string | null,
  key: null as string | null,
}));
const account = vi.hoisted(() => ({
  safeAddress: `0x${'1'.repeat(40)}`,
  deployed: true,
}));
const signSpy = vi.hoisted(() => vi.fn());
vi.mock('../../apps/mobile/src/lib/safeWallet', () => ({
  getSafeAccount: async () => ({ ...account, ownerAddress: memory.address }),
}));
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
  signSpy.mockImplementation(wallet.signMessage);
  return {
    getAddress: wallet.getAddress,
    createWallet: wallet.createWallet,
    signMessage: signSpy,
    describeWalletError: () => 'wallet error',
  };
});

import { createWallet } from '../../apps/mobile/src/lib/wallet';
import {
  ApiError,
  getClientIdentity,
  getLinkStatus,
  authorizeBankTransfer,
} from '../../apps/mobile/src/lib/api';
import {
  confirmWalletLink,
  describeLinkError,
  startWalletLink,
  validateLinkChallenge,
} from '../../apps/mobile/src/lib/walletlink';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();
let kyc: string;
let changeChallenge: (c: ReturnType<typeof serverChallenge>) => void;
let changeResult: (r: ReturnType<typeof serverResult>) => void;
let failPath: string | null;
let failCode: number;
function serverChallenge() {
  const expires = new Date(Date.now() + 300_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const c = {
    challenge_id: 'c'.repeat(32),
    owner_address: memory.address!.toLowerCase(),
    safe_address: account.safeAddress,
    chain_id: 11155111,
    user_id: 'demo-user',
    domain: 'swissquote-wallet.demo',
    expires_at: expires,
    message: '',
  };
  c.message = [
    'Swissquote Wallet: link this Safe to your demo bank account.',
    `Domain: ${c.domain}`,
    'Purpose: link-safe',
    `Account: ${c.user_id}`,
    `Safe: ${c.safe_address}`,
    `Owner key: ${c.owner_address}`,
    `Chain ID: ${c.chain_id}`,
    `Nonce: ${c.challenge_id}`,
    `Expires: ${c.expires_at}`,
    'This moves no funds. Bank identity checks are simulated.',
  ].join('\n');
  return c;
}
function serverResult() {
  return {
    owner_key_verified: true,
    ownership_verified: true,
    data: {
      user_id: 'demo-user',
      owner_address: memory.address!.toLowerCase(),
      safe_address: account.safeAddress,
      chain_id: 11155111,
    },
  };
}

beforeEach(async () => {
  memory.address = memory.key = null;
  account.deployed = true;
  account.safeAddress = `0x${'1'.repeat(40)}`;
  kyc = 'verified';
  changeChallenge = () => {};
  changeResult = () => {};
  failPath = null;
  failCode = 401;
  await createWallet();
  signSpy.mockClear();
  vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://backend.test/');
  vi.stubEnv('EXPO_PUBLIC_DEMO_ACCESS_TOKEN', 'demo-token');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === failPath)
      return json(failCode, { detail: 'private server details' });
    if (path === '/auth/me')
      return json(200, {
        client_id: 'demo-user',
        display_name: 'Alice',
        kyc_status: kyc,
        verified_at: null,
        mocked: true,
      });
    if (path === '/wallets/register')
      return json(200, { ownership_verified: false });
    if (path === '/wallets/link/challenge') {
      const c = serverChallenge();
      changeChallenge(c);
      return json(200, c);
    }
    if (path === '/wallets/link/complete') {
      const r = serverResult();
      changeResult(r);
      return json(200, r);
    }
    if (path === '/wallets/link/status')
      return json(200, {
        control_status: 'unlinked',
        bank_transfers_allowed: false,
      });
    if (path === '/bank/transfers/authorize')
      return json(200, {
        status: 'approved',
        mocked: true,
        funds_moved: false,
      });
    throw new Error(`Unexpected request ${path}`);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Safe identity linking with real local signatures', () => {
  it('registers the Safe, signs canonical text and validates the full result', async () => {
    const c = await startWalletLink();
    const result = await confirmWalletLink(c);
    expect(result.ownershipVerified).toBe(true);
    expect(result.safeAddress).toBe(account.safeAddress);
    const registration = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/wallets/register'),
    )!;
    expect(JSON.parse(registration[1]!.body as string)).toEqual({
      user_id: 'demo-user',
      safe_address: account.safeAddress,
      owner_address: memory.address,
    });
    const challengeRequest = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/challenge'),
    )!;
    expect(JSON.parse(challengeRequest[1]!.body as string)).toEqual({
      safe_address: account.safeAddress,
      owner_address: memory.address,
      chain_id: 11155111,
    });
    const complete = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/complete'),
    )!;
    const signed = JSON.parse(complete[1]!.body as string);
    expect(
      await verifyMessage({
        address: memory.address as `0x${string}`,
        message: c.message,
        signature: signed.signature,
      }),
    ).toBe(true);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      memory.key!.slice(2),
    );
  });

  it.each(['pending', 'rejected'])(
    'refuses %s identity without signing',
    async (state) => {
      kyc = state;
      await expect(startWalletLink()).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(signSpy).not.toHaveBeenCalled();
    },
  );

  it('does not issue a challenge for a predicted undeployed Safe', async () => {
    account.deployed = false;
    await expect(startWalletLink()).rejects.toThrow('not deployed yet');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'owner_address',
    'safe_address',
    'user_id',
    'chain_id',
    'domain',
    'challenge_id',
    'expires_at',
    'message',
  ])('rejects altered %s before signing', async (field) => {
    changeChallenge = (c) => {
      switch (field) {
        case 'owner_address':
          c.owner_address = `0x${'4'.repeat(40)}`;
          break;
        case 'safe_address':
          c.safe_address = `0x${'4'.repeat(40)}`;
          break;
        case 'user_id':
          c.user_id = 'mallory';
          break;
        case 'chain_id':
          c.chain_id = 1;
          break;
        case 'domain':
          c.domain = 'attacker.test';
          break;
        case 'challenge_id':
          c.challenge_id = 'short';
          break;
        case 'expires_at':
          c.expires_at = '2000-01-01T00:00:00Z';
          break;
        case 'message':
          c.message += '\nApprove a transfer';
          break;
      }
    };
    await expect(startWalletLink()).rejects.toBeInstanceOf(ApiError);
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('rejects expired and far-future challenges at confirmation', async () => {
    const c = await startWalletLink();
    for (const expiresAt of [
      'bad-date',
      new Date(Date.now() + 600_000).toISOString(),
      '2000-01-01T00:00:00Z',
    ]) {
      expect(() =>
        validateLinkChallenge(
          { ...c, expiresAt },
          c.userId,
          c.safeAddress,
          c.ownerAddress,
        ),
      ).toThrow();
    }
    c.expiresAt = '2000-01-01T00:00:00Z';
    await expect(confirmWalletLink(c)).rejects.toBeInstanceOf(ApiError);
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('refuses owner or Safe changes before signing', async () => {
    const c = await startWalletLink();
    account.safeAddress = `0x${'2'.repeat(40)}`;
    await expect(confirmWalletLink(c)).rejects.toBeInstanceOf(ApiError);
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('rechecks identity before signing', async () => {
    const c = await startWalletLink();
    kyc = 'rejected';
    await expect(confirmWalletLink(c)).rejects.toBeInstanceOf(ApiError);
    expect(signSpy).not.toHaveBeenCalled();
  });

  it.each(['proof', 'safe', 'owner', 'user', 'chain'])(
    'rejects a mismatched completion %s',
    async (field) => {
      const c = await startWalletLink();
      changeResult = (r) => {
        if (field === 'proof') r.ownership_verified = false;
        if (field === 'safe') r.data.safe_address = `0x${'3'.repeat(40)}`;
        if (field === 'owner') r.data.owner_address = `0x${'3'.repeat(40)}`;
        if (field === 'user') r.data.user_id = 'mallory';
        if (field === 'chain') r.data.chain_id = 1;
      };
      await expect(confirmWalletLink(c)).rejects.toBeInstanceOf(ApiError);
    },
  );

  it('fails closed when completion is rejected', async () => {
    const c = await startWalletLink();
    failPath = '/wallets/link/complete';
    await expect(confirmWalletLink(c)).rejects.toMatchObject({ status: 401 });
  });

  it('cannot reuse an expired challenge after slow biometric approval', async () => {
    const c = await startWalletLink();
    const original = signSpy.getMockImplementation()!;
    signSpy.mockImplementationOnce(async (...args) => {
      const signed = await original(...args);
      c.expiresAt = '2000-01-01T00:00:00Z';
      return signed;
    });
    await expect(confirmWalletLink(c)).rejects.toBeInstanceOf(ApiError);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/complete')),
    ).toBe(false);
  });
});

describe('API boundaries', () => {
  it('authenticates GET requests and retrieves server status without a local flag', async () => {
    await getClientIdentity();
    await getLinkStatus();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer demo-token',
      );
    }
  });
  it('sends mock bank direction, Safe, chain and decimal amount', async () => {
    const response = await authorizeBankTransfer(
      account.safeAddress as `0x${string}`,
      'wallet_to_bank',
      '10000.000001',
    );
    expect(response.funds_moved).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      safe_address: account.safeAddress,
      chain_id: 11155111,
      direction: 'wallet_to_bank',
      amount: '10000.000001',
    });
  });
  it('fails clearly when credentials are missing', async () => {
    vi.stubEnv('EXPO_PUBLIC_DEMO_ACCESS_TOKEN', '');
    await expect(startWalletLink()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 409, 410, 422, 503])(
    'sanitizes HTTP %i errors',
    async (status) => {
      failPath = '/auth/me';
      failCode = status;
      const e = await startWalletLink().catch((e) => e);
      expect(e).toBeInstanceOf(ApiError);
      expect(describeLinkError(e)).not.toContain('private server details');
    },
  );
  it('sanitizes network and malformed response errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('provider secret'));
    await expect(startWalletLink()).rejects.toThrow('Cannot reach');
    fetchMock.mockResolvedValueOnce(
      new Response('invalid json', { status: 200 }),
    );
    await expect(startWalletLink()).rejects.toThrow(
      'Unexpected server response',
    );
  });
  it('times out without a hanging request', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      async (_, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const result = getClientIdentity().catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toMatchObject({ code: 'TIMEOUT' });
  });
  it('does not sign when an operation is already cancelled', async () => {
    const c = await startWalletLink();
    const controller = new AbortController();
    controller.abort();
    // A real fetch rejects an already-aborted signal.
    fetchMock.mockImplementationOnce(async (_url, options) => {
      expect(options?.signal?.aborted).toBe(true);
      throw new Error('aborted');
    });
    await expect(
      confirmWalletLink(c, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(signSpy).not.toHaveBeenCalled();
  });
});
