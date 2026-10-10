import type { PropsWithChildren } from 'react';
import { View } from 'react-native';

export function Card({
  children,
  tone = 'default',
}: PropsWithChildren<{ tone?: 'default' | 'alert' | 'ok' | 'warn' }>) {
  const style = {
    default: 'bg-card',
    alert: 'bg-brandSoft border border-brand',
    ok: 'bg-successSoft border border-success',
    warn: 'bg-warningSoft border border-warning',
  }[tone];
  return <View className={`gap-3 rounded-3xl p-5 ${style}`}>{children}</View>;
}
