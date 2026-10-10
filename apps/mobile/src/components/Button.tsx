import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { Icon, type IconName } from './Icon';

type Props = {
  label: string;
  onPress: () => void;
  /** primary: red pill · secondary: white pill · ghost: text only · dark: black pill */
  variant?: 'primary' | 'secondary' | 'ghost' | 'dark';
  /** Legacy shorthand for variant="secondary". */
  secondary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
};

export function Button({
  label,
  onPress,
  variant,
  secondary = false,
  disabled = false,
  busy = false,
  icon,
}: Props) {
  const kind = variant ?? (secondary ? 'secondary' : 'primary');
  const box = {
    primary: 'bg-brand',
    secondary: 'bg-card border border-line',
    ghost: 'bg-transparent',
    dark: 'bg-ink',
  }[kind];
  const text =
    kind === 'primary' || kind === 'dark'
      ? colors.card
      : kind === 'ghost'
        ? colors.brand
        : colors.ink;
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      style={inactive ? { opacity: 0.5 } : undefined}
      onPress={onPress}
      className={`min-h-14 flex-row items-center justify-center gap-2 rounded-full px-6 py-4 active:opacity-80 ${box}`}
    >
      {busy ? (
        <ActivityIndicator color={text} />
      ) : (
        icon && <Icon name={icon} size={18} color={text} />
      )}
      <View>
        <Text
          style={{ color: text }}
          className="text-center text-base font-semibold"
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}
