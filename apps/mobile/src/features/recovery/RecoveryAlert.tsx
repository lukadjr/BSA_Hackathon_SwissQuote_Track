import { shortAddress, type SecurityState } from '@swissquote/wallet-core';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { formatCountdown } from '../../lib/recovery';
import type { RecoveryStatus } from '../../lib/recoveryApi';
import { SecurityReview, Words } from './parts';

/**
 * Owner phone: someone started a recovery of this Safe. The deadline comes
 * from the chain (executeAfter), never from the backend.
 */
export function RecoveryAlert({
  state,
  onChanged,
}: {
  state: SecurityState;
  onChanged: () => void;
}) {
  const pending = state.recovery?.pending;
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!pending) return null;
  const newOwner = pending.newOwners[0];
  const left = pending.executeAfter - now;
  return (
    <Card tone="alert">
      <Text className="text-lg font-bold text-accent">
        Someone wants to change the key of your wallet
      </Text>
      <Text className="text-base text-ink">
        {pending.approvals} guardians approved moving your Safe to the key{' '}
        {shortAddress(newOwner)}.
        {left > 0
          ? ` It takes effect in ${formatCountdown(left)} unless you cancel.`
          : ' The waiting period is over: it can be finalized now.'}
      </Text>
      <Words address={newOwner} caption="Words of the new key" />
      <Text className="text-sm text-muted">
        If you asked for this from a new phone, its screen shows the same words
        and you have nothing to do. Otherwise, cancel now.
      </Text>
      {left > 0 &&
        (cancelling ? (
          <SecurityReview
            action={{ kind: 'cancel-recovery' }}
            title="Cancel this recovery"
            confirmLabel="Cancel with Face ID"
            onDone={() => {
              setCancelling(false);
              onChanged();
            }}
          >
            <Text className="text-sm text-muted">
              Your Safe keeps this phone as its only owner. Afterwards, replace
              any guardian you no longer trust.
            </Text>
          </SecurityReview>
        ) : (
          <Button
            label="It wasn't me: cancel"
            onPress={() => setCancelling(true)}
          />
        ))}
    </Card>
  );
}

/**
 * Owner phone: someone opened a recovery request with Swissquote but it has
 * not started on-chain yet. The owner can void any approvals already signed.
 */
export function RequestedAlert({
  state,
  status,
  onChanged,
}: {
  state: SecurityState;
  status: RecoveryStatus | null;
  onChanged: () => void;
}) {
  const [voiding, setVoiding] = useState(false);
  const request = status?.openRequests[0];
  if (!request || !state.recovery || state.recovery.pending) return null;
  return (
    <Card tone="alert">
      <Text className="text-lg font-bold text-accent">
        A recovery of your wallet was requested
      </Text>
      <Text className="text-base text-ink">
        Someone asked to move your Safe to the key{' '}
        {shortAddress(request.newOwnerAddress)}. Nothing has changed yet.
      </Text>
      <Words address={request.newOwnerAddress} caption="Words of the new key" />
      {voiding ? (
        <SecurityReview
          action={{ kind: 'invalidate-approvals' }}
          title="Void this request"
          confirmLabel="Void with Face ID"
          onDone={() => {
            setVoiding(false);
            onChanged();
          }}
        >
          <Text className="text-sm text-muted">
            Every guardian approval already given for it stops working.
          </Text>
        </SecurityReview>
      ) : (
        <Button
          label="It wasn't me: void it"
          onPress={() => setVoiding(true)}
        />
      )}
    </Card>
  );
}
