import {
  ApiError,
  completeLink,
  getClientIdentity,
  registerWallet,
  requestLinkChallenge,
} from './api';
import type { ClientIdentity, LinkChallenge, LinkResult } from './api';
import { describeWalletError, getAddress, signMessage } from './wallet';
import { getSafeAccount } from './safeWallet';
import { isAddress, isAddressEqual } from 'viem';

export type { LinkChallenge, LinkResult };

function sameAddress(a: string, b: string) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    isAddress(a, { strict: false }) &&
    isAddress(b, { strict: false }) &&
    isAddressEqual(a, b)
  );
}

export function requireVerifiedIdentity(identity: ClientIdentity) {
  if (identity.kyc_status !== 'verified') {
    throw new ApiError(
      'REJECTED',
      identity.kyc_status === 'rejected'
        ? 'Your demo identity was rejected. Contact the demo bank operator.'
        : 'Your demo identity review is pending. Bank linking is not yet available.',
    );
  }
}

/** Reconstruct the exact purpose-bound text, rather than checking address substrings. */
export function validateLinkChallenge(
  c: LinkChallenge,
  clientId: string,
  safe: string,
  owner: string,
) {
  const expires = Date.parse(c.expiresAt);
  const domain =
    process.env.EXPO_PUBLIC_WALLET_LINK_DOMAIN ?? 'swissquote-wallet.demo';
  if (
    c.userId !== clientId ||
    !sameAddress(c.safeAddress, safe) ||
    !sameAddress(c.ownerAddress, owner) ||
    c.chainId !== 11155111 ||
    c.domain !== domain ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(c.challengeId) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(c.expiresAt) ||
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 310_000
  ) {
    throw new ApiError(
      'REJECTED',
      'This confirmation expired or does not match your account and Safe.',
    );
  }
  const expected = [
    'Swissquote Wallet: link this Safe to your demo bank account.',
    `Domain: ${domain}`,
    'Purpose: link-safe',
    `Account: ${clientId}`,
    `Safe: ${safe.toLowerCase()}`,
    `Owner key: ${owner.toLowerCase()}`,
    'Chain ID: 11155111',
    `Nonce: ${c.challengeId}`,
    `Expires: ${c.expiresAt}`,
    'This moves no funds. Bank identity checks are simulated.',
  ].join('\n');
  if (c.message !== expected)
    throw new ApiError(
      'SERVER',
      'The server sent an unexpected confirmation message.',
    );
}

export async function startWalletLink(
  signal?: AbortSignal,
): Promise<LinkChallenge> {
  const identity = await getClientIdentity(signal);
  requireVerifiedIdentity(identity);
  const account = await getSafeAccount();
  if (!account.deployed)
    throw new ApiError(
      'REJECTED',
      'Your Safe is not deployed yet. Use Add money to deploy it, then return to link it.',
    );
  await registerWallet(
    identity.client_id,
    account.safeAddress,
    account.ownerAddress,
    signal,
  );
  const challenge = await requestLinkChallenge(
    account.ownerAddress,
    account.safeAddress,
    signal,
  );
  validateLinkChallenge(
    challenge,
    identity.client_id,
    account.safeAddress,
    account.ownerAddress,
  );
  return challenge;
}

/** Call only after the user has confirmed the displayed text. Never cache a key. */
export async function confirmWalletLink(
  c: LinkChallenge,
  options?: { signal?: AbortSignal },
): Promise<LinkResult> {
  const identity = await getClientIdentity(options?.signal);
  requireVerifiedIdentity(identity);
  const owner = await getAddress();
  const account = await getSafeAccount();
  if (!owner || !sameAddress(owner, account.ownerAddress) || !account.deployed)
    throw new ApiError(
      'REJECTED',
      'The wallet changed. Request a new confirmation.',
    );
  validateLinkChallenge(c, identity.client_id, account.safeAddress, owner);
  const { address, signature } = await signMessage(c.message, options);
  if (
    !sameAddress(address, c.ownerAddress) ||
    Date.parse(c.expiresAt) <= Date.now()
  )
    throw new ApiError(
      'REJECTED',
      'The wallet changed or the confirmation expired. Please try again.',
    );
  const result = await completeLink(c.challengeId, signature, options?.signal);
  if (
    !result.ownerKeyVerified ||
    !result.ownershipVerified ||
    result.userId !== c.userId ||
    result.chainId !== c.chainId ||
    !sameAddress(result.ownerAddress, c.ownerAddress) ||
    !sameAddress(result.safeAddress, c.safeAddress)
  )
    throw new ApiError(
      'SERVER',
      'The server did not confirm control of your Safe.',
    );
  return result;
}

export function describeLinkError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409 || e.status === 410)
      return 'This confirmation expired or wallet control changed. Refresh and try again.';
    if (e.status === 401)
      return 'The server refused the signature or demo credentials.';
    if (e.status === 403)
      return 'Verified identity and current wallet control are required for this bank action.';
    if (e.status === 503)
      return 'Bank verification is unavailable. Check the backend and Sepolia connection, then retry.';
    return e.message;
  }
  return describeWalletError(e);
}
