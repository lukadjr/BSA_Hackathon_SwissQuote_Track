import { shortAddress, type Address } from '@swissquote/wallet-core';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import {
  describeError,
  periodLabel,
  recoveryModule,
  saveGuardianLabels,
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

type Step = 'intro' | 'backup' | 'friend' | 'review' | 'done';

/** Owner phone: backup phrase + Swissquote + friend → one Safe operation. */
export default function ProtectScreen() {
  const [step, setStep] = useState<Step>('intro');
  const [safe, setSafe] = useState<Address | null>(null);
  const [backup, setBackup] = useState<Address | null>(null);
  const [friend, setFriend] = useState<Address | null>(null);
  const [swissquote, setSwissquote] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guardians live in a Safe module, so the Safe must exist on-chain first.
  const [notDeployed, setNotDeployed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getSafeWallet().getSecurityState(),
      getSwissquoteGuardian(controller.signal),
    ])
      .then(([state, sq]) => {
        if (controller.signal.aborted) return;
        if (!state.deployed) {
          setNotDeployed(true);
          return;
        }
        if (state.recovery) {
          router.replace('/recovery');
          return;
        }
        setSafe(state.safeAddress);
        setSwissquote(sq.address);
      })
      .catch(
        (e: unknown) =>
          !controller.signal.aborted && setError(describeError(e)),
      );
    return () => controller.abort();
  }, []);

  const action = useMemo(
    () =>
      backup && friend && swissquote
        ? ({
            kind: 'protect',
            module: recoveryModule(),
            guardians: { backup, swissquote, friend },
          } as const)
        : null,
    [backup, friend, swissquote],
  );

  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Protect your wallet</Text>
      {error && (
        <Card>
          <ErrorText error={error} />
        </Card>
      )}
      {notDeployed && (
        <Card>
          <Text className="text-lg font-semibold text-ink">
            Your Safe is not deployed yet
          </Text>
          <Text className="text-base text-muted">
            Recovery guardians are stored in your Safe on Sepolia. Add money
            once from the demo bank: Swissquote then deploys your Safe, and you
            can come back here to add guardians.
          </Text>
          <Button
            label="Add money"
            onPress={() => router.replace('/add-money')}
          />
          <Button label="Back" secondary onPress={() => router.back()} />
        </Card>
      )}
      {!safe && !error && !notDeployed && <ActivityIndicator />}
      {safe && step === 'intro' && (
        <Card>
          <Text className="text-base text-muted">
            If you lose this phone, any 2 of these 3 guardians can move your
            Safe to a new phone key:
          </Text>
          <Text className="text-base text-ink">
            1. Your backup phrase (12 words on paper)
          </Text>
          <Text className="text-base text-ink">
            2. Swissquote, after an identity check
          </Text>
          <Text className="text-base text-ink">
            3. A trusted friend, with their own app
          </Text>
          <Text className="text-base text-muted">
            A recovery only takes effect after {periodLabel()}. During that time
            this phone gets an alert and can cancel it. Guardians cannot spend
            directly, but any two can replace the owner after the waiting
            period.
          </Text>
          <Button label="Start" onPress={() => setStep('backup')} />
        </Card>
      )}
      {safe && step === 'backup' && (
        <BackupPhraseSteps
          onDone={(address) => {
            setBackup(address);
            setStep('friend');
          }}
        />
      )}
      {safe && step === 'friend' && (
        <FriendInvite
          safe={safe}
          onConfirmed={(address) => {
            setFriend(address);
            setStep('review');
          }}
        />
      )}
      {step === 'review' && action && (
        <SecurityReview
          action={action}
          title="Review and confirm"
          onDone={async () => {
            await saveGuardianLabels({
              [action.guardians.backup]: 'backup',
              [action.guardians.swissquote]: 'swissquote',
              [action.guardians.friend]: 'friend',
            }).catch(() => {});
            setStep('done');
          }}
        >
          <AddressLine
            label="Backup phrase guardian"
            address={action.guardians.backup}
          />
          <AddressLine
            label="Swissquote guardian"
            address={action.guardians.swissquote}
          />
          <AddressLine
            label="Friend's guardian"
            address={action.guardians.friend}
          />
          <Text className="text-sm text-muted">
            Any 2 of 3 can start a recovery. Waiting period: {periodLabel()}.
          </Text>
        </SecurityReview>
      )}
      {step === 'done' && (
        <Card tone="ok">
          <Text className="text-lg font-semibold text-ink">
            Your wallet is protected
          </Text>
          <Text className="text-base text-muted">
            The change is confirmed on Sepolia: 3 guardians, any 2 can recover,
            after {periodLabel()}. Keep your paper with the 12 words for backup{' '}
            {backup ? shortAddress(backup) : ''} safe.
          </Text>
          <Button label="Done" onPress={() => router.replace('/recovery')} />
        </Card>
      )}
      <View className="h-4" />
    </Screen>
  );
}
