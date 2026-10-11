// Phone-side recovery state. Everything stored here is PUBLIC (addresses,
// signatures, ids): secrets stay in SecureStore behind Face ID, and the backup
// phrase is never stored at all.
import './polyfills';
import {
  createRecoveryClient,
  executeRecoveryCall,
  finalizeRecoveryCall,
  recoveryModuleFor,
  WalletError,
  type Address,
  type GuardianApproval,
  type RecoveryClient,
  type RecoveryPeriod,
  type SecurityPreview,
} from '@swissquote/wallet-core';
import * as SecureStore from 'expo-secure-store';
import { isAddressEqual } from 'viem';
import { ApiError } from './api';
import { getSafeWallet } from './safeWallet';
import { secureStoreAdapter } from './secureStoreAdapter';
import { describeWalletError } from './wallet';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};
const LABELS_KEY = 'swissquote.recovery.labels.v1';
const PENDING_KEY = 'swissquote.recovery.pending.v1';
const RECOVERED_KEY = 'swissquote.safe.recovered.v1';

/** 3 days in the product; EXPO_PUBLIC_RECOVERY_PERIOD=demoThreeMinutes for demos. */
export function recoveryPeriod(): RecoveryPeriod {
  return process.env.EXPO_PUBLIC_RECOVERY_PERIOD === 'demoThreeMinutes'
    ? 'demoThreeMinutes'
    : 'threeDays';
}
export function recoveryModule(): Address {
  return recoveryModuleFor(recoveryPeriod());
}
export function periodLabel(): string {
  return recoveryPeriod() === 'threeDays' ? '3 days' : '3 minutes (demo)';
}

let client: RecoveryClient | undefined;
export function getRecoveryClient(): RecoveryClient {
  client ??= createRecoveryClient({
    rpcUrl: process.env.EXPO_PUBLIC_RPC_PUBLIC_URL ?? '',
  });
  return client;
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const json = await SecureStore.getItemAsync(key, OPTIONS);
    return json === null ? null : (JSON.parse(json) as T);
  } catch {
    throw new WalletError('STORAGE_FAILED', 'Could not read recovery data.');
  }
}
async function writeJson(key: string, value: unknown) {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key, OPTIONS);
    else await SecureStore.setItemAsync(key, JSON.stringify(value), OPTIONS);
  } catch {
    throw new WalletError('STORAGE_FAILED', 'Could not save recovery data.');
  }
}

// ---- Guardian labels (owner phone) -----------------------------------------
export type GuardianRole = 'backup' | 'swissquote' | 'friend';
export type GuardianLabels = Record<string, GuardianRole>;

export async function readGuardianLabels(): Promise<GuardianLabels> {
  return (await readJson<GuardianLabels>(LABELS_KEY)) ?? {};
}
export async function saveGuardianLabel(address: Address, role: GuardianRole) {
  const labels = await readGuardianLabels();
  for (const [key, value] of Object.entries(labels))
    if (value === role) delete labels[key];
  labels[address.toLowerCase()] = role;
  await writeJson(LABELS_KEY, labels);
}
export async function saveGuardianLabels(labels: GuardianLabels) {
  await writeJson(
    LABELS_KEY,
    Object.fromEntries(
      Object.entries(labels).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  );
}
export function roleTitle(role: GuardianRole | undefined): string {
  switch (role) {
    case 'backup':
      return 'Your backup phrase';
    case 'swissquote':
      return 'Swissquote Wallet';
    case 'friend':
      return 'Trusted friend';
    default:
      return 'Guardian';
  }
}

// ---- Recovered Safe binding (new phone after finalization) -----------------
export async function readRecoveredSafe(): Promise<Address | null> {
  const value = await readJson<{ safe: Address; owner: Address }>(
    RECOVERED_KEY,
  );
  if (!value) return null;
  const owner = await secureStoreAdapter.readAddress();
  // Only valid for the key it was recovered to.
  return owner && isAddressEqual(owner, value.owner) ? value.safe : null;
}
export async function saveRecoveredSafe(safe: Address, owner: Address) {
  const localOwner = await secureStoreAdapter.readAddress();
  const owners = await getRecoveryClient().readOwners(safe);
  if (
    !localOwner ||
    !isAddressEqual(localOwner, owner) ||
    owners.length !== 1 ||
    !isAddressEqual(owners[0], owner)
  )
    throw new WalletError(
      'SAFE_CONFIG_INVALID',
      'Recovery is not finalized for this phone yet.',
    );
  await writeJson(RECOVERED_KEY, { safe, owner });
}

// ---- Recovery in progress (new phone) --------------------------------------
export interface PendingRecoveryLocal {
  safe: Address;
  module: Address;
  newOwner: Address;
  nonce: string;
  caseId: string | null;
  /** Approvals collected without the backend (backup phrase, friend's QR). */
  approvals: GuardianApproval[];
}

export async function readPendingRecovery(): Promise<PendingRecoveryLocal | null> {
  return readJson<PendingRecoveryLocal>(PENDING_KEY);
}
export async function savePendingRecovery(value: PendingRecoveryLocal | null) {
  await writeJson(PENDING_KEY, value);
}

export function mergeApprovals(
  ...lists: GuardianApproval[][]
): GuardianApproval[] {
  const byGuardian = new Map<string, GuardianApproval>();
  for (const list of lists)
    for (const a of list) byGuardian.set(a.guardian.toLowerCase(), a);
  return [...byGuardian.values()];
}

/** Send a public recovery call paid by this phone's key (needs Sepolia ETH). */
export async function sendFromThisPhone(
  kind: 'start' | 'finalize',
  pending: PendingRecoveryLocal,
  approvals: GuardianApproval[],
) {
  const call =
    kind === 'start'
      ? executeRecoveryCall(
          pending.module,
          pending.safe,
          pending.newOwner,
          approvals,
        )
      : finalizeRecoveryCall(pending.module, pending.safe);
  let key: `0x${string}` | undefined =
    await secureStoreAdapter.readPrivateKeyForSigning();
  try {
    return await getRecoveryClient().sendCall(key, call);
  } finally {
    key = undefined;
  }
}

export async function clearRecoveryForDev() {
  for (const key of [LABELS_KEY, PENDING_KEY, RECOVERED_KEY])
    await SecureStore.deleteItemAsync(key, OPTIONS);
}

export function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'now';
  const d = Math.floor(secondsLeft / 86400);
  const h = Math.floor((secondsLeft % 86400) / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = Math.floor(secondsLeft % 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

/** One message for wallet, chain and backend errors. Never raw server text. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'NOT_CONFIGURED') return e.message;
    if (e.status === 503)
      return 'This Swissquote service is not available right now.';
    if (e.status === 409)
      return 'This request is no longer open or not ready yet.';
    if (e.status === 401) return 'The signature was refused.';
    return e.message;
  }
  if (e instanceof WalletError && e.code === 'INVALID_MESSAGE')
    return e.message;
  return describeWalletError(e);
}

/** Submit an owner-signed security change and wait for its inclusion. */
export async function runSecurityOperation(
  preview: SecurityPreview,
  signal?: AbortSignal,
): Promise<{ transactionHash: string }> {
  const wallet = getSafeWallet();
  const { userOperationHash } = await wallet.submitSecurityOperation(
    preview,
    signal,
  );
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await wallet.checkSecurityOperation(userOperationHash);
    if (result) {
      if (!result.success)
        throw new WalletError(
          'TRANSFER_FAILED',
          'The operation reverted on Sepolia. Nothing changed.',
        );
      return { transactionHash: result.transactionHash };
    }
    await new Promise((done) => setTimeout(done, 3000));
  }
  throw new WalletError(
    'TRANSFER_PENDING',
    'Still waiting for Sepolia. Refresh this screen in a moment.',
  );
}
