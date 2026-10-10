// Recent wallet activity for the Payments tab: bank deposits come from the
// demo backend, sent transfers from this phone's own log. Public data only.
import * as SecureStore from 'expo-secure-store';
import type { ConfirmedTransfer } from '@swissquote/wallet-core';
import { formatUnits } from 'viem';
import type { FundingIntent } from './funding';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};
const SENT_KEY = 'swissquote.activity.sent.v1';
const MAX_ENTRIES = 30;

export interface ActivityItem {
  id: string;
  kind: 'deposit' | 'setup' | 'sent';
  /** Human amount in test USDC, e.g. "12.5"; null for setup operations. */
  amount: string | null;
  counterparty: string;
  status: 'pending' | 'confirmed' | 'failed';
  /** ISO time; null when unknown. */
  at: string | null;
  transactionHash: string | null;
}

interface SentEntry {
  hash: string;
  recipient: string;
  amount: string;
  at: string;
}

async function readSent(): Promise<SentEntry[]> {
  try {
    const json = await SecureStore.getItemAsync(SENT_KEY, OPTIONS);
    const value = json ? (JSON.parse(json) as SentEntry[]) : [];
    return Array.isArray(value)
      ? value.filter(
          (e) =>
            typeof e?.hash === 'string' &&
            /^0x[\da-fA-F]{64}$/.test(e.hash) &&
            typeof e.recipient === 'string' &&
            typeof e.amount === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

/** Remember a confirmed outgoing transfer (idempotent per transaction hash). */
export async function recordSentTransfer(transfer: ConfirmedTransfer) {
  const entries = await readSent();
  if (entries.some((e) => e.hash === transfer.transactionHash)) return;
  const next: SentEntry[] = [
    {
      hash: transfer.transactionHash,
      recipient: transfer.recipient,
      amount: formatUnits(BigInt(transfer.amountUnits), transfer.decimals),
      at: new Date().toISOString(),
    },
    ...entries,
  ].slice(0, MAX_ENTRIES);
  try {
    await SecureStore.setItemAsync(SENT_KEY, JSON.stringify(next), OPTIONS);
  } catch {
    // Activity is a convenience log; the chain stays the source of truth.
  }
}

function fundingStatus(i: FundingIntent): ActivityItem['status'] {
  if (i.status === 'confirmed') return 'confirmed';
  if (i.status === 'failed' || i.status === 'expired') return 'failed';
  return 'pending';
}

/** Merge bank intents for this Safe with the local sent log, newest first. */
export function buildActivity(
  intents: (FundingIntent & { created_at?: string | null })[],
  sent: { hash: string; recipient: string; amount: string; at: string }[],
  safe: string,
): ActivityItem[] {
  const fromBank: ActivityItem[] = intents
    .filter((i) => i.safe_address.toLowerCase() === safe.toLowerCase())
    .filter((i) => i.status !== 'expired' || i.transaction_hash)
    .map((i) => ({
      id: i.id,
      kind: i.kind === 'deploy' ? 'setup' : 'deposit',
      amount:
        i.kind === 'deposit' ? (Number(i.amount_units) / 1e6).toString() : null,
      counterparty: 'Swissquote account',
      status: fundingStatus(i),
      at: i.created_at ?? null,
      transactionHash: i.transaction_hash,
    }));
  const fromPhone: ActivityItem[] = sent.map((e) => ({
    id: e.hash,
    kind: 'sent',
    amount: e.amount,
    counterparty: e.recipient,
    status: 'confirmed',
    at: e.at,
    transactionHash: e.hash,
  }));
  const time = (a: ActivityItem) => (a.at ? Date.parse(a.at) : 0);
  // Bank intents without a time keep the server's newest-first order.
  return [...fromPhone, ...fromBank].sort((a, b) => time(b) - time(a));
}

export async function readSentTransfers() {
  return readSent();
}

export async function clearActivityForDev() {
  await SecureStore.deleteItemAsync(SENT_KEY, OPTIONS);
}
