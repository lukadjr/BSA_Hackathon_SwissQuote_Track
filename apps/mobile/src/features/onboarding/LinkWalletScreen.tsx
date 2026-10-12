import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import {
  getClientIdentity,
  getLinkStatus,
  type ClientIdentity,
} from '../../lib/api';
import { getSafeAccount } from '../../lib/safeWallet';
import { requireVerifiedIdentity } from '../../lib/walletlink';
import {
  confirmWalletLink,
  describeLinkError,
  startWalletLink,
  type LinkChallenge,
  type LinkResult,
} from '../../lib/walletlink';
import { BIOMETRY } from '../../lib/biometry';

export default function LinkWalletScreen() {
  const [identity, setIdentity] = useState<ClientIdentity | null>(null);
  const [challenge, setChallenge] = useState<LinkChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [linked, setLinked] = useState<LinkResult | null>(null);
  const focused = useRef(false);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const profile = await getClientIdentity(controller.signal);
      if (controller.signal.aborted) return;
      setIdentity(profile);
      requireVerifiedIdentity(profile);
      const account = await getSafeAccount();
      if (controller.signal.aborted) return;
      const status = await getLinkStatus(controller.signal);
      if (
        status.bank_transfers_allowed &&
        status.chain_id === 11155111 &&
        status.client_id === profile.client_id &&
        status.safe_address?.toLowerCase() ===
          account.safeAddress.toLowerCase() &&
        status.owner_address?.toLowerCase() ===
          account.ownerAddress.toLowerCase()
      ) {
        setLinked({
          userId: profile.client_id,
          ownerAddress: account.ownerAddress,
          safeAddress: account.safeAddress,
          chainId: 11155111,
          ownerKeyVerified: true,
          ownershipVerified: true,
        });
        return;
      }
      const c = await startWalletLink(controller.signal);
      if (!controller.signal.aborted) setChallenge(c);
    }
    load()
      .catch(
        (e: unknown) =>
          !controller.signal.aborted && setError(describeLinkError(e)),
      )
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [attempt]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setBusy(pending.current !== null);
      const subscription = AppState.addEventListener('change', (state) => {
        // A real background transition invalidates the signing attempt.
        if (state === 'background') pending.current?.abort();
      });
      return () => {
        focused.current = false;
        pending.current?.abort();
        subscription.remove();
      };
    }, []),
  );

  function retry() {
    setChallenge(null);
    setLinked(null);
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }

  async function onConfirm() {
    if (challenge === null || pending.current !== null) return;
    if (!focused.current || AppState.currentState !== 'active') return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmWalletLink(challenge, {
        signal: controller.signal,
      });
      if (focused.current && !controller.signal.aborted) setLinked(result);
    } catch (e) {
      if (focused.current) {
        setError(describeLinkError(e));
        // The backend burns a challenge after one attempt; fetch a fresh one.
        setChallenge(null);
      }
    } finally {
      pending.current = null;
      if (focused.current) setBusy(false);
    }
  }

  if (linked !== null) {
    return (
      <Screen>
        <View className="items-center gap-4 py-8">
          <View className="h-20 w-20 items-center justify-center rounded-full bg-accent">
            <Text className="text-4xl font-bold text-white">✓</Text>
          </View>
          <Text className="text-2xl font-bold text-ink text-center">
            Wallet linked to Swissquote
          </Text>
          <Text className="text-base text-muted text-center">
            Control of your Safe was verified on Sepolia and linked to your demo
            account. You must confirm the link again after an owner change.
          </Text>
        </View>
        <View className="bg-white border border-line rounded-3xl p-6 gap-2">
          <Text className="text-sm text-muted">Verified Safe · Sepolia</Text>
          <Text selectable className="text-sm text-ink">
            {linked.safeAddress}
          </Text>
        </View>
        <Text className="text-sm text-muted">
          Identity checks are simulated. This does not certify guardian setup or
          full Travel Rule compliance.
        </Text>
        <Button
          label="Test bank connection (demo)"
          onPress={() => router.push('/bank-link')}
        />
        <Button
          label="Open my wallet"
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace('/home')
          }
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Link to Swissquote</Text>
      <Text className="text-base text-muted">
        Link your existing Swissquote demo identity to the Safe you control.
        Read the confirmation, then sign with biometrics. This moves no funds.
      </Text>
      <View className="bg-white border border-line rounded-3xl p-6 gap-2">
        <Text className="text-lg font-semibold text-ink">
          Swissquote account · simulated
        </Text>
        <Text className="text-base text-muted">
          {identity?.display_name ??
            (loading ? 'Loading bank identity…' : 'Not available')}
        </Text>
        <Text className="text-sm text-muted">
          Identity: {identity?.kyc_status ?? 'unavailable'}
        </Text>
        <Text className="text-sm text-muted">
          Existing bank KYC is reused. No identity documents are uploaded.
        </Text>
      </View>
      {loading && <ActivityIndicator />}
      {challenge !== null && (
        <View className="bg-white border border-line rounded-3xl p-6 gap-2">
          <Text className="text-sm text-muted">You are about to sign</Text>
          <Text selectable className="text-sm font-semibold text-ink">
            {challenge.message}
          </Text>
        </View>
      )}
      {error !== null && <Text className="text-base text-accent">{error}</Text>}
      {challenge !== null ? (
        <Button
          label={busy ? 'Waiting…' : `Confirm with ${BIOMETRY}`}
          busy={busy}
          onPress={() => {
            if (!busy) void onConfirm();
          }}
        />
      ) : (
        !loading && <Button label="Refresh verification" onPress={retry} />
      )}
      <Button
        label="Set up wallet / add money"
        secondary
        disabled={busy}
        onPress={() => router.push('/add-money')}
      />
      <Button
        label="Open testnet wallet"
        secondary
        disabled={busy}
        onPress={() =>
          router.canGoBack() ? router.back() : router.replace('/home')
        }
      />
      <Text className="text-sm text-muted">
        Bank linking requires a deployed Safe. Use Add money to deploy it first;
        bank funding stays blocked until linking succeeds.
      </Text>
    </Screen>
  );
}
