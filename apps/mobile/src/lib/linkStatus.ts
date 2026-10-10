// Remembers that onboarding finished linking this phone's key to Swissquote.
// Public flag only; it holds no secret.
import * as SecureStore from 'expo-secure-store';

const LINKED_KEY = 'swissquote.owner.linked';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};

export async function isWalletLinked(): Promise<boolean> {
  return (await SecureStore.getItemAsync(LINKED_KEY, OPTIONS)) !== null;
}

export async function markWalletLinked(): Promise<void> {
  await SecureStore.setItemAsync(LINKED_KEY, '1', OPTIONS);
}

export async function clearWalletLinked(): Promise<void> {
  await SecureStore.deleteItemAsync(LINKED_KEY, OPTIONS);
}
