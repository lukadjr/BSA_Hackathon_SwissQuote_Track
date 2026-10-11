import { shortAddress } from '@swissquote/wallet-core';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Share, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { Divider, ListRow, Section } from '../../components/ui';
import { useWalletOverview } from '../../hooks/useWalletOverview';
import { getSession } from '../../lib/auth';
import { logoutWallet, resetWallet } from '../../lib/walletSession';
import { describeWalletError } from '../../lib/wallet';

function confirmReset() {
  Alert.alert(
    'Reset wallet?',
    'Deletes all app data on this phone, including your login, owner and guardian keys, recovery requests and history. You will need recovery to access your existing wallet. This also removes your ability to approve recoveries for friends from this phone.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset wallet',
        style: 'destructive',
        onPress: () => {
          resetWallet()
            .then(() => {
              if (router.canDismiss()) router.dismissAll();
              router.replace('/welcome');
            })
            .catch((e: unknown) =>
              Alert.alert('Reset failed', describeWalletError(e)),
            );
        },
      },
    ],
  );
}

/** Account, Swissquote link, addresses and session. */
export default function ProfileScreen() {
  const { account, linked } = useWalletOverview();
  const [name, setName] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      getSession()
        .then((s) => setName(s?.username ?? null))
        .catch(() => setName(null));
    }, []),
  );

  return (
    <Screen>
      <View className="items-center gap-2 py-4">
        <View className="h-20 w-20 items-center justify-center rounded-full bg-ink">
          <Text className="text-3xl font-bold text-white">
            {(name ?? 'S').slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <Text className="text-2xl font-bold text-ink">
          {name ?? 'Swissquote client'}
        </Text>
        <Text className="text-sm text-muted">Swissquote demo account</Text>
      </View>

      <Section title="Swissquote Wallet">
        <ListRow
          icon="link"
          tone={linked ? 'success' : 'warning'}
          title="Wallet link"
          subtitle={
            linked === null
              ? 'Swissquote is not reachable'
              : linked
                ? 'Your Safe is verified and linked'
                : 'Not linked: tap to verify'
          }
          onPress={() => router.push('/link-wallet')}
        />
        <Divider />
        <ListRow
          icon="building.columns.fill"
          title="Bank connection test"
          subtitle="Simulated transfer authorization"
          onPress={() => router.push('/bank-link')}
        />
      </Section>

      <Section title="Wallet">
        <ListRow
          icon="wallet.pass.fill"
          title="Safe address"
          subtitle={account ? shortAddress(account.safeAddress) : '…'}
          caption="Share"
          onPress={
            account
              ? () => void Share.share({ message: account.safeAddress })
              : undefined
          }
        />
        <Divider />
        <ListRow
          icon="key.fill"
          title="Owner key (this phone)"
          subtitle={account ? shortAddress(account.ownerAddress) : '…'}
        />
      </Section>

      <Button
        label="Log out"
        variant="secondary"
        icon="rectangle.portrait.and.arrow.right"
        onPress={() => {
          Alert.alert(
            'Disconnect this phone?',
            'Logging out removes the wallet key from this phone. You will need your guardians to recover this wallet.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Log out',
                style: 'destructive',
                onPress: () => {
                  logoutWallet()
                    .then(() => {
                      if (router.canDismiss()) router.dismissAll();
                      router.replace('/welcome');
                    })
                    .catch((e) =>
                      Alert.alert('Logout failed', describeWalletError(e)),
                    );
                },
              },
            ],
          );
        }}
      />
      <Button label="Reset wallet" variant="ghost" onPress={confirmReset} />
      <Text className="text-center text-xs text-muted">
        Sepolia testnet only · your key never leaves this phone
      </Text>
    </Screen>
  );
}
