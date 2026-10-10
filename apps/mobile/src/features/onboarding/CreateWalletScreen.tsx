import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { createWallet, describeWalletError } from '../../lib/wallet';

export default function CreateWalletScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      await createWallet();
      router.replace('/link-wallet');
    } catch (e) {
      setError(describeWalletError(e));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View className="py-8 gap-5">
        <Text className="text-accent text-sm font-bold tracking-widest">
          SWISSQUOTE
        </Text>
        <Text className="text-4xl font-bold text-ink">
          Your keys.{'\n'}Your crypto.
        </Text>
        <Text className="text-lg text-muted">
          Create your wallet on this phone to get started.
        </Text>
      </View>
      {error !== null && <Text className="text-base text-accent">{error}</Text>}
      <Button
        label={busy ? 'Creating…' : 'Create wallet'}
        onPress={() => {
          if (!busy) void onCreate();
        }}
      />
    </Screen>
  );
}
