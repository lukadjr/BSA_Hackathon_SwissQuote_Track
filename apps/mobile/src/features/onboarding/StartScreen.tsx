import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { Icon, type IconName } from '../../components/Icon';
import { Screen } from '../../components/Screen';
import { IconTile } from '../../components/ui';
import { clearSession, getSession } from '../../lib/auth';
import { colors } from '../../theme/colors';

/** Logged in, no key on this phone: create a wallet or recover the old one. */
export default function StartScreen() {
  const [name, setName] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      getSession()
        .then((s) => setName(s?.username ?? null))
        .catch(() => setName(null));
    }, []),
  );
  return (
    <Screen
      title={name ? `Hi ${name}` : 'Hi there'}
      subtitle="How do you want to start on this phone?"
      footer={
        <Button
          label="Log out"
          variant="ghost"
          onPress={() => {
            void clearSession().finally(() => router.replace('/welcome'));
          }}
        />
      }
    >
      <Choice
        icon="plus"
        title="Create a new wallet"
        text="Verify your identity, create your keys on this phone and choose your trusted guardians."
        onPress={() => router.push('/kyc')}
        primary
      />
      <Choice
        icon="arrow.counterclockwise"
        title="Recover my wallet"
        text="Lost your phone? Two of your three guardians bring your wallet to this phone."
        onPress={() => router.push('/recover')}
      />
    </Screen>
  );
}

function Choice({
  icon,
  title,
  text,
  onPress,
  primary = false,
}: {
  icon: IconName;
  title: string;
  text: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      className={`gap-4 rounded-3xl p-5 active:opacity-80 ${primary ? 'bg-ink' : 'bg-card'}`}
    >
      <View className="flex-row items-center justify-between">
        <IconTile name={icon} tone={primary ? 'brand' : 'neutral'} size={48} />
        <Icon
          name="arrow.right"
          size={18}
          color={primary ? colors.card : colors.ink}
        />
      </View>
      <View className="gap-1">
        <Text
          className={`text-xl font-bold ${primary ? 'text-white' : 'text-ink'}`}
        >
          {title}
        </Text>
        <Text
          className={`text-base leading-6 ${primary ? 'text-white/80' : 'text-muted'}`}
        >
          {text}
        </Text>
      </View>
    </Pressable>
  );
}
