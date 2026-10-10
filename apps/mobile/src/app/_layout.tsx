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
        <Stack.Screen
          name="bank-link"
          options={{ title: 'Bank connection · demo' }}
        />
        <Stack.Screen name="wallet" options={{ title: 'Your wallet' }} />
        <Stack.Screen name="send" options={{ title: 'Send' }} />
        <Stack.Screen name="sign-test" options={{ title: 'Sign test' }} />
        <Stack.Screen name="recovery" options={{ title: 'Recovery' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
