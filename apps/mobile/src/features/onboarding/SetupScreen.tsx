import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { isAddressEqual } from 'viem';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { ErrorText, StepLine, Steps } from '../../components/ui';
import { getLinkStatus } from '../../lib/api';
import {
  confirmFunding,
  describeFundingError,
  getFunding,
  isActiveFunding,
  listFunding,
  prepareFunding,
  type FundingIntent,
} from '../../lib/funding';
import { getSafeAccount, getSafeWallet } from '../../lib/safeWallet';
import { createWallet, getAddress } from '../../lib/wallet';
import {
  confirmWalletLink,
  describeLinkError,
  startWalletLink,
  type LinkChallenge,
} from '../../lib/walletlink';

type Stage = 'loading' | 'key' | 'deploy' | 'link' | 'done';

/** Where this phone stands: key → deployed Safe → Swissquote link. */
async function inspect(signal: AbortSignal) {
  if (!(await getAddress())) return { stage: 'key' as const };
  const account = await getSafeAccount();
  if (!account.deployed) {
    const { intents } = await listFunding(signal);
    const intent = intents.find(
      (i) =>
        i.kind === 'deploy' &&
        // A confirmed deployment may not be visible on-chain yet: keep waiting.
        (isActiveFunding(i) || i.status === 'confirmed') &&
        isAddressEqual(i.safe_address, account.safeAddress),
    );
    return { stage: 'deploy' as const, intent: intent ?? null };
  }
  const link = await getLinkStatus(signal);
  const linked =
    link.bank_transfers_allowed &&
    link.chain_id === 11155111 &&
    !!link.safe_address &&
    !!link.owner_address &&
    isAddressEqual(link.safe_address, account.safeAddress) &&
    isAddressEqual(link.owner_address, account.ownerAddress);
  if (!linked) return { stage: 'link' as const };
  const security = await getSafeWallet().getSecurityState();
  return { stage: 'done' as const, protected: security.recovery !== null };
}

/**
 * Wallet creation after KYC (and re-linking after a recovery). Each step is
 * resumable: leaving the app or a dropped connection never repeats a signed
 * step, the screen re-reads the chain and the bank instead.
 */
export default function SetupScreen() {
  const [stage, setStage] = useState<Stage>('loading');
  const [intent, setIntent] = useState<FundingIntent | null>(null);
  const [challenge, setChallenge] = useState<LinkChallenge | null>(null);
  const [isProtected, setProtected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMessage, setShowMessage] = useState(false);
  const [tick, setTick] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const focused = useRef(false);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const sub = AppState.addEventListener('change', (s) => {
        // A real background transition invalidates a signing attempt.
        if (s === 'background') pending.current?.abort();
      });
      return () => {
        focused.current = false;
        pending.current?.abort();
        sub.remove();
      };
    }, []),
  );

  useEffect(() => {
    const controller = new AbortController();
    inspect(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setStage(result.stage);
        if (result.stage === 'deploy') setIntent(result.intent);
        if (result.stage === 'done') setProtected(result.protected);
      })
      .catch(
        (e: unknown) =>
          !controller.signal.aborted && setError(describeLinkError(e)),
      );
    return () => controller.abort();
  }, [tick]);

  // Poll a confirmed deployment until the treasury worker reports it.
  useEffect(() => {
    if (
      stage !== 'deploy' ||
      !intent ||
      intent.status === 'awaiting_confirmation' ||
      !isActiveFunding(intent)
    )
      return;
    const timer = setInterval(() => {
      getFunding(intent.id)
        .then((next) => {
          setIntent(next);
          if (next.status === 'confirmed') setTick((n) => n + 1);
          if (next.status === 'failed')
            setError(
              'Swissquote could not deploy your Safe. Check the treasury worker and its Sepolia ETH, then retry.',
            );
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [stage, intent]);

  // A deployed Safe whose status lags: re-read until the chain shows it.
  useEffect(() => {
    if (stage !== 'deploy' || intent?.status !== 'confirmed') return;
    const timer = setInterval(() => setTick((n) => n + 1), 4000);
    return () => clearInterval(timer);
  }, [stage, intent]);

  // Fetch a fresh link challenge as soon as the link step is reached.
  useEffect(() => {
    if (stage !== 'link' || challenge) return;
    const controller = new AbortController();
    startWalletLink(controller.signal)
      .then((c) => !controller.signal.aborted && setChallenge(c))
      .catch(
        (e: unknown) =>
          !controller.signal.aborted && setError(describeLinkError(e)),
      );
    return () => controller.abort();
  }, [stage, challenge]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current || AppState.currentState !== 'active') return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      await action(controller.signal);
    } catch (e) {
      if (focused.current)
        setError(
          stage === 'deploy' ? describeFundingError(e) : describeLinkError(e),
        );
      // The backend burns a link challenge after one attempt.
      if (stage === 'link') setChallenge(null);
    } finally {
      pending.current = null;
      if (focused.current) setBusy(false);
    }
  }

  const order: Stage[] = ['key', 'deploy', 'link', 'done'];
  const position = order.indexOf(stage);
  const state = (s: Stage) =>
    stage === 'loading'
      ? 'todo'
      : order.indexOf(s) < position
        ? 'done'
        : s === stage
          ? error
            ? 'error'
            : 'active'
          : 'todo';
  const deploying =
    stage === 'deploy' &&
    intent !== null &&
    ['queued', 'submitted', 'reconciling', 'confirmed'].includes(intent.status);

  let footer: React.ReactNode = null;
  if (stage === 'key')
    footer = (
      <Button
        label="Create my keys with Face ID"
        icon="faceid"
        busy={busy}
        onPress={() =>
          void run(async () => {
            await createWallet();
            setTick((n) => n + 1);
          })
        }
      />
    );
  else if (stage === 'deploy')
    footer = deploying ? (
      <Button label="Deploying on Sepolia…" busy onPress={() => {}} />
    ) : intent?.status === 'awaiting_confirmation' ? (
      <Button
        label="Confirm with Face ID"
        icon="faceid"
        busy={busy}
        onPress={() =>
          void run(async (signal) => {
            setIntent(await confirmFunding(intent, signal));
          })
        }
      />
    ) : (
      <Button
        label="Create my Safe"
        busy={busy}
        onPress={() =>
          void run(async (signal) => {
            setIntent(
              await prepareFunding('deploy', '0', randomUUID(), signal),
            );
          })
        }
      />
    );
  else if (stage === 'link')
    footer = (
      <Button
        label={challenge ? 'Sign the link with Face ID' : 'Preparing…'}
        icon="faceid"
        busy={busy || !challenge}
        onPress={() =>
          void run(async (signal) => {
            if (!challenge) return;
            await confirmWalletLink(challenge, { signal });
            setTick((n) => n + 1);
          })
        }
      />
    );
  else if (stage === 'done')
    footer = isProtected ? (
      <Button label="Open my wallet" onPress={() => router.replace('/home')} />
    ) : (
      <Button
        label="Choose my guardians"
        onPress={() =>
          router.replace({ pathname: '/protect', params: { onboarding: '1' } })
        }
      />
    );

  return (
    <Screen footer={footer}>
      <Steps current={2} total={3} />
      <View className="gap-1 py-2">
        <Text className="text-3xl font-bold text-ink">
          {stage === 'done' ? 'Your wallet is ready' : 'Set up your wallet'}
        </Text>
        <Text className="text-base leading-6 text-muted">
          Your keys are created and stay on this phone, protected by Face ID.
          Swissquote pays every network fee and never holds your keys.
        </Text>
      </View>
      <Card>
        <StepLine
          label="Create your keys"
          detail="A private key generated in this phone's secure storage"
          state={state('key')}
        />
        <StepLine
          label="Create your Safe"
          detail={
            deploying
              ? 'Swissquote is deploying your Safe on Sepolia…'
              : 'Your smart account on Sepolia, owned only by your key'
          }
          state={state('deploy')}
        />
        <StepLine
          label="Link it to Swissquote"
          detail="Sign once to prove this Safe is yours. This moves no funds."
          state={state('link')}
        />
      </Card>
      {stage === 'deploy' && intent?.status === 'awaiting_confirmation' && (
        <SignedText
          title="You confirm the wallet setup"
          text={intent.message}
          open={showMessage}
          onToggle={() => setShowMessage((v) => !v)}
        />
      )}
      {stage === 'link' && challenge && (
        <SignedText
          title="You sign this link request"
          text={challenge.message}
          open={showMessage}
          onToggle={() => setShowMessage((v) => !v)}
        />
      )}
      <ErrorText error={error} />
      {error && (
        <Button
          label="Refresh"
          variant="secondary"
          onPress={() => {
            setError(null);
            setTick((n) => n + 1);
          }}
        />
      )}
    </Screen>
  );
}

/** The exact text the key signs, folded by default. */
function SignedText({
  title,
  text,
  open,
  onToggle,
}: {
  title: string;
  text: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide signed text' : 'Show signed text'}
        onPress={onToggle}
        className="flex-row items-center justify-between"
      >
        <Text className="text-base font-semibold text-ink">{title}</Text>
        <Text className="text-sm font-semibold text-brand">
          {open ? 'Hide' : 'Show text'}
        </Text>
      </Pressable>
      {open && (
        <Text selectable className="font-mono text-xs leading-5 text-muted">
          {text}
        </Text>
      )}
    </Card>
  );
}
