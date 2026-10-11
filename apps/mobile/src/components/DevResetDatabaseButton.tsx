import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text } from 'react-native';
import { request } from '../lib/api';
import { resetWallet } from '../lib/walletSession';

export function DevResetDatabaseButton() {
  const [busy, setBusy] = useState(false);
  if (!__DEV__) return null;
  async function reset() {
    if (busy) return;
    setBusy(true);
    try {
      await request(
        '/dev/reset-database',
        { confirmation: 'RESET DATABASE' },
        undefined,
        'POST',
        process.env.EXPO_PUBLIC_DEMO_ACCESS_TOKEN?.trim(),
      );
      await resetWallet();
      if (router.canDismiss()) router.dismissAll();
      router.replace('/welcome');
      Alert.alert(
        'Database reset',
        'All demo accounts and requests were cleared, along with all app data and keys on this phone. The treasury is preserved. Other phones must reset their own local data.',
      );
    } catch (error) {
      Alert.alert(
        'Reset unavailable',
        error instanceof Error
          ? error.message
          : 'Could not reset the database.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Reset database (dev only)"
      disabled={busy}
      hitSlop={12}
      onPress={() =>
        Alert.alert(
          'Reset database for everyone?',
          'Clears all demo accounts and requests on the server, plus all app data and owner and guardian keys on this phone. Other phones must reset their own local data. Blockchain wallets, the treasury and its signing journal remain. A server backup is saved first.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Reset this phone',
              style: 'destructive',
              onPress: () => {
                void resetWallet()
                  .then(() => {
                    if (router.canDismiss()) router.dismissAll();
                    router.replace('/welcome');
                  })
                  .catch(() =>
                    Alert.alert(
                      'Reset failed',
                      'Could not clear all phone data. Try again.',
                    ),
                  );
              },
            },
            {
              text: 'Reset database',
              style: 'destructive',
              onPress: () => void reset(),
            },
          ],
        )
      }
    >
      <Text className="font-semibold text-brand">
        {busy ? 'Resetting…' : 'Reset database'}
      </Text>
    </Pressable>
  );
}
