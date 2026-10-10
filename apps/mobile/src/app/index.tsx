import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Wordmark } from '../components/ui';
import { getSessionToken } from '../lib/auth';
import { readPendingRecovery } from '../lib/recovery';
import { describeWalletError, getAddress } from '../lib/wallet';

/**
 * Entry router. First visit (no Swissquote session): welcome. Logged in:
 * a recovery in progress wins, then the wallet if this phone has a key,
 * otherwise the create-or-recover choice.
 */
export default function Startup() {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!(await getSessionToken())) return '/welcome' as const;
      if (await readPendingRecovery()) return '/recover' as const;
      if (!(await getAddress())) return '/start' as const;
      return '/home' as const;
    })()
      .then((route) => active && router.replace(route))
      .catch((e: unknown) => {
        // Never route to wallet creation here: a key may exist but be unreadable.
        if (active) setError(describeWalletError(e));
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <View className="flex-1 items-center justify-center gap-6 bg-canvas p-6">
      <Wordmark />
      {error === null ? (
        <ActivityIndicator />
      ) : (
        <>
          <Text className="text-center text-xl font-semibold text-ink">
            Could not read your wallet
          </Text>
          <Text className="text-center text-base leading-6 text-muted">
            {error}
          </Text>
          <View className="self-stretch">
            <Button
              label="Try again"
              onPress={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            />
          </View>
        </>
      )}
    </View>
  );
}
