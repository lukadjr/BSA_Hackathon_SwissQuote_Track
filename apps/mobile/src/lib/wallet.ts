// Real owner wallet: wallet-core (keys, address, signing) + SecureStore adapter.
// Polyfill first: wallet-core needs secure randomness at import time.
import './polyfills';
import { createOwnerWallet, WalletError } from '@swissquote/wallet-core';
import type { Address, Signature } from '@swissquote/wallet-core';
import { secureStoreAdapter } from './secureStoreAdapter';

export type { Address, Signature };

const wallet = createOwnerWallet({ storage: secureStoreAdapter });

export const getAddress = wallet.getAddress;
export const createWallet = wallet.createWallet;
export const signMessage = wallet.signMessage;
export const verifyMessage = wallet.verifyMessage;

/** User-facing text for an error thrown by the wallet functions. */
export function describeWalletError(e: unknown): string {
  if (e instanceof WalletError) {
    switch (e.code) {
      case 'AUTH_CANCELLED':
        return 'Signing cancelled. No signature returned.';
      case 'AUTH_UNAVAILABLE':
        return (
          e.message ||
          'Set up Face ID or a device passcode on this phone first.'
        );
      case 'KEY_UNAVAILABLE':
        return 'The key cannot be read (biometrics changed?). Use recovery.';
      case 'WALLET_NOT_FOUND':
        return 'No wallet on this phone yet.';
      case 'WALLET_ALREADY_EXISTS':
        return e.message || 'A wallet already exists on this phone.';
      case 'NOT_IMPLEMENTED':
        return 'This feature is not available yet.';
      case 'STORAGE_FAILED':
        return e.message;
      case 'KEY_GENERATION_FAILED':
        return 'Secure key generation failed. Restart the app and try again.';
      case 'INVALID_MESSAGE':
        return 'The message cannot be signed.';
      case 'SIGNING_FAILED':
        return 'Signing failed. Nothing was returned.';
      case 'CHAIN_CONFIG_INVALID':
      case 'NETWORK_FAILED':
      case 'SAFE_CONFIG_INVALID':
      case 'INVALID_TRANSFER':
      case 'INSUFFICIENT_FUNDS':
      case 'TRANSFER_EXPIRED':
      case 'TRANSFER_PENDING':
      case 'TRANSFER_FAILED':
      case 'VERIFICATION_FAILED':
        return e.message;
      default:
        return 'Storage error. Please try again.';
    }
  }
  return 'Unexpected error.';
}
