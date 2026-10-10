import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { WalletError } from '../errors';
import type { Address } from '../types';
import type { PrivateKey } from './storage';

export function generateOwnerKey(): {
  address: Address;
  privateKey: PrivateKey;
} {
  try {
    const privateKey = generatePrivateKey();
    return { address: privateKeyToAddress(privateKey), privateKey };
  } catch {
    // Fail closed if secure randomness is unavailable. Do not expose raw
    // library errors, which could contain secret material.
    throw new WalletError(
      'KEY_GENERATION_FAILED',
      'Secure owner key generation failed.',
    );
  }
}
