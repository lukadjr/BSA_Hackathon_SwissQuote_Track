import { WalletError } from '../errors';
import { signOwnerMessage, verifyOwnerMessage } from '../signing/messages';
import type { OwnerWallet } from '../types';
import type { OwnerKeyStorage } from './storage';

export interface OwnerWalletOptions {
  storage: OwnerKeyStorage;
}

/** Creates an API instance, not a private key. Safe to call during app setup. */
export function createOwnerWallet({
  storage,
}: OwnerWalletOptions): OwnerWallet {
  return {
    getAddress() {
      return storage.readAddress();
    },

    async createWallet() {
      // TODO: serialize creation attempts and reject existing wallet material.
      // TODO: generate a valid secp256k1 key using OS-backed secure entropy.
      // TODO: derive its address using an established library, then persist via
      // storage.saveNewWallet(). Return only the address after persistence succeeds.
      throw new WalletError(
        'NOT_IMPLEMENTED',
        'Owner key creation is not implemented.',
      );
    },

    signMessage(message) {
      return signOwnerMessage(storage, message);
    },

    verifyMessage(input) {
      return verifyOwnerMessage(input);
    },
  };
}
