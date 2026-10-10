import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Swissquote Wallet',
  slug: 'swissquote-wallet',
  version: '0.1.0',
  scheme: 'swissquote-wallet',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.bsa.swissquotewallet.demo',
  },
  android: { package: 'com.bsa.swissquotewallet.demo' },
  web: { bundler: 'metro', favicon: './assets/favicon.png' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    './plugins/with-scene-lifecycle',
    [
      'expo-local-authentication',
      {
        faceIDPermission:
          'Allow Swissquote Wallet to confirm your identity before signing.',
      },
    ],
  ],
};

export default config;
