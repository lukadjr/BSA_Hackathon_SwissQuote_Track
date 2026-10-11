import { router } from 'expo-router';
import { Alert, Pressable, Text } from 'react-native';
import { clearSession } from '../lib/auth';
import { describeWalletError } from '../lib/wallet';
import { logoutWallet } from '../lib/walletSession';

/** Leaving recovery never cancels the on-chain request or loses its new key. */
export function RecoveryExitButton() {
  function exit(reset: boolean) {
    void (reset ? logoutWallet() : clearSession())
      .then(() => {
        if (router.canDismiss()) router.dismissAll();
        router.replace('/welcome');
      })
      .catch((error: unknown) =>
        Alert.alert('Could not leave recovery', describeWalletError(error)),
      );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Leave recovery"
      hitSlop={12}
      onPress={() =>
        Alert.alert(
          'Leave recovery?',
          'Return to welcome keeps this phone’s key and recovery progress. Start over removes the owner key and local progress from this phone. It does not cancel a recovery already started on-chain; you may need your guardians to recover again.',
          [
            { text: 'Stay here', style: 'cancel' },
            { text: 'Return to welcome', onPress: () => exit(false) },
            {
              text: 'Start over on this phone',
              style: 'destructive',
              onPress: () => exit(true),
            },
          ],
        )
      }
    >
      <Text className="font-semibold text-brand">Close</Text>
    </Pressable>
  );
}
