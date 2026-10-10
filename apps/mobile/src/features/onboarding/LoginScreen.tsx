import { router } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { setSession } from '../../lib/auth';
import { describeWalletError, getAddress } from '../../lib/wallet';
import { isWalletLinkComplete } from '../../lib/walletlink';

export default function LoginScreen() {
  const [username, setUsername] = useState('demo-user');
  const [password, setPassword] = useState('••••••••');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLogin() {
    if (!username.trim() || !password) {
      setError('Please enter your Swissquote username and password');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      // Mock network verification delay
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Use server token if configured or fallback to mock token
      const token =
        process.env.EXPO_PUBLIC_DEMO_ACCESS_TOKEN?.trim() ||
        `sq_mock_token_${Date.now()}`;
      await setSession(username.trim(), token);

      // Check wallet state to navigate to the appropriate step
      const address = await getAddress();
      if (!address) {
        router.replace('/create-wallet');
      } else {
        const linked = await isWalletLinkComplete();
        router.replace(linked ? '/wallet' : '/link-wallet');
      }
    } catch (e) {
      setError(describeWalletError(e));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View className="py-6 gap-3">
        <Text className="text-accent text-sm font-bold tracking-widest">
          SWISSQUOTE
        </Text>
        <Text className="text-3xl font-bold text-ink">
          Log in to your account
        </Text>
        <Text className="text-base text-muted">
          Connect your Swissquote account to prepare and link your self-custodial
          wallet.
        </Text>
      </View>

      <View className="bg-white border border-line rounded-3xl p-6 gap-4 mb-4">
        <View className="gap-1">
          <Text className="text-xs font-semibold text-muted uppercase">
            Username / Client ID
          </Text>
          <TextInput
            className="border border-line rounded-xl px-4 py-3 text-ink text-base bg-canvas"
            placeholder="e.g. demo-user"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View className="gap-1">
          <Text className="text-xs font-semibold text-muted uppercase">
            Password
          </Text>
          <TextInput
            className="border border-line rounded-xl px-4 py-3 text-ink text-base bg-canvas"
            placeholder="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
        </View>
      </View>

      {error !== null && (
        <Text className="text-base text-accent mb-4">{error}</Text>
      )}

      <Button
        label={busy ? 'Connecting…' : 'Log in'}
        onPress={() => {
          if (!busy) void onLogin();
        }}
      />
    </Screen>
  );
}
