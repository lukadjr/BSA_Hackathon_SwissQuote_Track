import { Tabs } from 'expo-router/js-tabs';
import type { ColorValue } from 'react-native';
import { Icon, type IconName } from '../../components/Icon';
import { colors } from '../../theme/colors';

function icon(name: IconName) {
  return function TabIcon({ color }: { color: ColorValue }) {
    return <Icon name={name} size={22} color={color} />;
  };
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.line,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: colors.canvas },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{ title: 'Home', tabBarIcon: icon('house.fill') }}
      />
      <Tabs.Screen
        name="payments"
        options={{
          title: 'Payments',
          tabBarIcon: icon('arrow.left.arrow.right'),
        }}
      />
      <Tabs.Screen
        name="guardians"
        options={{
          title: 'Guardians',
          tabBarIcon: icon('shield.lefthalf.filled'),
        }}
      />
    </Tabs>
  );
}
