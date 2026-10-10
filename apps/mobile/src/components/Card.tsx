import type { PropsWithChildren } from 'react';
import { View } from 'react-native';

export function Card({
  children,
  tone = 'default',
}: PropsWithChildren<{ tone?: 'default' | 'alert' | 'ok' }>) {
  const style =
    tone === 'alert'
      ? 'bg-red-50 border-accent'
      : tone === 'ok'
        ? 'bg-green-50 border-green-600'
        : 'bg-white border-line';
  return (
    <View className={`border rounded-3xl p-6 gap-3 ${style}`}>{children}</View>
  );
}
