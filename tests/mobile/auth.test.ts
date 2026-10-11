import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 6,
}));
vi.mock('expo-secure-store', () => store);
import {
  clearSession,
  getSession,
  loginToDemo,
  setSession,
} from '../../apps/mobile/src/lib/auth';

beforeEach(() => {
  vi.resetAllMocks();
  store.values.clear();
  vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://demo.test');
  vi.stubEnv('EXPO_PUBLIC_DEMO_ACCESS_TOKEN', 'disposable-demo-token');
  store.getItemAsync.mockImplementation(
    async (key) => store.values.get(key) ?? null,
  );
  store.setItemAsync.mockImplementation(async (key, value) => {
    store.values.set(key, value);
  });
  store.deleteItemAsync.mockImplementation(async (key) => {
    store.values.delete(key);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        client_id: 'demo-user',
        kyc_status: 'pending',
        mocked: true,
      }),
    }),
  );
});
describe('mock login integration', () => {
  it('accepts any username and password and never stores the password', async () => {
    const result = await loginToDemo('anyone', 'whatever');
    expect(result.username).toBe('anyone');
    expect(result.profile?.kyc_status).toBe('pending');
    expect(fetch).toHaveBeenCalledWith(
      'http://demo.test/auth/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer disposable-demo-token',
        }),
      }),
    );
    expect(await getSession()).toEqual({
      username: 'anyone',
      token: 'disposable-demo-token',
    });
    expect(store.values.size).toBe(2);
    expect([...store.values.values()]).not.toContain('whatever');
  });
  it('accepts an empty username and password', async () => {
    const result = await loginToDemo('  ', '');
    expect(result.username).toBe('demo-user');
    expect((await getSession())?.username).toBe('demo-user');
  });
  it('still logs in when the backend is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'));
    const result = await loginToDemo('demo-user', 'demo');
    expect(result.profile).toBeNull();
    expect(await getSession()).not.toBeNull();
  });
  it('does not manufacture a token when configuration is missing', async () => {
    vi.stubEnv('EXPO_PUBLIC_DEMO_ACCESS_TOKEN', '');
    await expect(loginToDemo('demo-user', 'demo')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.values.size).toBe(0);
  });
  it('reports a demo token the backend refuses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
    } as Response);
    await expect(loginToDemo('demo-user', 'demo')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(store.values.size).toBe(0);
  });
  it('logout preserves owner, recovery and pending transaction storage', async () => {
    store.values.set('swissquote.owner.privateKey', 'secret-test-placeholder');
    store.values.set('swissquote.recovery.pending.v1', 'public-recovery');
    store.values.set('swissquote.treasury.pending.v1', 'public-authorization');
    await setSession('demo-user', 'demo-token');
    await clearSession();
    expect(await getSession()).toBeNull();
    expect(store.values.size).toBe(3);
  });
  it('rolls back partial session writes', async () => {
    store.setItemAsync
      .mockImplementationOnce(async (key, value) => {
        store.values.set(key, value);
      })
      .mockRejectedValueOnce(new Error('disk'));
    await expect(setSession('demo-user', 'token')).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
    expect(await getSession()).toBeNull();
  });
  it('does not interpret a storage read failure as logged out', async () => {
    store.getItemAsync.mockRejectedValueOnce(new Error('locked keychain'));
    await expect(getSession()).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
  });
});

it('creates a username session and uses it for later API requests', async () => {
  vi.stubEnv('EXPO_PUBLIC_DEMO_USERNAME_LOGIN', 'true');
  const sessionToken = 'new-session-token-'.repeat(3);
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ token: sessionToken, client_id: 'alice' }),
  } as Response);
  await loginToDemo('Alice', 'demo');
  expect(fetch).toHaveBeenNthCalledWith(
    1,
    'http://demo.test/auth/demo/login',
    expect.objectContaining({ body: JSON.stringify({ username: 'alice' }) }),
  );
  expect((await getSession())?.token).toBe(sessionToken);
  const { getClientIdentity } = await import('../../apps/mobile/src/lib/api');
  await getClientIdentity();
  expect(fetch).toHaveBeenLastCalledWith(
    'http://demo.test/auth/me',
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: `Bearer ${sessionToken}`,
      }),
    }),
  );
  vi.unstubAllEnvs();
});

it('migrates an old shared-token login to welcome without touching wallet keys', async () => {
  await setSession('alice', 'disposable-demo-token');
  store.values.set('sq_owner_address', 'preserved-owner');
  vi.stubEnv('EXPO_PUBLIC_DEMO_USERNAME_LOGIN', 'true');
  expect(await getSession()).toBeNull();
  expect(store.values.get('sq_owner_address')).toBe('preserved-owner');
  vi.unstubAllEnvs();
});
