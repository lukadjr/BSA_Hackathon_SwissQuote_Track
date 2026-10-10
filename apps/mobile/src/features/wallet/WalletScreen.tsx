import { SEPOLIA } from '@swissquote/wallet-core';
import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { mockWallet } from './mock';

export default function WalletScreen() {
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
      <Button
        label="Security & recovery"
        secondary
        onPress={() => router.push('/recovery')}
      />
      <Text className="text-sm text-muted">
        No activity yet. This balance is sample data.
      </Text>
    </Screen>
  );
}
