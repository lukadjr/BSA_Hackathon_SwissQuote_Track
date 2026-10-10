// Links this phone's owner key to the user's backend account:
// 1. ask the backend for a challenge, 2. the user reads and confirms it,
// 3. sign it locally (Face ID), 4. the backend checks the signature.
import { ApiError, completeLink, requestLinkChallenge } from './api';
import type { LinkChallenge, LinkResult } from './api';
import { markWalletLinked } from './linkStatus';
import { describeWalletError, getAddress, signMessage } from './wallet';
import { WalletError } from '@swissquote/wallet-core';

export type { LinkChallenge, LinkResult };

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/** Step 1: fetch a challenge for the local owner key. Nothing is signed yet. */
export async function startWalletLink(
  signal?: AbortSignal,
): Promise<LinkChallenge> {
  const address = await getAddress();
  if (address === null) {
    throw new WalletError('WALLET_NOT_FOUND', 'No owner wallet exists.');
  }
  const challenge = await requestLinkChallenge(address, signal);
  // Only show (and later sign) a challenge about this phone's own key.
  if (
    !sameAddress(challenge.ownerAddress, address) ||
    !challenge.message.toLowerCase().includes(address.toLowerCase())
  ) {
    throw new ApiError(
      'SERVER',
      'The server sent a challenge for a different key.',
    );
  }
  return challenge;
}

/**
 * Step 2: call only after the user confirmed `challenge.message` on screen.
 * Signs exactly that text with the local key, then completes the link.
 */
export async function confirmWalletLink(
  challenge: LinkChallenge,
  options?: { signal?: AbortSignal },
): Promise<LinkResult> {
  const { address, signature } = await signMessage(challenge.message, options);
  if (!sameAddress(address, challenge.ownerAddress)) {
    throw new WalletError(
      'KEY_UNAVAILABLE',
      'The owner key changed during linking.',
    );
  }
  const result = await completeLink(
    challenge.challengeId,
    signature,
    options?.signal,
  );
  if (!result.ownerKeyVerified || !sameAddress(result.ownerAddress, address)) {
    throw new ApiError('SERVER', 'The server did not confirm this key.');
  }
  // Linking is a one-time onboarding step; never offer it again.
  await markWalletLinked();
  return result;
}

/** User-facing text for an error thrown during linking. */
export function describeLinkError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.status) {
      case 409:
      case 410:
        return 'This confirmation expired. Request a new one.';
      case 401:
        return 'The server refused the signature or the demo credentials.';
    }
    return e.message;
  }
  return describeWalletError(e);
}
