import {
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { WalletError } from '../errors';
import type { SepoliaClient } from '../safe/account';

/**
 * Candide SocialRecoveryModule deployments (abstractionkit 0.4.0) on Sepolia.
 * The grace period is fixed by the deployment, not by a parameter: the 3-day
 * module is the product setting and the 1-minute one is the demo setting
 * (deployed by scripts/deploy-recovery-module.ts from the verified 3-minute
 * module's creation code). The 3-minute module stays recognised for Safes
 * that were protected with it.
 */
export const RECOVERY_MODULES = Object.freeze({
  threeDays: '0x38275826E1933303E508433dD5f289315Da2541c' as Address,
  demoThreeMinutes: '0x949d01d424bE050D09C16025dd007CB59b3A8c66' as Address,
  demoOneMinute: '0x09FAb55bFc4B5bC016AA634a2194FE3186219Fd1' as Address,
});
export type RecoveryPeriod = keyof typeof RECOVERY_MODULES;
export const RECOVERY_PERIOD_SECONDS: Record<RecoveryPeriod, number> = {
  threeDays: 3 * 24 * 60 * 60,
  demoThreeMinutes: 3 * 60,
  demoOneMinute: 60,
};
/** Any two of: the user's backup key, Swissquote, the trusted friend. */
export const GUARDIAN_THRESHOLD = 2;
export const GUARDIAN_COUNT = 3;

export function isRecoveryModule(address: Address): boolean {
  return Object.values(RECOVERY_MODULES).some((module) =>
    isAddressEqual(module, address),
  );
}
export function recoveryModuleFor(period: RecoveryPeriod): Address {
  return RECOVERY_MODULES[period];
}

export const recoveryModuleAbi = parseAbi([
  'function getRecoveryRequest(address wallet) view returns ((uint64 guardiansApprovalCount, uint64 newThreshold, uint64 executeAfter, address[] newOwners))',
  'function nonce(address wallet) view returns (uint256)',
  'function getGuardians(address wallet) view returns (address[])',
  'function threshold(address wallet) view returns (uint256)',
  'function isGuardian(address wallet, address guardian) view returns (bool)',
  'function getRecoveryHash(address wallet, address[] newOwners, uint256 newThreshold, uint256 nonce) view returns (bytes32)',
  'function multiConfirmRecovery(address wallet, address[] newOwners, uint256 newThreshold, (address signer, bytes signature)[] signatures, bool execute)',
  'function finalizeRecovery(address wallet)',
  'function cancelRecovery()',
  'function invalidateNonce()',
  'function addGuardianWithThreshold(address guardian, uint256 threshold)',
  'function revokeGuardianWithThreshold(address prevGuardian, address guardian, uint256 threshold)',
]);
const safeModuleAbi = parseAbi(['function enableModule(address module)']);
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

export interface Guardians {
  /** Key derived from the user's offline recovery phrase. */
  backup: Address;
  /** Swissquote's isolated guardian signer. */
  swissquote: Address;
  /** Guardian key held in the trusted friend's own app. */
  friend: Address;
}

export function validateGuardians(owner: Address, guardians: Guardians) {
  const list = [guardians.backup, guardians.swissquote, guardians.friend];
  if (
    list.some(
      (g) =>
        !isAddress(g, { strict: false }) ||
        isAddressEqual(g, zeroAddress) ||
        isAddressEqual(g, owner),
    ) ||
    new Set(list.map((g) => g.toLowerCase())).size !== GUARDIAN_COUNT
  )
    throw new WalletError(
      'SAFE_CONFIG_INVALID',
      'Choose three different guardians, none of them your own phone key.',
    );
  return list.map((g) => getAddress(g));
}

/** One Safe batch: enable the module, add the 3 guardians, threshold 2. */
export function protectCalls(
  safe: Address,
  owner: Address,
  module: Address,
  guardians: Guardians,
): Call[] {
  if (!isRecoveryModule(module))
    throw new WalletError('SAFE_CONFIG_INVALID', 'Unknown recovery module.');
  const list = validateGuardians(owner, guardians);
  return [
    {
      to: getAddress(safe),
      value: 0n,
      data: encodeFunctionData({
        abi: safeModuleAbi,
        functionName: 'enableModule',
        args: [module],
      }),
    },
    ...list.map((guardian, i) => ({
      to: module,
      value: 0n,
      data: encodeFunctionData({
        abi: recoveryModuleAbi,
        functionName: 'addGuardianWithThreshold',
        // The module requires threshold <= guardian count after each addition.
        args: [
          guardian,
          i === list.length - 1 ? BigInt(GUARDIAN_THRESHOLD) : 1n,
        ],
      }),
    })),
  ];
}

/** Swap one guardian for another, keeping 3 guardians and threshold 2. */
export function replaceGuardianCalls(
  module: Address,
  currentGuardians: readonly Address[],
  oldGuardian: Address,
  newGuardian: Address,
  owner: Address,
): Call[] {
  const index = currentGuardians.findIndex((g) =>
    isAddressEqual(g, oldGuardian),
  );
  if (index < 0)
    throw new WalletError(
      'SAFE_CONFIG_INVALID',
      'This address is not a current guardian.',
    );
  if (
    !isAddress(newGuardian, { strict: false }) ||
    isAddressEqual(newGuardian, zeroAddress) ||
    isAddressEqual(newGuardian, owner) ||
    currentGuardians.some((g) => isAddressEqual(g, newGuardian))
  )
    throw new WalletError(
      'SAFE_CONFIG_INVALID',
      'The new guardian must be a different, unused address.',
    );
  const prev = index === 0 ? SENTINEL : currentGuardians[index - 1];
  return [
    {
      to: module,
      value: 0n,
      data: encodeFunctionData({
        abi: recoveryModuleAbi,
        functionName: 'revokeGuardianWithThreshold',
        args: [prev, getAddress(oldGuardian), BigInt(GUARDIAN_THRESHOLD)],
      }),
    },
    {
      to: module,
      value: 0n,
      data: encodeFunctionData({
        abi: recoveryModuleAbi,
        functionName: 'addGuardianWithThreshold',
        args: [getAddress(newGuardian), BigInt(GUARDIAN_THRESHOLD)],
      }),
    },
  ];
}

/** Must be executed BY the Safe (owner signature): cancels the pending request. */
export function cancelRecoveryCall(module: Address): Call {
  return {
    to: module,
    value: 0n,
    data: encodeFunctionData({
      abi: recoveryModuleAbi,
      functionName: 'cancelRecovery',
    }),
  };
}

/**
 * Executed BY the Safe: bumps the module nonce, voiding every approval signed
 * for a request that has not started yet.
 */
export function invalidateApprovalsCall(module: Address): Call {
  return {
    to: module,
    value: 0n,
    data: encodeFunctionData({
      abi: recoveryModuleAbi,
      functionName: 'invalidateNonce',
    }),
  };
}

/** Public: anyone may send it once the grace period is over. */
export function finalizeRecoveryCall(module: Address, safe: Address): Call {
  return {
    to: module,
    value: 0n,
    data: encodeFunctionData({
      abi: recoveryModuleAbi,
      functionName: 'finalizeRecovery',
      args: [getAddress(safe)],
    }),
  };
}

export interface GuardianApproval {
  guardian: Address;
  signature: Hex;
}

/** Public: anyone may send it. Starts the grace period when 2 approvals are valid. */
export function executeRecoveryCall(
  module: Address,
  safe: Address,
  newOwner: Address,
  approvals: readonly GuardianApproval[],
): Call {
  const sorted = [...approvals].sort((a, b) =>
    BigInt(a.guardian) < BigInt(b.guardian) ? -1 : 1,
  );
  return {
    to: module,
    value: 0n,
    data: encodeFunctionData({
      abi: recoveryModuleAbi,
      functionName: 'multiConfirmRecovery',
      args: [
        getAddress(safe),
        [getAddress(newOwner)],
        1n,
        sorted.map((a) => ({
          signer: getAddress(a.guardian),
          signature: a.signature,
        })),
        true,
      ],
    }),
  };
}

/** What a guardian signs: EIP-712 data checked by the module itself. */
export function recoveryTypedData(input: {
  module: Address;
  safe: Address;
  newOwner: Address;
  nonce: bigint;
  chainId: number;
}) {
  return {
    domain: {
      name: 'Social Recovery Module',
      version: '0.0.1',
      chainId: input.chainId,
      verifyingContract: getAddress(input.module),
    },
    types: {
      ExecuteRecovery: [
        { name: 'wallet', type: 'address' },
        { name: 'newOwners', type: 'address[]' },
        { name: 'newThreshold', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'ExecuteRecovery',
    message: {
      wallet: getAddress(input.safe),
      newOwners: [getAddress(input.newOwner)],
      newThreshold: 1n,
      nonce: input.nonce,
    },
  } as const;
}

export async function recoverApprovalSigner(
  input: Parameters<typeof recoveryTypedData>[0],
  signature: Hex,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      ...recoveryTypedData(input),
      signature,
    });
  } catch {
    return null;
  }
}

export interface PendingRecovery {
  newOwners: Address[];
  approvals: number;
  /** Unix seconds read from the chain. 0 = approvals collected but not started. */
  executeAfter: number;
}
export interface RecoveryState {
  module: Address;
  guardians: Address[];
  threshold: number;
  nonce: bigint;
  pending: PendingRecovery | null;
}

export async function readRecoveryState(
  client: SepoliaClient,
  module: Address,
  safe: Address,
  blockNumber?: bigint,
): Promise<RecoveryState> {
  const read = <T>(functionName: string, args: unknown[]) =>
    client.readContract({
      address: module,
      abi: recoveryModuleAbi,
      functionName: functionName as never,
      args: args as never,
      blockNumber,
    }) as Promise<T>;
  const [guardians, threshold, nonce, request] = await Promise.all([
    read<readonly Address[]>('getGuardians', [safe]),
    read<bigint>('threshold', [safe]),
    read<bigint>('nonce', [safe]),
    read<{
      guardiansApprovalCount: bigint;
      newThreshold: bigint;
      executeAfter: bigint;
      newOwners: readonly Address[];
    }>('getRecoveryRequest', [safe]),
  ]);
  const started = request.executeAfter > 0n;
  return {
    module,
    guardians: guardians.map((g) => getAddress(g)),
    threshold: Number(threshold),
    nonce,
    pending: started
      ? {
          newOwners: request.newOwners.map((o) => getAddress(o)),
          approvals: Number(request.guardiansApprovalCount),
          executeAfter: Number(request.executeAfter),
        }
      : null,
  };
}
