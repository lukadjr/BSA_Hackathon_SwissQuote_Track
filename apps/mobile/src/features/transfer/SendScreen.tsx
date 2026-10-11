import { shortAddress, WalletError } from '@swissquote/wallet-core';
import { formatUnits } from 'viem';
import type {
  ConfirmedTransfer,
  SubmittedTransfer,
  TransferPreview,
  Address,
} from '@swissquote/wallet-core';
import * as Linking from 'expo-linking';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { colors } from '../../theme/colors';
import { Screen } from '../../components/Screen';
import {
  getSafeAccount,
  getSafeWallet,
  readLastTransfer,
  transferActivity,
} from '../../lib/safeWallet';
import { recordSentTransfer } from '../../lib/activity';
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
            setResult(pending ? null : last);
            if (last) void recordSentTransfer(last);
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
    let failure: unknown;
    try {
      await action(controller.signal);
    } catch (e) {
      failure = e;
      if (focused.current) setError(describeWalletError(e));
    } finally {
      try {
        const pending = await transferActivity.readPending();
        if (focused.current) {
          setPendingTransfer(pending);
          if (
            pending &&
            (!(failure instanceof WalletError) ||
              ['NETWORK_FAILED', 'TRANSFER_PENDING'].includes(failure.code))
          )
            setError(null);
        }
      } catch (e) {
        if (focused.current) setError(describeWalletError(e));
      }
      request.current = null;
      if (focused.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!pendingTransfer || error) return;
    let active = true;
    let checking = false;
    async function poll() {
      if (
        !active ||
        checking ||
        request.current ||
        !focused.current ||
        AppState.currentState !== 'active'
      )
        return;
      checking = true;
      try {
        const confirmed = await getSafeWallet().confirmTransfer(
          pendingTransfer!,
        );
        if (!active || !focused.current) return;
        if (confirmed) {
          await recordSentTransfer(confirmed);
          setResult(confirmed);
          setPendingTransfer(null);
          setError(null);
        }
      } catch (e) {
        // Connection failures and normal inclusion delays keep the pending state.
        if (
          active &&
          focused.current &&
          e instanceof WalletError &&
          [
            'TRANSFER_FAILED',
            'VERIFICATION_FAILED',
            'TRANSFER_EXPIRED',
          ].includes(e.code)
        ) {
          setError(describeWalletError(e));
          try {
            const remaining = await transferActivity.readPending();
            if (active && focused.current) setPendingTransfer(remaining);
          } catch {
            // Keep tracking and stop polling until storage can be read again.
          }
        }
      } finally {
        checking = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void poll();
    });
    return () => {
      active = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [pendingTransfer, error]);

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
        Sepolia only · Network fees covered by Swissquote
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
          <Text className="text-sm text-muted">
            Network fee: covered by Swissquote
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
              })
            }
          />
        </View>
      )}
      {pendingTransfer && !error && (
        <View
          accessibilityLiveRegion="polite"
          className="bg-card border border-line rounded-3xl p-6 gap-4"
        >
          <View className="flex-row items-center gap-3">
            <View className="h-12 w-12 rounded-full bg-brandSoft items-center justify-center">
              <ActivityIndicator color="#FF5722" />
            </View>
            <View className="flex-1 gap-1">
              <Text className="text-lg font-bold text-ink">Pending</Text>
              <Text className="text-sm text-muted">
                Your transfer is being confirmed
              </Text>
            </View>
          </View>
          <Text className="text-sm leading-6 text-muted">
            You’re all set. We’ll update this automatically once your transfer
            is confirmed.
          </Text>
          <View className="h-1 rounded-full bg-brandSoft">
            <View className="h-1 w-1/2 rounded-full bg-brand" />
          </View>
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
          <View className="flex-row items-center gap-3">
            <View className="h-12 w-12 rounded-full bg-successSoft items-center justify-center">
              <Icon
                name="checkmark.circle.fill"
                size={26}
                color={colors.success}
              />
            </View>
            <View className="flex-1 gap-1">
              <Text className="text-lg font-bold text-ink">
                Transfer confirmed
              </Text>
              <Text className="text-sm text-muted">
                {formatUnits(BigInt(result.amountUnits), result.decimals)} USDC
                sent
              </Text>
            </View>
          </View>
          <Text selectable className="text-sm text-muted">
            To {shortAddress(result.recipient)}
          </Text>
          <Text className="text-sm text-muted">
            Wallet balance: {result.senderBalanceAfter} USDC
          </Text>
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
