import { SEPOLIA } from '@swissquote/wallet-core';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import type { SafeAccountInfo } from '@swissquote/wallet-core';
import { Alert, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { useOwnerAddress } from '../../hooks/useOwnerAddress';
import { resetWalletForDev } from '../../lib/devReset';
import { describeWalletError } from '../../lib/wallet';
import { getSafeAccount } from '../../lib/safeWallet';
import { useSecurityState } from '../../hooks/useSecurityState';
import { RecoveryAlert, RequestedAlert } from '../recovery/RecoveryAlert';

function confirmDevReset() {
  Alert.alert(
    'Reset wallet?',
    'Development only. This permanently deletes the key and Safe tracking on this phone. Any assets in the old Safe become inaccessible. You will create and link a new wallet.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete key',
        style: 'destructive',
        onPress: () => {
          resetWalletForDev()
            .then(() => router.replace('/create-wallet'))
            .catch((e: unknown) =>
              Alert.alert('Reset failed', describeWalletError(e)),
            );
        },
      },
    ],
  );
}

export default function WalletScreen() {
  const { address, error } = useOwnerAddress();
  const [account, setAccount] = useState<SafeAccountInfo | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const security = useSecurityState();
  useFocusEffect(
    useCallback(() => {
      setAttempt((value) => value + 1);
    }, []),
  );
  useEffect(() => {
    let active = true;
    void getSafeAccount()
      .then((info) => {
        if (active) {
          setAccount(info);
          setChainError(null);
        }
      })
      .catch((e: unknown) => {
        if (active) {
          setAccount(null);
          setChainError(describeWalletError(e));
        }
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  return (
    <Screen>
      {security.state && (
        <RecoveryAlert state={security.state} onChanged={security.refresh} />
      )}
      {security.state && (
        <RequestedAlert
          state={security.state}
          status={security.status}
          onChanged={security.refresh}
        />
      )}
      {security.state && !security.state.recovery && (
        <View className="bg-white border border-accent rounded-3xl p-6 gap-3">
          <Text className="text-lg font-semibold text-ink">
            Protect your wallet
          </Text>
          <Text className="text-base text-muted">
            Add 3 guardians so you can recover it if you lose this phone.
          </Text>
          <Button
            label="Set up recovery"
            onPress={() => router.push('/protect')}
          />
        </View>
      )}
      <View className="rounded-3xl bg-ink p-6 gap-3">
        <Text className="text-white text-sm">Safe test-token balance</Text>
        <Text className="text-white text-4xl font-bold">
          {account?.tokenBalance ?? '—'}
        </Text>
        <Text className="text-white text-base">
          Test tokens · {SEPOLIA.name}
        </Text>
      </View>
      <Button
        label="Swissquote account (demo)"
        secondary
        onPress={() => router.push('/link-wallet')}
      />
      <Button label="Send" onPress={() => router.push('/send')} />
      <Button label="Add money" onPress={() => router.push('/add-money')} />
      <View className="bg-white border border-line rounded-3xl p-6 gap-3">
        <Text className="text-lg font-semibold text-ink">Receive</Text>
        <Text className="text-base leading-6 text-muted">
          {account
            ? account.deployed
              ? 'Safe deployed and configuration verified.'
              : 'Safe address reserved. Open Add money to deploy it through the demo bank.'
            : 'Configure the Sepolia connection to load your Safe.'}
        </Text>
        {account && (
          <>
            <Text selectable className="text-sm text-ink">
              {account.safeAddress}
            </Text>
            <Text className="text-sm text-muted">
              Gas balance: {account.ethBalance} Sepolia ETH
            </Text>
            <Text selectable className="text-xs text-muted">
              Test-token contract: {account.tokenAddress}
            </Text>
            <Text className="text-sm text-muted">
              Add test tokens from the demo bank or receive the configured token
              at this Safe address. Outgoing fee sponsorship is a separate
              integration.
            </Text>
          </>
        )}
        {chainError && (
          <Text className="text-sm text-accent">{chainError}</Text>
        )}
        <Button
          label="Refresh balances"
          secondary
          onPress={() => setAttempt((value) => value + 1)}
        />
      </View>
      <View className="bg-white border border-line rounded-3xl p-6 gap-3">
        <Text className="text-lg font-semibold text-ink">Owner address</Text>
        <Text selectable className="text-sm leading-5 text-muted">
          {error ?? address ?? (address === undefined ? 'Loading…' : 'None')}
        </Text>
        <Text className="text-xs text-muted">
          Public address of the signing key on this phone. Not the Safe address.
        </Text>
      </View>
      <Button
        label="Sign a test message"
        secondary
        onPress={() => router.push('/sign-test')}
      />
      <Button
        label="Security & recovery"
        secondary
        onPress={() => router.push('/recovery')}
      />
      {__DEV__ && (
        <Button
          label="Reset wallet (dev only)"
          secondary
          onPress={confirmDevReset}
        />
      )}
      <Button
        label="Be a guardian for a friend"
        secondary
        onPress={() => router.push('/guardian')}
      />
      <Text className="text-sm text-muted">Sepolia testnet only.</Text>
    </Screen>
  );
}
