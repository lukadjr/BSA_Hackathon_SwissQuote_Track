// Legacy flag cleanup for development resets. Bank link status comes from the backend.
import * as SecureStore from 'expo-secure-store';

const LINKED_KEY = 'swissquote.owner.linked';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};

export async function clearWalletLinked(): Promise<void> {
  await SecureStore.deleteItemAsync(LINKED_KEY, OPTIONS);
}
