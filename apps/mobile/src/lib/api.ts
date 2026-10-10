// Backend client for the demo API (backend/). Only public data travels here:
// addresses, challenge ids and signatures. Never send a private key.
import type { Address, Signature } from './wallet';

const REQUEST_TIMEOUT_MS = 10_000;

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

export interface LinkChallenge {
  challengeId: string;
  message: string;
  ownerAddress: Address;
  expiresAt: string;
}

export interface LinkResult {
  userId: string;
  ownerAddress: Address;
  ownerKeyVerified: boolean;
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

async function request<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const { baseUrl, token } = config();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
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
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(
      'UNAUTHORIZED',
      'The server refused this request.',
      response.status,
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

export async function requestLinkChallenge(
  ownerAddress: Address,
  signal?: AbortSignal,
): Promise<LinkChallenge> {
  const data = await request<{
    challenge_id: string;
    message: string;
    owner_address: Address;
    expires_at: string;
  }>('/wallets/link/challenge', { owner_address: ownerAddress }, signal);
  return {
    challengeId: data.challenge_id,
    message: data.message,
    ownerAddress: data.owner_address,
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
    data: { user_id: string; owner_address: Address };
  }>(
    '/wallets/link/complete',
    { challenge_id: challengeId, signature },
    signal,
  );
  return {
    userId: data.data.user_id,
    ownerAddress: data.data.owner_address,
    ownerKeyVerified: data.owner_key_verified === true,
  };
}
