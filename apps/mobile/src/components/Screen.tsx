import type { PropsWithChildren, ReactNode } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Props = PropsWithChildren<{
  /** Large title shown at the top of the scroll view. */
  title?: string;
  subtitle?: string;
  /** Fixed area under the scroll view (primary actions). */
  footer?: ReactNode;
  /** Top safe area: needed when the screen has no navigation header. */
  edgeToEdge?: boolean;
  /** Inside the tab navigator: the tab bar owns the bottom inset. */
  inTabs?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}>;

export function Screen({
  children,
  title,
  subtitle,
  footer,
  edgeToEdge = false,
  inTabs = false,
  onRefresh,
  refreshing = false,
}: Props) {
  return (
    <SafeAreaView
      className="flex-1 bg-canvas"
      edges={[
        ...(edgeToEdge ? (['top'] as const) : []),
        'left',
        'right',
        ...(footer || inTabs ? [] : (['bottom'] as const)),
      ]}
    >
      <ScrollView
        contentContainerClassName="grow gap-4 px-5 pb-8 pt-4"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          ) : undefined
        }
      >
        {title && (
          <View className="gap-1 pb-2">
            <Text className="text-3xl font-bold text-ink">{title}</Text>
            {subtitle && (
              <Text className="text-base leading-6 text-muted">{subtitle}</Text>
            )}
          </View>
        )}
        {children}
      </ScrollView>
      {footer && (
        <SafeAreaView
          edges={['bottom']}
          className="gap-3 bg-canvas px-5 pb-4 pt-3"
        >
          {footer}
        </SafeAreaView>
      )}
    </SafeAreaView>
  );
}
