import * as Linking from 'expo-linking';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { Button } from './Button';
import { Icon } from './Icon';

type Props = {
  /** Headline, e.g. "Transfer confirmed". */
  title: string;
  /** Amount line under the headline, e.g. "10 USDC sent". */
  subtitle: string;
  /** Sepolia transaction hash; shows the explorer button when present. */
  transactionHash?: string | null;
  /** Called when the explorer link cannot be opened. */
  onExplorerError?: () => void;
  /** Extra detail lines (recipient, balance, ...). */
  children?: ReactNode;
};

/** Confirmation card shown after a successful on-chain transfer (Send and Add money). */
export function SuccessAnimation({
  title,
  subtitle,
  transactionHash,
  onExplorerError,
  children,
}: Props) {
  return (
    <View
      accessibilityLiveRegion="polite"
      className="bg-white border border-line rounded-3xl p-6 gap-3"
    >
      <View className="flex-row items-center gap-3">
        <View className="h-12 w-12 rounded-full bg-successSoft items-center justify-center">
          <Icon name="checkmark.circle.fill" size={26} color={colors.success} />
        </View>
        <View className="flex-1 gap-1">
          <Text className="text-lg font-bold text-ink">{title}</Text>
          <Text className="text-sm text-muted">{subtitle}</Text>
        </View>
      </View>
      {children}
      {transactionHash && (
        <Button
          label="View on Sepolia explorer"
          secondary
          onPress={() => {
            void Linking.openURL(
              `https://sepolia.etherscan.io/tx/${transactionHash}`,
            ).catch(() => onExplorerError?.());
          }}
        />
      )}
    </View>
  );
}
