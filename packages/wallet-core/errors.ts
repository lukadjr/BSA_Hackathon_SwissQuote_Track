export type WalletErrorCode =
  | 'WALLET_ALREADY_EXISTS'
  | 'WALLET_NOT_FOUND'
  | 'AUTH_CANCELLED'
  | 'AUTH_UNAVAILABLE'
  | 'KEY_UNAVAILABLE'
  | 'STORAGE_FAILED'
  | 'KEY_GENERATION_FAILED'
  | 'INVALID_MESSAGE'
  | 'SIGNING_FAILED'
  | 'CHAIN_CONFIG_INVALID'
  | 'NETWORK_FAILED'
  | 'SAFE_CONFIG_INVALID'
  | 'INVALID_TRANSFER'
  | 'INSUFFICIENT_FUNDS'
  | 'TRANSFER_EXPIRED'
  | 'TRANSFER_PENDING'
  | 'TRANSFER_FAILED'
  | 'VERIFICATION_FAILED'
  | 'NOT_IMPLEMENTED';

/** Use safe messages only: never attach keys or raw native errors. */
export class WalletError extends Error {
  constructor(
    public readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}
