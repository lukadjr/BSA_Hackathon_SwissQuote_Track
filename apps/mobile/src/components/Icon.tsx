import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import semiBold from 'expo-symbols/androidWeights/semiBold';
import { Text, type ColorValue } from 'react-native';
import { colors } from '../theme/colors';

export type IconName = Extract<SymbolViewProps['name'], string>;
type AndroidSymbol = NonNullable<
  Extract<SymbolViewProps['name'], object>['android']
>;

/** Material Symbol used on Android (and web) for each SF Symbol the app uses. */
const MATERIAL: Partial<Record<IconName, AndroidSymbol>> = {
  'arrow.counterclockwise': 'restart_alt',
  'arrow.down.left': 'south_west',
  'arrow.left.arrow.right': 'swap_horiz',
  'arrow.right': 'arrow_forward',
  'arrow.up.right': 'north_east',
  'bell.badge.fill': 'notifications_active',
  'bell.fill': 'notifications',
  'building.columns.fill': 'account_balance',
  'checkmark.circle.fill': 'check_circle',
  'checkmark.shield.fill': 'verified_user',
  'chevron.right': 'chevron_right',
  circle: 'radio_button_unchecked',
  'circle.dotted': 'pending',
  'diamond.fill': 'diamond',
  'doc.text.fill': 'description',
  dollarsign: 'attach_money',
  'exclamationmark.circle.fill': 'error',
  'exclamationmark.shield.fill': 'gpp_maybe',
  'exclamationmark.triangle.fill': 'warning',
  faceid: 'fingerprint',
  'house.fill': 'home',
  'key.fill': 'key',
  link: 'link',
  'person.2': 'group',
  'person.2.fill': 'group',
  'person.crop.circle': 'account_circle',
  'person.crop.circle.fill': 'account_circle',
  'person.fill': 'person',
  plus: 'add',
  qrcode: 'qr_code',
  'qrcode.viewfinder': 'qr_code_scanner',
  'rectangle.portrait.and.arrow.right': 'logout',
  'shield.lefthalf.filled': 'shield',
  'shield.slash.fill': 'remove_moderator',
  sparkles: 'auto_awesome',
  'square.and.arrow.up': 'share',
  'wallet.pass.fill': 'wallet',
};

/** SF Symbol on iOS, the matching Material Symbol on Android and web. */
export function Icon({
  name,
  size = 22,
  color = colors.ink,
}: {
  name: IconName;
  size?: number;
  color?: ColorValue;
}) {
  const material = MATERIAL[name];
  return (
    <SymbolView
      name={material ? { ios: name, android: material, web: material } : name}
      size={size}
      tintColor={color}
      weight={{ ios: 'semibold', android: semiBold }}
      fallback={<Text style={{ color, fontSize: size * 0.8 }}>•</Text>}
    />
  );
}
