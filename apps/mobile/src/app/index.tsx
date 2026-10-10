import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { describeWalletError, getAddress } from '../lib/wallet';
import { isWalletLinkComplete } from '../lib/walletlink';

export default function Startup() {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    getAddress()
      .then(async (address) => {
        if (!address) return '/create-wallet' as const;
        // Onboarding is complete only once the new wallet is linked.
        return (await isWalletLinkComplete())
          ? ('/wallet' as const)
          : ('/link-wallet' as const);
      })
      .then((route) => {
        if (active) router.replace(route);
      })
      .catch((e: unknown) => {
        if (!active) return;
        // Never go to create-wallet here: a key may exist but be unreadable.
        setError(describeWalletError(e));
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <View className="flex-1 items-center justify-center bg-canvas p-6 gap-4">
      {error === null ? (
        <ActivityIndicator />
      ) : (
        <>
          <Text className="text-xl font-semibold text-ink text-center">
            Could not read your wallet
          </Text>
          <Text className="text-base leading-6 text-muted text-center">
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
