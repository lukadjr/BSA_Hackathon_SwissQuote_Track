import { router } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { ErrorText, Wordmark } from '../../components/ui';
import { loginToDemo } from '../../lib/auth';
import { readPendingRecovery } from '../../lib/recovery';
import { describeWalletError, getAddress } from '../../lib/wallet';
import { colors } from '../../theme/colors';

export default function LoginScreen() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // DEMO ONLY: any username and password are accepted (see loginToDemo).
  async function onLogin() {
    setBusy(true);
    setError(null);
    try {
      await loginToDemo(username.trim(), password);
      setPassword('');
      if (await readPendingRecovery()) router.replace('/recover');
      else router.replace((await getAddress()) ? '/home' : '/start');
    } catch (e) {
      setError(describeWalletError(e));
      setBusy(false);
    }
  }

  return (
    <Screen
      footer={
        <Button
          label="Log in"
          busy={busy}
          onPress={() => {
            if (!busy) void onLogin();
          }}
        />
      }
    >
      <View className="gap-3 pb-4">
        <Wordmark />
        <Text className="pt-4 text-3xl font-bold text-ink">Welcome back</Text>
        <Text className="text-base leading-6 text-muted">
          Log in with your Swissquote account. For this demo any username and
          password work; nothing is checked or stored.
        </Text>
      </View>
      <View className="gap-3">
        <Field
          label="Username"
          value={username}
          onChangeText={setUsername}
          placeholder="e.g. alice"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder="Any password"
          secure
          onSubmit={() => !busy && void onLogin()}
        />
      </View>
      <ErrorText error={error} />
    </Screen>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure = false,
  onSubmit,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  secure?: boolean;
  onSubmit?: () => void;
}) {
  return (
    <View className="gap-1 rounded-2xl bg-card px-4 py-3">
      <Text className="text-xs font-semibold uppercase text-muted">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        className="py-1 text-lg text-ink"
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        returnKeyType={onSubmit ? 'go' : 'next'}
        onSubmitEditing={onSubmit}
      />
    </View>
  );
}
