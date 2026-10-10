/** Hex types describe the API shape; validate values at runtime when implementing. */
export type Address = `0x${string}`;
export type Signature = `0x${string}`;

export interface SignedMessage {
  address: Address;
  signature: Signature;
}

export interface VerifyMessageInput extends SignedMessage {
  message: string;
}

/** Public UI contract. The address belongs to the owner EOA, not the Safe. */
export interface OwnerWallet {
  /** Read public metadata on startup; never create or replace a key. */
  getAddress(): Promise<Address | null>;
  /** Explicit onboarding action; never overwrite an existing wallet. */
  createWallet(): Promise<{ address: Address }>;
  /** Call after user confirmation. Each attempt must unlock the key afresh. */
  signMessage(
    message: string,
    options?: { signal?: AbortSignal },
  ): Promise<SignedMessage>;
  /** Public verification, with no secret access or authentication. */
  verifyMessage(input: VerifyMessageInput): Promise<boolean>;
}
