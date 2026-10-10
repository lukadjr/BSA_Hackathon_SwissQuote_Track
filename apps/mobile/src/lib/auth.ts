import * as SecureStore from 'expo-secure-store';
import { WalletError } from '@swissquote/wallet-core';
import { getClientIdentity } from './api';

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
/** UI-only demo session; bank identity and KYC remain controlled by the backend. */
export async function loginToDemo(username: string, password: string) {
  if (!username.trim() || !password)
    throw new Error('Enter a demo client ID and password.');
  const profile = await getClientIdentity();
  if (profile.client_id !== username.trim())
    throw new Error('Use the client ID configured by the demo operator.');
  const token = process.env.EXPO_PUBLIC_DEMO_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Demo access token is not configured.');
  await setSession(profile.client_id, token);
  return profile;
}
