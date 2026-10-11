import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { DevResetDatabaseButton } from '../../components/DevResetDatabaseButton';
import { IconTile, Wordmark } from '../../components/ui';
import { getGuardianAddress, listGuardedWallets } from '../../lib/guardianKey';
import { listGuardianRequests } from '../../lib/recoveryApi';
import { readPausedOnboarding } from '../../lib/onboardingNavigation';
import { colors } from '../../theme/colors';

/** First screen: log in with Swissquote, or help a friend as a guardian. */
export default function WelcomeScreen() {
  const [guardian, setGuardian] = useState<{
    wallets: number;
    requests: number;
  } | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const address = await getGuardianAddress();
        if (!address) return null;
        const [wallets, requests] = await Promise.all([
          listGuardedWallets(),
          listGuardianRequests(address).catch(() => []),
        ]);
        return {
          wallets: wallets.length,
          requests: requests.filter((r) => !r.approvedByYou).length,
        };
      })()
        .then((value) => active && setGuardian(value))
        .catch(() => active && setGuardian(null));
      return () => {
        active = false;
      };
    }, []),
  );

  return (
    <View className="flex-1 bg-brand">
      <SafeAreaView edges={['top']} className="flex-1 justify-between px-6">
        <View className="pt-4">
          <Wordmark light />
        </View>
        <View className="gap-4 pb-10">
          <Text className="text-5xl font-extrabold leading-tight text-white">
            Your keys.{'\n'}Your crypto.
          </Text>
          <Text className="text-lg leading-7 text-white/90">
            A self-custody wallet with Swissquote by your side. Lose your phone,
            not your money.
          </Text>
        </View>
      </SafeAreaView>
      <SafeAreaView
        edges={['bottom']}
        className="gap-3 rounded-t-[32px] bg-canvas px-6 pt-6"
      >
        {guardian && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="People I protect"
            onPress={() => router.push('/guardian')}
            className="flex-row items-center gap-3 rounded-3xl bg-card p-4 active:opacity-70"
          >
            <IconTile
              name="person.2.fill"
              tone={guardian.requests > 0 ? 'brand' : 'success'}
            />
            <View className="flex-1">
              <Text className="text-base font-semibold text-ink">
                People I protect
              </Text>
              <Text className="text-sm text-muted">
                {guardian.requests > 0
                  ? `${guardian.requests} recovery request${guardian.requests > 1 ? 's' : ''} to review`
                  : `${guardian.wallets} wallet${guardian.wallets === 1 ? '' : 's'} · nothing to do`}
              </Text>
            </View>
            {guardian.requests > 0 && (
              <View className="h-6 min-w-6 items-center justify-center rounded-full bg-brand px-2">
                <Text className="text-xs font-bold text-white">
                  {guardian.requests}
                </Text>
              </View>
            )}
            <Icon name="chevron.right" size={14} color={colors.faint} />
          </Pressable>
        )}
        <Button
          label="Log in with Swissquote"
          icon="person.crop.circle.fill"
          onPress={() => {
            void readPausedOnboarding()
              .then((route) =>
                route ? router.dismissTo(route) : router.push('/login'),
              )
              .catch(() =>
                Alert.alert('Could not resume', 'Please try again.'),
              );
          }}
        />
        <Button
          label="Be a guardian"
          variant="secondary"
          icon="shield.lefthalf.filled"
          onPress={() => router.push('/guardian')}
        />
        <Text className="pb-2 text-center text-xs text-muted">
          Demo on the Sepolia testnet · no real funds
        </Text>
        {__DEV__ && (
          <View className="items-center pb-2">
            <DevResetDatabaseButton />
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}
