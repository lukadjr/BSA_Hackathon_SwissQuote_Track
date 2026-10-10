import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Text,
  TextInput,
  View,
} from 'react-native';
import { formatUnits } from 'viem';
import type { SafeAccountInfo } from '@swissquote/wallet-core';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { getClientIdentity, getLinkStatus } from '../../lib/api';
import { getSafeAccount } from '../../lib/safeWallet';
import {
  confirmFunding,
  describeFundingError,
  getFunding,
  getTreasuryAccount,
  isActiveFunding,
  listFunding,
  prepareFunding,
  validateFundingIntent,
  type FundingIntent,
  type TreasuryAccount,
} from '../../lib/funding';

export default function AddMoneyScreen() {
  const [treasury, setTreasury] = useState<TreasuryAccount | null>(null);
  const [safe, setSafe] = useState<SafeAccountInfo | null>(null);
  const [linked, setLinked] = useState(false);
  const [amount, setAmount] = useState('');
  const [intent, setIntent] = useState<FundingIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const pending = useRef<AbortController | null>(null);
  // Keep the same key after a create timeout; changing input starts a different request.
  const creation = useRef<{ fingerprint: string; key: string } | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    const [profile, account, bank, history, link] = await Promise.all([
      getClientIdentity(signal),
      getSafeAccount(),
      getTreasuryAccount(signal),
      listFunding(signal),
      getLinkStatus(signal),
    ]);
    if (signal.aborted) return;
    const latest = history.intents.find(
      (i) =>
        i.safe_address.toLowerCase() === account.safeAddress.toLowerCase() &&
        i.owner_address.toLowerCase() === account.ownerAddress.toLowerCase(),
    );
    if (latest)
      validateFundingIntent(
        latest,
        profile,
        account.safeAddress,
        account.ownerAddress,
        bank,
      );
    setTreasury(bank);
    setSafe(account);
    setLinked(
      link.bank_transfers_allowed &&
        link.client_id === profile.client_id &&
        link.chain_id === 11155111 &&
        link.safe_address?.toLowerCase() ===
          account.safeAddress.toLowerCase() &&
        link.owner_address?.toLowerCase() ===
          account.ownerAddress.toLowerCase(),
    );
    setIntent(latest ?? null);
  }, []);

  const run = useCallback(
    async (operation: (signal: AbortSignal) => Promise<void>) => {
      if (
        !focused.current ||
        pending.current ||
        AppState.currentState !== 'active'
      )
        return;
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError(null);
      try {
        await operation(controller.signal);
      } catch (e) {
        if (focused.current && !controller.signal.aborted)
          setError(describeFundingError(e));
      } finally {
        if (pending.current === controller) pending.current = null;
        if (focused.current) setBusy(false);
      }
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void run((signal) => load(signal));
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'background') pending.current?.abort();
      });
      return () => {
        focused.current = false;
        pending.current?.abort();
        sub.remove();
      };
    }, [load, run]),
  );

  const refresh = useCallback(
    () =>
      run(async (signal) => {
        if (intent) {
          const result = await getFunding(intent.id, signal);
          if (result.id !== intent.id || result.message !== intent.message)
            throw new Error('Unexpected bank status');
        }
        await load(signal);
      }),
    [intent, load, run],
  );

  useEffect(() => {
    if (
      !intent ||
      !isActiveFunding(intent) ||
      intent.status === 'awaiting_confirmation'
    )
      return;
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [intent, refresh]);

  function review(kind: FundingIntent['kind']) {
    void run(async (signal) => {
      const fingerprint = `${kind}:${amount}:${safe?.safeAddress}`;
      if (
        creation.current?.fingerprint !== fingerprint ||
        (intent && !isActiveFunding(intent))
      )
        creation.current = { fingerprint, key: randomUUID() };
      const result = await prepareFunding(
        kind,
        amount,
        creation.current.key,
        signal,
      );
      if (!signal.aborted) setIntent(result);
    });
  }

  const active = intent !== null && isActiveFunding(intent);
  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Add money</Text>
      <Text className="text-base text-muted">
        Transfer test tokens from your Swissquote demo account into your own
        wallet. Bank identity and compliance checks are simulated. Transfers are
        real on Sepolia.
      </Text>
      {busy && <ActivityIndicator />}
      {treasury && (
        <View className="bg-white border border-line rounded-3xl p-6 gap-2">
          <Text className="text-lg font-semibold text-ink">
            Swissquote demo account
          </Text>
          <Text className="text-2xl font-bold text-ink">
            {formatUnits(BigInt(treasury.available_units), 6)}{' '}
            {treasury.token_label}
          </Text>
          <Text className="text-sm text-muted">
            Available for this single-client demo. Funded manually through
            faucets.
          </Text>
          <Text selectable className="text-xs text-muted">
            {treasury.treasury_address}
          </Text>
          <Text className="text-xs text-muted">
            Treasury gas balance:{' '}
            {formatUnits(BigInt(treasury.eth_balance_wei), 18)} Sepolia ETH
          </Text>
        </View>
      )}
      {safe && (
        <View className="bg-white border border-line rounded-3xl p-6 gap-2">
          <Text className="text-lg font-semibold text-ink">
            Your receiving wallet
          </Text>
          <Text selectable className="text-sm text-ink">
            {safe.safeAddress}
          </Text>
          <Text className="text-sm text-muted">
            {safe.deployed
              ? 'Deployed on Sepolia'
              : 'Setup needed before bank linking'}
          </Text>
          <Text className="text-sm text-muted">
            Wallet balance: {safe.tokenBalance} test tokens
          </Text>
        </View>
      )}
      {safe && safe.deployed && !active && (
        <Button
          label="Protect wallet before adding money"
          secondary
          onPress={() => router.push('/protect')}
        />
      )}
      {safe && !active && !safe.deployed && (
        <Button
          disabled={busy}
          label="Review wallet setup"
          onPress={() => review('deploy')}
        />
      )}
      {safe?.deployed && !linked && !active && (
        <Button
          disabled={busy}
          label="Verify bank connection"
          onPress={() => router.push('/link-wallet')}
        />
      )}
      {safe?.deployed && linked && !active && (
        <View className="gap-3">
          <Text className="text-base font-semibold text-ink">
            Amount in test tokens
          </Text>
          <TextInput
            accessibilityLabel="Amount in test tokens"
            editable={!busy}
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
            placeholder="20.00"
            className="bg-white border border-line rounded-2xl p-4 text-lg text-ink"
          />
          <Button
            disabled={busy || amount.length === 0}
            label="Review transfer"
            onPress={() => review('deposit')}
          />
        </View>
      )}
      {intent && (
        <View className="bg-white border border-line rounded-3xl p-6 gap-3">
          <Text className="text-lg font-semibold text-ink">
            {intent.kind === 'deploy'
              ? 'Wallet setup'
              : `${formatUnits(BigInt(intent.amount_units), 6)} test tokens`}{' '}
            · {intent.status.replaceAll('_', ' ')}
          </Text>
          <Text className="text-sm text-muted">
            {intent.kind === 'deploy'
              ? 'The demo bank pays to deploy your wallet. It receives no ownership rights.'
              : 'From the demo bank into your Safe. The bank pays this transfer’s fee.'}
          </Text>
          {intent.security_mode === 'unprotected_test_demo' && (
            <Text className="text-sm text-accent">
              Developer test mode: recovery setup is not verified. Use
              disposable test tokens only.
            </Text>
          )}
          {intent.status === 'awaiting_confirmation' && (
            <>
              <Text className="text-sm text-muted">
                Review the exact instruction before signing. Expires{' '}
                {intent.expires_at}.
              </Text>
              <Text selectable className="text-xs text-ink">
                {intent.message}
              </Text>
              <Button
                disabled={busy}
                label="Authenticate & confirm"
                onPress={() => {
                  void run(async (signal) => {
                    const result = await confirmFunding(intent, signal);
                    if (!signal.aborted) setIntent(result);
                  });
                }}
              />
            </>
          )}
          {['queued', 'submitted', 'reconciling'].includes(intent.status) && (
            <Text className="text-sm text-muted">
              Processing. The treasury worker must be running. Closing the app
              does not cancel a confirmed request; refresh this request instead
              of creating another.
            </Text>
          )}
          {intent.status === 'confirmed' && (
            <Text className="text-sm text-muted">
              Confirmed. Refresh to read the latest blockchain balance.
            </Text>
          )}
          {intent.status === 'failed' && (
            <Text className="text-sm text-accent">
              This operation failed. Check the demo treasury funds and wallet
              setup before retrying.
            </Text>
          )}
          {intent.transaction_hash && (
            <Button
              secondary
              label="View on Sepolia explorer"
              onPress={() => {
                void Linking.openURL(
                  `https://sepolia.etherscan.io/tx/${intent.transaction_hash}`,
                );
              }}
            />
          )}
        </View>
      )}
      {error && (
        <Text accessibilityRole="alert" className="text-base text-accent">
          {error}
        </Text>
      )}
      <Button
        secondary
        disabled={busy}
        label="Refresh balances & request status"
        onPress={() => {
          void refresh();
        }}
      />
      <Button
        secondary
        disabled={busy}
        label="Back to wallet"
        onPress={() => router.dismissTo('/wallet')}
      />
    </Screen>
  );
}
