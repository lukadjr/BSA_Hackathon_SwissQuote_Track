import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { getClientIdentity, type ClientIdentity } from '../../lib/api';
import {
  requireVerifiedIdentity,
  describeLinkError,
} from '../../lib/walletlink';
import { createWallet } from '../../lib/wallet';

export default function CreateWalletScreen() {
  const [identity, setIdentity] = useState<ClientIdentity | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getClientIdentity(controller.signal)
      .then((profile) => {
        if (!controller.signal.aborted) setIdentity(profile);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(describeLinkError(e));
      });
    return () => controller.abort();
  }, [attempt]);

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      requireVerifiedIdentity(await getClientIdentity());
      await createWallet();
      router.replace('/link-wallet');
    } catch (e) {
      setError(describeLinkError(e));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View className="py-8 gap-5">
        <Text className="text-accent text-sm font-bold tracking-widest">
          SWISSQUOTE
        </Text>
        <Text className="text-4xl font-bold text-ink">
          Your keys.{'\n'}Your crypto.
        </Text>
        <Text className="text-lg text-muted">
          Create your wallet on this phone to get started.
        </Text>
      </View>
      <View className="bg-white border border-line rounded-3xl p-6 gap-2">
        <Text className="text-lg font-semibold text-ink">
          Swissquote demo account
        </Text>
        <Text className="text-base text-muted">
          {identity?.display_name ?? 'Loading…'}
        </Text>
        <Text className="text-sm text-muted">
          Identity: {identity?.kyc_status ?? 'unavailable'} · simulated bank KYC
        </Text>
        {identity && identity.kyc_status !== 'verified' && (
          <Text className="text-sm text-accent">
            Your identity must be verified by the demo bank operator before
            onboarding.
          </Text>
        )}
      </View>
      <Button
        label="Refresh identity"
        secondary
        disabled={busy}
        onPress={() => {
          setIdentity(null);
          setError(null);
          setAttempt((n) => n + 1);
        }}
      />
      {error !== null && <Text className="text-base text-accent">{error}</Text>}
      <Button
        disabled={busy || identity?.kyc_status !== 'verified'}
        label={busy ? 'Creating…' : 'Create wallet'}
        onPress={() => {
          if (!busy) void onCreate();
        }}
      />
    </Screen>
  );
}
