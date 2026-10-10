import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Text, type ColorValue } from 'react-native';
import { colors } from '../theme/colors';

export type IconName = Extract<SymbolViewProps['name'], string>;

/** SF Symbol on iOS; a neutral dot elsewhere (the demo targets iPhone). */
export function Icon({
  name,
  size = 22,
  color = colors.ink,
}: {
  name: IconName;
  size?: number;
  color?: ColorValue;
}) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      weight="semibold"
      fallback={<Text style={{ color, fontSize: size * 0.8 }}>•</Text>}
    />
  );
}
