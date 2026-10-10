import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';

export default function SendScreen() {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState(false);

  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Send demo USDC</Text>
      <View className="gap-3">
        <Text className="text-base text-ink">Recipient</Text>
        <TextInput
          accessibilityLabel="Recipient address"
          placeholder="Recipient address"
          placeholderTextColor="#596574"
          autoCapitalize="none"
          autoCorrect={false}
          value={recipient}
          onChangeText={(value) => {
            setRecipient(value);
            setPreview(false);
          }}
          className="bg-white rounded-2xl border border-line p-4 text-base text-ink"
        />
        <Text className="text-base text-ink">Amount</Text>
        <TextInput
          accessibilityLabel="Amount in demo USDC"
          placeholder="0.00"
          placeholderTextColor="#596574"
          keyboardType="decimal-pad"
          value={amount}
          onChangeText={(value) => {
            setAmount(value);
            setPreview(false);
          }}
          className="bg-white rounded-2xl border border-line p-4 text-base text-ink"
        />
      </View>
      <Button label="Preview mock transfer" onPress={() => setPreview(true)} />
      {preview && (
        <View
          accessibilityLiveRegion="polite"
          className="bg-white border border-line rounded-3xl p-6 gap-3"
        >
          <Text className="text-lg font-semibold text-ink">Preview only</Text>
          <Text className="text-base text-muted">
            Amount: {amount || '—'} demo USDC
          </Text>
          <Text selectable className="text-base text-muted">
            Recipient: {recipient || '—'}
          </Text>
          <Text className="text-base text-muted">
            Network: Sepolia · Fees: not estimated
          </Text>
        </View>
      )}
      <Text className="text-sm leading-5 text-muted">
        Form preview only. Validation, simulation and local signing are not
        connected. Nothing is sent.
      </Text>
    </Screen>
  );
}
