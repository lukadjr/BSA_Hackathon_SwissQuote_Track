import type { Address } from '../types';

/** Internal secret type. Never return this through OwnerWallet or put it in UI state. */
export type PrivateKey = `0x${string}`;

/**
 * Trusted native boundary, implemented in apps/mobile with SecureStore.
 * Map native failures to WalletError codes without exposing secret values.
 */
export interface OwnerKeyStorage {
  /** Public metadata only. null means no registered owner address. */
  readAddress(): Promise<Address | null>;

  /**
   * Protect the secret with native authentication and persist public metadata.
   * Never overwrite existing key material, including when metadata is missing.
   * Resolve only after both writes succeed; handle interrupted/partial writes.
   */
  saveNewWallet(input: {
    address: Address;
    privateKey: PrivateKey;
  }): Promise<void>;

  /**
   * Fresh protected read for this signing attempt, after UI confirmation.
   * Reject on cancellation, missing/invalidated key, or unavailable protection.
   * Never substitute a cached key or generate a replacement.
   */
  readPrivateKeyForSigning(): Promise<PrivateKey>;
}
