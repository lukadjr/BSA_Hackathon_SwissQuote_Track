import { english } from 'viem/accounts';
import {
  getAddress,
  hexToBytes,
  isAddress,
  isAddressEqual,
  keccak256,
  zeroAddress,
  type Address,
  verifyMessage,
  type Hex,
} from 'viem';
import { WalletError } from '../errors';
import { SAFE_DEPLOYMENT } from '../safe/account';
import { isRecoveryModule } from './module';

/**
 * Four words derived from an address, read aloud by both phones before a
 * guardian is added or a recovery approved. A server that swaps the address
 * cannot also make the words match on the other phone.
 */
export function addressWords(address: Address): string {
  const bytes = hexToBytes(keccak256(getAddress(address)));
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits = (bits << 8n) | BigInt(bytes[i]);
  const words: string[] = [];
  for (let i = 0; i < 4; i++)
    words.push(english[Number((bits >> BigInt(37 - i * 11)) & 2047n)]);
  return words.join(' ');
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Owner phone → friend phone: "become my guardian". */
export interface GuardianInvitePayload {
  t: 'sqw-guardian-invite';
  v: 1;
  chainId: number;
  safe: Address;
  invite: string;
  from: string;
}
/** Recovering phone → guardian phone: "approve this new owner". */
export interface RecoveryRequestPayload {
  t: 'sqw-recovery-request';
  v: 1;
  chainId: number;
  safe: Address;
  module: Address;
  newOwner: Address;
  nonce: string;
  case?: string;
}
/** Guardian phone → recovering phone, when the backend is unreachable. */
export interface RecoveryApprovalPayload {
  t: 'sqw-recovery-approval';
  v: 1;
  chainId: number;
  safe: Address;
  module: Address;
  newOwner: Address;
  nonce: string;
  guardian: Address;
  signature: Hex;
}
/** Friend phone → owner phone, when the backend is unreachable. */
export interface GuardianAcceptPayload {
  t: 'sqw-guardian-accept';
  v: 1;
  chainId: number;
  safe: Address;
  invite: string;
  guardian: Address;
  signature: Hex;
}
export type QrPayload =
  | GuardianInvitePayload
  | GuardianAcceptPayload
  | RecoveryRequestPayload
  | RecoveryApprovalPayload;

function address(value: unknown): Address {
  if (
    typeof value !== 'string' ||
    !isAddress(value, { strict: false }) ||
    isAddressEqual(value as Address, zeroAddress)
  )
    throw new Error();
  return getAddress(value);
}

/** Strict parser: anything unexpected is rejected, never partially used. */
export function parseQrPayload(text: string): QrPayload {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.v !== 1 || raw.chainId !== SAFE_DEPLOYMENT.chainId)
      throw new Error();
    if (raw.t === 'sqw-guardian-invite') {
      if (
        typeof raw.invite !== 'string' ||
        !/^[\w-]{16,128}$/.test(raw.invite) ||
        typeof raw.from !== 'string' ||
        raw.from.length > 64
      )
        throw new Error();
      return {
        t: raw.t,
        v: 1,
        chainId: raw.chainId,
        safe: address(raw.safe),
        invite: raw.invite,
        from: raw.from,
      };
    }
    if (raw.t === 'sqw-guardian-accept') {
      if (
        typeof raw.invite !== 'string' ||
        !/^[\w-]{16,128}$/.test(raw.invite) ||
        typeof raw.signature !== 'string' ||
        !/^0x[\da-fA-F]{130}$/.test(raw.signature)
      )
        throw new Error();
      return {
        t: raw.t,
        v: 1,
        chainId: raw.chainId,
        safe: address(raw.safe),
        invite: raw.invite,
        guardian: address(raw.guardian),
        signature: raw.signature as Hex,
      };
    }
    const common = {
      v: 1 as const,
      chainId: raw.chainId as number,
      safe: address(raw.safe),
      module: address(raw.module),
      newOwner: address(raw.newOwner),
      nonce: String(raw.nonce),
    };
    if (!isRecoveryModule(common.module) || !/^\d{1,30}$/.test(common.nonce))
      throw new Error();
    if (raw.t === 'sqw-recovery-request') {
      if (
        raw.case !== undefined &&
        (typeof raw.case !== 'string' || !/^[\w-]{16,128}$/.test(raw.case))
      )
        throw new Error();
      return {
        t: raw.t,
        ...common,
        ...(raw.case ? { case: raw.case as string } : {}),
      };
    }
    if (raw.t === 'sqw-recovery-approval') {
      if (
        typeof raw.signature !== 'string' ||
        !/^0x[\da-fA-F]{130}$/.test(raw.signature)
      )
        throw new Error();
      return {
        t: raw.t,
        ...common,
        guardian: address(raw.guardian),
        signature: raw.signature as Hex,
      };
    }
    throw new Error();
  } catch {
    throw new WalletError(
      'INVALID_MESSAGE',
      'This QR code is not a Swissquote Wallet code for Sepolia.',
    );
  }
}

/** Message the friend's guardian key signs to accept an invite. */
export function guardianInviteMessage(input: {
  safe: Address;
  invite: string;
  guardian: Address;
}): string {
  return [
    'Swissquote Wallet: I agree to be a recovery guardian.',
    `Safe: ${getAddress(input.safe)}`,
    `Guardian key: ${getAddress(input.guardian)}`,
    `Invite: ${input.invite}`,
    `Chain: ${SAFE_DEPLOYMENT.chainId}`,
    'This moves no funds.',
  ].join('\n');
}

/** Checks the friend's acceptance locally (same check as the backend). */
export async function verifyGuardianAcceptance(
  payload: GuardianAcceptPayload,
): Promise<boolean> {
  try {
    return await verifyMessage({
      address: payload.guardian,
      message: guardianInviteMessage(payload),
      signature: payload.signature,
    });
  } catch {
    return false;
  }
}
