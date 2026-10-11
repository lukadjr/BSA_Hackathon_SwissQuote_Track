import { shortAddress, type Address } from '@swissquote/wallet-core';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import {
  Badge,
  Divider,
  ErrorText,
  ListRow,
  Section,
} from '../../components/ui';
import type { IconName } from '../../components/Icon';
import { useSecurityState } from '../../hooks/useSecurityState';
import {
  periodLabel,
  readGuardianLabels,
  roleTitle,
  type GuardianLabels,
  type GuardianRole,
} from '../../lib/recovery';
import { getSafeWallet } from '../../lib/safeWallet';
import { treasuryRelay } from '../../lib/treasuryRelay';
import { describeWalletError } from '../../lib/wallet';
import { GuardianPanel } from '../recovery/GuardianScreen';
import { RecoveryAlert, RequestedAlert } from '../recovery/RecoveryAlert';

type Tab = 'mine' | 'protect';

const ROLE_ICON: Record<GuardianRole, IconName> = {
  backup: 'doc.text.fill',
  swissquote: 'building.columns.fill',
  friend: 'person.fill',
};

/** My three guardians, and the people I protect as a guardian. */
export default function GuardiansScreen() {
  const [tab, setTab] = useState<Tab>('mine');
  return (
    <Screen edgeToEdge inTabs title="Guardians">
      <View className="flex-row rounded-full bg-card p-1">
        <Segment
          label="My guardians"
          active={tab === 'mine'}
          onPress={() => setTab('mine')}
        />
        <Segment
          label="I protect"
          active={tab === 'protect'}
          onPress={() => setTab('protect')}
        />
      </View>
      {tab === 'mine' ? <MyGuardians /> : <GuardianPanel />}
    </Screen>
  );
}

function Segment({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      className={`flex-1 items-center rounded-full py-2.5 ${active ? 'bg-ink' : ''}`}
    >
      <Text
        className={`text-sm font-semibold ${active ? 'text-white' : 'text-muted'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MyGuardians() {
  const { state, status, error, refresh } = useSecurityState();
  const [labels, setLabels] = useState<GuardianLabels>({});
  const [pendingOp, setPendingOp] = useState(false);
  const [checking, setChecking] = useState(false);
  const [relayMessage, setRelayMessage] = useState<string | null>(null);

  useEffect(() => {
    readGuardianLabels()
      .then(setLabels)
      .catch(() => setLabels({}));
    treasuryRelay
      .readPending()
      .then((op) => setPendingOp(!!op && op.kind !== 'transfer'))
      .catch((e) => setRelayMessage(describeWalletError(e)));
  }, [state]);

  async function checkPending() {
    setChecking(true);
    try {
      const result = await getSafeWallet().resumePendingRelay();
      setRelayMessage(
        result
          ? result.success
            ? 'Security operation confirmed.'
            : 'Security operation failed.'
          : 'Still pending at Swissquote. Check again shortly.',
      );
      const op = await treasuryRelay.readPending();
      setPendingOp(!!op && op.kind !== 'transfer');
      refresh();
    } catch (e) {
      setRelayMessage(describeWalletError(e));
    } finally {
      setChecking(false);
    }
  }

  const roleOf = (g: Address): GuardianRole | undefined =>
    labels[g.toLowerCase()] ??
    (status?.swissquoteGuardian?.toLowerCase() === g.toLowerCase()
      ? 'swissquote'
      : undefined);

  return (
    <>
      <ErrorText error={error} />
      {!state && !error && <ActivityIndicator />}
      {state && <RecoveryAlert state={state} onChanged={refresh} />}
      {state && (
        <RequestedAlert state={state} status={status} onChanged={refresh} />
      )}
      {pendingOp && (
        <Button
          label={checking ? 'Checking…' : 'Check pending security change'}
          variant="secondary"
          busy={checking}
          onPress={() => void checkPending()}
        />
      )}
      {relayMessage && (
        <Text className="px-1 text-sm text-muted">{relayMessage}</Text>
      )}

      {state && !state.recovery && (
        <Card tone="alert">
          <Text className="text-lg font-bold text-ink">
            Your wallet is not protected
          </Text>
          <Text className="text-base leading-6 text-muted">
            Without guardians, losing this phone means losing your wallet.
            Choose your backup phrase, Swissquote and a trusted friend.
          </Text>
          <Button
            label={
              state.deployed ? 'Choose my guardians' : 'Finish setup first'
            }
            onPress={() => router.push(state.deployed ? '/protect' : '/setup')}
          />
        </Card>
      )}

      {state?.recovery && (
        <>
          <Card>
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-bold text-ink">
                Recovery is active
              </Text>
              <Badge label="Protected" tone="success" />
            </View>
            <Text className="text-sm leading-5 text-muted">
              Any {state.recovery.threshold} of{' '}
              {state.recovery.guardians.length} guardians can move your wallet
              to a new phone after {periodLabel()}. This phone can cancel during
              that time.
            </Text>
          </Card>
          <Section title="My guardians">
            {state.recovery.guardians.map((g, i) => {
              const role = roleOf(g);
              return (
                <View key={g}>
                  {i > 0 && <Divider />}
                  <ListRow
                    icon={role ? ROLE_ICON[role] : 'person.crop.circle'}
                    tone={role === 'swissquote' ? 'brand' : 'neutral'}
                    title={roleTitle(role)}
                    subtitle={shortAddress(g)}
                    caption={state.recovery?.pending ? undefined : 'Replace'}
                    onPress={
                      state.recovery?.pending
                        ? undefined
                        : () =>
                            router.push({
                              pathname: '/replace-guardian',
                              params: { old: g, role: role ?? 'friend' },
                            })
                    }
                  />
                </View>
              );
            })}
          </Section>
        </>
      )}

      {status && status.alerts.length > 0 && (
        <Section title="Security alerts">
          {status.alerts.slice(0, 5).map((a, i) => (
            <View key={i}>
              {i > 0 && <Divider />}
              <ListRow
                icon="bell.fill"
                tone="warning"
                title={
                  a.kind === 'recovery_started'
                    ? 'Recovery started'
                    : 'Recovery requested'
                }
                subtitle={a.message}
              />
            </View>
          ))}
        </Section>
      )}
    </>
  );
}
