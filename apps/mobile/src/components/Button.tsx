import { Pressable, Text } from 'react-native';

type Props = {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
};

export function Button({
  label,
  onPress,
  secondary = false,
  disabled = false,
}: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      style={disabled ? { opacity: 0.5 } : undefined}
      onPress={onPress}
      className={`rounded-2xl px-5 py-4 border active:opacity-70 ${
        secondary ? 'bg-white border-line' : 'bg-accent border-accent'
      }`}
    >
      <Text
        className={`text-center font-semibold text-base ${secondary ? 'text-ink' : 'text-white'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
