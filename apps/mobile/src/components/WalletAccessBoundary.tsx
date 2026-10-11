import { router, useSegments } from 'expo-router';
import { type PropsWithChildren, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Text, View } from 'react-native';
import { Button } from './Button';
import { walletAccess, logoutWallet } from '../lib/walletSession';

const PRIVATE_ROUTES = new Set([
  '(tabs)',
  'profile',
  'send',
  'receive',
  'add-money',
  'protect',
  'replace-guardian',
  'link-wallet',
  'bank-link',
  'setup',
  'recover',
]);

/** Hide private screens until ownership is verified, including on foreground. */
export function WalletAccessBoundary({ children }: PropsWithChildren) {
  const segments = useSegments();
  const protectedRoute = PRIVATE_ROUTES.has(segments[0] ?? '');
  const requireProtection = ![
    'protect',
    'link-wallet',
    'setup',
    'recover',
  ].includes(segments[0] ?? '');
  const allowNewWallet = ['setup', 'recover'].includes(segments[0] ?? '');
  const accessPolicy = requireProtection
    ? 'protected'
    : allowNewWallet
      ? 'new-wallet'
      : 'owner';
  const [verifiedRoute, setVerifiedRoute] = useState<string | null>(null);
  const verified = verifiedRoute === accessPolicy;
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!protectedRoute) return;
    let active = true;
    let checking = false;
    async function check() {
      if (checking || AppState.currentState !== 'active') return;
      checking = true;
      try {
        const access = await walletAccess(requireProtection, allowNewWallet);
        if (!active || AppState.currentState !== 'active') return;
        if (access !== 'active') {
          setVerifiedRoute(null);
          if (router.canDismiss()) router.dismissAll();
          router.replace(access === 'setup-required' ? '/setup' : '/welcome');
        } else {
          setError(null);
          setVerifiedRoute(accessPolicy);
        }
      } catch {
        if (active) {
          setVerifiedRoute(null);
          setError(
            'Connect to the network to verify this phone still owns your wallet.',
          );
        }
      } finally {
        checking = false;
      }
    }
    void check();
    const timer = setInterval(() => void check(), 5000);
    const sub = AppState.addEventListener('change', (state) => {
      setVerifiedRoute(null);
      if (state === 'active') void check();
    });
    return () => {
      active = false;
      setVerifiedRoute(null);
      clearInterval(timer);
      sub.remove();
    };
  }, [
    protectedRoute,
    requireProtection,
    allowNewWallet,
    accessPolicy,
    attempt,
  ]);

  return (
    <View className="flex-1">
      <View
        className="flex-1"
        style={{ opacity: protectedRoute && !verified ? 0 : 1 }}
        pointerEvents={protectedRoute && !verified ? 'none' : 'auto'}
        accessibilityElementsHidden={protectedRoute && !verified}
        importantForAccessibility={
          protectedRoute && !verified ? 'no-hide-descendants' : 'auto'
        }
      >
        {children}
      </View>
      {protectedRoute && !verified && (
        <View
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
          className="items-center justify-center gap-4 bg-canvas px-6"
        >
          {error ? (
            <>
              <Text className="text-center text-base text-muted">{error}</Text>
              <Button
                label="Try again"
                onPress={() => setAttempt((n) => n + 1)}
              />
              <Button
                label="Log out"
                variant="secondary"
                onPress={() => {
                  void logoutWallet()
                    .then(() => router.replace('/welcome'))
                    .catch(() =>
                      setError('Could not disconnect this phone. Try again.'),
                    );
                }}
              />
            </>
          ) : (
            <>
              <ActivityIndicator />
              <Text className="text-sm text-muted">
                Verifying wallet access…
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}
