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
import { clearSession, getSession } from '../../lib/auth';

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
  const [sessionUser, setSessionUser] = useState<string | null>(null);

  useEffect(() => {
    void getSession().then((s) => setSessionUser(s?.username ?? null));
  }, []);
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
      <View className="rounded-3xl bg-ink p-6 gap-3">
        <Text className="text-white text-sm">Safe test-token balance</Text>
        <Text className="text-white text-4xl font-bold">
          {account?.tokenBalance ?? '—'}
        </Text>
        <Text className="text-white text-base">
          Test tokens · {SEPOLIA.name}
        </Text>
      </View>
      <Button label="Send" onPress={() => router.push('/send')} />
      <View className="bg-white border border-line rounded-3xl p-6 gap-3">
        <Text className="text-lg font-semibold text-ink">Receive</Text>
        <Text className="text-base leading-6 text-muted">
          {account
            ? account.deployed
              ? 'Safe deployed and configuration verified.'
              : 'Safe address reserved. Your first transfer deploys it.'
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
              Fund this Safe address with Sepolia ETH and the configured test
              token.
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
        label={sessionUser ? `Log out (${sessionUser})` : 'Log out of Swissquote'}
        secondary
        onPress={() => {
          clearSession()
            .then(() => router.replace('/login'))
            .catch((e: unknown) => Alert.alert('Error', describeWalletError(e)));
        }}
      />
      <Text className="text-sm text-muted">
        Sepolia testnet only. Recovery is not configured for this milestone.
      </Text>
    </Screen>
  );
}
