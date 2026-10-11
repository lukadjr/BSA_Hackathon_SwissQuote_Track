// Backend client for the demo API (backend/). Only public data travels here:
// addresses, challenge ids and signatures. Never send a private key.
import type { Address, Signature } from './wallet';
import { clearSession, getSessionToken } from './auth';

const REQUEST_TIMEOUT_MS = 30_000;

export type ApiErrorCode =
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'UNAUTHORIZED'
  | 'REJECTED'
  | 'SERVER';

/** Error with a safe, user-facing message. Raw server text is not forwarded. */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientIdentity {
  client_id: string;
  display_name: string;
  kyc_status: 'verified' | 'pending' | 'rejected';
  verified_at: string | null;
  mocked: true;
}

export interface LinkStatus {
  client_id: string;
  kyc_status: ClientIdentity['kyc_status'];
  control_status: string;
  bank_transfers_allowed: boolean;
  safe_address: Address | null;
  owner_address: Address | null;
  chain_id: number;
  verified_at: string | null;
  checked_block: number | null;
  identity_mocked: true;
}

export interface LinkChallenge {
  challengeId: string;
  message: string;
  userId: string;
  ownerAddress: Address;
  safeAddress: Address;
  chainId: number;
  domain: string;
  expiresAt: string;
}

export interface LinkResult {
  userId: string;
  ownerAddress: Address;
  safeAddress: Address;
  chainId: number;
  ownerKeyVerified: boolean;
  ownershipVerified: boolean;
}

function config() {
  const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  // Disposable demo token for local builds only (see .env.example).
  const token = process.env.EXPO_PUBLIC_DEMO_ACCESS_TOKEN?.trim();
  if (!baseUrl || !token) {
    throw new ApiError(
      'NOT_CONFIGURED',
      'Backend not configured. Set EXPO_PUBLIC_API_BASE_URL and EXPO_PUBLIC_DEMO_ACCESS_TOKEN.',
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

export async function request<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
  method: 'GET' | 'POST' = 'POST',
  tokenOverride?: string,
): Promise<T> {
  const { baseUrl, token: defaultToken } = config();
  const token = tokenOverride ?? (await getSessionToken()) ?? defaultToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) controller.abort();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    if (signal?.aborted) throw new ApiError('NETWORK', 'Request cancelled.');
    if (controller.signal.aborted)
      throw new ApiError('TIMEOUT', 'The server did not answer in time.');
    throw new ApiError('NETWORK', 'Cannot reach the server.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }

  if (response.ok) {
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(
        'SERVER',
        'Unexpected server response.',
        response.status,
      );
    }
  }
  if (
    response.status === 401 &&
    !tokenOverride &&
    token !== defaultToken &&
    response.headers?.get('WWW-Authenticate')?.toLowerCase().includes('bearer')
  )
    await clearSession();
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(
      'UNAUTHORIZED',
      'The server refused this request.',
      response.status,
    );
  }
  if (response.status === 409) {
    const messages: Record<string, string> = {
      'Finish the existing bank operation first':
        'An operation is already pending for this account. Refresh to resume it.',
      'Wallet changed; relink required':
        'This account is registered to a different wallet. Use your own username or recover the original wallet.',
      'Safe does not match the registered wallet':
        'This wallet does not belong to the logged-in demo account. Log in with its original username.',
      'Wait for queued or submitted transactions before resetting the database':
        'A transaction is already queued or submitted. Wait for it to finish before resetting the database.',
      'Insufficient demo bank token balance':
        'The demo treasury does not have enough test tokens.',
    };
    const detail = await response.json().catch(() => null);
    throw new ApiError(
      'REJECTED',
      typeof detail?.detail === 'string' &&
        Object.prototype.hasOwnProperty.call(messages, detail.detail)
        ? messages[detail.detail]
        : 'This operation conflicts with the current account state. Refresh its status.',
      409,
    );
  }
  if (response.status >= 400 && response.status < 500) {
    throw new ApiError(
      'REJECTED',
      'The server rejected this request.',
      response.status,
    );
  }
  throw new ApiError(
    'SERVER',
    'Server error. Please try again.',
    response.status,
  );
}

export function getClientIdentity(
  signal?: AbortSignal,
  tokenOverride?: string,
): Promise<ClientIdentity> {
  return request('/auth/me', undefined, signal, 'GET', tokenOverride);
}

export function getLinkStatus(signal?: AbortSignal): Promise<LinkStatus> {
  return request('/wallets/link/status', undefined, signal, 'GET');
}

export async function registerWallet(
  userId: string,
  safeAddress: Address,
  ownerAddress: Address,
  signal?: AbortSignal,
): Promise<void> {
  await request(
    '/wallets/register',
    {
      user_id: userId,
      safe_address: safeAddress,
      owner_address: ownerAddress,
    },
    signal,
  );
}

export async function requestLinkChallenge(
  ownerAddress: Address,
  safeAddress: Address,
  signal?: AbortSignal,
): Promise<LinkChallenge> {
  const data = await request<{
    challenge_id: string;
    message: string;
    user_id: string;
    owner_address: Address;
    safe_address: Address;
    chain_id: number;
    domain: string;
    expires_at: string;
  }>(
    '/wallets/link/challenge',
    {
      owner_address: ownerAddress,
      safe_address: safeAddress,
      chain_id: 11155111,
    },
    signal,
  );
  return {
    challengeId: data.challenge_id,
    message: data.message,
    userId: data.user_id,
    ownerAddress: data.owner_address,
    safeAddress: data.safe_address,
    chainId: data.chain_id,
    domain: data.domain,
    expiresAt: data.expires_at,
  };
}

export async function completeLink(
  challengeId: string,
  signature: Signature,
  signal?: AbortSignal,
): Promise<LinkResult> {
  const data = await request<{
    owner_key_verified: boolean;
    ownership_verified: boolean;
    data: {
      user_id: string;
      owner_address: Address;
      safe_address: Address;
      chain_id: number;
    };
  }>(
    '/wallets/link/complete',
    { challenge_id: challengeId, signature },
    signal,
  );
  return {
    userId: data.data.user_id,
    ownerAddress: data.data.owner_address,
    safeAddress: data.data.safe_address,
    chainId: data.data.chain_id,
    ownerKeyVerified: data.owner_key_verified === true,
    ownershipVerified: data.ownership_verified === true,
  };
}

export function authorizeBankTransfer(
  safeAddress: Address,
  direction: 'bank_to_wallet' | 'wallet_to_bank',
  amount: string,
): Promise<{
  status: string;
  mocked: true;
  funds_moved: false;
  checked_block: number;
}> {
  return request('/bank/transfers/authorize', {
    safe_address: safeAddress,
    chain_id: 11155111,
    direction,
    amount,
  });
}
