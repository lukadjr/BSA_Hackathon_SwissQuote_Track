import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { isWalletLinked } from '../../lib/linkStatus';
import {
  confirmWalletLink,
  describeLinkError,
  startWalletLink,
  type LinkChallenge,
  type LinkResult,
} from '../../lib/walletlink';

export default function LinkWalletScreen() {
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
    // Linking happens once, during wallet creation. Never offer it again.
    isWalletLinked()
      .then(async (done) => {
        if (done) {
          router.replace('/wallet');
          return;
        }
        const c = await startWalletLink(controller.signal);
        if (!controller.signal.aborted) setChallenge(c);
      })
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
      if (focused.current) setLinked(result);
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
            Swissquote verified that this phone holds your wallet key. You will
            not need to do this again.
          </Text>
        </View>
        <View className="bg-white border border-line rounded-3xl p-6 gap-2">
          <Text className="text-sm text-muted">Linked key</Text>
          <Text selectable className="text-sm text-ink">
            {linked.ownerAddress}
          </Text>
        </View>
        <Button
          label="Open my wallet"
          onPress={() => router.replace('/wallet')}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Text className="text-2xl font-bold text-ink">Link to Swissquote</Text>
      <Text className="text-base text-muted">
        Confirm that this phone holds your wallet key. Read the message below,
        then sign it with Face ID.
      </Text>
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
          label={busy ? 'Waiting…' : 'Confirm with Face ID'}
          onPress={() => {
            if (!busy) void onConfirm();
          }}
        />
      ) : (
        !loading && <Button label="Try again" onPress={retry} />
      )}
    </Screen>
  );
}
