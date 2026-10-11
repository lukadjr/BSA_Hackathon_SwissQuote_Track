import { type Address } from '@swissquote/wallet-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { OnboardingBackButton } from '../../components/OnboardingBackButton';
import { ListRow, Steps } from '../../components/ui';
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

/**
 * Owner phone: the three trusted guardians (backup phrase, Swissquote, a
 * friend) written to the Safe in one operation. Any 2 of 3 can recover.
 */
export default function ProtectScreen() {
  const { onboarding } = useLocalSearchParams<{ onboarding?: string }>();
  const inOnboarding = onboarding === '1';
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
          setStep('done');
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

  const progress = { intro: 0, backup: 1, friend: 2, review: 3, done: 4 }[step];

  return (
    <Screen
      footer={
        step === 'intro' && safe ? (
          <>
            <Button label="Start" onPress={() => setStep('backup')} />
          </>
        ) : step === 'done' ? (
          <Button
            label={inOnboarding ? 'Open my wallet' : 'Done'}
            onPress={() =>
              inOnboarding ? router.replace('/home') : router.back()
            }
          />
        ) : undefined
      }
    >
      <Stack.Screen
        options={{
          headerBackVisible: !inOnboarding,
          ...(inOnboarding
            ? {
                headerLeft: () => (
                  <OnboardingBackButton route="/protect?onboarding=1" />
                ),
              }
            : {}),
        }}
      />
      {inOnboarding && <Steps current={3} total={3} />}
      {!inOnboarding && <Steps current={progress} total={4} />}
      <View className="gap-1 py-2">
        <Text className="text-3xl font-bold text-ink">
          {step === 'done' ? 'Your wallet is protected' : 'Trusted guardians'}
        </Text>
        <Text className="text-base leading-6 text-muted">
          {step === 'done'
            ? `Any 2 of your 3 guardians can move your wallet to a new phone, after ${periodLabel()}.`
            : 'If you lose this phone, any 2 of these 3 guardians bring your wallet back.'}
        </Text>
      </View>
      <ErrorText error={error} />
      {notDeployed && (
        <Card tone="warn">
          <Text className="text-base text-ink">
            Your Safe is not deployed yet. Finish the wallet setup first.
          </Text>
          <Button
            label="Finish setup"
            onPress={() => router.replace('/setup')}
          />
        </Card>
      )}
      {!safe && !error && !notDeployed && step !== 'done' && (
        <ActivityIndicator />
      )}
      {safe && step === 'intro' && (
        <>
          <Card>
            <ListRow
              icon="doc.text.fill"
              tone="neutral"
              title="Your backup phrase"
              subtitle="12 words on paper, kept away from this phone"
            />
            <ListRow
              icon="building.columns.fill"
              tone="brand"
              title="Swissquote Wallet"
              subtitle="Approves after checking your identity"
            />
            <ListRow
              icon="person.fill"
              tone="success"
              title="A trusted friend"
              subtitle="Approves from their own Swissquote Wallet app"
            />
          </Card>
          <Text className="px-1 text-sm leading-5 text-muted">
            A recovery only takes effect after {periodLabel()}. During that time
            this phone is alerted and can cancel it. Guardians can never spend
            your money.
          </Text>
        </>
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
          <ListRow
            icon="checkmark.shield.fill"
            tone="success"
            title="Recovery is active on Sepolia"
            subtitle="Keep your paper with the 12 words somewhere safe."
          />
        </Card>
      )}
    </Screen>
  );
}
