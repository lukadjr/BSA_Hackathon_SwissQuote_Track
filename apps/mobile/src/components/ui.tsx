// Small presentational pieces shared by every screen.
import type { PropsWithChildren, ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { WalletLogo } from './WalletLogo';
import { Icon, type IconName } from './Icon';

/** Round icon tile used in lists (Revolut-style). */
export function IconTile({
  name,
  tone = 'neutral',
  size = 44,
}: {
  name: IconName;
  tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'dark';
  size?: number;
}) {
  const bg = {
    neutral: colors.canvas,
    brand: colors.brandSoft,
    success: colors.successSoft,
    warning: colors.warningSoft,
    dark: colors.ink,
  }[tone];
  const fg = {
    neutral: colors.ink,
    brand: colors.brand,
    success: colors.success,
    warning: colors.warning,
    dark: colors.card,
  }[tone];
  return (
    <View
      style={{ width: size, height: size, backgroundColor: bg }}
      className="items-center justify-center rounded-full"
    >
      <Icon name={name} size={size * 0.45} color={fg} />
    </View>
  );
}

/** A tappable (or static) list row: icon, title, subtitle, trailing value. */
export function ListRow({
  icon,
  tone,
  title,
  subtitle,
  value,
  valueTone = 'ink',
  caption,
  onPress,
  chevron = !!onPress,
}: {
  icon?: IconName;
  tone?: Parameters<typeof IconTile>[0]['tone'];
  title: string;
  subtitle?: string;
  value?: string;
  valueTone?: 'ink' | 'success' | 'muted' | 'brand';
  caption?: string;
  onPress?: () => void;
  chevron?: boolean;
}) {
  const valueColor = {
    ink: 'text-ink',
    success: 'text-success',
    muted: 'text-muted',
    brand: 'text-brand',
  }[valueTone];
  const body = (
    <View className="flex-row items-center gap-3 py-3">
      {icon && <IconTile name={icon} tone={tone} />}
      <View className="flex-1 gap-0.5">
        <Text className="text-base font-semibold text-ink" numberOfLines={1}>
          {title}
        </Text>
        {subtitle && (
          <Text className="text-sm text-muted" numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
      {(value || caption) && (
        <View className="items-end gap-0.5">
          {value && (
            <Text className={`text-base font-semibold ${valueColor}`}>
              {value}
            </Text>
          )}
          {caption && <Text className="text-xs text-muted">{caption}</Text>}
        </View>
      )}
      {chevron && <Icon name="chevron.right" size={14} color={colors.faint} />}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      className="active:opacity-60"
    >
      {body}
    </Pressable>
  );
}

/** White rounded section with an optional header and trailing action. */
export function Section({
  title,
  action,
  children,
}: PropsWithChildren<{ title?: string; action?: ReactNode }>) {
  return (
    <View className="gap-2">
      {(title || action) && (
        <View className="flex-row items-center justify-between px-1">
          {title && <Text className="text-lg font-bold text-ink">{title}</Text>}
          {action}
        </View>
      )}
      <View className="rounded-3xl bg-card px-4 py-1">{children}</View>
    </View>
  );
}

export function Divider() {
  return <View className="h-px bg-line" />;
}

/** Round quick action under the balance (Add money · Send · Receive). */
export function QuickAction({
  icon,
  label,
  onPress,
  light = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  light?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-1 items-center gap-2 active:opacity-70"
    >
      <View
        className={`h-14 w-14 items-center justify-center rounded-full ${light ? 'bg-white/20' : 'bg-card'}`}
      >
        <Icon name={icon} size={22} color={light ? colors.card : colors.ink} />
      </View>
      <Text
        className={`text-sm font-semibold ${light ? 'text-white' : 'text-ink'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'brand' | 'success' | 'warning';
}) {
  const style = {
    neutral: 'bg-canvas text-muted',
    brand: 'bg-brandSoft text-brand',
    success: 'bg-successSoft text-success',
    warning: 'bg-warningSoft text-warning',
  }[tone];
  return (
    <Text
      className={`self-start overflow-hidden rounded-full px-3 py-1 text-xs font-bold ${style}`}
    >
      {label}
    </Text>
  );
}

/** "Step 2 of 4" progress bar for onboarding. */
export function Steps({ current, total }: { current: number; total: number }) {
  return (
    <View className="flex-row gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          className={`h-1 flex-1 rounded-full ${i < current ? 'bg-brand' : 'bg-line'}`}
        />
      ))}
    </View>
  );
}

/** Checklist line for multi-step progress (done / running / waiting). */
export function StepLine({
  label,
  detail,
  state,
}: {
  label: string;
  detail?: string;
  state: 'done' | 'active' | 'todo' | 'error';
}) {
  const icon: IconName =
    state === 'done'
      ? 'checkmark.circle.fill'
      : state === 'error'
        ? 'exclamationmark.circle.fill'
        : state === 'active'
          ? 'circle.dotted'
          : 'circle';
  const color =
    state === 'done'
      ? colors.success
      : state === 'error'
        ? colors.brand
        : state === 'active'
          ? colors.ink
          : colors.faint;
  return (
    <View className="flex-row gap-3 py-2">
      <Icon name={icon} size={22} color={color} />
      <View className="flex-1 gap-0.5">
        <Text
          className={`text-base font-semibold ${state === 'todo' ? 'text-faint' : 'text-ink'}`}
        >
          {label}
        </Text>
        {detail && <Text className="text-sm text-muted">{detail}</Text>}
      </View>
    </View>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <View
      accessibilityRole="alert"
      className="flex-row gap-2 rounded-2xl bg-brandSoft p-4"
    >
      <Icon
        name="exclamationmark.triangle.fill"
        size={16}
        color={colors.brand}
      />
      <Text className="flex-1 text-sm leading-5 text-brandDark">{error}</Text>
    </View>
  );
}

/** Swissquote wordmark used on the welcome and login screens. */
export function Wordmark({ light = false }: { light?: boolean }) {
  return (
    <View className="flex-row items-center gap-2">
      {light ? (
        <View className="h-11 w-11 items-center justify-center rounded-full bg-white">
          <WalletLogo size={36} />
        </View>
      ) : (
        <WalletLogo size={36} />
      )}
      <Text
        className={`text-xl font-extrabold tracking-tight ${light ? 'text-white' : 'text-ink'}`}
      >
        Swissquote Wallet
      </Text>
    </View>
  );
}
