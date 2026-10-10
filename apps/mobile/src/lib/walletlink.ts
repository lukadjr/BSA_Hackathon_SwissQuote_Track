// Links this phone's wallet to the user's backend account. Onboarding order:
// 1. the owner key exists, 2. the Safe address is derived from it (it is
// counterfactual: nothing is deployed and no network is needed),
// 3. the backend sends a challenge naming both addresses, the user reads and
// confirms it, the owner key signs it (Face ID), and the backend checks it.
import { ApiError, completeLink, requestLinkChallenge } from './api';
import type { LinkChallenge, LinkResult } from './api';
import { isLinked, markWalletLinked } from './linkStatus';
import { describeWalletError, getAddress, signMessage } from './wallet';
import { WalletError } from '@swissquote/wallet-core';
import { currentSafeAddress } from './safeWallet';

export type { LinkChallenge, LinkResult };

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/** True once this phone's owner key and Safe were linked with Swissquote. */
export async function isWalletLinkComplete(): Promise<boolean> {
  const owner = await getAddress();
  if (owner === null) return false;
  return isLinked(owner, await currentSafeAddress(owner));
}

/** Fetch a challenge naming the owner key and its Safe. Nothing is signed yet. */
export async function startWalletLink(
  signal?: AbortSignal,
): Promise<LinkChallenge> {
  const address = await getAddress();
  if (address === null) {
    throw new WalletError('WALLET_NOT_FOUND', 'No owner wallet exists.');
  }
  const safe = await currentSafeAddress(address);
  const challenge = await requestLinkChallenge(address, safe, signal);
  // Only show (and later sign) a challenge about this phone's own key and Safe.
  const text = challenge.message.toLowerCase();
  if (
    !sameAddress(challenge.ownerAddress, address) ||
    !sameAddress(challenge.safeAddress, safe) ||
    !text.includes(address.toLowerCase()) ||
    !text.includes(safe.toLowerCase())
  ) {
    throw new ApiError(
      'SERVER',
      'The server sent a challenge for a different wallet.',
    );
  }
  return challenge;
}

/**
 * Call only after the user confirmed `challenge.message` on screen.
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
  if (
    !result.ownerKeyVerified ||
    !sameAddress(result.ownerAddress, address) ||
    !sameAddress(result.safeAddress, challenge.safeAddress)
  ) {
    throw new ApiError('SERVER', 'The server did not confirm this wallet.');
  }
  // Linking is a one-time onboarding step; never offer it again.
  await markWalletLinked(address, challenge.safeAddress);
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
