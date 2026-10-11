// Building blocks shared by the protect, replace-guardian and recovery flows.
import {
  addressWords,
  createBackupPhrase,
  SAFE_DEPLOYMENT,
  shortAddress,
  type Address,
  parseQrPayload,
  verifyGuardianAcceptance,
  type GuardianInvitePayload,
  type SecurityAction,
  type SecurityPreview,
} from '@swissquote/wallet-core';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { QrCode } from '../../components/QrCode';
import { QrScanner } from '../../components/QrScanner';
import { isAddressEqual } from 'viem';
import { describeError, runSecurityOperation } from '../../lib/recovery';
import {
  createGuardianInvite,
  readGuardianInvite,
} from '../../lib/recoveryApi';
import { getSafeWallet } from '../../lib/safeWallet';
import { getSession } from '../../lib/auth';
import { ErrorText } from '../../components/ui';

export function AddressLine({
  label,
  address,
}: {
  label: string;
  address: string;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-muted">{label}</Text>
      <Text selectable className="text-sm text-ink">
        {address}
      </Text>
    </View>
  );
}

/** The 4 words both phones must show before anything is trusted. */
export function Words({
  address,
  caption,
}: {
  address: Address;
  caption: string;
}) {
  return (
    <View className="gap-1 rounded-2xl bg-ink p-4">
      <Text className="text-xs font-semibold uppercase text-white/70">
        {caption}
      </Text>
      <Text className="text-2xl font-bold text-white">
        {addressWords(address)}
      </Text>
      <Text className="text-xs text-white/70">{shortAddress(address)}</Text>
    </View>
  );
}

export { ErrorText } from '../../components/ui';

/**
 * Create a backup phrase, show it once, then check 3 words. The phrase lives
 * only in this component's memory; only the derived address is returned.
 */
export function BackupPhraseSteps({
  onDone,
}: {
  onDone: (address: Address) => void;
}) {
  const backup = useMemo(() => createBackupPhrase(), []);
  const words = backup.phrase.split(' ');
  const [checking, setChecking] = useState(false);
  const positions = useMemo(() => {
    const picked = new Set<number>();
    const random = new Uint8Array(8);
    crypto.getRandomValues(random);
    for (const byte of random) {
      picked.add(byte % 12);
      if (picked.size === 3) break;
    }
    while (picked.size < 3) picked.add(picked.size * 4);
    return [...picked].sort((a, b) => a - b);
  }, []);
  const [answers, setAnswers] = useState(['', '', '']);
  const [error, setError] = useState<string | null>(null);

  if (!checking)
    return (
      <Card>
        <Text className="text-lg font-semibold text-ink">
          Your backup phrase
        </Text>
        <Text className="text-base text-muted">
          Write these 12 words on paper and keep them away from this phone. They
          are one of your three guardians: with Swissquote or your friend, they
          let you recover the wallet. Never type them into a website or share
          them.
        </Text>
        <View className="flex-row flex-wrap gap-2">
          {words.map((word, i) => (
            <View key={i} className="rounded-xl bg-canvas px-3 py-2">
              <Text className="text-base text-ink">
                {i + 1}. {word}
              </Text>
            </View>
          ))}
        </View>
        <Button label="I wrote them down" onPress={() => setChecking(true)} />
      </Card>
    );
  return (
    <Card>
      <Text className="text-lg font-semibold text-ink">Check your backup</Text>
      {positions.map((p, i) => (
        <View key={p} className="gap-1">
          <Text className="text-sm text-muted">Word #{p + 1}</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            value={answers[i]}
            onChangeText={(text) =>
              setAnswers((a) => a.map((v, j) => (j === i ? text : v)))
            }
            className="rounded-xl bg-canvas px-3 py-3 text-base text-ink"
          />
        </View>
      ))}
      <ErrorText error={error} />
      <Button
        label="Confirm"
        onPress={() => {
          const ok = positions.every(
            (p, i) => answers[i].trim().toLowerCase() === words[p],
          );
          if (ok) onDone(backup.address);
          else setError('These words do not match. Check your paper.');
        }}
      />
      <Button
        label="Show the words again"
        secondary
        onPress={() => setChecking(false)}
      />
    </Card>
  );
}

/**
 * Owner side of the friend invite: QR code, wait for the friend's app, then
 * compare the 4 words read aloud. Returns the confirmed guardian address.
 */
export function FriendInvite({
  safe,
  onConfirmed,
}: {
  safe: Address;
  onConfirmed: (guardian: Address) => void;
}) {
  const [payload, setPayload] = useState<GuardianInvitePayload | null>(null);
  const [guardian, setGuardian] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const restart = () => {
    setPayload(null);
    setGuardian(null);
    setError(null);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    getSession()
      .catch(() => null)
      .then((session) =>
        createGuardianInvite(safe, controller.signal, session?.username),
      )
      .then((invite) => {
        setPayload({
          t: 'sqw-guardian-invite',
          v: 1,
          chainId: SAFE_DEPLOYMENT.chainId,
          safe,
          invite: invite.inviteId,
          from: invite.from,
        });
        timer.current = setInterval(() => {
          readGuardianInvite(invite.inviteId, controller.signal)
            .then((state) => {
              if (state.status === 'accepted' && state.guardianAddress) {
                setGuardian(state.guardianAddress);
                if (timer.current) clearInterval(timer.current);
              }
            })
            .catch(() => {});
        }, 2000);
      })
      .catch(
        (e: unknown) =>
          !controller.signal.aborted && setError(describeError(e)),
      );
    return () => {
      controller.abort();
      if (timer.current) clearInterval(timer.current);
    };
  }, [safe, attempt]);

  if (error)
    return (
      <Card>
        <ErrorText error={error} />
        <Button label="Try again" onPress={restart} />
      </Card>
    );
  if (!payload) return <ActivityIndicator />;
  if (!guardian)
    return (
      <Card>
        <Text className="text-lg font-semibold text-ink">
          Add your trusted friend
        </Text>
        <Text className="text-base text-muted">
          Your friend opens Swissquote Wallet on their phone, taps “Be a
          guardian” and scans this code. The code expires in 15 minutes. If
          their phone cannot reach Swissquote, it shows a code: scan it below.
        </Text>
        <QrCode shareable value={JSON.stringify(payload)} />
        <View className="flex-row items-center gap-2">
          <ActivityIndicator />
          <Text className="text-sm text-muted">Waiting for your friend…</Text>
        </View>
        <Button label="Generate a new code" variant="ghost" onPress={restart} />
        <ErrorText error={scanError} />
        <Button
          label="Scan my friend’s code"
          secondary
          onPress={() => setScanning(true)}
        />
        <QrScanner
          visible={scanning}
          title="Scan your friend's guardian code"
          onClose={() => setScanning(false)}
          onScanned={(text) => {
            setScanning(false);
            setScanError(null);
            void (async () => {
              try {
                const p = parseQrPayload(text);
                if (
                  p.t !== 'sqw-guardian-accept' ||
                  p.invite !== payload.invite ||
                  !isAddressEqual(p.safe, safe) ||
                  !(await verifyGuardianAcceptance(p))
                )
                  throw new Error();
                if (timer.current) clearInterval(timer.current);
                setGuardian(p.guardian);
              } catch {
                setScanError('This is not your friend’s code for this invite.');
              }
            })();
          }}
        />
      </Card>
    );
  return (
    <Card>
      <Text className="text-lg font-semibold text-ink">
        Check with your friend
      </Text>
      <Text className="text-base text-muted">
        Your friend’s phone now shows 4 words. They must be exactly these. If
        they differ, someone is in the middle: do not continue.
      </Text>
      <Words address={guardian} caption="Friend's guardian key" />
      <Button label="The words match" onPress={() => onConfirmed(guardian)} />
      <Button
        label="They don't match: start again"
        secondary
        onPress={restart}
      />
    </Card>
  );
}

/**
 * Review → Face ID → on-chain inclusion for an owner-signed security change.
 * Aborts the signing attempt if the app goes to the background.
 */
export function SecurityReview({
  action,
  title,
  children,
  confirmLabel = 'Confirm with Face ID',
  onDone,
}: {
  action: SecurityAction;
  title: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  onDone: (transactionHash: string) => void;
}) {
  const [preview, setPreview] = useState<SecurityPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getSafeWallet()
      .prepareSecurityOperation(action, controller.signal)
      .then((p) => !controller.signal.aborted && setPreview(p))
      .catch(
        (e: unknown) =>
          !controller.signal.aborted && setError(describeError(e)),
      );
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') pending.current?.abort();
    });
    return () => {
      controller.abort();
      pending.current?.abort();
      subscription.remove();
    };
    // The action object is created by the parent for one review only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  async function confirm() {
    if (!preview || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      const { transactionHash } = await runSecurityOperation(
        preview,
        controller.signal,
      );
      onDone(transactionHash);
    } catch (e) {
      setError(describeError(e));
      setPreview(null);
    } finally {
      pending.current = null;
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text className="text-lg font-semibold text-ink">{title}</Text>
      {children}
      {preview && (
        <>
          <AddressLine label="Safe" address={preview.safeAddress} />
          <Text className="text-sm text-muted">
            Network fee: covered by Swissquote
            {preview.deploysSafe ? ' (this also deploys your Safe)' : ''}.
          </Text>
        </>
      )}
      <ErrorText error={error} />
      {preview ? (
        <Button
          label={busy ? 'Confirming…' : confirmLabel}
          disabled={busy}
          onPress={() => void confirm()}
        />
      ) : error ? (
        <Button
          label="Prepare again"
          secondary
          onPress={() => {
            setError(null);
            setAttempt((n) => n + 1);
          }}
        />
      ) : (
        <ActivityIndicator />
      )}
    </Card>
  );
}
