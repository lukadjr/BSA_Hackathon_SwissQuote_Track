import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';

export default function WelcomeScreen() {
  return (
    <Screen>
      <View className="py-8 gap-5">
        <Text className="text-accent text-sm font-bold tracking-widest">
          SWISSQUOTE
        </Text>
        <Text className="text-4xl font-bold text-ink">
          Your keys.{'\n'}Your crypto.
        </Text>
        <Text className="text-lg text-muted">Swissquote by your side.</Text>
      </View>
      <View className="bg-white border border-line rounded-3xl p-6 gap-3">
        <Text className="text-xl font-semibold text-ink">
          A simple place to start
        </Text>
        <Text className="text-base leading-6 text-muted">
          Explore a sample wallet and the first screens of your mobile app. All
          balances are fictional. No wallet or keys are created.
        </Text>
      </View>
      <Button label="Open demo wallet" onPress={() => router.push('/wallet')} />
      <Button
        label="Explore recovery"
        secondary
        onPress={() => router.push('/recovery')}
      />
    </Screen>
  );
}
