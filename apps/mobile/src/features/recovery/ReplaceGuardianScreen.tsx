import { isAddress, isAddressEqual, type Address } from 'viem';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import {
  describeError,
  roleTitle,
  saveGuardianLabel,
  type GuardianRole,
} from '../../lib/recovery';
import { getSwissquoteGuardian } from '../../lib/recoveryApi';
import { getSafeWallet } from '../../lib/safeWallet';
import {
  AddressLine,
  BackupPhraseSteps,
  ErrorText,
  FriendInvite,
  SecurityReview,
} from './parts';

/**
 * The owner swaps one guardian (lost phrase, friend lost their phone,
 * Swissquote rotated its key). Immediate: it is the owner's own decision.
 */
export default function ReplaceGuardianScreen() {
  const params = useLocalSearchParams<{ old: string; role: string }>();
  const role: GuardianRole =
    params.role === 'backup' || params.role === 'swissquote'
      ? params.role
      : 'friend';
  const old = isAddress(params.old ?? '') ? (params.old as Address) : null;
  const [safe, setSafe] = useState<Address | null>(null);
  const [replacement, setReplacement] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    getSafeWallet()
      .getSecurityState()
      .then(async (state) => {
        setSafe(state.safeAddress);
        if (role === 'swissquote') {
          const sq = await getSwissquoteGuardian();
          if (old && isAddressEqual(sq.address, old))
            setError(
              'Swissquote’s guardian key has not changed: nothing to update.',
            );
          else setReplacement(sq.address);
        }
      })
      .catch((e: unknown) => setError(describeError(e)));
  }, [role, old]);

  if (!old)
    return (
      <Screen>
        <ErrorText error="Unknown guardian." />
      </Screen>
    );
  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">
        Replace: {roleTitle(role)}
      </Text>
      <AddressLine label="Guardian removed" address={old} />
      <ErrorText error={error} />
      {!safe && !error && <ActivityIndicator />}
      {safe && !replacement && role === 'backup' && (
        <BackupPhraseSteps onDone={setReplacement} />
      )}
      {safe && !replacement && role === 'friend' && (
        <FriendInvite safe={safe} onConfirmed={setReplacement} />
      )}
      {replacement && !done && (
        <SecurityReview
          action={{
            kind: 'replace-guardian',
            oldGuardian: old,
            newGuardian: replacement,
          }}
          title="Confirm the new guardian"
          onDone={async () => {
            await saveGuardianLabel(replacement, role).catch(() => {});
            setDone(true);
          }}
        >
          <AddressLine label="New guardian" address={replacement} />
          <Text className="text-sm text-muted">
            The old guardian stops counting immediately. Still any 2 of 3.
          </Text>
        </SecurityReview>
      )}
      {done && (
        <Card tone="ok">
          <Text className="text-lg font-semibold text-ink">
            Guardian replaced
          </Text>
          <Button label="Back to security" onPress={() => router.back()} />
        </Card>
      )}
    </Screen>
  );
}
