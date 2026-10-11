import { Image } from 'react-native';

export function WalletLogo({ size = 48 }: { size?: number }) {
  return (
    <Image
      accessibilityLabel="Swissquote Wallet"
      source={require('../../assets/padlock-logo.png')}
      style={{ width: size, height: size }}
      resizeMode="contain"
    />
  );
}
