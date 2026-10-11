import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text } from 'react-native';
import {
  pauseOnboarding,
  type OnboardingRoute,
} from '../lib/onboardingNavigation';

/** Return to welcome while preserving the unfinished screen and its state. */
export function OnboardingBackButton({ route }: { route: OnboardingRoute }) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to welcome"
      hitSlop={12}
      disabled={busy}
      onPress={() => {
        if (busy) return;
        setBusy(true);
        void pauseOnboarding(route)
          .then(() => router.push('/welcome'))
          .catch((error: unknown) =>
            Alert.alert(
              'Could not return',
              error instanceof Error ? error.message : 'Please try again.',
            ),
          )
          .finally(() => setBusy(false));
      }}
    >
      <Text className="font-semibold text-brand">‹ Back</Text>
    </Pressable>
  );
}
