import {
  backupAddressFromPhrase,
  parseQrPayload,
  SAFE_DEPLOYMENT,
  shortAddress,
  signApprovalWithPhrase,
  verifyRecoveryApproval,
  type Address,
  type GuardianApproval,
  type RecoveryRequestPayload,
  type RecoveryState,
} from '@swissquote/wallet-core';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { formatEther, getAddress, isAddress, isAddressEqual } from 'viem';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { QrCode } from '../../components/QrCode';
import { QrScanner } from '../../components/QrScanner';
import { Screen } from '../../components/Screen';
import {
  describeError,
  formatCountdown,
  getRecoveryClient,
  mergeApprovals,
  periodLabel,
  readPendingRecovery,
  saveGuardianLabels,
  savePendingRecovery,
  saveRecoveredSafe,
  sendFromThisPhone,
  type PendingRecoveryLocal,
} from '../../lib/recovery';
import {
  addRecoveryApproval,
  askSwissquoteApproval,
  createRecoveryCase,
  getMyWallet,
  getSwissquoteGuardian,
  readRecoveryCase,
  relayRecoveryFinalize,
  relayRecoveryStart,
  type RecoveryCase,
} from '../../lib/recoveryApi';
import { createWallet, getAddress as getOwnerAddress } from '../../lib/wallet';
import { Steps } from '../../components/ui';
import { AddressLine, ErrorText, Words } from './parts';

type Chain = { state: RecoveryState; owners: Address[]; now: number };

/** New phone: request, collect 2 approvals, wait, finalize. */
export default function RecoverScreen() {
  const [pending, setPending] = useState<
    PendingRecoveryLocal | null | undefined
  >(undefined);
  const [chain, setChain] = useState<Chain | null>(null);
  const [backendCase, setBackendCase] = useState<RecoveryCase | null>(null);
  const [swissquote, setSwissquote] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useFocusEffect(
    useCallback(() => {
      const timer = setInterval(refresh, 5000);
      return () => clearInterval(timer);
    }, [refresh]),
  );

  useEffect(() => {
    let active = true;
    (async () => {
      const local = await readPendingRecovery();
      if (!active) return;
      setPending(local);
      if (!local) return;
      const client = getRecoveryClient();
      const [state, owners, now] = await Promise.all([
        client.readState(local.safe),
        client.readOwners(local.safe),
        client.chainTime(),
      ]);
      if (!active || !state) return;
      setChain({ state, owners, now });
      if (local.caseId)
        setBackendCase(await readRecoveryCase(local.caseId).catch(() => null));
      if (!swissquote)
        setSwissquote(
          (await getSwissquoteGuardian().catch(() => null))?.address ?? null,
        );
    })().catch((e: unknown) => active && setError(describeError(e)));
    return () => {
      active = false;
    };
  }, [tick, swissquote]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error && !('code' in e) ? e.message : describeError(e),
      );
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (pending === undefined) return <Screen>{<ActivityIndicator />}</Screen>;
  if (pending === null)
    return (
      <StartRecovery
        onStarted={(p) => setPending(p)}
        busy={busy}
        act={act}
        error={error}
      />
    );

  const guardians = chain?.state.guardians ?? [];
  const valid = (a: GuardianApproval) =>
    guardians.some((g) => isAddressEqual(g, a.guardian));
  const approvals = mergeApprovals(
    pending.approvals,
    (backendCase?.approvals ?? []).map((a) => ({
      guardian: a.guardianAddress,
      signature: a.signature,
    })),
  ).filter(valid);
  const threshold = chain?.state.threshold ?? 2;
  const nonceMatches = chain
    ? chain.state.nonce === BigInt(pending.nonce)
    : true;
  const ourPending =
    chain?.state.pending &&
    isAddressEqual(chain.state.pending.newOwners[0], pending.newOwner)
      ? chain.state.pending
      : null;
  const recovered =
    chain?.owners.length === 1 &&
    isAddressEqual(chain.owners[0], pending.newOwner);
  const request: RecoveryRequestPayload = {
    t: 'sqw-recovery-request',
    v: 1,
    chainId: SAFE_DEPLOYMENT.chainId,
    safe: pending.safe,
    module: pending.module,
    newOwner: pending.newOwner,
    nonce: pending.nonce,
    ...(pending.caseId ? { case: pending.caseId } : {}),
  };

  async function addLocal(approval: GuardianApproval) {
    const target = {
      safe: pending!.safe,
      module: pending!.module,
      newOwner: pending!.newOwner,
      nonce: BigInt(pending!.nonce),
    };
    if (!(await verifyRecoveryApproval(target, approval)) || !valid(approval))
      throw new Error('This approval is not from a guardian of this wallet.');
    const next = {
      ...pending!,
      approvals: mergeApprovals(pending!.approvals, [approval]),
    };
    await savePendingRecovery(next);
    setPending(next);
    if (pending!.caseId)
      await addRecoveryApproval(
        pending!.caseId,
        approval.guardian,
        approval.signature,
      ).catch(() => {});
  }

  async function finish() {
    await saveRecoveredSafe(pending!.safe, pending!.newOwner);
    // On a new phone only Swissquote's guardian is known for sure.
    if (swissquote)
      await saveGuardianLabels({ [swissquote]: 'swissquote' }).catch(() => {});
    await savePendingRecovery(null);
    // Re-link the recovered Safe to Swissquote, then open the wallet.
    router.replace('/setup');
  }

  return (
    <Screen
      title="Recover your wallet"
      subtitle="Any 2 of your 3 guardians bring your wallet to this phone."
    >
      <Card>
        <AddressLine label="Wallet (Safe)" address={pending.safe} />
        <Words
          address={pending.newOwner}
          caption="This phone's new key: read these words to your guardians"
        />
      </Card>
      <ErrorText error={error} />
      {!chain && <ActivityIndicator />}

      {chain && recovered && (
        <Card tone="ok">
          <Text className="text-lg font-semibold text-ink">
            Your wallet is back
          </Text>
          <Text className="text-base text-muted">
            This phone’s key now owns your Safe. Next: confirm with Swissquote,
            then replace any guardian you lost (for example your backup phrase).
          </Text>
          <Button label="Continue" onPress={() => void act(finish)} />
        </Card>
      )}

      {chain && !recovered && ourPending && (
        <Card>
          <Text className="text-lg font-semibold text-ink">Waiting period</Text>
          {ourPending.executeAfter > chain.now ? (
            <>
              <Text className="text-base text-muted">
                Your Safe moves to this phone in{' '}
                {formatCountdown(ourPending.executeAfter - chain.now)}. Your old
                phone was alerted and can cancel until then.
              </Text>
              <ActivityIndicator />
            </>
          ) : (
            <>
              <Text className="text-base text-muted">
                The waiting period is over.{' '}
                {pending.caseId
                  ? 'Swissquote pays the fee.'
                  : 'Offline mode: this phone needs Sepolia ETH for the fee.'}
              </Text>
              <Button
                label={busy ? 'Finishing…' : 'Finish recovery'}
                disabled={busy}
                onPress={() =>
                  void act(async () => {
                    const hash = pending.caseId
                      ? await relayRecoveryFinalize(pending.caseId)
                      : await sendFromThisPhone('finalize', pending, []);
                    await getRecoveryClient().waitForTransaction(hash);
                  })
                }
              />
            </>
          )}
        </Card>
      )}

      {chain && !recovered && !ourPending && chain.state.pending && (
        <Card tone="alert">
          <Text className="text-base text-ink">
            Another recovery is running for this wallet (new key{' '}
            {shortAddress(chain.state.pending.newOwners[0])}). Contact
            Swissquote.
          </Text>
        </Card>
      )}

      {chain && !recovered && !chain.state.pending && !nonceMatches && (
        <Card tone="alert">
          <Text className="text-base text-ink">
            This request was cancelled by the current owner key (or replaced).
            If you still have your old phone, use it instead.
          </Text>
          <Button
            label="Start a new request"
            onPress={() =>
              void act(async () => {
                await savePendingRecovery(null);
                setPending(null);
              })
            }
          />
        </Card>
      )}

      {chain && !recovered && !chain.state.pending && nonceMatches && (
        <Approvals
          busy={busy}
          act={act}
          approvals={approvals}
          threshold={threshold}
          request={request}
          pending={pending}
          swissquote={swissquote}
          onApproval={addLocal}
          onBackendCase={setBackendCase}
        />
      )}
    </Screen>
  );
}

function StartRecovery({
  onStarted,
  busy,
  act,
  error,
}: {
  onStarted: (p: PendingRecoveryLocal) => void;
  busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
  error: string | null;
}) {
  const [safe, setSafe] = useState('');
  useEffect(() => {
    getMyWallet()
      .then((w) => setSafe((current) => current || w.safeAddress))
      .catch(() => {}); // Swissquote offline: the user types the Safe address
  }, []);
  return (
    <Screen
      title="Recover your wallet"
      subtitle="Any 2 of your 3 guardians bring your wallet to this phone."
    >
      <Card>
        <Text className="text-base text-muted">
          Lost your phone? This phone gets a new key. Then 2 of your 3 guardians
          (backup phrase, Swissquote, trusted friend) approve, and after{' '}
          {periodLabel()} your Safe and its funds belong to this phone.
        </Text>
        <Text className="text-sm text-muted">Your Safe address</Text>
        <TextInput
          value={safe}
          onChangeText={setSafe}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="0x…"
          className="rounded-2xl bg-canvas px-4 py-3 text-sm text-ink"
        />
        <ErrorText error={error} />
        <Button
          label={busy ? 'Preparing…' : 'Create my new key and request recovery'}
          disabled={busy}
          onPress={() =>
            void act(async () => {
              if (!isAddress(safe.trim()))
                throw new Error('Enter a valid Safe address.');
              const safeAddress = getAddress(safe.trim());
              const client = getRecoveryClient();
              const state = await client.readState(safeAddress);
              if (!state)
                throw new Error('This wallet has no recovery set up.');
              if (state.pending)
                throw new Error(
                  'A recovery is already running for this wallet.',
                );
              const owner =
                (await getOwnerAddress()) ?? (await createWallet()).address;
              const owners = await client.readOwners(safeAddress);
              if (owners.some((o) => isAddressEqual(o, owner)))
                throw new Error('This phone already owns this wallet.');
              let caseId: string | null = null;
              try {
                caseId = (await createRecoveryCase(safeAddress, owner)).caseId;
              } catch {
                caseId = null; // Swissquote offline: backup + friend still work
              }
              // Demo: logging in to Swissquote is the identity check, so
              // Swissquote approves as a guardian right away (best effort).
              if (caseId) await askSwissquoteApproval(caseId).catch(() => {});
              const local: PendingRecoveryLocal = {
                safe: safeAddress,
                module: state.module,
                newOwner: owner,
                nonce: state.nonce.toString(),
                caseId,
                approvals: [],
              };
              await savePendingRecovery(local);
              onStarted(local);
            })
          }
        />
      </Card>
      <Button label="Back" secondary onPress={() => router.back()} />
    </Screen>
  );
}

function Approvals({
  busy,
  act,
  approvals,
  threshold,
  request,
  pending,
  swissquote,
  onApproval,
  onBackendCase,
}: {
  busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
  approvals: GuardianApproval[];
  threshold: number;
  request: RecoveryRequestPayload;
  pending: PendingRecoveryLocal;
  swissquote: Address | null;
  onApproval: (a: GuardianApproval) => Promise<void>;
  onBackendCase: (c: RecoveryCase) => void;
}) {
  const [phrase, setPhrase] = useState('');
  const [showPhrase, setShowPhrase] = useState(false);
  const [showFriendQr, setShowFriendQr] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const target = {
    safe: pending.safe,
    module: pending.module,
    newOwner: pending.newOwner,
    nonce: BigInt(pending.nonce),
  };
  const has = (address: Address | null) =>
    !!address && approvals.some((a) => isAddressEqual(a.guardian, address));
  const enough = approvals.length >= threshold;

  useEffect(() => {
    if (enough)
      getRecoveryClient()
        .balanceOf(pending.newOwner)
        .then(setBalance)
        .catch(() => setBalance(null));
  }, [enough, pending.newOwner]);

  return (
    <>
      <Card>
        <Text className="text-lg font-semibold text-ink">
          Approvals: {approvals.length} of {threshold}
        </Text>
        <Steps
          current={Math.min(approvals.length, threshold)}
          total={threshold}
        />
        {approvals.map((a) => (
          <Text key={a.guardian} className="text-sm text-ink">
            ✓{' '}
            {swissquote && isAddressEqual(a.guardian, swissquote)
              ? 'Swissquote Wallet'
              : shortAddress(a.guardian)}
          </Text>
        ))}
      </Card>

      {!enough && (
        <>
          <Card>
            <Text className="text-lg font-semibold text-ink">
              Your backup phrase
            </Text>
            {showPhrase ? (
              <>
                <TextInput
                  value={phrase}
                  onChangeText={setPhrase}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={false}
                  placeholder="12 words separated by spaces"
                  className="min-h-24 rounded-2xl bg-canvas px-4 py-3 text-base text-ink"
                />
                <Button
                  label={busy ? 'Signing…' : 'Approve with my phrase'}
                  disabled={busy}
                  onPress={() =>
                    void act(async () => {
                      backupAddressFromPhrase(phrase);
                      const approval = await signApprovalWithPhrase(
                        phrase,
                        target,
                      );
                      setPhrase(''); // the phrase is never stored
                      setShowPhrase(false);
                      await onApproval(approval);
                    })
                  }
                />
              </>
            ) : (
              <Button
                label="Use my backup phrase"
                secondary
                onPress={() => setShowPhrase(true)}
              />
            )}
          </Card>

          <Card>
            <Text className="text-lg font-semibold text-ink">
              Swissquote Wallet
            </Text>
            {has(swissquote) ? (
              <Text className="text-sm text-ink">✓ Approved</Text>
            ) : (
              <>
                <Text className="text-sm text-muted">
                  Demo identity check: you are logged in to your Swissquote
                  account. A real check adds ID verification and a call-back.
                </Text>
                <Button
                  label={
                    busy ? 'Checking…' : 'Confirm my identity with Swissquote'
                  }
                  disabled={busy || !pending.caseId}
                  onPress={() =>
                    void act(async () => {
                      onBackendCase(
                        await askSwissquoteApproval(pending.caseId!),
                      );
                    })
                  }
                />
                {!pending.caseId && (
                  <Text className="text-sm text-muted">
                    Swissquote is not reachable.
                  </Text>
                )}
              </>
            )}
          </Card>

          <Card>
            <Text className="text-lg font-semibold text-ink">
              Your trusted friend
            </Text>
            <Text className="text-sm text-muted">
              Your friend scans this code in their app (“Be a guardian”), then
              compares the 4 words above with you by phone.
            </Text>
            {showFriendQr ? (
              <QrCode shareable value={JSON.stringify(request)} />
            ) : (
              <Button
                label="Show code for my friend"
                secondary
                onPress={() => setShowFriendQr(true)}
              />
            )}
            <Button
              label="Scan my friend's approval code"
              secondary
              onPress={() => setScanning(true)}
            />
            <QrScanner
              visible={scanning}
              title="Scan your friend's approval"
              onClose={() => setScanning(false)}
              onScanned={(text) => {
                setScanning(false);
                void act(async () => {
                  const p = parseQrPayload(text);
                  if (
                    p.t !== 'sqw-recovery-approval' ||
                    !isAddressEqual(p.safe, pending.safe) ||
                    !isAddressEqual(p.newOwner, pending.newOwner) ||
                    p.nonce !== pending.nonce
                  )
                    throw new Error(
                      'This code is not an approval for this request.',
                    );
                  await onApproval({
                    guardian: p.guardian,
                    signature: p.signature,
                  });
                });
              }}
            />
          </Card>
        </>
      )}

      {enough && (
        <Card>
          <Text className="text-lg font-semibold text-ink">
            Start the waiting period
          </Text>
          <Text className="text-base text-muted">
            This sends the {approvals.length} approvals to the recovery module.
            After {periodLabel()}, if your old phone did not cancel, the Safe is
            yours.
          </Text>
          <Button
            label={busy ? 'Sending…' : 'Start (fee paid by Swissquote)'}
            disabled={busy || !pending.caseId}
            onPress={() =>
              void act(async () => {
                const id = pending.caseId!;
                for (const a of approvals)
                  await addRecoveryApproval(id, a.guardian, a.signature).catch(
                    () => {},
                  );
                const hash = await relayRecoveryStart(id);
                await getRecoveryClient().waitForTransaction(hash);
              })
            }
          />
          <Text className="text-sm text-muted">
            Without Swissquote, this phone pays the fee: send a little Sepolia
            ETH to {shortAddress(pending.newOwner)} (balance{' '}
            {balance === null
              ? '…'
              : `${Number(formatEther(balance)).toFixed(5)} ETH`}
            ).
          </Text>
          <Button
            label="Start (fee paid by this phone)"
            secondary
            disabled={busy || balance === 0n}
            onPress={() =>
              void act(async () => {
                const hash = await sendFromThisPhone(
                  'start',
                  pending,
                  approvals,
                );
                await getRecoveryClient().waitForTransaction(hash);
              })
            }
          />
          <AddressLine
            label="This phone's key (for Sepolia ETH)"
            address={pending.newOwner}
          />
        </Card>
      )}
      <View className="h-4" />
    </>
  );
}
