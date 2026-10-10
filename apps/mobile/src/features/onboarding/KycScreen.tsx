import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { Card } from '../../components/Card';
import { Badge, ErrorText, StepLine, Steps } from '../../components/ui';
import { getClientIdentity, type ClientIdentity } from '../../lib/api';
import {
  describeLinkError,
  requireVerifiedIdentity,
} from '../../lib/walletlink';

const CHECKS = [
  { label: 'Identity document', detail: 'Reused from your Swissquote account' },
  { label: 'Proof of address', detail: 'On file since account opening' },
  { label: 'Sanctions and AML screening', detail: 'No match found' },
] as const;

/**
 * Demo KYC: the bank already knows this client, so the wallet reuses the
 * existing (simulated) identity instead of uploading documents again.
 */
export default function KycScreen() {
  const [identity, setIdentity] = useState<ClientIdentity | null>(null);
  const [checked, setChecked] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getClientIdentity(controller.signal)
      .then((p) => !controller.signal.aborted && setIdentity(p))
      .catch(
        (e: unknown) =>
          !controller.signal.aborted && setError(describeLinkError(e)),
      );
    return () => controller.abort();
  }, [attempt]);

  // Walk through the simulated checks so the user sees what is reused.
  useEffect(() => {
    if (checked < 0 || checked >= CHECKS.length) return;
    const timer = setTimeout(() => setChecked((n) => n + 1), 700);
    return () => clearTimeout(timer);
  }, [checked]);

  const running = checked >= 0 && checked < CHECKS.length;
  const finished = checked >= CHECKS.length;
  const verified = identity?.kyc_status === 'verified';

  return (
    <Screen
      footer={
        finished && verified ? (
          <Button label="Continue" onPress={() => router.replace('/setup')} />
        ) : (
          <Button
            label={running ? 'Checking…' : 'Verify my identity'}
            busy={running}
            disabled={!identity}
            onPress={() => {
              setError(null);
              try {
                if (identity) requireVerifiedIdentity(identity);
                setChecked(0);
              } catch (e) {
                setError(describeLinkError(e));
              }
            }}
          />
        )
      }
    >
      <Steps current={1} total={3} />
      <View className="gap-1 py-2">
        <Text className="text-3xl font-bold text-ink">
          Verify your identity
        </Text>
        <Text className="text-base leading-6 text-muted">
          Swissquote already knows you. We reuse your account&apos;s verified
          identity for your wallet. No new documents needed.
        </Text>
      </View>
      <Card>
        <View className="flex-row items-center justify-between">
          <Text className="text-lg font-semibold text-ink">
            {identity?.display_name ?? 'Swissquote client'}
          </Text>
          {identity ? (
            <Badge
              label={
                finished && verified
                  ? 'Verified'
                  : identity.kyc_status === 'verified'
                    ? 'On file'
                    : identity.kyc_status
              }
              tone={finished && verified ? 'success' : 'neutral'}
            />
          ) : (
            !error && <ActivityIndicator />
          )}
        </View>
        <Text className="text-sm text-muted">
          Client {identity?.client_id ?? '…'} · simulated bank KYC
        </Text>
      </Card>
      <Card>
        {CHECKS.map((c, i) => (
          <StepLine
            key={c.label}
            label={c.label}
            detail={checked > i ? c.detail : undefined}
            state={checked > i ? 'done' : checked === i ? 'active' : 'todo'}
          />
        ))}
      </Card>
      <ErrorText error={error} />
      {error && (
        <Button
          label="Try again"
          variant="secondary"
          onPress={() => {
            setError(null);
            setIdentity(null);
            setAttempt((n) => n + 1);
          }}
        />
      )}
    </Screen>
  );
}
