import * as SecureStore from 'expo-secure-store';

const SESSION_TOKEN_KEY = 'sq_session_token';
const SESSION_USER_KEY = 'sq_session_user';

export interface UserSession {
  username: string;
  token: string;
}

export async function getSession(): Promise<UserSession | null> {
  try {
    const token = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
    const username = await SecureStore.getItemAsync(SESSION_USER_KEY);
    if (!token) return null;
    return { username: username || 'User', token };
  } catch {
    return null;
  }
}

export async function getSessionToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setSession(username: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_USER_KEY, username);
  await SecureStore.setItemAsync(SESSION_TOKEN_KEY, token);
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
  await SecureStore.deleteItemAsync(SESSION_USER_KEY);
}
