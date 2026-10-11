import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  Text,
  View,
} from 'react-native';
import { shortAddress } from '@swissquote/wallet-core';
import { Icon, type IconName } from '../../components/Icon';
import { Screen } from '../../components/Screen';
import { Divider, ErrorText, ListRow, Section } from '../../components/ui';
import {
  buildActivity,
  readSentTransfers,
  type ActivityItem,
} from '../../lib/activity';
import { formatAmount, formatWhen } from '../../lib/format';
import { listFunding } from '../../lib/funding';
import { getSafeAccount } from '../../lib/safeWallet';
import { describeWalletError } from '../../lib/wallet';
import { colors } from '../../theme/colors';

/** Move money: add from Swissquote, send, receive, and recent activity. */
export default function PaymentsScreen() {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useFocusEffect(
    useCallback(() => {
      void tick;
      let active = true;
      setItems(null);
      setError(null);
      (async () => {
        const account = await getSafeAccount();
        const [bank, sent] = await Promise.all([
          listFunding()
            .then((r) => r.intents)
            .catch(() => []), // Swissquote offline: still show local transfers
          readSentTransfers(),
        ]);
        return buildActivity(bank, sent, account.safeAddress);
      })()
        .then((list) => {
          if (!active) return;
          setItems(list);
          setError(null);
        })
        .catch((e: unknown) => active && setError(describeWalletError(e)));
      return () => {
        active = false;
      };
    }, [tick]),
  );

  return (
    <Screen
      edgeToEdge
      inTabs
      title="Payments"
      onRefresh={() => setTick((n) => n + 1)}
      refreshing={false}
    >
      <View className="flex-row gap-3">
        <Tile
          icon="plus"
          label="Add money"
          primary
          onPress={() => router.push('/add-money')}
        />
        <Tile
          icon="arrow.up.right"
          label="Send"
          onPress={() => router.push('/send')}
        />
        <Tile
          icon="qrcode"
          label="Receive"
          onPress={() => router.push('/receive')}
        />
      </View>

      <Section title="Recent transactions">
        {items === null && !error && (
          <View className="py-6">
            <ActivityIndicator />
          </View>
        )}
        {items?.length === 0 && (
          <ListRow
            icon="clock"
            title="No transactions yet"
            subtitle="Add money from your Swissquote account to get started."
          />
        )}
        {items?.map((item, i) => (
          <View key={item.id}>
            {i > 0 && <Divider />}
            <ActivityRow item={item} />
          </View>
        ))}
      </Section>
      <ErrorText error={error} />
    </Screen>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const open = item.transactionHash
    ? () =>
        void Linking.openURL(
          `https://sepolia.etherscan.io/tx/${item.transactionHash}`,
        ).catch(() => {})
    : undefined;
  const title =
    item.kind === 'sent'
      ? `To ${shortAddress(item.counterparty as `0x${string}`)}`
      : item.kind === 'deposit'
        ? 'From Swissquote'
        : 'Wallet created';
  const status =
    item.status === 'pending'
      ? 'Pending'
      : item.status === 'failed'
        ? 'Failed'
        : formatWhen(item.at);
  return (
    <ListRow
      icon={
        item.kind === 'sent'
          ? 'arrow.up.right'
          : item.kind === 'deposit'
            ? 'arrow.down.left'
            : 'sparkles'
      }
      tone={
        item.status === 'failed'
          ? 'brand'
          : item.kind === 'deposit'
            ? 'success'
            : 'neutral'
      }
      title={title}
      subtitle={
        status || (item.kind === 'setup' ? 'Fee paid by Swissquote' : '')
      }
      value={
        item.amount === null
          ? undefined
          : `${item.kind === 'sent' ? '-' : '+'}${formatAmount(item.amount, 2)} USDC`
      }
      valueTone={item.kind === 'deposit' ? 'success' : 'ink'}
      onPress={open}
    />
  );
}

function Tile({
  icon,
  label,
  onPress,
  primary = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={`flex-1 gap-6 rounded-3xl p-4 active:opacity-80 ${primary ? 'bg-brand' : 'bg-card'}`}
    >
      <View
        className={`h-10 w-10 items-center justify-center rounded-full ${primary ? 'bg-white/20' : 'bg-canvas'}`}
      >
        <Icon
          name={icon}
          size={18}
          color={primary ? colors.card : colors.ink}
        />
      </View>
      <Text
        className={`text-base font-bold ${primary ? 'text-white' : 'text-ink'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
