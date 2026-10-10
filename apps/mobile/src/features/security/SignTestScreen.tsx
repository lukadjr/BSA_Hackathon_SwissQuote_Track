import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import {
  describeWalletError,
  signMessage,
  verifyMessage,
  type Address,
  type Signature,
} from '../../lib/wallet';

const TEST_MESSAGE = 'Swissquote Wallet test message';

type Result = { address: Address; signature: Signature; valid: boolean };

export default function SignTestScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function onSign() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Face ID / biometrics are requested inside signMessage, on every call.
      const { address, signature } = await signMessage(TEST_MESSAGE);
      const valid = await verifyMessage({
        address,
        message: TEST_MESSAGE,
        signature,
      });
      setResult({ address, signature, valid });
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Sign a test message</Text>
      <View className="bg-white border border-line rounded-3xl p-6 gap-2">
        <Text className="text-sm text-muted">You are about to sign</Text>
        <Text className="text-base font-semibold text-ink">{TEST_MESSAGE}</Text>
        <Text className="text-sm text-muted">
          This is a test message. It moves no funds.
        </Text>
      </View>
      <Button
        label={busy ? 'Waiting…' : 'Confirm with Face ID'}
        onPress={() => {
          if (!busy) void onSign();
        }}
      />
      {error !== null && <Text className="text-base text-accent">{error}</Text>}
      {result !== null && (
        <View className="bg-white border border-line rounded-3xl p-6 gap-2">
          <Text className="font-semibold text-ink">
            {result.valid ? 'Signature valid' : 'Signature INVALID'}
          </Text>
          <Text className="text-sm text-muted">Address</Text>
          <Text selectable className="text-sm text-ink">
            {result.address}
          </Text>
          <Text className="text-sm text-muted">Signature</Text>
          <Text selectable className="text-xs text-ink">
            {result.signature}
          </Text>
        </View>
      )}
    </Screen>
  );
}
