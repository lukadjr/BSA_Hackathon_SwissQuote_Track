import type { SafeAccountInfo } from '@swissquote/wallet-core';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Share, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { QrCode } from '../../components/QrCode';
import { Screen } from '../../components/Screen';
import { ErrorText } from '../../components/ui';
import { getSafeAccount } from '../../lib/safeWallet';
import { describeWalletError } from '../../lib/wallet';

/** The Safe address as a QR code: the only address to receive funds on. */
export default function ReceiveScreen() {
  const [account, setAccount] = useState<SafeAccountInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getSafeAccount()
      .then(setAccount)
      .catch((e: unknown) => setError(describeWalletError(e)));
  }, []);

  return (
    <Screen
      footer={
        account && (
          <Button
            label="Share address"
            icon="square.and.arrow.up"
            onPress={() =>
              void Share.share({ message: account.safeAddress }).catch(() => {})
            }
          />
        )
      }
    >
      <View className="items-center gap-2 py-2">
        <Text className="text-2xl font-bold text-ink">Your wallet address</Text>
        <Text className="text-center text-base leading-6 text-muted">
          Send only Sepolia test USDC or Sepolia ETH to this address.
        </Text>
      </View>
      {!account && !error && <ActivityIndicator />}
      {account && (
        <View className="items-center gap-5 rounded-[32px] bg-card p-6">
          <QrCode value={account.safeAddress} size={240} />
          <Text
            selectable
            accessibilityLabel="Wallet address"
            className="text-center font-mono text-sm leading-6 text-ink"
          >
            {account.safeAddress}
          </Text>
          <Text className="text-center text-xs text-muted">
            Ethereum Sepolia · Safe smart account
            {account.deployed ? '' : ' (deployed on first use)'}
          </Text>
        </View>
      )}
      <ErrorText error={error} />
    </Screen>
  );
}
