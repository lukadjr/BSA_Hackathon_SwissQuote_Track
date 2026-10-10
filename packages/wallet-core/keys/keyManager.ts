import { WalletError } from '../errors';
import { signOwnerMessage, verifyOwnerMessage } from '../signing/messages';
import type { OwnerWallet } from '../types';
import type { OwnerKeyStorage } from './storage';
import { generateOwnerKey } from './generateOwnerKey';

export interface OwnerWalletOptions {
  storage: OwnerKeyStorage;
}

// Serialize even across factory instances sharing the same storage adapter.
// The adapter must enforce no-overwrite across separate adapters/processes.
const creationLocks = new WeakMap<OwnerKeyStorage, Promise<void>>();

/** Creates an API instance, not a private key. Safe to call during app setup. */
export function createOwnerWallet({
  storage,
}: OwnerWalletOptions): OwnerWallet {
  return {
    async getAddress() {
      try {
        return await storage.readAddress();
      } catch (error) {
        throw storageFailure(error);
      }
    },

    async createWallet() {
      const previous = creationLocks.get(storage) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      creationLocks.set(storage, current);
      await previous;

      try {
        let existingAddress;
        try {
          existingAddress = await storage.readAddress();
        } catch (error) {
          throw storageFailure(error);
        }
        if (existingAddress !== null) {
          throw new WalletError(
            'WALLET_ALREADY_EXISTS',
            'An owner wallet already exists.',
          );
        }

        const { address, privateKey } = generateOwnerKey();
        try {
          await storage.saveNewWallet({ address, privateKey });
        } catch (error) {
          throw storageFailure(error);
        }
        // Do not retain the private key or create a cached signer.
        return { address };
      } finally {
        release();
        if (creationLocks.get(storage) === current)
          creationLocks.delete(storage);
      }
    },

    signMessage(message) {
      return signOwnerMessage(storage, message);
    },

    verifyMessage(input) {
      return verifyOwnerMessage(input);
    },
  };
}

function storageFailure(error: unknown): WalletError {
  // The trusted adapter must supply only safe WalletError messages.
  if (error instanceof WalletError) return error;
  return new WalletError('STORAGE_FAILED', 'Owner wallet storage failed.');
}
