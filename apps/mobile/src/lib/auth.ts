import * as SecureStore from 'expo-secure-store';
import { WalletError } from '@swissquote/wallet-core';
import {
  ApiError,
  getClientIdentity,
  request,
  type ClientIdentity,
} from './api';

const SESSION_TOKEN_KEY = 'sq_session_token';
const SESSION_USER_KEY = 'sq_session_user';
// Account that owns this phone's wallet state. Survives a plain session end
// (expired token, "Return to welcome") and is removed with the owner key.
const WALLET_USER_KEY = 'sq_wallet_user';
// Owner key, interrupted key creation, recovery in progress.
const LOCAL_WALLET_KEYS = [
  'swissquote.owner.address',
  'swissquote.owner.creating',
  'swissquote.recovery.pending.v1',
];
const OPTIONS = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};
export interface UserSession {
  username: string;
  token: string;
}

export async function getSession(): Promise<UserSession | null> {
  try {
    const token = await SecureStore.getItemAsync(SESSION_TOKEN_KEY, OPTIONS);
    if (!token) return null;
    // Old builds shared one bank identity. Require a username session after migration.
    if (
      process.env.EXPO_PUBLIC_DEMO_USERNAME_LOGIN === 'true' &&
      token === process.env.EXPO_PUBLIC_DEMO_ACCESS_TOKEN?.trim()
    ) {
      await clearSession();
      return null;
    }
    const username = await SecureStore.getItemAsync(SESSION_USER_KEY, OPTIONS);
    if (!username) throw new Error('Incomplete session');
    return { username, token };
  } catch {
    throw new WalletError(
      'STORAGE_FAILED',
      'Could not read the demo login session.',
    );
  }
}
export async function getSessionToken() {
  return (await getSession())?.token ?? null;
}
export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY, OPTIONS);
    await SecureStore.deleteItemAsync(SESSION_USER_KEY, OPTIONS);
  } catch {
    throw new WalletError(
      'STORAGE_FAILED',
      'Could not clear the demo login session.',
    );
  }
}
export async function setSession(
  username: string,
  token: string,
): Promise<void> {
  if (!username.trim() || !token.trim())
    throw new Error('Incomplete demo login');
  try {
    await SecureStore.setItemAsync(SESSION_USER_KEY, username, OPTIONS);
    await SecureStore.setItemAsync(SESSION_TOKEN_KEY, token, OPTIONS);
  } catch {
    await clearSession();
    throw new WalletError(
      'STORAGE_FAILED',
      'Could not save the demo login session.',
    );
  }
}
async function hasLocalWallet(): Promise<boolean> {
  for (const key of LOCAL_WALLET_KEYS)
    if ((await SecureStore.getItemAsync(key, OPTIONS)) !== null) return true;
  return false;
}

/**
 * Another account must never open the wallet left on this phone: its key
 * would sign for a Safe that belongs to someone else. That account logs in
 * again (or logs out from its profile, which removes the key) first.
 */
async function assertPhoneAccount(username: string): Promise<void> {
  let owner: string | null;
  let local: boolean;
  try {
    owner = await SecureStore.getItemAsync(WALLET_USER_KEY, OPTIONS);
    local = owner !== null && owner !== username && (await hasLocalWallet());
  } catch {
    throw new WalletError('STORAGE_FAILED', 'Could not read this phone.');
  }
  if (local)
    throw new WalletError(
      'WALLET_ALREADY_EXISTS',
      `This phone holds the wallet of "${owner}". Log in as ${owner}, then log out from the profile before using another account.`,
    );
}
async function bindPhoneAccount(username: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(WALLET_USER_KEY, username, OPTIONS);
  } catch {
    await clearSession();
    throw new WalletError(
      'STORAGE_FAILED',
      'Could not save the demo login session.',
    );
  }
}
/** Called once the owner key and recovery progress are gone from this phone. */
export async function clearPhoneAccount(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(WALLET_USER_KEY, OPTIONS);
  } catch {
    throw new WalletError('STORAGE_FAILED', 'Could not clear the account.');
  }
}

/**
 * DEMO ONLY: accepts any username and any password; the password is never
 * checked, sent or stored. Username demo login creates or resumes a bank
 * identity and stores its server-issued session token. Replace with real bank
 * authentication before any non-demo build.
 */
export const DEMO_DEFAULT_USERNAME = 'demo-user';

export async function loginToDemo(username: string, _password: string) {
  const name = username.trim().toLowerCase() || DEMO_DEFAULT_USERNAME;
  await assertPhoneAccount(name);
  let token = process.env.EXPO_PUBLIC_DEMO_ACCESS_TOKEN?.trim();
  if (!token)
    throw new ApiError(
      'NOT_CONFIGURED',
      'Demo access token is not configured (EXPO_PUBLIC_DEMO_ACCESS_TOKEN).',
    );
  if (process.env.EXPO_PUBLIC_DEMO_USERNAME_LOGIN === 'true') {
    const session = await request<{ token: string; client_id: string }>(
      '/auth/demo/login',
      { username: name },
      undefined,
      'POST',
      token,
    );
    if (
      session.client_id !== name ||
      typeof session.token !== 'string' ||
      session.token.length < 32
    )
      throw new ApiError('SERVER', 'Unexpected demo login response.');
    token = session.token;
  }
  let profile: ClientIdentity | null = null;
  try {
    profile = await getClientIdentity(undefined, token);
  } catch (e) {
    // A token the backend refuses would break every later call: say so now.
    if (e instanceof ApiError && e.code === 'UNAUTHORIZED')
      throw new ApiError(
        'UNAUTHORIZED',
        'The backend refused the demo token. EXPO_PUBLIC_DEMO_ACCESS_TOKEN must equal the backend MOCK_ACCESS_TOKEN.',
        e.status,
      );
    if (e instanceof ApiError && e.code === 'NOT_CONFIGURED') throw e;
    // Backend offline: the self-custody wallet still works without it.
  }
  await setSession(name, token);
  await bindPhoneAccount(name);
  return { username: name, profile };
}
