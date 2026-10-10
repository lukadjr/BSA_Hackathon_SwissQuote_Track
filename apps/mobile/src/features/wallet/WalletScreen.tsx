import { SEPOLIA } from '@swissquote/wallet-core';
import { router } from 'expo-router';
import { Alert, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { useOwnerAddress } from '../../hooks/useOwnerAddress';
import { resetWalletForDev } from '../../lib/devReset';
import { describeWalletError } from '../../lib/wallet';
import { mockWallet } from './mock';

function confirmDevReset() {
  Alert.alert(
    'Reset wallet?',
    'Development only. This deletes the key on this phone for good. You will create and link a new wallet.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete key',
        style: 'destructive',
        onPress: () => {
          resetWalletForDev()
            .then(() => router.replace('/create-wallet'))
            .catch((e: unknown) =>
              Alert.alert('Reset failed', describeWalletError(e)),
            );
        },
      },
    ],
  );
}

export default function WalletScreen() {
  const { address, error } = useOwnerAddress();
  return (
    <Screen>
      <View className="rounded-3xl bg-ink p-6 gap-3">
        <Text className="text-white text-sm">Sample balance</Text>
        <Text className="text-white text-4xl font-bold">
          {mockWallet.balance}
        </Text>
        <Text className="text-white text-base">
          {mockWallet.token} · {SEPOLIA.name}
        </Text>
      </View>
      <Button label="Send" onPress={() => router.push('/send')} />
      <View className="bg-white border border-line rounded-3xl p-6 gap-3">
        <Text className="text-lg font-semibold text-ink">Receive</Text>
        <Text className="text-base leading-6 text-muted">
          No receiving address yet. Your wallet must be created and verified
          before you can receive test tokens.
        </Text>
      </View>
      <View className="bg-white border border-line rounded-3xl p-6 gap-3">
        <Text className="text-lg font-semibold text-ink">Owner address</Text>
        <Text selectable className="text-sm leading-5 text-muted">
          {error ?? address ?? (address === undefined ? 'Loading…' : 'None')}
        </Text>
        <Text className="text-xs text-muted">
          Public address of the signing key on this phone. Not the Safe address.
        </Text>
      </View>
      <Button
        label="Sign a test message"
        secondary
        onPress={() => router.push('/sign-test')}
      />
      <Button
        label="Security & recovery"
        secondary
        onPress={() => router.push('/recovery')}
      />
      {__DEV__ && (
        <Button
          label="Reset wallet (dev only)"
          secondary
          onPress={confirmDevReset}
        />
      )}
      <Text className="text-sm text-muted">
        No activity yet. This balance is sample data.
      </Text>
    </Screen>
  );
}
