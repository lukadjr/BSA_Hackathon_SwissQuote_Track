import { useEffect, useState } from 'react';
import { describeWalletError, getAddress, type Address } from '../lib/wallet';

/** Reads the public owner address once. `undefined` = still loading. */
export function useOwnerAddress() {
  const [address, setAddress] = useState<Address | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getAddress()
      .then((a) => active && setAddress(a))
      .catch((e: unknown) => active && setError(describeWalletError(e)));
    return () => {
      active = false;
    };
  }, []);

  return { address, error };
}
