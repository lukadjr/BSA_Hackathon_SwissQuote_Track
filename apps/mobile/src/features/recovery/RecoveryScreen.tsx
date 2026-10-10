import { Text, View } from 'react-native';
import { Screen } from '../../components/Screen';

export default function RecoveryScreen() {
  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Recover together</Text>
      <Text className="text-base leading-6 text-muted">
        The planned recovery requires Swissquote and one independent contact.
        Swissquote cannot recover your wallet alone.
      </Text>
      <View className="bg-white border border-line rounded-3xl p-6 gap-5">
        <Text className="font-semibold text-ink">
          1. Verify your identity with Swissquote
        </Text>
        <Text className="font-semibold text-ink">
          2. Get approval from Contact A or B
        </Text>
        <Text className="font-semibold text-ink">
          3. Wait, then restore access
        </Text>
      </View>
      <Text className="text-sm leading-5 text-muted">
        Preview only. No contacts are configured and no recovery request is
        submitted.
      </Text>
    </Screen>
  );
}
