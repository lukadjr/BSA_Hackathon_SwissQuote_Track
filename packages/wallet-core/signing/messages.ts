import { isAddress, isAddressEqual, stringToBytes, verifyMessage } from 'viem';
import { privateKeyToAddress, signMessage } from 'viem/accounts';
import { WalletError } from '../errors';
import type { OwnerKeyStorage } from '../keys/storage';
import type { Address, SignedMessage, VerifyMessageInput } from '../types';

// A bounded, nonempty UTF-8 message for the milestone's human-readable preview.
const MAX_MESSAGE_BYTES = 4096;

/** Milestone test-message signing. This is not Safe transaction signing. */
export async function signOwnerMessage(
  storage: OwnerKeyStorage,
  message: string,
  signal?: AbortSignal,
): Promise<SignedMessage> {
  assertNotCancelled(signal);
  validateMessage(message);
  const address = await readOwnerAddress(storage);
  assertNotCancelled(signal);

  // The UI must confirm this exact message before calling us. The adapter
  // enforces authentication on this read; a prior UI authentication is insufficient.
  let privateKey;
  try {
    privateKey = await storage.readPrivateKeyForSigning();
  } catch (error) {
    throw storageFailure(error);
  }
  assertNotCancelled(signal);

  try {
    if (
      typeof privateKey !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(privateKey)
    ) {
      throw new Error('Invalid key format.');
    }
    if (!isAddressEqual(privateKeyToAddress(privateKey), address)) {
      throw new Error('Owner mismatch.');
    }
  } catch {
    throw new WalletError(
      'KEY_UNAVAILABLE',
      'The owner key is unavailable or does not match.',
    );
  }

  // Authentication can take time. Refuse a changed owner instead of signing
  // for stale metadata. App background/payload cancellation belongs to the UI/adapter.
  if (!isAddressEqual(await readOwnerAddress(storage), address)) {
    throw new WalletError(
      'KEY_UNAVAILABLE',
      'The owner changed during authentication.',
    );
  }
  assertNotCancelled(signal);

  let signature;
  try {
    signature = await signMessage({ privateKey, message });
  } catch {
    throw new WalletError('SIGNING_FAILED', 'Owner message signing failed.');
  }
  assertNotCancelled(signal);
  return { address, signature };
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WalletError(
      'AUTH_CANCELLED',
      'The signing attempt was cancelled.',
    );
  }
}

export async function verifyOwnerMessage(
  input: VerifyMessageInput,
): Promise<boolean> {
  // EOA-only public verification. Malformed inputs/signatures fail verification.
  try {
    validateMessage(input.message);
    if (!isAddress(input.address, { strict: false })) return false;
    if (
      typeof input.signature !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(input.signature)
    )
      return false;
    return await verifyMessage(input);
  } catch {
    return false;
  }
}

function validateMessage(message: string): void {
  if (
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    stringToBytes(message).length > MAX_MESSAGE_BYTES
  ) {
    throw new WalletError(
      'INVALID_MESSAGE',
      'Use a nonempty message of at most 4096 UTF-8 bytes.',
    );
  }
}

async function readOwnerAddress(storage: OwnerKeyStorage): Promise<Address> {
  let address;
  try {
    address = await storage.readAddress();
  } catch (error) {
    throw storageFailure(error);
  }
  if (address === null) {
    throw new WalletError('WALLET_NOT_FOUND', 'No owner wallet exists.');
  }
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    throw new WalletError(
      'KEY_UNAVAILABLE',
      'The stored owner address is invalid.',
    );
  }
  return address;
}

function storageFailure(error: unknown): WalletError {
  if (error instanceof WalletError) return error;
  return new WalletError('STORAGE_FAILED', 'Owner wallet storage failed.');
}
