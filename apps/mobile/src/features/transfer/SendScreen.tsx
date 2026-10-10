import type {
  ConfirmedTransfer,
  SubmittedTransfer,
  TransferPreview,
  Address,
} from '@swissquote/wallet-core';
import * as Linking from 'expo-linking';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import {
  getSafeAccount,
  getSafeWallet,
  readLastTransfer,
  transferActivity,
} from '../../lib/safeWallet';
import { describeWalletError } from '../../lib/wallet';

export default function SendScreen() {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [pendingTransfer, setPendingTransfer] =
    useState<SubmittedTransfer | null>(null);
  const [result, setResult] = useState<ConfirmedTransfer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const request = useRef<AbortController | null>(null);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setBusy(request.current !== null);
      setPreview(null);
      void Promise.all([transferActivity.readPending(), readLastTransfer()])
        .then(([pending, last]) => {
          if (focused.current) {
            setPendingTransfer(pending);
            setResult(last);
          }
        })
        .catch((e: unknown) => {
          if (focused.current) setError(describeWalletError(e));
        });
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'background') {
          request.current?.abort();
          setPreview(null);
        }
      });
      return () => {
        focused.current = false;
        request.current?.abort();
        subscription.remove();
      };
    }, []),
  );

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (
      request.current ||
      !focused.current ||
      AppState.currentState !== 'active'
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      await action(controller.signal);
    } catch (e) {
      if (focused.current) setError(describeWalletError(e));
    } finally {
      try {
        const pending = await transferActivity.readPending();
        if (focused.current) setPendingTransfer(pending);
      } catch (e) {
        if (focused.current) setError(describeWalletError(e));
      }
      request.current = null;
      if (focused.current) setBusy(false);
    }
  }
  async function checkStatus(submitted: SubmittedTransfer) {
    const confirmed = await getSafeWallet().confirmTransfer(submitted);
    if (!focused.current) return;
    if (confirmed) {
      setResult(confirmed);
      setPreview(null);
      setPendingTransfer(null);
    } else setError('Not confirmed yet. Check again shortly; do not resend.');
  }
  function edit(set: (value: string) => void, value: string) {
    request.current?.abort();
    set(value);
    setPreview(null);
    setError(null);
  }

  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Send test tokens</Text>
      <Text className="text-sm text-muted">
        Sepolia only · Gas paid with your Safe’s test ETH
      </Text>
      <View className="gap-3">
        <Text className="text-base text-ink">Recipient</Text>
        <TextInput
          accessibilityLabel="Recipient address"
          placeholder="0x…"
          placeholderTextColor="#596574"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy && !pendingTransfer}
          value={recipient}
          onChangeText={(value) => edit(setRecipient, value)}
          className="bg-white rounded-2xl border border-line p-4 text-base text-ink"
        />
        <Text className="text-base text-ink">Amount</Text>
        <TextInput
          accessibilityLabel="Amount in test tokens"
          placeholder="0.00"
          placeholderTextColor="#596574"
          keyboardType="decimal-pad"
          editable={!busy && !pendingTransfer}
          value={amount}
          onChangeText={(value) => edit(setAmount, value)}
          className="bg-white rounded-2xl border border-line p-4 text-base text-ink"
        />
      </View>
      {!pendingTransfer && (
        <Button
          label={busy ? 'Working…' : 'Preview transfer'}
          disabled={busy}
          onPress={() =>
            void run(async (signal) => {
              setPreview(null);
              await getSafeAccount();
              const next = await getSafeWallet().prepareTransfer(
                {
                  recipient: recipient.trim() as Address,
                  amount: amount.trim(),
                },
                signal,
              );
              if (focused.current && !signal.aborted) {
                setPreview(next);
                setResult(null);
              }
            })
          }
        />
      )}
      {preview && !pendingTransfer && (
        <View
          accessibilityLiveRegion="polite"
          className="bg-white border border-line rounded-3xl p-6 gap-3"
        >
          <Text className="text-lg font-semibold text-ink">
            Review transfer
          </Text>
          <Text className="text-base text-muted">
            Amount: {preview.amount} test tokens
          </Text>
          <Text selectable className="text-sm text-muted">
            Recipient: {preview.recipient}
          </Text>
          <Text selectable className="text-sm text-muted">
            Token: {preview.tokenAddress}
          </Text>
          <Text selectable className="text-sm text-muted">
            From Safe: {preview.safeAddress}
          </Text>
          <Text className="text-sm text-muted">
            Maximum gas: {preview.maxGasEth} Sepolia ETH
          </Text>
          <Text className="text-sm text-muted">
            Gas estimated by bundler.{' '}
            {preview.deploysSafe
              ? 'This also deploys your Safe.'
              : 'Your Safe is deployed.'}
          </Text>
          <Button
            label={busy ? 'Signing / submitting…' : 'Authenticate & send'}
            disabled={busy}
            onPress={() =>
              void run(async (signal) => {
                const submitted = await getSafeWallet().submitTransfer(
                  preview,
                  signal,
                );
                if (focused.current) {
                  setPendingTransfer(submitted);
                  setPreview(null);
                }
                await checkStatus(submitted);
              })
            }
          />
        </View>
      )}
      {pendingTransfer && (
        <View className="bg-white border border-line rounded-3xl p-6 gap-3">
          <Text className="text-lg font-semibold text-ink">
            Awaiting confirmation
          </Text>
          <Text className="text-sm text-muted">
            Submission may have succeeded even if the connection dropped. Check
            this operation before sending again.
          </Text>
          <Text selectable className="text-xs text-ink">
            {pendingTransfer.userOperationHash}
          </Text>
          <Button
            label={busy ? 'Checking…' : 'Check status'}
            disabled={busy}
            onPress={() => void run(async () => checkStatus(pendingTransfer))}
          />
        </View>
      )}
      {error && (
        <Text
          accessibilityLiveRegion="polite"
          className="text-base text-accent"
        >
          {error}
        </Text>
      )}
      {result && (
        <View
          accessibilityLiveRegion="polite"
          className="bg-white border border-line rounded-3xl p-6 gap-3"
        >
          <Text className="text-lg font-semibold text-ink">
            Transfer confirmed on Sepolia
          </Text>
          <Text className="text-sm text-muted">
            Two confirmations · Safe configuration and Transfer event verified
          </Text>
          <Text selectable className="text-xs text-ink">
            {result.transactionHash}
          </Text>
          <Text className="text-sm text-muted">
            Safe balance: {result.senderBalanceBefore} →{' '}
            {result.senderBalanceAfter}
          </Text>
          <Text className="text-sm text-muted">
            Recipient balance: {result.recipientBalanceBefore} →{' '}
            {result.recipientBalanceAfter}
          </Text>
          {!result.balanceChangesMatch && (
            <Text className="text-sm text-muted">
              Block balance changes differ from this transfer; other activity
              may have occurred in the same block.
            </Text>
          )}
          <Button
            label="View on Sepolia explorer"
            secondary
            onPress={() => {
              void Linking.openURL(
                `https://sepolia.etherscan.io/tx/${result.transactionHash}`,
              ).catch(() => setError('Could not open the explorer.'));
            }}
          />
        </View>
      )}
    </Screen>
  );
}
