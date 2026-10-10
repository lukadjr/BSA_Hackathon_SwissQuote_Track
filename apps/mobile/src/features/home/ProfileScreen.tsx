import { shortAddress } from '@swissquote/wallet-core';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Share, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { Divider, ListRow, Section } from '../../components/ui';
import { useWalletOverview } from '../../hooks/useWalletOverview';
import { clearActivityForDev } from '../../lib/activity';
import { clearSession, getSession } from '../../lib/auth';
import { resetWalletForDev } from '../../lib/devReset';
import { describeWalletError } from '../../lib/wallet';

function confirmDevReset() {
  Alert.alert(
    'Reset wallet?',
    'Development only. This permanently deletes the key and Safe tracking on this phone. Any assets in the old Safe become inaccessible.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete key',
        style: 'destructive',
        onPress: () => {
          resetWalletForDev()
            .then(() => clearActivityForDev())
            .then(() => router.replace('/start'))
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

      <Section title="Swissquote">
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
        <Divider />
        <ListRow
          icon="signature"
          title="Sign a test message"
          onPress={() => router.push('/sign-test')}
        />
      </Section>

      <Button
        label="Log out"
        variant="secondary"
        icon="rectangle.portrait.and.arrow.right"
        onPress={() => {
          clearSession()
            .then(() => {
              if (router.canDismiss()) router.dismissAll();
              router.replace('/welcome');
            })
            .catch((e) => Alert.alert('Logout failed', describeWalletError(e)));
        }}
      />
      {__DEV__ && (
        <Button
          label="Reset wallet (dev only)"
          variant="ghost"
          onPress={confirmDevReset}
        />
      )}
      <Text className="text-center text-xs text-muted">
        Sepolia testnet only · your key never leaves this phone
      </Text>
    </Screen>
  );
}
