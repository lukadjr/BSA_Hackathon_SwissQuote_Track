export { SEPOLIA } from './config/chains';
export { WalletError } from './errors';
export type { WalletErrorCode } from './errors';
export { createOwnerWallet } from './keys/keyManager';
export type { OwnerWalletOptions } from './keys/keyManager';
export type { OwnerKeyStorage } from './keys/storage';
export type {
  Address,
  OwnerWallet,
  Signature,
  SignedMessage,
  VerifyMessageInput,
} from './types';
