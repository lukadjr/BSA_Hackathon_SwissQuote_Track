import { Text, View } from 'react-native';
import { Screen } from '../../components/Screen';

export default function RecoveryScreen() {
  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Recover together</Text>
      <Text className="text-base leading-6 text-muted">
        The planned recovery needs any two of Swissquote, Contact A and Contact
        B. Your contacts can help you recover without Swissquote.
      </Text>
      <View className="bg-white border border-line rounded-3xl p-6 gap-5">
        <Text className="font-semibold text-ink">
          1. Ask two guardians to approve
        </Text>
        <Text className="font-semibold text-ink">
          2. Wait through the 7-day challenge period
        </Text>
        <Text className="font-semibold text-ink">
          3. Restore access if the current owner has not cancelled
        </Text>
      </View>
      <Text className="text-sm leading-5 text-muted">
        Preview only. No contacts are configured and no recovery request is
        submitted.
      </Text>
    </Screen>
  );
}
