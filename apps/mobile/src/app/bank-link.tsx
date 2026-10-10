import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { Screen } from '../components/Screen';
import { Button } from '../components/Button';
import {
  authorizeBankTransfer,
  getLinkStatus,
  type LinkStatus,
} from '../lib/api';
import { getSafeAccount } from '../lib/safeWallet';
import { describeLinkError } from '../lib/walletlink';

export default function BankLinkScreen() {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [amount, setAmount] = useState('10');
  const [direction, setDirection] = useState<
    'bank_to_wallet' | 'wallet_to_bank'
  >('bank_to_wallet');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useFocusEffect(
    useCallback(() => {
      // Re-run the read when the user explicitly requests a refresh.
      void attempt;
      const controller = new AbortController();
      setStatus(null);
      setResult(null);
      setError(null);
      void getSafeAccount()
        .then(async (account) => {
          const state = await getLinkStatus(controller.signal);
          if (
            state.safe_address?.toLowerCase() !==
              account.safeAddress.toLowerCase() ||
            state.owner_address?.toLowerCase() !==
              account.ownerAddress.toLowerCase() ||
            state.chain_id !== 11155111
          )
            state.bank_transfers_allowed = false;
          if (!controller.signal.aborted) setStatus(state);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setError(describeLinkError(e));
        });
      return () => controller.abort();
    }, [attempt]),
  );

  async function authorize() {
    if (busy || !status?.bank_transfers_allowed || !status.safe_address) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const response = await authorizeBankTransfer(
        status.safe_address,
        direction,
        amount,
      );
      setResult(
        response.status === 'approved'
          ? 'Demo authorization approved. No funds moved.'
          : 'Additional demo review required for amounts above 10,000. No funds moved.',
      );
    } catch (e) {
      setStatus(null);
      setError(describeLinkError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Swissquote connection</Text>
      <Text className="text-base text-muted">
        Simulated bank transfer authorization. Identity, AML and Travel Rule
        services are mocked. This screen sends no blockchain transaction.
      </Text>
      {status ? (
        <View className="bg-white border border-line rounded-3xl p-6 gap-2">
          <Text className="text-base text-ink">
            Identity: {status.kyc_status} (simulated)
          </Text>
          <Text className="text-base text-ink">
            Safe control: {status.control_status}
          </Text>
          <Text className="text-sm text-muted">
            Bank connection:{' '}
            {status.bank_transfers_allowed ? 'eligible' : 'blocked'}
          </Text>
          <Text selectable className="text-xs text-muted">
            {status.safe_address}
          </Text>
        </View>
      ) : (
        !error && <ActivityIndicator />
      )}
      <Button
        label="Refresh status"
        secondary
        disabled={busy}
        onPress={() => setAttempt((n) => n + 1)}
      />
      <Button
        label={`Direction: ${direction === 'bank_to_wallet' ? 'Swissquote → wallet' : 'Wallet → Swissquote'}`}
        secondary
        disabled={busy}
        onPress={() => {
          setDirection((d) =>
            d === 'bank_to_wallet' ? 'wallet_to_bank' : 'bank_to_wallet',
          );
          setResult(null);
        }}
      />
      <Text className="text-sm text-muted">
        Test USDC amount (above 10,000 requires review)
      </Text>
      <TextInput
        accessibilityLabel="Test USDC amount"
        value={amount}
        onChangeText={(value) => {
          setAmount(value);
          setResult(null);
        }}
        editable={!busy}
        keyboardType="decimal-pad"
        className="bg-white border border-line rounded-2xl p-4 text-ink"
      />
      <Button
        label={busy ? 'Checking…' : 'Check demo authorization'}
        disabled={busy || !status?.bank_transfers_allowed}
        onPress={() => void authorize()}
      />
      {result && <Text className="text-base text-ink">{result}</Text>}
      {error && <Text className="text-base text-accent">{error}</Text>}
      <Button
        label="Verify wallet link"
        secondary
        disabled={busy}
        onPress={() => router.push('/link-wallet')}
      />
    </Screen>
  );
}
