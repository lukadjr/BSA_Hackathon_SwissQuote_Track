// Recovery endpoints of the demo backend. Only public data travels here:
// addresses, invite/case ids and signatures. The chain stays the authority;
// the app re-checks what matters (guardians, nonce, pending request) on-chain.
import type { Address, Hex } from '@swissquote/wallet-core';
import { request } from './api';

export interface CaseApproval {
  guardianAddress: Address;
  signature: Hex;
  isSwissquote: boolean;
}
export type CaseStatus =
  'collecting' | 'started' | 'other_request_pending' | 'closed' | 'finalized';
export interface RecoveryCase {
  caseId: string;
  safeAddress: Address;
  module: Address;
  newOwnerAddress: Address;
  nonce: string;
  status: CaseStatus;
  executeAfter: number | null;
  approvals: CaseApproval[];
  threshold: number;
}
export interface GuardianRequest {
  caseId: string;
  safeAddress: Address;
  module: Address;
  newOwnerAddress: Address;
  nonce: string;
  approvedByYou: boolean;
}
export interface RecoveryStatus {
  protected: boolean;
  guardians: Address[];
  pending: { newOwnerAddress: Address; executeAfter: number } | null;
  openRequests: { caseId: string; newOwnerAddress: Address }[];
  alerts: { kind: string; message: string; createdAt: string }[];
  swissquoteGuardian: Address | null;
}

type RawCase = {
  case_id: string;
  safe_address: Address;
  module: Address;
  new_owner_address: Address;
  nonce: string;
  status: CaseStatus;
  execute_after: number | null;
  approvals: {
    guardian_address: Address;
    signature: Hex;
    is_swissquote: boolean;
  }[];
  threshold: number;
};
function toCase(raw: RawCase): RecoveryCase {
  return {
    caseId: raw.case_id,
    safeAddress: raw.safe_address,
    module: raw.module,
    newOwnerAddress: raw.new_owner_address,
    nonce: raw.nonce,
    status: raw.status,
    executeAfter: raw.execute_after,
    approvals: raw.approvals.map((a) => ({
      guardianAddress: a.guardian_address,
      signature: a.signature,
      isSwissquote: a.is_swissquote,
    })),
    threshold: raw.threshold,
  };
}

export async function getSwissquoteGuardian(signal?: AbortSignal) {
  const data = await request<{
    address: Address;
    relayer_address: Address | null;
  }>('/guardians/swissquote', undefined, signal, 'GET');
  return { address: data.address, relayerAddress: data.relayer_address };
}

export async function getMyWallet(signal?: AbortSignal) {
  const data = await request<{ user_id: string; safe_address: Address }>(
    '/me/wallet',
    undefined,
    signal,
    'GET',
  );
  return { userId: data.user_id, safeAddress: data.safe_address };
}

export async function createGuardianInvite(
  safe: Address,
  signal?: AbortSignal,
) {
  const data = await request<{
    invite_id: string;
    safe_address: Address;
    from: string;
    expires_at: string;
  }>('/guardians/invites', { safe_address: safe }, signal);
  return {
    inviteId: data.invite_id,
    safeAddress: data.safe_address,
    from: data.from,
    expiresAt: data.expires_at,
  };
}

export async function readGuardianInvite(
  inviteId: string,
  signal?: AbortSignal,
) {
  const data = await request<{
    status: 'open' | 'accepted';
    guardian_address: Address | null;
  }>(
    `/guardians/invites/${encodeURIComponent(inviteId)}`,
    undefined,
    signal,
    'GET',
  );
  return { status: data.status, guardianAddress: data.guardian_address };
}

export async function acceptGuardianInvite(
  inviteId: string,
  guardianAddress: Address,
  signature: Hex,
  signal?: AbortSignal,
) {
  await request(
    `/guardians/invites/${encodeURIComponent(inviteId)}/accept`,
    { guardian_address: guardianAddress, signature },
    signal,
  );
}

export async function listGuardianRequests(
  guardian: Address,
  signal?: AbortSignal,
): Promise<GuardianRequest[]> {
  const data = await request<{
    requests: {
      case_id: string;
      safe_address: Address;
      module: Address;
      new_owner_address: Address;
      nonce: string;
      approved_by_you: boolean;
    }[];
  }>(`/guardians/${guardian.toLowerCase()}/requests`, undefined, signal, 'GET');
  return data.requests.map((r) => ({
    caseId: r.case_id,
    safeAddress: r.safe_address,
    module: r.module,
    newOwnerAddress: r.new_owner_address,
    nonce: r.nonce,
    approvedByYou: r.approved_by_you,
  }));
}

export async function createRecoveryCase(
  safe: Address,
  newOwner: Address,
  signal?: AbortSignal,
) {
  return toCase(
    await request<RawCase>(
      '/recovery/requests',
      { safe_address: safe, new_owner_address: newOwner },
      signal,
    ),
  );
}

const casePath = (id: string) => `/recovery/requests/${encodeURIComponent(id)}`;

export async function readRecoveryCase(id: string, signal?: AbortSignal) {
  return toCase(await request<RawCase>(casePath(id), undefined, signal, 'GET'));
}

export async function addRecoveryApproval(
  id: string,
  guardian: Address,
  signature: Hex,
  signal?: AbortSignal,
) {
  return toCase(
    await request<RawCase>(
      `${casePath(id)}/approvals`,
      { guardian_address: guardian, signature },
      signal,
    ),
  );
}

export async function askSwissquoteApproval(id: string, signal?: AbortSignal) {
  return toCase(
    await request<RawCase>(
      `${casePath(id)}/swissquote-approve`,
      { identity_confirmed: true },
      signal,
    ),
  );
}

export async function relayRecoveryStart(id: string, signal?: AbortSignal) {
  return (await request<{ tx_hash: Hex }>(`${casePath(id)}/submit`, {}, signal))
    .tx_hash;
}

export async function relayRecoveryFinalize(id: string, signal?: AbortSignal) {
  return (
    await request<{ tx_hash: Hex }>(`${casePath(id)}/finalize`, {}, signal)
  ).tx_hash;
}

export async function readRecoveryStatus(
  safe: Address,
  signal?: AbortSignal,
): Promise<RecoveryStatus> {
  const data = await request<{
    protected: boolean;
    guardians: Address[];
    pending: { new_owner_address: Address; execute_after: number } | null;
    open_requests: { case_id: string; new_owner_address: Address }[];
    alerts: { kind: string; message: string; created_at: string }[];
    swissquote_guardian: Address | null;
  }>(
    `/wallets/${safe.toLowerCase()}/recovery-status`,
    undefined,
    signal,
    'GET',
  );
  return {
    protected: data.protected,
    guardians: data.guardians,
    pending: data.pending
      ? {
          newOwnerAddress: data.pending.new_owner_address,
          executeAfter: data.pending.execute_after,
        }
      : null,
    openRequests: data.open_requests.map((r) => ({
      caseId: r.case_id,
      newOwnerAddress: r.new_owner_address,
    })),
    alerts: data.alerts.map((a) => ({
      kind: a.kind,
      message: a.message,
      createdAt: a.created_at,
    })),
    swissquoteGuardian: data.swissquote_guardian,
  };
}
