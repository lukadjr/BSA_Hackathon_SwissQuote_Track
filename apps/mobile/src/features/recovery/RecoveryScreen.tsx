import { shortAddress, type Address } from '@swissquote/wallet-core';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { useSecurityState } from '../../hooks/useSecurityState';
import {
  periodLabel,
  readGuardianLabels,
  roleTitle,
  type GuardianLabels,
  type GuardianRole,
} from '../../lib/recovery';
import { ErrorText } from './parts';
import { RecoveryAlert, RequestedAlert } from './RecoveryAlert';

/** Security & recovery: on-chain guardians, pending recovery, alerts. */
export default function RecoveryScreen() {
  const { state, status, error, refresh } = useSecurityState();
  const [labels, setLabels] = useState<GuardianLabels>({});
  useEffect(() => {
    readGuardianLabels()
      .then(setLabels)
      .catch(() => setLabels({}));
  }, [state]);

  const roleOf = (g: Address): GuardianRole | undefined =>
    labels[g.toLowerCase()] ??
    (status?.swissquoteGuardian?.toLowerCase() === g.toLowerCase()
      ? 'swissquote'
      : undefined);

  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Security & recovery</Text>
      <ErrorText error={error} />
      {!state && !error && <ActivityIndicator />}
      {state && <RecoveryAlert state={state} onChanged={refresh} />}
      {state && (
        <RequestedAlert state={state} status={status} onChanged={refresh} />
      )}
      {state && !state.recovery && (
        <Card>
          <Text className="text-lg font-semibold text-ink">
            Your wallet is not protected yet
          </Text>
          <Text className="text-base text-muted">
            Without recovery, losing this phone means losing access to your
            Safe. Add 3 guardians (your backup phrase, Swissquote and a trusted
            friend); any 2 can move the Safe to a new phone after{' '}
            {periodLabel()}.
          </Text>
          <Button
            label="Protect my wallet"
            onPress={() => router.push('/protect')}
          />
        </Card>
      )}
      {state?.recovery && (
        <Card>
          <Text className="text-lg font-semibold text-ink">
            Guardians (on-chain)
          </Text>
          <Text className="text-sm text-muted">
            Any {state.recovery.threshold} of {state.recovery.guardians.length}{' '}
            can recover your wallet after {periodLabel()}. You can cancel during
            that time from this phone.
          </Text>
          {state.recovery.guardians.map((g) => {
            const role = roleOf(g);
            return (
              <View key={g} className="gap-2 border-t border-line pt-3">
                <Text className="text-base font-semibold text-ink">
                  {roleTitle(role)}
                </Text>
                <Text selectable className="text-xs text-muted">
                  {g}
                </Text>
                {!state.recovery?.pending && (
                  <Button
                    label={
                      role === 'swissquote'
                        ? 'Update Swissquote guardian'
                        : role === 'backup'
                          ? 'Lost my phrase: create a new one'
                          : role === 'friend'
                            ? 'Replace my friend'
                            : 'Replace this guardian'
                    }
                    secondary
                    onPress={() =>
                      router.push({
                        pathname: '/replace-guardian',
                        params: { old: g, role: role ?? 'friend' },
                      })
                    }
                  />
                )}
              </View>
            );
          })}
        </Card>
      )}
      {status && status.alerts.length > 0 && (
        <Card>
          <Text className="text-lg font-semibold text-ink">Alerts</Text>
          {status.alerts.slice(0, 5).map((a, i) => (
            <View key={i} className="gap-1 border-t border-line pt-3">
              <Text className="text-xs text-muted">{a.createdAt}</Text>
              <Text className="text-sm text-ink">{a.message}</Text>
            </View>
          ))}
        </Card>
      )}
      {state && (
        <Text className="text-xs text-muted">
          Safe {shortAddress(state.safeAddress)} · owner key{' '}
          {shortAddress(state.ownerAddress)}
        </Text>
      )}
      <Button
        label="Be a guardian for a friend"
        secondary
        onPress={() => router.push('/guardian')}
      />
      <Button label="Refresh" secondary onPress={refresh} />
    </Screen>
  );
}
