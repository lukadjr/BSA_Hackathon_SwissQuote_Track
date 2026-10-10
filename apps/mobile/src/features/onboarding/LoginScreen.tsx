import { router } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { loginToDemo } from '../../lib/auth';
import { readPendingRecovery } from '../../lib/recovery';
import { describeWalletError, getAddress } from '../../lib/wallet';

export default function LoginScreen() {
  const [username, setUsername] = useState('demo-user');
  const [password, setPassword] = useState('');
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
      await loginToDemo(username.trim(), password);
      setPassword('');

      // Check wallet state to navigate to the appropriate step
      const address = await getAddress();
      if (await readPendingRecovery()) router.replace('/recover');
      else router.replace(address ? '/wallet' : '/create-wallet');
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
          Mock Swissquote login for this test build. Use the demo client ID and
          any non-empty demo password; no real banking password is checked.
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
            placeholder="Demo password (any non-empty value)"
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
        label="Open wallet without bank login"
        secondary
        disabled={busy}
        onPress={() => {
          getAddress()
            .then((address) => {
              if (!address)
                throw new Error(
                  'Create a wallet after demo login, or choose recovery.',
                );
              router.replace('/wallet');
            })
            .catch((e) => setError(describeWalletError(e)));
        }}
      />
      <Button
        label="Recover my wallet"
        secondary
        disabled={busy}
        onPress={() => router.push('/recover')}
      />
      <Button
        label="Help a friend: be a guardian"
        secondary
        disabled={busy}
        onPress={() => router.push('/guardian')}
      />
      <Button
        disabled={busy}
        label={busy ? 'Connecting…' : 'Log in'}
        onPress={() => {
          if (!busy) void onLogin();
        }}
      />
    </Screen>
  );
}
