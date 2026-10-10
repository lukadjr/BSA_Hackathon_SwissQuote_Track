import '../../global.css';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.canvas },
          headerTintColor: colors.ink,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.canvas },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen
          name="create-wallet"
          options={{ title: 'Create wallet', headerBackVisible: false }}
        />
        <Stack.Screen
          name="link-wallet"
          options={{
            title: 'Link wallet',
            headerBackVisible: false,
            gestureEnabled: false,
          }}
        />
        <Stack.Screen name="wallet" options={{ title: 'Your wallet' }} />
        <Stack.Screen name="send" options={{ title: 'Send' }} />
        <Stack.Screen name="sign-test" options={{ title: 'Sign test' }} />
        <Stack.Screen name="recovery" options={{ title: 'Security' }} />
        <Stack.Screen name="protect" options={{ title: 'Protect wallet' }} />
        <Stack.Screen
          name="replace-guardian"
          options={{ title: 'Replace guardian' }}
        />
        <Stack.Screen name="guardian" options={{ title: 'Be a guardian' }} />
        <Stack.Screen
          name="recover"
          options={{ title: 'Recover wallet', headerBackVisible: false }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}
