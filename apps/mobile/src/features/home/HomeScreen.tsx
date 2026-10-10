import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { Screen } from '../../components/Screen';
import {
  Divider,
  ErrorText,
  ListRow,
  QuickAction,
  Section,
} from '../../components/ui';
import { useSecurityState } from '../../hooks/useSecurityState';
import { useWalletOverview } from '../../hooks/useWalletOverview';
import { getSession } from '../../lib/auth';
import { formatAmount, formatUsd, portfolioUsd } from '../../lib/format';
import { colors } from '../../theme/colors';
import { RecoveryAlert, RequestedAlert } from '../recovery/RecoveryAlert';

/** Wallet home: total balance in USD, quick actions and the tokens held. */
export default function HomeScreen() {
  const { account, linked, error, loading, refresh } = useWalletOverview();
  const security = useSecurityState();
  const [name, setName] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      getSession()
        .then((s) => setName(s?.username ?? null))
        .catch(() => setName(null));
    }, []),
  );
  const total = portfolioUsd({ usdc: account?.tokenBalance ?? null });
  const needsSetup =
    account !== null && (!account.deployed || linked === false);
  const unprotected =
    account?.deployed === true && security.state?.recovery === null;

  return (
    <Screen
      edgeToEdge
      inTabs
      onRefresh={() => {
        refresh();
        security.refresh();
      }}
      refreshing={false}
    >
      <View className="flex-row items-center justify-between">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Profile"
          onPress={() => router.push('/profile')}
          className="flex-row items-center gap-3 active:opacity-70"
        >
          <View className="h-10 w-10 items-center justify-center rounded-full bg-ink">
            <Text className="text-base font-bold text-white">
              {(name ?? 'S').slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View>
            <Text className="text-xs text-muted">Welcome back</Text>
            <Text className="text-base font-bold text-ink">
              {name ?? 'Swissquote client'}
            </Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Security"
          onPress={() => router.navigate('/guardians')}
          className="h-10 w-10 items-center justify-center rounded-full bg-card active:opacity-70"
        >
          <Icon
            name={
              security.state?.recovery?.pending ||
              security.status?.openRequests.length
                ? 'bell.badge.fill'
                : 'bell.fill'
            }
            size={18}
            color={
              security.state?.recovery?.pending ||
              security.status?.openRequests.length
                ? colors.brand
                : colors.ink
            }
          />
        </Pressable>
      </View>

      <View className="gap-6 rounded-[32px] bg-brand px-5 pb-5 pt-6">
        <View className="items-center gap-1">
          <Text className="text-sm font-semibold text-white/80">
            Total balance · USD
          </Text>
          {loading && !account ? (
            <ActivityIndicator color={colors.card} />
          ) : (
            <Text
              accessibilityLabel="Total balance"
              className="text-5xl font-extrabold text-white"
            >
              {formatUsd(total)}
            </Text>
          )}
          <View className="mt-1 rounded-full bg-white/20 px-3 py-1">
            <Text className="text-xs font-semibold text-white">
              Sepolia testnet
            </Text>
          </View>
        </View>
        <View className="flex-row">
          <QuickAction
            light
            icon="plus"
            label="Add money"
            onPress={() => router.push('/add-money')}
          />
          <QuickAction
            light
            icon="arrow.up.right"
            label="Send"
            onPress={() => router.push('/send')}
          />
          <QuickAction
            light
            icon="qrcode"
            label="Receive"
            onPress={() => router.push('/receive')}
          />
        </View>
      </View>

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

      {needsSetup && (
        <Card tone="warn">
          <ListRow
            icon="exclamationmark.triangle.fill"
            tone="warning"
            title="Finish setting up your wallet"
            subtitle={
              account?.deployed
                ? 'Link your Safe to Swissquote to add money.'
                : 'Create your Safe to start using your wallet.'
            }
            onPress={() => router.push('/setup')}
          />
        </Card>
      )}
      {!needsSetup && unprotected && (
        <Card tone="alert">
          <ListRow
            icon="shield.slash.fill"
            tone="brand"
            title="Protect your wallet"
            subtitle="Choose 3 guardians so you never lose access."
            onPress={() => router.push('/protect')}
          />
        </Card>
      )}

      <Section title="Assets">
        <ListRow
          icon="dollarsign"
          tone="success"
          title="USD Coin"
          subtitle={`${account ? formatAmount(account.tokenBalance, 2) : '—'} USDC`}
          value={formatUsd(account?.tokenBalance ?? null)}
          caption="Test token · $1.00"
        />
        <Divider />
        <ListRow
          icon="diamond.fill"
          tone="neutral"
          title="Sepolia Ether"
          subtitle={`${account ? formatAmount(account.ethBalance, 5) : '—'} ETH`}
          value="$0.00"
          valueTone="muted"
          caption="Testnet gas · no value"
        />
      </Section>
      <Text className="px-1 text-xs leading-5 text-muted">
        Swissquote pays the network fees of your transfers and recovery. You
        keep the only key to your Safe.
      </Text>
      <ErrorText error={error} />
    </Screen>
  );
}
