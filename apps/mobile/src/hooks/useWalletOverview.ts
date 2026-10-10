import type { SafeAccountInfo } from '@swissquote/wallet-core';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { isAddressEqual } from 'viem';
import { getLinkStatus } from '../lib/api';
import { getSafeAccount } from '../lib/safeWallet';
import { describeWalletError } from '../lib/wallet';

/**
 * Safe balances (from Sepolia) and whether the Swissquote link is current.
 * Re-reads on focus; `refresh` forces a re-read (pull to refresh).
 */
export function useWalletOverview() {
  const [account, setAccount] = useState<SafeAccountInfo | null>(null);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useFocusEffect(refresh);

  useEffect(() => {
    let active = true;
    getSafeAccount()
      .then(async (info) => {
        if (!active) return;
        setAccount(info);
        setError(null);
        try {
          const link = await getLinkStatus();
          if (!active) return;
          setLinked(
            link.bank_transfers_allowed &&
              !!link.safe_address &&
              !!link.owner_address &&
              isAddressEqual(link.safe_address, info.safeAddress) &&
              isAddressEqual(link.owner_address, info.ownerAddress),
          );
        } catch {
          // Swissquote offline: self-custody access never depends on it.
          if (active) setLinked(null);
        }
      })
      .catch((e: unknown) => active && setError(describeWalletError(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [tick]);

  return { account, linked, error, loading, refresh };
}
