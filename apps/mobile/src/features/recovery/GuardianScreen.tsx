import {
  parseQrPayload,
  SAFE_DEPLOYMENT,
  shortAddress,
  type Address,
  type GuardianAcceptPayload,
  type GuardianInvitePayload,
  type RecoveryApprovalPayload,
  type RecoveryRequestPayload,
} from '@swissquote/wallet-core';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { isAddressEqual } from 'viem';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { QrCode } from '../../components/QrCode';
import { QrScanner } from '../../components/QrScanner';
import { Screen } from '../../components/Screen';
import {
  getGuardianAddress,
  listGuardedWallets,
  rememberGuardedWallet,
  signApprovalAsGuardian,
  signInviteAcceptance,
  type GuardedWallet,
} from '../../lib/guardianKey';
import { describeError, getRecoveryClient } from '../../lib/recovery';
import {
  acceptGuardianInvite,
  addRecoveryApproval,
  listGuardianRequests,
  listProtectedWallets,
  type GuardianRequest,
  type ProtectedWallet,
} from '../../lib/recoveryApi';
import { Divider, ListRow, Section } from '../../components/ui';
import { AddressLine, ErrorText, Words } from './parts';

type Guarded = GuardedWallet & { active: boolean | null };

/** This phone's list plus what Swissquote recorded (another phone, reinstall). */
function mergeGuarded(
  local: GuardedWallet[],
  remote: ProtectedWallet[],
): Guarded[] {
  const bySafe = new Map<string, Guarded>();
  for (const w of local)
    bySafe.set(w.safe.toLowerCase(), { ...w, active: null });
  for (const w of remote)
    bySafe.set(w.safeAddress.toLowerCase(), {
      safe: w.safeAddress,
      from: w.from,
      acceptedAt: w.acceptedAt ?? bySafe.get(w.safeAddress)?.acceptedAt ?? '',
      active: w.active,
    });
  return [...bySafe.values()].filter((w) => w.active !== false);
}

type View_ =
  | { kind: 'home' }
  | { kind: 'invite'; payload: GuardianInvitePayload }
  | {
      kind: 'invite-done';
      guardian: Address;
      from: string;
      /** Set when Swissquote was unreachable: the owner scans this instead. */
      offline: GuardianAcceptPayload | null;
    }
  | { kind: 'approve'; payload: RecoveryRequestPayload }
  | { kind: 'approved'; payload: RecoveryApprovalPayload; sent: boolean };

/** Standalone route (from the welcome screen, before any login). */
export default function GuardianScreen() {
  return (
    <Screen
      title="Be a guardian"
      subtitle="Help a friend get their wallet back if they lose their phone."
    >
      <GuardianPanel
        onAccepted={() => (router.canGoBack() ? router.back() : undefined)}
      />
    </Screen>
  );
}

/** The friend's side: accept invites, list who I protect, approve recoveries. */
export function GuardianPanel({
  onAccepted,
}: {
  /** Called when the user closes the "you are now a guardian" result. */
  onAccepted?: () => void;
} = {}) {
  const [view, setView] = useState<View_>({ kind: 'home' });
  const [scanning, setScanning] = useState(false);
  const [guardian, setGuardian] = useState<Address | null>(null);
  const [guarded, setGuarded] = useState<Guarded[]>([]);
  const [requests, setRequests] = useState<GuardianRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = async () => {
        const address = await getGuardianAddress();
        if (!active) return;
        setGuardian(address);
        const local = await listGuardedWallets();
        const remote = address
          ? await listProtectedWallets(address).catch(() => [])
          : [];
        setGuarded(mergeGuarded(local, remote));
        if (address)
          setRequests(
            (await listGuardianRequests(address).catch(() => [])).filter(
              (r) => !r.approvedByYou,
            ),
          );
      };
      load().catch((e: unknown) => active && setError(describeError(e)));
      const timer = setInterval(() => load().catch(() => {}), 10_000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, []),
  );

  const nameOf = (safe: Address) =>
    guarded.find((w) => isAddressEqual(w.safe, safe))?.from ?? 'Your friend';

  function onScanned(text: string) {
    setScanning(false);
    setError(null);
    try {
      const payload = parseQrPayload(text);
      if (payload.t === 'sqw-guardian-invite')
        setView({ kind: 'invite', payload });
      else if (payload.t === 'sqw-recovery-request')
        setView({ kind: 'approve', payload });
      else
        setError(
          'This is an approval code: scan it with the recovering phone.',
        );
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function accept(payload: GuardianInvitePayload) {
    setBusy(true);
    setError(null);
    try {
      const signed = await signInviteAcceptance({
        safe: payload.safe,
        invite: payload.invite,
      });
      let offline: GuardianAcceptPayload | null = null;
      try {
        await acceptGuardianInvite(
          payload.invite,
          signed.guardian,
          signed.signature,
        );
      } catch {
        // Swissquote unreachable: hand the signed acceptance over by QR.
        offline = {
          t: 'sqw-guardian-accept',
          v: 1,
          chainId: SAFE_DEPLOYMENT.chainId,
          safe: payload.safe,
          invite: payload.invite,
          guardian: signed.guardian,
          signature: signed.signature,
        };
      }
      await rememberGuardedWallet({
        safe: payload.safe,
        from: payload.from,
        acceptedAt: new Date().toISOString(),
      });
      setGuardian(signed.guardian);
      setView({
        kind: 'invite-done',
        guardian: signed.guardian,
        from: payload.from,
        offline,
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve(payload: RecoveryRequestPayload) {
    setBusy(true);
    setError(null);
    try {
      const me = await getGuardianAddress();
      if (!me)
        throw new Error(
          'This phone has no guardian key yet. Accept an invite first.',
        );
      // Check the chain, not the QR: this key must guard this Safe at this nonce.
      const state = await getRecoveryClient().readState(payload.safe);
      if (!state || !state.guardians.some((g) => isAddressEqual(g, me)))
        throw new Error('You are not a guardian of this wallet.');
      if (
        !isAddressEqual(state.module, payload.module) ||
        state.nonce !== BigInt(payload.nonce)
      )
        throw new Error('This request is outdated. Ask for a new code.');
      if (state.pending)
        throw new Error('A recovery is already running for this wallet.');
      const approval = await signApprovalAsGuardian({
        safe: payload.safe,
        module: payload.module,
        newOwner: payload.newOwner,
        nonce: BigInt(payload.nonce),
      });
      let sent = false;
      if (payload.case) {
        try {
          await addRecoveryApproval(
            payload.case,
            approval.guardian,
            approval.signature,
          );
          sent = true;
        } catch {
          sent = false; // the QR below still works without Swissquote
        }
      }
      setView({
        kind: 'approved',
        sent,
        payload: {
          t: 'sqw-recovery-approval',
          v: 1,
          chainId: SAFE_DEPLOYMENT.chainId,
          safe: payload.safe,
          module: payload.module,
          newOwner: payload.newOwner,
          nonce: payload.nonce,
          guardian: approval.guardian,
          signature: approval.signature,
        },
      });
    } catch (e) {
      setError(
        e instanceof Error && !('code' in e) ? e.message : describeError(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <QrScanner
        visible={scanning}
        title="Scan your friend's code"
        onScanned={onScanned}
        onClose={() => setScanning(false)}
      />
      <ErrorText error={error} />

      {view.kind === 'home' && (
        <>
          <Card>
            <ListRow
              icon="qrcode.viewfinder"
              tone="brand"
              title="Scan a friend's code"
              subtitle="An invite to become their guardian, or a recovery request"
              onPress={() => setScanning(true)}
            />
            {guardian ? (
              <Words address={guardian} caption="Your guardian key" />
            ) : (
              <Text className="text-sm leading-5 text-muted">
                A guardian key is created on this phone, behind Face ID, when
                you accept your first invite. It can approve a recovery but can
                never spend your friend&apos;s money.
              </Text>
            )}
          </Card>
          {requests.length > 0 && (
            <Section title="Requests to review">
              {requests.map((r, i) => (
                <View key={r.caseId}>
                  {i > 0 && <Divider />}
                  <ListRow
                    icon="exclamationmark.shield.fill"
                    tone="brand"
                    title={`${nameOf(r.safeAddress)} wants to recover`}
                    subtitle={`New phone key ${shortAddress(r.newOwnerAddress)}`}
                    onPress={() =>
                      setView({
                        kind: 'approve',
                        payload: {
                          t: 'sqw-recovery-request',
                          v: 1,
                          chainId: SAFE_DEPLOYMENT.chainId,
                          safe: r.safeAddress,
                          module: r.module,
                          newOwner: r.newOwnerAddress,
                          nonce: r.nonce,
                          case: r.caseId,
                        },
                      })
                    }
                  />
                </View>
              ))}
            </Section>
          )}
          <Section title="People I protect">
            {guarded.length === 0 ? (
              <ListRow
                icon="person.2"
                title="Nobody yet"
                subtitle="Scan a friend's invite to protect their wallet."
              />
            ) : (
              guarded.map((w, i) => (
                <View key={w.safe}>
                  {i > 0 && <Divider />}
                  <ListRow
                    icon="person.fill"
                    tone="success"
                    title={w.from}
                    subtitle={`Safe ${shortAddress(w.safe)}`}
                    caption={
                      requests.some((r) =>
                        isAddressEqual(r.safeAddress, w.safe),
                      )
                        ? 'Request open'
                        : w.active
                          ? 'Protected'
                          : 'Accepted'
                    }
                  />
                </View>
              ))
            )}
          </Section>
        </>
      )}

      {view.kind === 'invite' && (
        <Card>
          <Text className="text-lg font-semibold text-ink">
            {view.payload.from} asks you to be a guardian
          </Text>
          <AddressLine label="Their Safe" address={view.payload.safe} />
          <Text className="text-base text-muted">
            Accept only if your friend is with you or on the phone. After Face
            ID, this phone shows 4 words: your friend must see the same words.
          </Text>
          {busy ? (
            <ActivityIndicator />
          ) : (
            <Button
              label="Accept with Face ID"
              onPress={() => void accept(view.payload)}
            />
          )}
          <Button
            label="Cancel"
            secondary
            disabled={busy}
            onPress={() => setView({ kind: 'home' })}
          />
        </Card>
      )}

      {view.kind === 'invite-done' && (
        <Card tone="ok">
          <Text className="text-lg font-semibold text-ink">
            Read these words to {view.from}
          </Text>
          <Words address={view.guardian} caption="Your guardian key" />
          <Text className="text-sm text-muted">
            Their phone must show exactly the same 4 words before they add you.
          </Text>
          {view.offline && (
            <>
              <Text className="text-sm text-ink">
                Swissquote could not be reached. On their phone, {view.from}{' '}
                taps “Scan my friend’s code” and scans this:
              </Text>
              <QrCode shareable value={JSON.stringify(view.offline)} />
            </>
          )}
          <Button
            label="Done"
            onPress={() => {
              setView({ kind: 'home' });
              onAccepted?.();
            }}
          />
        </Card>
      )}

      {view.kind === 'approve' && (
        <Card tone="alert">
          <Text className="text-lg font-semibold text-ink">
            Approve a recovery?
          </Text>
          <AddressLine label="Wallet (Safe)" address={view.payload.safe} />
          <Words address={view.payload.newOwner} caption="New phone key" />
          <Text className="text-base text-ink">
            Call your friend and ask them to read the 4 words shown on their NEW
            phone. Approve only if they match and you are sure it is them. If
            someone else is asking, refuse: they would take the wallet.
          </Text>
          {busy ? (
            <ActivityIndicator />
          ) : (
            <Button
              label="The words match: approve with Face ID"
              onPress={() => void approve(view.payload)}
            />
          )}
          <Button
            label="Refuse"
            secondary
            disabled={busy}
            onPress={() => setView({ kind: 'home' })}
          />
        </Card>
      )}

      {view.kind === 'approved' && (
        <Card tone="ok">
          <Text className="text-lg font-semibold text-ink">
            Approval signed
          </Text>
          <Text className="text-base text-muted">
            {view.sent
              ? 'Sent to Swissquote. Your friend’s phone will pick it up.'
              : 'Swissquote is not reachable. Let your friend scan this code with their new phone.'}
          </Text>
          <QrCode shareable value={JSON.stringify(view.payload)} />
          <Button label="Done" onPress={() => setView({ kind: 'home' })} />
        </Card>
      )}
    </>
  );
}
