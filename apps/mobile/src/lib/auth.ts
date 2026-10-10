import * as SecureStore from 'expo-secure-store';
import { WalletError } from '@swissquote/wallet-core';
import { ApiError, getClientIdentity, type ClientIdentity } from './api';

const SESSION_TOKEN_KEY = 'sq_session_token';
const SESSION_USER_KEY = 'sq_session_user';
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
/**
 * DEMO ONLY: accepts any username and any password; the password is never
 * checked, sent or stored. The backend knows a single mock client and every
 * demo login maps to it through the bundled demo token. Replace with real bank
 * authentication before any non-demo build.
 */
export const DEMO_DEFAULT_USERNAME = 'demo-user';

export async function loginToDemo(username: string, _password: string) {
  const token = process.env.EXPO_PUBLIC_DEMO_ACCESS_TOKEN?.trim();
  if (!token)
    throw new ApiError(
      'NOT_CONFIGURED',
      'Demo access token is not configured (EXPO_PUBLIC_DEMO_ACCESS_TOKEN).',
    );
  let profile: ClientIdentity | null = null;
  try {
    profile = await getClientIdentity();
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
  const name = username.trim() || DEMO_DEFAULT_USERNAME;
  await setSession(name, token);
  return { username: name, profile };
}
