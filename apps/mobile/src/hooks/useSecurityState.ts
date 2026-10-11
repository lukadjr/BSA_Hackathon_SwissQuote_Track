import type { SecurityState } from '@swissquote/wallet-core';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { describeError } from '../lib/recovery';
import { readRecoveryStatus, type RecoveryStatus } from '../lib/recoveryApi';
import { getSafeWallet } from '../lib/safeWallet';

/**
 * On-chain security state of this phone's Safe (authoritative) plus the
 * backend's alerts (best effort). Refreshes on focus, on return to the
 * foreground and every 30 s, so a started recovery shows up quickly.
 */
export function useSecurityState() {
  const [state, setState] = useState<SecurityState | null>(null);
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useFocusEffect(
    useCallback(() => {
      setState(null);
      setStatus(null);
      setError(null);
      refresh();
      const timer = setInterval(refresh, 30_000);
      const sub = AppState.addEventListener(
        'change',
        (s) => s === 'active' && refresh(),
      );
      return () => {
        clearInterval(timer);
        sub.remove();
      };
    }, [refresh]),
  );

  useEffect(() => {
    let active = true;
    getSafeWallet()
      .getSecurityState()
      .then(async (s) => {
        if (!active) return;
        setState(s);
        setError(null);
        try {
          const backend = await readRecoveryStatus(s.safeAddress);
          if (active) setStatus(backend);
        } catch {
          if (active) setStatus(null); // the chain view stays valid without it
        }
      })
      .catch((e: unknown) => active && setError(describeError(e)));
    return () => {
      active = false;
    };
  }, [tick]);

  return { state, status, error, refresh };
}
