// Remembers that onboarding finished linking this phone's owner key and Safe
// to Swissquote. Public data only; it holds no secret. The flag stores the
// linked pair, so a different key or Safe never counts as linked.
import * as SecureStore from 'expo-secure-store';

const LINKED_KEY = 'swissquote.link.v2';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};

function pair(owner: string, safe: string) {
  return `${owner.toLowerCase()}|${safe.toLowerCase()}`;
}

export async function isLinked(owner: string, safe: string): Promise<boolean> {
  return (
    (await SecureStore.getItemAsync(LINKED_KEY, OPTIONS)) === pair(owner, safe)
  );
}

export async function markWalletLinked(
  owner: string,
  safe: string,
): Promise<void> {
  await SecureStore.setItemAsync(LINKED_KEY, pair(owner, safe), OPTIONS);
}

export async function clearWalletLinked(): Promise<void> {
  await SecureStore.deleteItemAsync(LINKED_KEY, OPTIONS);
}
