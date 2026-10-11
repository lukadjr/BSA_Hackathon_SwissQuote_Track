import '../../global.css';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DevResetDatabaseButton } from '../components/DevResetDatabaseButton';
import { RecoveryExitButton } from '../components/RecoveryExitButton';
import { WalletAccessBoundary } from '../components/WalletAccessBoundary';
import { OnboardingBackButton } from '../components/OnboardingBackButton';
import { colors } from '../theme/colors';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <WalletAccessBoundary>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.canvas },
            headerTintColor: colors.ink,
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: colors.canvas },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen
            name="welcome"
            options={{ headerShown: false, animation: 'fade' }}
          />
          <Stack.Screen
            name="login"
            options={{
              title: '',
              headerLeft: () => <OnboardingBackButton route="/login" />,
            }}
          />
          <Stack.Screen
            name="start"
            options={{
              title: '',
              headerBackVisible: false,
              headerLeft: () => <OnboardingBackButton route="/start" />,
            }}
          />
          <Stack.Screen
            name="kyc"
            options={{
              title: 'Identity check',
              headerLeft: () => <OnboardingBackButton route="/kyc" />,
            }}
          />
          <Stack.Screen
            name="setup"
            options={{
              title: 'Your wallet',
              headerLeft: () => <OnboardingBackButton route="/setup" />,
              headerRight: () => <DevResetDatabaseButton />,
              headerBackVisible: false,
              gestureEnabled: false,
            }}
          />
          <Stack.Screen
            name="protect"
            options={{ title: 'Trusted guardians', gestureEnabled: false }}
          />
          <Stack.Screen
            name="(tabs)"
            options={{ headerShown: false, animation: 'fade' }}
          />
          <Stack.Screen
            name="add-money"
            options={{ title: 'Add money', presentation: 'modal' }}
          />
          <Stack.Screen
            name="send"
            options={{ title: 'Send', presentation: 'modal' }}
          />
          <Stack.Screen
            name="receive"
            options={{ title: 'Receive', presentation: 'modal' }}
          />
          <Stack.Screen
            name="profile"
            options={{
              title: 'Profile',
              headerRight: () => <DevResetDatabaseButton />,
            }}
          />
          <Stack.Screen
            name="link-wallet"
            options={{ title: 'Swissquote link' }}
          />
          <Stack.Screen
            name="bank-link"
            options={{ title: 'Bank connection' }}
          />
          <Stack.Screen
            name="replace-guardian"
            options={{ title: 'Replace guardian' }}
          />
          <Stack.Screen name="guardian" options={{ title: 'Guardian' }} />
          <Stack.Screen
            name="recover"
            options={{
              title: 'Recover wallet',
              headerLeft: () => <OnboardingBackButton route="/recover" />,
              gestureEnabled: false,
              headerRight: () => <RecoveryExitButton />,
            }}
          />
        </Stack>
      </WalletAccessBoundary>
    </SafeAreaProvider>
  );
}
