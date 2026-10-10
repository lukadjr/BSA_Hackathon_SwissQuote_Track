import type { PropsWithChildren } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export function Screen({ children }: PropsWithChildren) {
  return (
    <SafeAreaView
      className="flex-1 bg-canvas"
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView contentContainerClassName="grow p-6 gap-6">
        <View className="self-start rounded-full bg-white px-3 py-2 border border-line">
          <Text className="text-xs font-semibold text-muted">
            UI MOCK · SEPOLIA
          </Text>
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
